/**
 * Columnar, typed-array candle storage.
 *
 * Design goals:
 *  - Years of 1-minute data must live *outside* React state and be cheap to scan.
 *  - Zero-copy slicing: every read returns subarray views over the owning buffers.
 *  - Immutable once built; nothing here may fabricate a candle.
 */

import type { TimeframeId } from '../time/timeframes.ts';

export interface CandleColumns {
  /** Candle open time, epoch ms UTC, strictly ascending. */
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  /** Tick volume; 0-filled when the source has no volume column. */
  v: Float64Array;
  /** Number of base candles folded into each row (1 for untouched source rows). */
  n: Uint32Array;
  /** Populated length. Backing arrays may be longer (spare capacity). */
  len: number;
}

export interface SeriesMeta {
  symbol: string;
  tf: TimeframeId;
  /** Timezone the buckets are anchored to. */
  tz: string;
  /** Nominal spacing in ms (regular intraday/day/week series only). */
  stepMs?: number;
  /** True when `v` carries real volume rather than zeros. */
  hasVolume: boolean;
  /** Id of the stored dataset this series was parsed from. */
  datasetId?: string;
}

export function emptyColumns(capacity = 0): CandleColumns {
  return {
    t: new Float64Array(capacity),
    o: new Float64Array(capacity),
    h: new Float64Array(capacity),
    l: new Float64Array(capacity),
    c: new Float64Array(capacity),
    v: new Float64Array(capacity),
    n: new Uint32Array(capacity),
    len: capacity,
  };
}

export function sliceColumns(cols: CandleColumns, from: number, to: number): CandleColumns {
  const a = Math.max(0, Math.min(from, cols.len));
  const b = Math.max(a, Math.min(to, cols.len));
  return {
    t: cols.t.subarray(a, b),
    o: cols.o.subarray(a, b),
    h: cols.h.subarray(a, b),
    l: cols.l.subarray(a, b),
    c: cols.c.subarray(a, b),
    v: cols.v.subarray(a, b),
    n: cols.n.subarray(a, b),
    len: b - a,
  };
}

/** First index whose time is >= `time`. Returns cols.len when none qualifies. */
export function lowerBound(cols: CandleColumns, time: number, limit = cols.len): number {
  let lo = 0;
  let hi = Math.min(limit, cols.len);
  const t = cols.t;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose time is > `time`. */
export function upperBound(cols: CandleColumns, time: number, limit = cols.len): number {
  let lo = 0;
  let hi = Math.min(limit, cols.len);
  const t = cols.t;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the candle covering `time` (t[i] <= time < t[i]+step), or -1. */
export function indexAtTime(
  cols: CandleColumns,
  time: number,
  stepMs: number | undefined,
  limit = cols.len,
): number {
  if (stepMs && stepMs > 0) {
    const i = lowerBound(cols, time - stepMs + 1, limit);
    if (i < limit && cols.t[i] <= time) {
      const end = cols.t[i] + stepMs;
      if (time < end) return i;
    }
    return -1;
  }
  const i = upperBound(cols, time, limit);
  if (i === 0) return -1;
  return i - 1;
}

/** Aggregate OHLC of `cols[from..to)` into a single candle. */
export function foldRange(
  cols: CandleColumns,
  from: number,
  to: number,
): { o: number; h: number; l: number; c: number; v: number; n: number } | null {
  if (to <= from) return null;
  const { o, h, l, c, v, n } = cols;
  let hi = -Infinity;
  let lo = Infinity;
  let vol = 0;
  let cnt = 0;
  for (let i = from; i < to; i++) {
    if (h[i] > hi) hi = h[i];
    if (l[i] < lo) lo = l[i];
    vol += v[i];
    cnt += n[i] || 1;
  }
  return { o: o[from], h: hi, l: lo, c: c[to - 1], v: vol, n: cnt };
}

export interface PriceBounds {
  min: number;
  max: number;
}

export function priceBounds(cols: CandleColumns, from: number, to: number): PriceBounds {
  let min = Infinity;
  let max = -Infinity;
  const { h, l } = cols;
  const a = Math.max(0, from);
  const b = Math.min(cols.len, to);
  for (let i = a; i < b; i++) {
    if (l[i] < min) min = l[i];
    if (h[i] > max) max = h[i];
  }
  if (min > max) return { min: 0, max: 1 };
  return { min, max };
}
