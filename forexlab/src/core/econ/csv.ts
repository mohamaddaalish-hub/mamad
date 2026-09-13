/**
 * Economic-news CSV import.
 *
 * Reuses the market importer's scanner, delimiter sniffing, date/time token
 * parsing and wall-clock resolver so a news file and a price file agree on what
 * "16:30 in New York" means. The importer:
 *
 *  - detects columns by header aliases, but every role can be overridden;
 *  - never fabricates Actual / Forecast / Previous — empty stays `null`;
 *  - rejects rows with unusable timestamps and reports why;
 *  - detects duplicates (same key + same instant) and keeps the first;
 *  - produces a summary the UI shows before anything is stored.
 */

import { CsvScanner, sniffDelimiter, splitRecord } from '../csv/parser.ts';
import { parseDateToken, parseNumber, parseTimeToken, toInstant } from '../csv/values.ts';
import { createResolver } from '../time/wallclock.ts';
import { CATEGORIES, CURRENCIES, type Category, type Currency, type EconEvent, type Impact } from './types.ts';

export type NewsRole =
  | 'date'
  | 'time'
  | 'datetime'
  | 'timestamp'
  | 'currency'
  | 'country'
  | 'impact'
  | 'event'
  | 'category'
  | 'subcategory'
  | 'actual'
  | 'forecast'
  | 'previous'
  | 'revised';

export const NEWS_ROLES: NewsRole[] = [
  'datetime',
  'date',
  'time',
  'timestamp',
  'currency',
  'country',
  'impact',
  'event',
  'category',
  'subcategory',
  'actual',
  'forecast',
  'previous',
  'revised',
];

export const NEWS_ROLE_LABEL: Record<NewsRole, string> = {
  datetime: 'Datetime',
  date: 'Date',
  time: 'Time',
  timestamp: 'Timestamp (epoch)',
  currency: 'Currency',
  country: 'Country',
  impact: 'Impact',
  event: 'Event',
  category: 'Category',
  subcategory: 'Subcategory',
  actual: 'Actual',
  forecast: 'Forecast',
  previous: 'Previous',
  revised: 'Revised Previous',
};

const ALIASES: Record<NewsRole, string[]> = {
  datetime: ['datetime', 'date time', 'date_time', 'release time', 'releasetime', 'release_date', 'start', 'dateutc'],
  date: ['date', 'day', 'release date'],
  time: ['time', 'time (utc)', 'time utc', 'hour', 'release_time_only'],
  timestamp: ['timestamp', 'epoch', 'unix', 'ts', 'time_ms'],
  currency: ['currency', 'ccy', 'cur'],
  country: ['country', 'region', 'zone', 'nation'],
  impact: ['impact', 'importance', 'volatility', 'priority', 'level', 'stars'],
  event: ['event', 'title', 'name', 'indicator', 'description', 'event name', 'release'],
  category: ['category', 'group', 'sector', 'type'],
  subcategory: ['subcategory', 'sub category', 'sub_category', 'subgroup'],
  actual: ['actual', 'act', 'result', 'value'],
  forecast: ['forecast', 'consensus', 'expected', 'estimate', 'fcst', 'exp', 'survey'],
  previous: ['previous', 'prev', 'prior', 'last'],
  revised: ['revised', 'revised previous', 'revised_previous', 'previous revised', 'prev revised', 'revision'],
};

export type NewsColumnMap = Partial<Record<NewsRole, number>>;

function norm(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Header-based detection; falls back to sampling values for date-like columns. */
export function detectNewsColumns(rows: string[][]): { map: NewsColumnMap; hasHeader: boolean } {
  if (rows.length === 0) return { map: {}, hasHeader: false };
  const header = rows[0].map(norm);
  const map: NewsColumnMap = {};
  const used = new Set<number>();
  let hits = 0;
  for (const role of NEWS_ROLES) {
    for (let i = 0; i < header.length; i++) {
      if (used.has(i)) continue;
      const h = header[i];
      if (ALIASES[role].some((a) => h === a || h.startsWith(`${a} `) || h === a.replace(/ /g, ''))) {
        map[role] = i;
        used.add(i);
        hits++;
        break;
      }
    }
  }
  const hasHeader = hits >= 3 || (hits >= 2 && header.some((h) => /event|actual|forecast|currency/.test(h)));
  if (!hasHeader) {
    // Positional guess on headerless files: date,time,currency,impact,event,actual,forecast,previous
    const sample = rows.slice(0, 20);
    const cols = Math.max(...sample.map((r) => r.length));
    const dateLike: number[] = [];
    for (let c = 0; c < cols; c++) {
      const ok = sample.filter((r) => parseDateToken(r[c], false).wall !== null).length;
      if (ok >= Math.max(1, sample.length * 0.7)) dateLike.push(c);
    }
    const out: NewsColumnMap = {};
    if (dateLike.length > 0) out.datetime = dateLike[0];
    return { map: out, hasHeader: false };
  }
  // "type" is ambiguous — only treat it as category if no category column exists.
  return { map, hasHeader: true };
}

export interface NewsImportOptions {
  /** IANA zone the file's wall-clock times are expressed in. */
  tz: string;
  dayFirst: boolean;
  delimiter?: string;
  hasHeader?: boolean;
  batchId: string;
  /** Sparse override for detected roles. */
  map?: NewsColumnMap;
}

export interface NewsRejectedRow {
  row: number;
  reason: string;
  cells: string[];
}

export interface NewsImportSummary {
  totalRows: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  missingActual: number;
  missingForecast: number;
  missingPrevious: number;
  withRevised: number;
  unknownCurrency: number;
  unknownImpact: number;
  firstTime: number | null;
  lastTime: number | null;
  dateFormat: string | null;
  delimiter: string;
  tz: string;
  currencies: Record<string, number>;
  rejectedRows: NewsRejectedRow[];
  columnMap: NewsColumnMap;
}

export interface NewsImportResult {
  events: EconEvent[];
  summary: NewsImportSummary;
}

/** Normalise "USD", "usd ", "US Dollar" → USD. */
export function normaliseCurrency(raw: string | undefined, country?: string | null): { code: string; known: boolean } {
  const s = (raw ?? '').trim().toUpperCase();
  if ((CURRENCIES as readonly string[]).includes(s)) return { code: s, known: true };
  const byName: Record<string, Currency> = {
    'US DOLLAR': 'USD',
    DOLLAR: 'USD',
    EURO: 'EUR',
    POUND: 'GBP',
    STERLING: 'GBP',
    YEN: 'JPY',
    FRANC: 'CHF',
    'AUSTRALIAN DOLLAR': 'AUD',
    'CANADIAN DOLLAR': 'CAD',
    'NEW ZEALAND DOLLAR': 'NZD',
  };
  if (byName[s]) return { code: byName[s], known: true };
  const c = (country ?? '').trim().toUpperCase();
  const byCountry: Record<string, Currency> = {
    US: 'USD',
    USA: 'USD',
    'UNITED STATES': 'USD',
    EU: 'EUR',
    EMU: 'EUR',
    EUROZONE: 'EUR',
    'EURO AREA': 'EUR',
    'EURO ZONE': 'EUR',
    DE: 'EUR',
    GERMANY: 'EUR',
    FR: 'EUR',
    FRANCE: 'EUR',
    IT: 'EUR',
    ITALY: 'EUR',
    ES: 'EUR',
    SPAIN: 'EUR',
    UK: 'GBP',
    GB: 'GBP',
    'UNITED KINGDOM': 'GBP',
    JP: 'JPY',
    JAPAN: 'JPY',
    CH: 'CHF',
    SWITZERLAND: 'CHF',
    AU: 'AUD',
    AUSTRALIA: 'AUD',
    CA: 'CAD',
    CANADA: 'CAD',
    NZ: 'NZD',
    'NEW ZEALAND': 'NZD',
  };
  if (s && byCountry[s]) return { code: byCountry[s], known: true };
  if (c && byCountry[c]) return { code: byCountry[c], known: true };
  if (/^[A-Z]{3}$/.test(s)) return { code: s, known: false };
  return { code: s || 'UNKNOWN', known: false };
}

export function normaliseImpact(raw: string | undefined): Impact | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/critical|extreme|\b5\b|★★★★★|\*{5}/.test(s)) return 'critical';
  if (/very ?high|\b4\b|★★★★|\*{4}/.test(s)) return 'veryHigh';
  if (/high|\b3\b|★★★|\*{3}|red/.test(s)) return 'high';
  if (/med|moderate|\b2\b|★★|\*{2}|orange|yellow/.test(s)) return 'medium';
  if (/low|\b1\b|★|\*|holiday|none|grey|gray|white/.test(s)) return 'low';
  return null;
}

/** Category from an explicit column or from the event title. */
export function inferCategory(raw: string | undefined, title: string): Category {
  const s = (raw ?? '').trim().toLowerCase();
  for (const c of CATEGORIES) if (s && s === c.toLowerCase()) return c;
  const t = `${s} ${title}`.toLowerCase();
  if (/cpi|inflation|ppi|pce|price index|deflator|hicp/.test(t)) return 'Inflation';
  if (/payroll|nfp|employment|unemployment|jobless|claims|jolts|earnings|labor|labour|wage|ADP/i.test(t)) return 'Employment';
  if (/gdp|growth|industrial production|output/.test(t)) return 'Growth';
  if (/rate decision|interest rate|fomc|policy|minutes|statement|dot plot|qe|bank rate|refinancing/.test(t))
    return 'Monetary Policy';
  if (/fed|ecb|boe|boj|snb|rba|boc|rbnz|central bank|powell|lagarde|governor|chair|speech|press conference|testif/.test(t))
    return 'Central Bank';
  if (/manufactur|ism manu|factory|durable/.test(t)) return 'Manufacturing';
  if (/services|ism non|non-manufacturing/.test(t)) return 'Services';
  if (/retail|consumer|spending|personal income|credit/.test(t)) return 'Consumer';
  if (/housing|home|building permit|construction|mortgage/.test(t)) return 'Housing';
  if (/trade|export|import|current account|balance/.test(t)) return 'Trade';
  if (/budget|debt|treasury|auction|government|fiscal|election/.test(t)) return 'Government';
  if (/sentiment|confidence|pmi|zew|ifo|michigan|expectations|survey|tankan/.test(t)) return 'Sentiment';
  return 'Other';
}

/** Short event-type tag for grouping/filtering (CPI, NFP, GDP ...). */
export function inferEventType(title: string): string {
  const t = title.toLowerCase();
  const rules: [RegExp, string][] = [
    [/core (cpi|consumer price)|cpi ex|core inflation/, 'Core CPI'],
    [/cpi|consumer price/, 'CPI'],
    [/core pce/, 'Core PCE'],
    [/pce/, 'PCE'],
    [/ppi|producer price/, 'PPI'],
    [/non-?farm|nfp|nonfarm/, 'NFP'],
    [/adp/, 'ADP'],
    [/unemployment rate/, 'Unemployment Rate'],
    [/jobless|initial claims|continuing claims/, 'Jobless Claims'],
    [/jolts/, 'JOLTS'],
    [/average hourly earnings|hourly earnings/, 'Avg Hourly Earnings'],
    [/gdp/, 'GDP'],
    [/retail sales/, 'Retail Sales'],
    [/fomc|fed (interest )?rate|federal funds/, 'FOMC'],
    [/ecb (interest|rate|deposit|refinanc)|main refinancing|deposit facility/, 'ECB'],
    [/boe|bank of england|bank rate/, 'BoE'],
    [/boj|bank of japan/, 'BoJ'],
    [/snb/, 'SNB'],
    [/rba/, 'RBA'],
    [/boc|bank of canada/, 'BoC'],
    [/rbnz/, 'RBNZ'],
    [/ism manufacturing/, 'ISM Manufacturing'],
    [/ism (services|non)/, 'ISM Services'],
    [/services pmi/, 'Services PMI'],
    [/manufacturing pmi/, 'Manufacturing PMI'],
    [/composite pmi/, 'Composite PMI'],
    [/pmi/, 'PMI'],
    [/zew/, 'ZEW'],
    [/ifo/, 'IFO'],
    [/michigan|consumer sentiment/, 'Consumer Sentiment'],
    [/consumer confidence/, 'Consumer Confidence'],
    [/durable/, 'Durable Goods'],
    [/industrial production/, 'Industrial Production'],
    [/trade balance/, 'Trade Balance'],
    [/housing starts/, 'Housing Starts'],
    [/building permits/, 'Building Permits'],
    [/existing home/, 'Existing Home Sales'],
    [/new home/, 'New Home Sales'],
    [/speech|speaks|testif|remarks/, 'Speech'],
    [/minutes/, 'Minutes'],
  ];
  for (const [re, tag] of rules) if (re.test(t)) return tag;
  return title.replace(/\(.*?\)/g, '').trim().slice(0, 32) || 'Other';
}

/** Stable per-indicator key: currency + cleaned title (period qualifiers kept). */
export function indicatorKey(currency: string, title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b\.?/g, '')
    .replace(/\b(q[1-4]|20\d\d|19\d\d)\b/g, '')
    .replace(/\b(prelim(inary)?|final|revised|1st|2nd|3rd|first|second|third|est(imate)?|adv(ance)?)\b/g, (m) => m)
    .replace(/[^a-z0-9%()/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${currency.toUpperCase()}|${cleaned}`;
}

function unitOf(...cells: (string | undefined)[]): string | null {
  for (const c of cells) {
    if (!c) continue;
    const m = /([%KMBT])\s*$/i.exec(c.trim());
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (!s) return null;
  // Strip unit suffix (K/M/B/%) but do not scale: unit is kept separately for display.
  const stripped = s.replace(/\s*[%KMBT]\s*$/i, '');
  return parseNumber(stripped, { decimalSeparator: '.' });
}

/** Probe the first rows so the dialog can show a preview + detected mapping. */
export function probeNewsText(text: string): { rows: string[][]; delimiter: string; map: NewsColumnMap; hasHeader: boolean } {
  const delimiter = sniffDelimiter(text.slice(0, 16_384));
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0).slice(0, 51);
  const rows = lines.map((l) => splitRecord(l, delimiter));
  const det = detectNewsColumns(rows);
  return { rows, delimiter, map: det.map, hasHeader: det.hasHeader };
}

export function requiredNewsRolesMissing(map: NewsColumnMap): NewsRole[] {
  const missing: NewsRole[] = [];
  const hasTime = map.datetime !== undefined || map.timestamp !== undefined || map.date !== undefined;
  if (!hasTime) missing.push('date');
  if (map.event === undefined) missing.push('event');
  if (map.currency === undefined && map.country === undefined) missing.push('currency');
  return missing;
}

/** Full parse of an in-memory text. Files are small (thousands of rows), so no chunking is required. */
export function importNewsText(text: string, opts: NewsImportOptions): NewsImportResult {
  const delimiter = opts.delimiter ?? sniffDelimiter(text.slice(0, 16_384));
  const rows: string[][] = [];
  const scanner = new CsvScanner({ delimiter });
  scanner.push(text, { row: (cells) => rows.push(cells) }, true);
  const det = detectNewsColumns(rows);
  const hasHeader = opts.hasHeader ?? det.hasHeader;
  const map: NewsColumnMap = { ...det.map, ...(opts.map ?? {}) };
  for (const k of Object.keys(map) as NewsRole[]) if (map[k] === undefined || map[k] === null || (map[k] as number) < 0) delete map[k];
  const resolver = createResolver(opts.tz);
  const events: EconEvent[] = [];
  const rejected: NewsRejectedRow[] = [];
  const seen = new Map<string, number>();
  const currencies: Record<string, number> = {};
  let missingActual = 0;
  let missingForecast = 0;
  let missingPrevious = 0;
  let withRevised = 0;
  let unknownCurrency = 0;
  let unknownImpact = 0;
  let duplicates = 0;
  let dateFormat: string | null = null;
  let first: number | null = null;
  let last: number | null = null;
  const start = hasHeader ? 1 : 0;
  const cell = (r: string[], role: NewsRole): string | undefined => {
    const i = map[role];
    return i === undefined ? undefined : r[i];
  };

  const missingRoles = requiredNewsRolesMissing(map);
  if (missingRoles.length > 0) {
    return {
      events: [],
      summary: {
        totalRows: Math.max(0, rows.length - start),
        accepted: 0,
        rejected: Math.max(0, rows.length - start),
        duplicates: 0,
        missingActual: 0,
        missingForecast: 0,
        missingPrevious: 0,
        withRevised: 0,
        unknownCurrency: 0,
        unknownImpact: 0,
        firstTime: null,
        lastTime: null,
        dateFormat: null,
        delimiter,
        tz: opts.tz,
        currencies: {},
        rejectedRows: [{ row: 0, reason: `missing required column(s): ${missingRoles.join(', ')}`, cells: [] }],
        columnMap: map,
      },
    };
  }

  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = hasHeader ? r : r + 1;
    if (row.every((c) => c.trim() === '')) continue;
    // ---- timestamp
    let instant: number | null = null;
    let reason: string | null = null;
    const tsRaw = cell(row, 'timestamp');
    if (tsRaw !== undefined && tsRaw.trim() !== '') {
      const n = Number(tsRaw.trim());
      if (Number.isFinite(n)) {
        instant = n > 1e11 ? Math.round(n) : Math.round(n * 1000);
        dateFormat ??= 'epoch';
      } else reason = `invalid timestamp "${tsRaw}"`;
    }
    if (instant === null && reason === null) {
      const dtRaw = cell(row, 'datetime') ?? cell(row, 'date');
      const timeRaw = cell(row, 'time');
      const date = parseDateToken(dtRaw, opts.dayFirst);
      if (date.wall === null && date.absolute === null) reason = date.error ?? `unreadable date "${dtRaw ?? ''}"`;
      else {
        let timeMs: number | null = null;
        if (timeRaw !== undefined && timeRaw.trim() !== '') {
          const t = parseTimeToken(timeRaw);
          if (t.ms === null) {
            if (/all ?day|tentative|tba|n\/a/i.test(timeRaw)) reason = `no release time ("${timeRaw.trim()}")`;
            else reason = `unreadable time "${timeRaw}"`;
          } else timeMs = t.ms;
        }
        if (!reason) {
          const inst = toInstant(date, timeMs, resolver);
          if (inst.instant === null) reason = inst.error ?? 'unresolvable timestamp';
          else {
            instant = inst.instant;
            dateFormat ??= inst.format;
          }
        }
      }
    }
    if (instant === null || reason) {
      rejected.push({ row: rowNo, reason: reason ?? 'missing timestamp', cells: row });
      continue;
    }
    if (instant < Date.UTC(1990, 0, 1) || instant > Date.UTC(2100, 0, 1)) {
      rejected.push({ row: rowNo, reason: `timestamp out of range (${new Date(instant).toISOString()})`, cells: row });
      continue;
    }
    // ---- title
    const title = (cell(row, 'event') ?? '').trim().replace(/\s+/g, ' ');
    if (!title) {
      rejected.push({ row: rowNo, reason: 'empty event title', cells: row });
      continue;
    }
    if (title.length > 200) {
      rejected.push({ row: rowNo, reason: 'event title longer than 200 characters', cells: row });
      continue;
    }
    // ---- currency
    const country = (cell(row, 'country') ?? '').trim() || null;
    const cur = normaliseCurrency(cell(row, 'currency'), country);
    if (!cur.known) unknownCurrency++;
    // ---- impact
    const impactRaw = cell(row, 'impact');
    const impact = normaliseImpact(impactRaw);
    if (impactRaw && impactRaw.trim() && impact === null) unknownImpact++;
    // ---- numbers
    const aRaw = cell(row, 'actual');
    const fRaw = cell(row, 'forecast');
    const pRaw = cell(row, 'previous');
    const rRaw = cell(row, 'revised');
    const actual = num(aRaw);
    const forecast = num(fRaw);
    const previous = num(pRaw);
    const revised = num(rRaw);
    const bad = [
      ['Actual', aRaw, actual],
      ['Forecast', fRaw, forecast],
      ['Previous', pRaw, previous],
      ['Revised Previous', rRaw, revised],
    ].find(([, raw, v]) => raw !== undefined && String(raw).trim() !== '' && v === null && !/^(n\/?a|na|-+|—|–|tba|tbd)$/i.test(String(raw).trim()));
    if (bad) {
      rejected.push({ row: rowNo, reason: `invalid numeric ${bad[0]} "${String(bad[1]).trim()}"`, cells: row });
      continue;
    }
    if (actual === null) missingActual++;
    if (forecast === null) missingForecast++;
    if (previous === null) missingPrevious++;
    if (revised !== null) withRevised++;
    const key = indicatorKey(cur.code, title);
    const dupKey = `${key}@${instant}`;
    if (seen.has(dupKey)) {
      duplicates++;
      rejected.push({ row: rowNo, reason: `duplicate of row ${seen.get(dupKey)} (same indicator and instant)`, cells: row });
      continue;
    }
    seen.set(dupKey, rowNo);
    currencies[cur.code] = (currencies[cur.code] ?? 0) + 1;
    first = first === null ? instant : Math.min(first, instant);
    last = last === null ? instant : Math.max(last, instant);
    events.push({
      id: `${opts.batchId}:${rowNo}`,
      time: instant,
      currency: cur.code,
      country,
      impact,
      event: title,
      key,
      type: inferEventType(title),
      category: inferCategory(cell(row, 'category'), title),
      subcategory: (cell(row, 'subcategory') ?? '').trim() || null,
      actual,
      forecast,
      previous,
      revisedPrevious: revised,
      row: rowNo,
      unit: unitOf(aRaw, fRaw, pRaw),
      batchId: opts.batchId,
    });
  }
  events.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
  return {
    events,
    summary: {
      totalRows: Math.max(0, rows.length - start),
      accepted: events.length,
      rejected: rejected.length,
      duplicates,
      missingActual,
      missingForecast,
      missingPrevious,
      withRevised,
      unknownCurrency,
      unknownImpact,
      firstTime: first,
      lastTime: last,
      dateFormat,
      delimiter,
      tz: opts.tz,
      currencies,
      rejectedRows: rejected.slice(0, 500),
      columnMap: map,
    },
  };
}
