/**
 * Economic-calendar CSV ingestion (stage 8).
 *
 * Column roles are detected, never guessed silently: the map is reported back so
 * the UI can show what was assigned and let the user override it. Anything that
 * cannot be read is rejected with a reason and the source line — the row is never
 * repaired by inventing a value.
 */

import { parseCsv, CsvScanner, sniffDelimiter, type SplitOptions } from '../csv/parser.ts';
import { parseNumber, parseDateToken, parseTimeToken, toInstant } from '../csv/values.ts';
import { createResolver } from '../time/wallclock.ts';
import { isKnownTimeZone } from '../time/tz.ts';
import {
  eventIdFor,
  eventKeyFor,
  normalizeImpact,
  type EconEvent,
  type InvalidNewsRow,
  type NewsGap,
  type NewsImportReport,
  type NewsRole,
} from './types.ts';

const ALIASES: Record<NewsRole, RegExp[]> = {
  date: [/^date$/, /^day$/, /^datetime$/, /^timestamp$/, /^time$/, /^release( date)?$/, /^wd$/i, /^datum$/i],
  time: [/^time$/, /^hour$/, /^hr$/, /^releasetime$/, /^clock$/, /^heure$/i, /^zeit$/i, /^hh:mm$/i],
  currency: [/^curr/, /^ccy$/, /^cur$/, /^pair$/, /^money$/i, /^w.hr?g?$/i],
  country: [/^country$/, /^nation$/, /^region$/, /^geo$/, /^land$/i, /^kraj$/i],
  impact: [/^impact/, /^importance/, /^priority/, /^volatility$/, /^weight$/, /^tier$/, /^star/, /^relevanz$/i, /^bw$/i],
  event: [/^event/, /^indicator/, /^name$/, /^title$/, /^release$/, /^series$/, /^economic indicator$/, /^nazwa$/i, /^bezeichnung$/i],
  category: [/^category$/, /^type$/, /^kind$/, /^group$/, /^sector$/, /^kategorie$/i],
  actual: [/^actual/, /^released$/, /^aktuell$/i, /^real$/i, /^fact$/i],
  forecast: [/^forecast/, /^consensus/, /^expect/, /^estimate/, /^prognos/i, /^erwart/i, /^mediana$/i],
  previous: [/^previous/, /^prior/, /^last$/, /^prev\b/, /^vorwert/i, /^précédent/i],
  revisedPrevious: [/^revised/, /^rev\b/, /^previous.*revi/i, /^rev.*previous/i, /^修正/i],
};

export interface NewsColumnDetection {
  roles: Partial<Record<NewsRole, number>>;
  confidence: number;
  notes: string[];
  hasHeader: boolean;
  delimiter: string;
}

function scoreHeader(cell: string, role: NewsRole): number {
  const c = cell.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!c) return 0;
  for (const re of ALIASES[role]) {
    if (re.test(c)) return 1;
    if (c.startsWith(re.source.replace(/^\^|\$$/g, ''))) return 0.7;
  }
  return 0;
}

/**
 * Read a role map off the header, falling back to cell-shape heuristics for
 * header-less exports. Ambiguities (e.g. one column matching both `previous` and
 * `revisedPrevious`) are resolved by preferring the more specific alias and are
 * always written into `notes`.
 */
export function detectNewsColumns(rows: string[][], delimiter = ','): NewsColumnDetection {
  const notes: string[] = [];
  if (rows.length === 0) return { roles: {}, confidence: 0, notes: ['empty file'], hasHeader: false, delimiter };
  const first = rows[0].map((c) => c ?? '');
  let headerScore = 0;
  for (const role of Object.keys(ALIASES) as NewsRole[]) {
    for (const cell of first) headerScore += scoreHeader(cell, role);
  }
  const numericCells = first.filter((c) => parseNumber(c) !== null).length;
  const hasHeader = headerScore >= 1 && numericCells <= 1;
  const header = hasHeader ? first : [];
  const width = Math.max(...rows.slice(0, 25).map((r) => (r ?? []).length));
  const roles: Partial<Record<NewsRole, number>> = {};

  if (hasHeader) {
    const taken = new Set<number>();
    // Most specific roles first, so "Revised previous" cannot steal "Previous".
    const order: NewsRole[] = ['revisedPrevious', 'time', 'date', 'actual', 'forecast', 'previous', 'impact', 'category', 'currency', 'country', 'event'];
    for (const role of order) {
      let best = -1;
      let bestScore = 0;
      for (let i = 0; i < header.length; i++) {
        if (taken.has(i)) continue;
        const sc = scoreHeader(header[i], role);
        if (sc > bestScore) {
          bestScore = sc;
          best = i;
        }
      }
      if (best >= 0 && bestScore > 0) {
        roles[role] = best;
        taken.add(best);
      }
    }
    if (roles.date === undefined) notes.push('no date column detected — map it manually');
    if (roles.event === undefined) notes.push('no event/indicator column detected');
  }

  const data = hasHeader ? rows.slice(1) : rows;
  if ((roles.date === undefined || roles.time === undefined) && data.length > 0) {
    // Heuristic: the leftmost column that looks like a date wins for date, the
    // next that looks like a clock wins for time.
    for (let col = 0; col < width; col++) {
      const samples = data.slice(0, 20).map((r) => r[col] ?? '');
      if (samples.filter((s) => { const d = parseDateToken(s, false); return d.wall !== null || d.absolute !== null; }).length >= Math.min(3, samples.length)) {
        if (roles.date === undefined) {
          roles.date = col;
          continue;
        }
        if (roles.time === undefined && samples.every((s) => parseTimeToken(s).ms !== null)) roles.time = col;
      }
    }
    if (roles.time === undefined) {
      for (let col = 0; col < width; col++) {
        if (col === roles.date) continue;
        const samples = data.slice(0, 20).map((r) => (r[col] ?? '').trim());
        if (samples.length > 0 && samples.every((x) => x === '' || parseTimeToken(x).ms !== null) && samples.some((x) => x !== '')) {
          roles.time = col;
          notes.push(`column ${col + 1} treated as the time`);
          break;
        }
      }
    }
    if (roles.date !== undefined) notes.push(`header not understood: column ${roles.date + 1} treated as the date`);
  }
  if (roles.event === undefined && data.length > 0) {
    for (let col = width - 1; col >= 0; col--) {
      if (roles.date === col || roles.time === col) continue;
      const textish = data.slice(0, 20).filter((r) => {
        const c = (r[col] ?? '').trim();
        return c.length > 3 && !/[.]/.test(c) && parseNumber(c) === null;
      }).length;
      if (textish >= Math.min(3, 20)) {
        roles.event = col;
        notes.push(`no event column matched by name: column ${col + 1} used (looks textual)`);
        break;
      }
    }
  }

  const required = 2;
  const found = Object.keys(roles).length;
  const confidence = found === 0 ? 0 : Math.min(1, found / 8) * (hasHeader ? 1 : 0.6) + (found >= required ? 0.15 : 0);
  return { roles, confidence: Number(confidence.toFixed(2)), notes, hasHeader, delimiter };
}

export interface NewsParseOptions {
  fileName?: string;
  /** Zone the file's timestamps were written in. */
  tz?: string;
  dayFirst?: boolean;
  map?: Partial<Record<NewsRole, number>>;
  /** Duplicate rows (same instant+currency+event): keep the first, the last, or both. */
  dedupe?: 'first' | 'last' | 'keep';
  maxInvalidReported?: number;
}

export interface NewsBuildResult {
  events: EconEvent[];
  report: NewsImportReport;
}

/**
 * Streaming builder: feed it rows, get sorted, deduplicated events plus a report.
 * Memory is O(accepted rows); nothing else is retained.
 */
export class NewsCsvBuilder {
  private readonly fileName: string;
  private readonly tz: string;
  private readonly dayFirst: boolean;
  private readonly dedupe: 'first' | 'last' | 'keep';
  private readonly maxInvalid: number;
  private map: Partial<Record<NewsRole, number>> | null;
  private resolver = createResolver('UTC');
  private header: string[] | null = null;
  private rows: EconEvent[] = [];
  private totalLines = 0;
  private dataRows = 0;
  private badTime = 0;
  private missingEvent = 0;
  private badNumbers = 0;
  private unknownImpact = 0;
  private noTime = 0;
  private notes: string[] = [];
  private invalid: InvalidNewsRow[] = [];
  private dateFormats = new Set<string>();
  private startedAt = Date.now();

  constructor(opts: NewsParseOptions = {}) {
    this.fileName = opts.fileName ?? 'calendar.csv';
    this.tz = opts.tz && isKnownTimeZone(opts.tz) ? opts.tz : 'UTC';
    if (opts.tz && opts.tz !== this.tz) this.notes.push(`unknown timezone "${opts.tz}" — read as UTC`);
    this.dayFirst = opts.dayFirst ?? false;
    this.dedupe = opts.dedupe ?? 'first';
    this.maxInvalid = opts.maxInvalidReported ?? 40;
    this.map = opts.map ? { ...opts.map } : null;
    this.resolver = createResolver(this.tz);
  }

  get linesSeen(): number {
    return this.totalLines;
  }

  setMap(map: Partial<Record<NewsRole, number>>): void {
    this.map = { ...map };
  }

  getMap(): Partial<Record<NewsRole, number>> | null {
    return this.map ? { ...this.map } : null;
  }

  /** Feed one record. A leading header row is consumed automatically. */
  feed(cells: string[]): void {
    this.totalLines++;
    if ((cells[0] ?? '').trim().startsWith('#')) return;
    if (this.header === null) {
      const textual = cells.filter((c) => parseNumber((c ?? '').trim()) === null && (c ?? '').trim() !== '').length;
      // A header row carries no measurements: if any cell is a number or a date,
      // this is data and must not be swallowed.
      const measurable = cells.some((c) => {
        const x = (c ?? '').trim();
        if (!x) return false;
        const d = parseDateToken(x, this.dayFirst);
        return parseNumber(x) !== null || d.wall !== null || d.absolute !== null;
      });
      const looksHeader = !measurable && textual >= Math.max(2, Math.floor(cells.length / 2));
      this.header = looksHeader ? cells.map((c) => (c ?? '').trim()) : [];
      if (looksHeader) {
        if (!this.map) this.map = detectNewsColumns([cells], ',').roles;
        return;
      }
    }
    if (cells.every((c) => (c ?? '').trim() === '')) return;
    this.dataRows++;
    const map = this.map;
    if (!map) {
      this.reject(this.totalLines, 'no column mapping set', cells);
      return;
    }
    const get = (role: NewsRole): string => {
      const i = map[role];
      return i === undefined ? '' : (cells[i] ?? '').trim();
    };

    const dateTok = parseDateToken(get('date'), this.dayFirst);
    if (dateTok.wall === null && dateTok.absolute === null) {
      this.badTime++;
      this.reject(this.totalLines, dateTok.error ?? 'date could not be read', cells);
      return;
    }
    const rawTime = get('time');
    const timeTok = rawTime ? parseTimeToken(rawTime) : { ms: null, meridiem: false, format: null };
    if (rawTime && timeTok.ms === null) {
      this.badTime++;
      this.reject(this.totalLines, `time "${rawTime}" could not be read`, cells);
      return;
    }
    if (dateTok.format) this.dateFormats.add(dateTok.format);
    const conv = toInstant(dateTok, timeTok.ms, this.resolver);
    if (conv.instant === null) {
      this.badTime++;
      this.reject(this.totalLines, conv.error ?? 'timestamp could not be resolved', cells);
      return;
    }
    const timeKnown = timeTok.ms !== null;
    if (!timeKnown) this.noTime++;

    const eventName = get('event').replace(/\s+/g, ' ').trim();
    if (!eventName) {
      this.missingEvent++;
      this.reject(this.totalLines, 'no event name in this row', cells);
      return;
    }
    const currencyRaw = get('currency').toUpperCase().replace(/[^A-Z]/g, '');
    const country = get('country').trim() || null;
    const fromCountry = (country ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    const currency = currencyRaw.length >= 2 ? currencyRaw.slice(0, 3) : fromCountry;
    if (!currency) {
      this.reject(this.totalLines, 'no currency or country to key the event by', cells);
      return;
    }
    const impactRaw = get('impact') || null;
    const impact = normalizeImpact(impactRaw);
    if (impact === 'unknown') this.unknownImpact++;

    const num = (role: NewsRole): number | null => {
      const cell = get(role);
      if (!cell) return null;
      const v = parseNumber(cell, { allowParens: true });
      if (v === null) {
        this.badNumbers++;
        this.notes.push(`row ${this.totalLines}: ${role} value "${cell}" is not a number — kept as missing`);
      }
      return v;
    };
    const actual = num('actual');
    const forecast = num('forecast');
    const previous = num('previous');
    const revisedPrevious = num('revisedPrevious');
    if (this.notes.length > 12) this.notes.length = 12;

    const eventKey = eventKeyFor(currency, eventName);
    this.rows.push({
      id: eventIdFor({ instant: conv.instant, currency, eventKey, line: this.totalLines }),
      instant: conv.instant,
      timeKnown,
      currency,
      country,
      impact,
      impactRaw,
      event: eventName,
      eventKey,
      category: get('category').trim() || null,
      actual,
      forecast,
      previous,
      revisedPrevious,
      previousWasRevised: false,
      unit: null,
      line: this.totalLines,
    });
  }

  private reject(line: number, reason: string, cells: string[]): void {
    if (this.invalid.length < this.maxInvalid) this.invalid.push({ line, reason, cells: cells.slice(0, 12) });
  }

  finish(): NewsBuildResult {
    // Chronological order is a hard requirement of the whole feature: every
    // downstream statistic walks the list forward exactly once.
    this.rows.sort((a, b) => a.instant - b.instant || a.currency.localeCompare(b.currency) || a.event.localeCompare(b.event));

    const gaps: NewsGap[] = [];
    let duplicates = 0;
    let duplicatesKept = 0;
    const events: EconEvent[] = [];
    const seen = new Map<string, number>();
    for (const e of this.rows) {
      const key = `${e.instant}|${e.currency}|${e.eventKey}`;
      const prevIdx = seen.get(key);
      if (prevIdx === undefined) {
        seen.set(key, events.length);
        events.push(e);
        continue;
      }
      duplicates++;
      if (this.dedupe === 'keep') {
        duplicatesKept++;
        events.push(e);
        continue;
      }
      if (this.dedupe === 'last') events[prevIdx] = e;
      if (gaps.length < 40) {
        gaps.push({ line: e.line ?? 0, instant: e.instant, currency: e.currency, event: e.event, kept: this.dedupe });
      }
    }

    const impacts: Record<string, number> = { high: 0, medium: 0, low: 0, none: 0, unknown: 0 };
    let withoutActual = 0;
    let withoutForecast = 0;
    const currencies = new Set<string>();
    for (const e of events) {
      impacts[e.impact] = (impacts[e.impact] ?? 0) + 1;
      currencies.add(e.currency);
      if (e.actual === null) withoutActual++;
      if (e.forecast === null) withoutForecast++;
    }

    const report: NewsImportReport = {
      fileName: this.fileName,
      tz: this.tz,
      totalLines: this.totalLines,
      dataRows: this.dataRows,
      accepted: events.length,
      rejected: this.dataRows - this.rows.length,
      badTime: this.badTime,
      missingEvent: this.missingEvent,
      badNumbers: this.badNumbers,
      unknownImpact: this.unknownImpact,
      noTime: this.noTime,
      duplicates,
      duplicatesKept,
      withoutActual,
      withoutForecast,
      firstTime: events.length ? events[0].instant : null,
      lastTime: events.length ? events[events.length - 1].instant : null,
      currencies: [...currencies].sort(),
      impacts: impacts as NewsImportReport['impacts'],
      columns: this.map ?? {},
      header: this.header ?? [],
      columnConfidence: this.map ? 1 : 0,
      notes: this.notes,
      invalid: this.invalid,
      gaps,
      durationMs: Date.now() - this.startedAt,
    };
    return { events, report };
  }
}

export function parseNewsCsv(text: string, opts: NewsParseOptions = {}): NewsBuildResult {
  const delimiter = sniffDelimiter(text.slice(0, 8192));
  const builder = new NewsCsvBuilder(opts);
  const rows = parseCsv(text, { delimiter } as SplitOptions);
  if (!opts.map) {
    const detection = detectNewsColumns(rows.slice(0, 40), delimiter);
    builder.setMap(detection.roles);
  }
  for (const row of rows) builder.feed(row);
  const out = builder.finish();
  out.report.notes.unshift(...(opts.map ? [] : detectNewsColumns(rows.slice(0, 40), delimiter).notes));
  return out;
}

export interface NewsChunkProgress {
  lines: number;
  rows: number;
  fraction: number;
}

/**
 * Chunked parse for the sizes a multi-year archive can reach: the text is split on
 * record boundaries and a task yields between chunks, so a long import never
 * blocks a frame. Same builder, same result as `parseNewsCsv`.
 */
export async function parseNewsCsvChunked(
  text: string,
  opts: NewsParseOptions = {},
  onProgress?: (p: NewsChunkProgress) => void,
  chunkBytes = 1 << 19,
): Promise<NewsBuildResult> {
  const delimiter = sniffDelimiter(text.slice(0, 8192));
  const head = text.slice(0, 1 << 15);
  const headRows = parseCsv(head, { delimiter });
  const detection = opts.map ? null : detectNewsColumns(headRows.slice(0, 40), delimiter);
  const builder = new NewsCsvBuilder(opts);
  if (detection) builder.setMap(detection.roles);
  const scanner = new CsvScanner({ delimiter });
  const sink = { row: (cells: string[]) => builder.feed(cells) };
  let pos = 0;
  let first = true;
  while (pos < text.length) {
    const next = Math.min(text.length, pos + chunkBytes);
    const slice = text.slice(pos, next);
    scanner.push(slice, sink, next >= text.length);
    pos = next;
    onProgress?.({ lines: builder.linesSeen, rows: builder.linesSeen, fraction: pos / text.length });
    if (!first) await new Promise((resolve) => setTimeout(resolve, 0));
    first = false;
  }
  const out = builder.finish();
  if (detection) out.report.columnConfidence = detection.confidence;
  if (detection) out.report.notes.unshift(...detection.notes);
  return out;
}
