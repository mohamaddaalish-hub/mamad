/**
 * Streaming market-CSV builder.
 *
 * Turns arbitrary CSV rows into validated columnar OHLCV. At `finish()` it
 * resolves the timeframe, aligns rows to buckets, folds/aggregates or dedupes
 * duplicates, sorts chronologically and writes an import report.
 *
 * Invariants the tests hold this file to:
 *  - OHLC values are copied verbatim; only max/min selection reads them.
 *  - Missing bars are reported, never inserted.
 *  - Unparsable rows are reported with their line number, never coerced.
 */

import { parseDateToken, parseNumber, parseTimeToken, toInstant } from './values.ts';
import type { ColumnRole } from './columns.ts';
import { TIMEFRAMES, timeframe, type TimeframeId } from '../time/timeframes.ts';
import { bucketEnd, floorToTimeframe, zonedParts } from '../time/tz.ts';
import { createResolver, type WallClockResolver } from '../time/wallclock.ts';
import { emptyColumns, type CandleColumns } from '../data/types.ts';

export interface InvalidRow {
  line: number;
  reason: string;
  raw: string;
}

export interface GapRecord {
  from: number;
  to: number;
  missingBars: number;
  kind: 'hole' | 'holiday';
}

export interface ImportReport {
  fileName: string;
  symbol: string;
  timeframe: TimeframeId;
  /** Timeframe the source rows themselves represent (before aggregation). */
  nativeTimeframe: TimeframeId | 'irregular';
  timezone: string;
  totalLines: number;
  dataRows: number;
  /** Lines that were comments/banners and deliberately ignored. */
  commentLines: number;
  accepted: number;
  rejected: number;
  ohlcViolations: number;
  duplicates: number;
  duplicatesKept: number;
  mergedIntoBuckets: number;
  unorderedRows: number;
  gaps: GapRecord[];
  gapCount: number;
  missingBars: number;
  closedSpans: number;
  firstTime: number | null;
  lastTime: number | null;
  minLow: number;
  maxHigh: number;
  volumeSeen: boolean;
  /** Decimal places seen in the price columns — defines the pip size downstream. */
  priceDecimals: number;
  invalid: InvalidRow[];
  notes: string[];
  durationMs: number;
  dateFormat: string | null;
  timeFormat: string | null;
  columnMap: Partial<Record<ColumnRole, number>>;
  header: string[];
}

/** Digits after the decimal separator in a raw price cell (never inferred from the value). */
function decimalsIn(raw: string | undefined, sep: '.' | ',' | 'auto'): number {
  if (!raw) return 0;
  const text = raw.trim();
  const dot = /[.,]/;
  const idx = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
  if (idx < 0 || !dot.test(text[idx])) return 0;
  const tail = text.slice(idx + 1);
  if (!/^\d+$/.test(tail)) return 0;
  void sep;
  return Math.min(8, tail.length);
}

export interface MarketImportOptions {
  symbol?: string;
  fileName?: string;
  /** 'auto' infers the timeframe from row spacing. */
  tf?: TimeframeId | 'auto';
  tz: string;
  dayFirst?: boolean;
  decimalSeparator?: '.' | ',' | 'auto';
  /** Whether the source timestamp marks the candle open or its close. */
  timestampMode?: 'open' | 'close';
  dedupe?: 'first' | 'last' | 'reject';
  map?: Partial<Record<ColumnRole, number>>;
  maxInvalidReported?: number;
}

export interface MarketBuildResult {
  cols: CandleColumns;
  report: ImportReport;
  /** Requested timeframe is finer than the source rows can support. */
  finerThanSource: boolean;
}

class Grower {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  len = 0;
  private cap: number;

  constructor(cap: number) {
    this.cap = Math.max(1024, cap);
    this.t = new Float64Array(this.cap);
    this.o = new Float64Array(this.cap);
    this.h = new Float64Array(this.cap);
    this.l = new Float64Array(this.cap);
    this.c = new Float64Array(this.cap);
    this.v = new Float64Array(this.cap);
  }

  private ensure(): void {
    if (this.len <= this.cap) return;
    let cap = this.cap;
    while (cap < this.len) cap *= 2;
    const grow = (src: Float64Array): Float64Array => {
      const out = new Float64Array(cap);
      out.set(src);
      return out;
    };
    this.t = grow(this.t);
    this.o = grow(this.o);
    this.h = grow(this.h);
    this.l = grow(this.l);
    this.c = grow(this.c);
    this.v = grow(this.v);
    this.cap = cap;
  }

  push(t: number, o: number, h: number, l: number, c: number, v: number): void {
    this.ensure();
    const i = this.len++;
    this.t[i] = t;
    this.o[i] = o;
    this.h[i] = h;
    this.l[i] = l;
    this.c[i] = c;
    this.v[i] = v;
  }
}

export class MarketCsvBuilder {
  private readonly symbol: string;
  private readonly fileName: string;
  private readonly tz: string;
  private readonly dayFirst: boolean;
  private readonly decimalSeparator: '.' | ',' | 'auto';
  private readonly timestampMode: 'open' | 'close';
  private readonly dedupe: 'first' | 'last' | 'reject';
  private readonly maxInvalidReported: number;
  private readonly requestedTf: TimeframeId | 'auto';
  private readonly resolver: WallClockResolver;
  private map: Partial<Record<ColumnRole, number>> | null;
  private rows = new Grower(1 << 16);
  private header: string[] | null = null;
  private totalLines = 0;
  private dataRows = 0;
  private commentLines = 0;
  private rejected = 0;
  private ohlcViolations = 0;
  private unordered = 0;
  private volumeSeen = false;
  private priceDecimals = 0;
  private dateFormat: string | null = null;
  private timeFormat: string | null = null;
  private invalid: InvalidRow[] = [];
  private notes: string[] = [];
  private readonly startedAt = Date.now();

  constructor(opts: MarketImportOptions) {
    this.symbol = (opts.symbol ?? 'EURUSD').toUpperCase();
    this.fileName = opts.fileName ?? 'data.csv';
    this.tz = opts.tz || 'UTC';
    this.dayFirst = opts.dayFirst ?? false;
    this.decimalSeparator = opts.decimalSeparator ?? 'auto';
    this.timestampMode = opts.timestampMode ?? 'open';
    this.dedupe = opts.dedupe ?? 'first';
    this.maxInvalidReported = opts.maxInvalidReported ?? 40;
    this.requestedTf = opts.tf ?? 'auto';
    this.map = opts.map ? { ...opts.map } : null;
    this.resolver = createResolver(this.tz);
  }

  get linesSeen(): number {
    return this.totalLines;
  }

  setMap(map: Partial<Record<ColumnRole, number>>): void {
    this.map = { ...map };
  }

  getMap(): Partial<Record<ColumnRole, number>> | null {
    return this.map;
  }

  /** Feed one raw record. A leading header row is consumed automatically. */
  feed(cells: string[]): void {
    this.totalLines++;
    // Comment/banner lines (common in vendor exports) are skipped, never rejected.
    if ((cells[0] ?? '').trim().startsWith('#')) {
      this.commentLines++;
      return;
    }
    if (this.header === null) {
      const looksHeader =
        cells.some((c) => !/^[+-]?[\d.,%]+$/.test((c ?? '').trim())) ||
        cells.some((c) => /^(date|time|open|high|low|close|volume|symbol|datetime|timestamp)$/i.test((c ?? '').trim()));
      if (looksHeader) {
        this.header = cells;
        return;
      }
      this.header = [];
    }
    if (cells.every((c) => (c ?? '').trim() === '')) return;
    this.dataRows++;
    const map = this.map;
    if (!map) {
      this.reject(this.totalLines, 'no column mapping set', cells);
      return;
    }
    const get = (role: ColumnRole): string => {
      const i = map[role];
      return i === undefined ? '' : (cells[i] ?? '').trim();
    };
    const when = this.instantFrom(get('date'), map.time === undefined ? '' : get('time'));
    if (when.instant === null) {
      this.reject(this.totalLines, when.error ?? 'unparsable date/time', cells);
      return;
    }
    const dsep = this.decimalSeparator;
    const o = parseNumber(get('open'), { decimalSeparator: dsep });
    const h = parseNumber(get('high'), { decimalSeparator: dsep });
    const l = parseNumber(get('low'), { decimalSeparator: dsep });
    const c = parseNumber(get('close'), { decimalSeparator: dsep });
    if (o === null || h === null || l === null || c === null) {
      this.reject(this.totalLines, 'missing or unparsable OHLC', cells);
      return;
    }
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) {
      this.reject(this.totalLines, 'non-positive price', cells);
      return;
    }
    // A candle whose high is below its open/close (or low above) is corrupt. It is
    // reported, never repaired.
    if (h < Math.max(o, c) - 1e-12 || l > Math.min(o, c) + 1e-12) {
      this.ohlcViolations++;
      this.reject(this.totalLines, 'inconsistent OHLC (high < max(o,c) or low > min(o,c))', cells);
      return;
    }
    const volRaw = get('volume');
    const v = volRaw ? (parseNumber(volRaw, { decimalSeparator: dsep }) ?? 0) : 0;
    if (v > 0) this.volumeSeen = true;
    this.priceDecimals = Math.max(this.priceDecimals, decimalsIn(get('close'), dsep));
    this.rows.push(when.instant, o, h, l, c, v);
  }

  private instantFrom(dateRaw: string, timeRaw: string): {
    instant: number | null;
    error?: string;
  } {
    const dateTok = parseDateToken(dateRaw, this.dayFirst);
    let timeMs: number | null = null;
    if (timeRaw !== '') {
      const tt = parseTimeToken(timeRaw);
      if (tt.ms === null) return { instant: null, error: `unparsable time "${timeRaw}"` };
      timeMs = tt.ms;
      this.timeFormat = this.timeFormat ?? tt.format;
    }
    const res = toInstant(dateTok, timeMs, this.resolver);
    if (res.format && !this.dateFormat) this.dateFormat = `${res.format}${timeMs !== null ? ' + time column' : ''}`;
    return { instant: res.instant, error: res.error };
  }

  private reject(line: number, reason: string, cells: string[]): void {
    this.rejected++;
    if (this.invalid.length < this.maxInvalidReported) {
      this.invalid.push({ line, reason, raw: cells.join(',').slice(0, 180) });
    }
  }

  finish(): MarketBuildResult {
    const src = this.rows;
    const n = src.len;
    const notes = [...this.notes];
    const report: ImportReport = {
      fileName: this.fileName,
      symbol: this.symbol,
      timeframe: this.requestedTf === 'auto' ? '1m' : this.requestedTf,
      nativeTimeframe: 'irregular',
      timezone: this.tz,
      totalLines: this.totalLines,
      dataRows: this.dataRows,
      commentLines: this.commentLines,
      accepted: 0,
      rejected: this.rejected,
      ohlcViolations: this.ohlcViolations,
      duplicates: 0,
      duplicatesKept: 0,
      mergedIntoBuckets: 0,
      unorderedRows: this.unordered,
      gaps: [],
      gapCount: 0,
      missingBars: 0,
      closedSpans: 0,
      firstTime: null,
      lastTime: null,
      minLow: Infinity,
      maxHigh: -Infinity,
      volumeSeen: this.volumeSeen,
      priceDecimals: this.priceDecimals,
      invalid: this.invalid,
      notes,
      durationMs: Date.now() - this.startedAt,
      dateFormat: this.dateFormat,
      timeFormat: this.timeFormat,
      columnMap: { ...(this.map ?? {}) },
      header: this.header ?? [],
    };
    if (this.commentLines > 0) {
      notes.push(`skipped ${this.commentLines.toLocaleString()} comment line(s) starting with #`);
    }
    if (n === 0) {
      notes.push('no usable rows found');
      return { cols: emptyColumns(0), report, finerThanSource: false };
    }

    // --- chronological order ------------------------------------------------
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    let sorted = true;
    for (let i = 1; i < n; i++) {
      if (src.t[i] < src.t[i - 1]) {
        sorted = false;
        break;
      }
    }
    if (!sorted) {
      let unordered = 0;
      for (let i = 1; i < n; i++) if (src.t[i] < src.t[i - 1]) unordered++;
      report.unorderedRows = unordered;
      const times = src.t;
      idx.sort((a, b) => (times[a] < times[b] ? -1 : times[a] > times[b] ? 1 : a - b));
      notes.push(`re-sorted ${unordered.toLocaleString()} out-of-order rows chronologically`);
    }

    const times = new Float64Array(n);
    for (let i = 0; i < n; i++) times[i] = src.t[idx[i]];
    const nativeStep = medianPositiveDelta(times);
    const nativeTf = matchTimeframe(nativeStep);
    report.nativeTimeframe = nativeTf ?? 'irregular';

    const targetTf: TimeframeId = this.requestedTf === 'auto' ? (nativeTf ?? '1m') : this.requestedTf;
    report.timeframe = targetTf;
    const targetMs = timeframe(targetTf).ms ?? 0;
    if (nativeTf === null && nativeStep > 0) {
      notes.push(`irregular row spacing (~${formatSpan(nativeStep)}); rows are aligned to ${targetTf} buckets`);
    }
    const finerThanSource = nativeStep > 0 && targetMs > 0 && targetMs < nativeStep * 0.98;
    if (finerThanSource) {
      notes.push(
        `requested ${targetTf} is finer than the source (~${formatSpan(nativeStep)}); nothing was invented — import a finer dataset to view ${targetTf}`,
      );
    }

    // --- close-timestamped feeds (truefx-style) -----------------------------
    const shift = this.timestampMode === 'close' ? (nativeStep > 0 ? nativeStep : targetMs) : 0;
    if (shift > 0) notes.push(`shifted timestamps by -${formatSpan(shift)} because the source stamps candle close`);

    const tz = this.tz;
    const align = !(nativeTf === targetTf && nativeStep > 0 && Math.abs(nativeStep - targetMs) < targetMs * 0.02);
    const out = emptyColumns(n);
    let w = 0;
    let prevBucket = NaN;
    let folded = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k];
      const t = times[k] - shift;
      const o = src.o[i];
      const h = src.h[i];
      const l = src.l[i];
      const c = src.c[i];
      const v = src.v[i];
      const bucket = align ? floorToTimeframe(t, targetTf, tz) : t;
      if (w > 0 && bucket === prevBucket) {
        const j = w - 1;
        if (align) {
          // Coarser target: aggregate. open stays first, high/low take extremes,
          // close becomes the latest, volume sums.
          if (h > out.h[j]) out.h[j] = h;
          if (l < out.l[j]) out.l[j] = l;
          out.c[j] = c;
          out.v[j] += v;
          out.n[j] += 1;
          folded++;
          continue;
        }
        report.duplicates++;
        if (this.dedupe === 'last') {
          out.o[j] = o;
          out.h[j] = h;
          out.l[j] = l;
          out.c[j] = c;
          out.v[j] = v;
          report.duplicatesKept++;
        } else if (this.dedupe === 'first') {
          report.duplicatesKept++;
        }
        continue;
      }
      out.t[w] = bucket;
      out.o[w] = o;
      out.h[w] = h;
      out.l[w] = l;
      out.c[w] = c;
      out.v[w] = v;
      out.n[w] = 1;
      w++;
      prevBucket = bucket;
    }
    if (folded > 0) {
      notes.push(`folded ${folded.toLocaleString()} source rows into coarser ${targetTf} buckets`);
    }
    report.mergedIntoBuckets = folded;
    if (report.duplicates > 0) {
      notes.push(
        `${report.duplicates.toLocaleString()} duplicate timestamps → policy "${this.dedupe}" (kept ${report.duplicatesKept.toLocaleString()})`,
      );
    }

    const cols: CandleColumns = w === out.len ? out : trimColumns(out, w);
    report.accepted = cols.len;
    if (cols.len === 0) {
      notes.push('nothing left after validation');
      return { cols, report, finerThanSource };
    }
    report.firstTime = cols.t[0];
    report.lastTime = cols.t[cols.len - 1];
    let minLow = Infinity;
    let maxHigh = -Infinity;
    for (let i = 0; i < cols.len; i++) {
      if (cols.l[i] < minLow) minLow = cols.l[i];
      if (cols.h[i] > maxHigh) maxHigh = cols.h[i];
    }
    report.minLow = minLow;
    report.maxHigh = maxHigh;
    report.volumeSeen = this.volumeSeen;
    if (!this.volumeSeen) notes.push('no volume column found — volume kept at 0 rather than guessed');

    // --- discontinuities (reported only) ------------------------------------
    const kind = timeframe(targetTf).kind;
    if (kind === 'intraday' || kind === 'day') {
      const scan = scanGaps(cols, targetMs > 0 ? targetMs : nativeStep, targetTf, tz);
      report.gapCount = scan.gaps.length;
      report.missingBars = scan.missingBars;
      report.closedSpans = scan.closedSpans;
      report.gaps = scan.gaps.slice(0, 200);
      if (scan.gaps.length > 0) {
        notes.push(
          `${scan.gaps.length.toLocaleString()} discontinuities, ~${scan.missingBars.toLocaleString()} bars absent (market-closed spans excluded: ${scan.closedSpans.toLocaleString()}). No bars were fabricated.`,
        );
      }
    }
    report.durationMs = Date.now() - this.startedAt;
    return { cols, report, finerThanSource };
  }
}

function trimColumns(cols: CandleColumns, len: number): CandleColumns {
  return {
    t: cols.t.slice(0, len),
    o: cols.o.slice(0, len),
    h: cols.h.slice(0, len),
    l: cols.l.slice(0, len),
    c: cols.c.slice(0, len),
    v: cols.v.slice(0, len),
    n: cols.n.slice(0, len),
    len,
  };
}

/** Median positive gap between consecutive (already sorted) timestamps. */
export function medianPositiveDelta(t: Float64Array | number[]): number {
  const n = Math.min(t.length, 50_000);
  if (n < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = t[i] - t[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

export function matchTimeframe(stepMs: number): TimeframeId | null {
  if (!Number.isFinite(stepMs) || stepMs <= 0) return null;
  for (const tf of TIMEFRAMES) {
    if (tf.ms && Math.abs(tf.ms - stepMs) <= tf.ms * 0.02) return tf.id;
  }
  return null;
}

export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  const m = ms / 60_000;
  if (m < 60) return `${round(m)} min`;
  const h = m / 60;
  if (h < 24) return `${round(h)} h`;
  const d = h / 24;
  if (d < 31) return `${round(d)} d`;
  return `${round(d / 30.44)} mo`;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

const DAY_MS = 86_400_000;

/**
 * Classify discontinuities between consecutive rows.
 *
 * A hole that contains at least one complete weekday is real missing data; a run
 * that only covers Saturday/Sunday is ordinary market closure and is *not*
 * counted as missing. Nothing here creates candles.
 */
export function scanGaps(
  cols: CandleColumns,
  stepMs: number,
  tf: TimeframeId,
  tz: string,
): { gaps: GapRecord[]; missingBars: number; closedSpans: number } {
  const gaps: GapRecord[] = [];
  let missingBars = 0;
  let closedSpans = 0;
  if (!(stepMs > 0) || cols.len < 2) return { gaps, missingBars, closedSpans };
  const limit = Math.max(stepMs * 0.05, 1000);
  for (let i = 1; i < cols.len; i++) {
    const prev = cols.t[i - 1];
    const cur = cols.t[i];
    const expected = nextBucketStart(prev, tf, tz);
    const delta = cur - expected;
    if (delta <= limit) continue;
    const missing = Math.max(1, Math.round(delta / stepMs));
    if (isMarketClosure(expected, cur, tz)) {
      closedSpans++;
      continue;
    }
    // Short absences are data holes; a long absence that is not weekend closure
    // looks like a holiday or an outage. Both are reported, neither is filled.
    const spanMs = cur - prev;
    gaps.push({ from: prev, to: cur, missingBars: missing, kind: spanMs >= 12 * 3_600_000 ? 'holiday' : 'hole' });
    missingBars += missing;
    if (gaps.length >= 4000) break;
  }
  return { gaps, missingBars, closedSpans };
}

function nextBucketStart(prev: number, tf: TimeframeId, tz: string): number {
  const ms = timeframe(tf).ms;
  if (!ms) return bucketEnd(prev, tf, tz);
  return floorToTimeframe(prev + ms, tf, tz);
}

/** True when the interval [from,to) holds no complete weekday in the chart zone. */
export function isMarketClosure(from: number, to: number, tz: string): boolean {
  if (to - from < 20 * 3_600_000) return false;
  const dayIndex = (t: number): number => {
    const p = zonedParts(t, tz);
    return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
  };
  const a = dayIndex(from);
  const b = dayIndex(to);
  if (b - a > 5) return false;
  for (let d = a + 1; d < b; d++) {
    const wd = new Date(d * DAY_MS).getUTCDay();
    if (wd !== 6 && wd !== 0) return false;
  }
  return true;
}
