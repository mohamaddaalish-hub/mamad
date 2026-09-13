/**
 * Candle series: columnar storage + O(1)/O(log n) indexing + an explicit
 * replay limit that makes future data structurally unreachable.
 *
 * `limit` is the exclusive upper index bound of candles that *exist yet* from
 * the perspective of the current replay cursor. Every accessor honours it and
 * every render/analytics path goes through these accessors, so a leak would
 * require deliberately reading `cols` directly — which the codebase avoids.
 */

import {
  emptyColumns,
  foldRange,
  indexAtTime,
  lowerBound,
  priceBounds,
  sliceColumns,
  upperBound,
  type CandleColumns,
  type PriceBounds,
} from './types.ts';
import { isRegular, timeframe, type TimeframeId } from '../time/timeframes.ts';
import { bucketEnd, floorToTimeframe } from '../time/tz.ts';

export class CandleSeries {
  readonly symbol: string;
  readonly tf: TimeframeId;
  readonly tz: string;
  readonly hasVolume: boolean;
  readonly datasetId?: string;
  readonly cols: CandleColumns;
  readonly stepMs: number | undefined;
  /** Replay barrier (exclusive). Equals total when not replaying. */
  private _limit: number;

  constructor(init: {
    symbol: string;
    tf: TimeframeId;
    tz?: string;
    cols: CandleColumns;
    hasVolume?: boolean;
    datasetId?: string;
    limit?: number;
  }) {
    this.symbol = init.symbol.toUpperCase();
    this.tf = init.tf;
    this.tz = init.tz ?? 'UTC';
    this.cols = init.cols;
    this.hasVolume = init.hasVolume ?? true;
    this.datasetId = init.datasetId;
    this._limit = Math.max(0, Math.min(init.limit ?? init.cols.len, init.cols.len));
    this.stepMs = isRegular(init.tf) ? timeframe(init.tf).ms : undefined;
  }

  get total(): number {
    return this.cols.len;
  }
  get count(): number {
    return this._limit;
  }
  get limit(): number {
    return this._limit;
  }
  get regular(): boolean {
    return this.stepMs !== undefined;
  }

  firstTime(): number | null {
    return this.cols.len > 0 ? this.cols.t[0] : null;
  }
  lastTime(): number | null {
    return this._limit > 0 ? this.cols.t[this._limit - 1] : null;
  }
  /** Last time in the underlying dataset (used by navigation, never by replay views). */
  lastAvailableTime(): number | null {
    return this.cols.len > 0 ? this.cols.t[this.cols.len - 1] : null;
  }

  /** Time of bar `i`. Out-of-range reads — including bars beyond the replay
   * barrier — return NaN rather than leaking a future timestamp. */
  time(i: number): number {
    if (i < 0 || i >= this._limit) return NaN;
    return this.cols.t[i];
  }
  candle(i: number): { t: number; o: number; h: number; l: number; c: number; v: number; n: number } | null {
    if (i < 0 || i >= this._limit) return null;
    const { t, o, h, l, c, v, n } = this.cols;
    return { t: t[i], o: o[i], h: h[i], l: l[i], c: c[i], v: v[i], n: n[i] };
  }

  /** View over [from,to) clamped to the replay barrier. */
  range(from: number, to: number): CandleColumns {
    const a = Math.max(0, Math.min(from, this._limit));
    const b = Math.max(a, Math.min(to, this._limit));
    return sliceColumns(this.cols, a, b);
  }

  indexFor(time: number): number {
    return indexAtTime(this.cols, time, this.stepMs, this._limit);
  }
  lower(time: number): number {
    return lowerBound(this.cols, time, this._limit);
  }
  upper(time: number): number {
    return upperBound(this.cols, time, this._limit);
  }

  bounds(from: number, to: number): PriceBounds {
    return priceBounds(this.cols, from, Math.min(to, this._limit));
  }

  /** Index of the candle whose bucket contains `time`, or the previous one. */
  indexAtOrBefore(time: number): number {
    const i = this.indexFor(time);
    if (i >= 0) return i;
    const j = upperBound(this.cols, time, this._limit);
    return j === 0 ? -1 : j - 1;
  }

  fold(from: number, to: number) {
    const clamped = sliceColumns(this.cols, Math.max(0, from), Math.min(to, this._limit));
    return foldRange(clamped, 0, clamped.len);
  }

  /** Series with a different replay barrier. Cheap: shares buffers. */
  withLimit(limit: number): CandleSeries {
    const clamped = Math.max(0, Math.min(limit, this.cols.len));
    if (clamped === this._limit) return this;
    return new CandleSeries({
      symbol: this.symbol,
      tf: this.tf,
      tz: this.tz,
      cols: this.cols,
      hasVolume: this.hasVolume,
      datasetId: this.datasetId,
      limit: clamped,
    });
  }

  /** Full-dataset view — only for import diagnostics, never for chart/analytics. */
  underlying(): CandleColumns {
    return this.cols;
  }
}

export function seriesFromArrays(
  t: number[],
  o: number[],
  h: number[],
  l: number[],
  c: number[],
  v: number[] | undefined,
  meta: { symbol: string; tf: TimeframeId; tz?: string; datasetId?: string },
): CandleSeries {
  const len = t.length;
  const cols = emptyColumns(len);
  for (let i = 0; i < len; i++) {
    cols.t[i] = t[i];
    cols.o[i] = o[i];
    cols.h[i] = h[i];
    cols.l[i] = l[i];
    cols.c[i] = c[i];
    cols.v[i] = v ? v[i] : 0;
    cols.n[i] = 1;
  }
  return new CandleSeries({
    symbol: meta.symbol,
    tf: meta.tf,
    tz: meta.tz,
    cols,
    hasVolume: Boolean(v),
    datasetId: meta.datasetId,
  });
}

/**
 * Aggregate a base (finer) series into `target`.
 *
 * Rules: open = first open, high = max high, low = min low, close = last close,
 * volume = sum, n = sum of constituent counts. Buckets with no constituent rows
 * are skipped (missing data is reported by the importer, never invented here).
 * Because buckets are aligned to `target` boundaries and each base candle can
 * only ever land in its own bucket, the result cannot contain look-ahead.
 */
export function aggregateSeries(base: CandleSeries, target: TimeframeId, tz = base.tz): CandleSeries {
  if (target === base.tf && tz === base.tz) return base;
  const src = base.cols;
  // Respect the replay barrier: aggregate the *allowed* rows only.
  const n = Math.min(base.count, src.len);
  if (n === 0) {
    return new CandleSeries({ symbol: base.symbol, tf: target, tz, cols: emptyColumns(0) });
  }
  const capacity = Math.max(16, Math.ceil(n / bucketRatio(base.tf, target)) + 2);
  const out = emptyColumns(capacity);
  const tf = timeframe(target);
  let w = 0;
  let i = 0;
  while (i < n) {
    const start = floorToTimeframe(src.t[i], target, tz);
    let end = bucketEnd(start, target, tz);
    if (end <= start) end = start + (tf.ms ?? 1);
    let o = NaN;
    let hi = -Infinity;
    let lo = Infinity;
    let c = NaN;
    let vol = 0;
    let cnt = 0;
    let j = i;
    while (j < n && src.t[j] < end) {
      if (Number.isNaN(o)) o = src.o[j];
      if (src.h[j] > hi) hi = src.h[j];
      if (src.l[j] < lo) lo = src.l[j];
      c = src.c[j];
      vol += src.v[j];
      cnt += src.n[j] || 1;
      j++;
    }
    if (!Number.isNaN(o) && Number.isFinite(hi) && Number.isFinite(lo) && w < capacity) {
      out.t[w] = start;
      out.o[w] = o;
      out.h[w] = hi;
      out.l[w] = lo;
      out.c[w] = c;
      out.v[w] = vol;
      out.n[w] = cnt;
      w++;
    }
    i = j;
  }
  return new CandleSeries({
    symbol: base.symbol,
    tf: target,
    tz,
    cols: out.len === w ? out : sliceColumns(out, 0, w),
    hasVolume: base.hasVolume,
    datasetId: base.datasetId,
  });
}

function bucketRatio(fine: TimeframeId, coarse: TimeframeId): number {
  const a = timeframe(fine).ms ?? 30 * 86_400_000;
  const b = timeframe(coarse).ms ?? 30 * 86_400_000;
  return Math.max(1, Math.round(b / a));
}

/** End time of a candle, honouring calendar month lengths. */
export function candleEndTime(series: CandleSeries, i: number): number {
  if (series.stepMs) return series.cols.t[i] + series.stepMs;
  return bucketEnd(series.cols.t[i], series.tf, series.tz);
}
