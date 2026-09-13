/**
 * The knowledge boundary.
 *
 * Replay state is authoritative in *time*, not in bar index: the user knows
 * everything up to `knownUntil`. A chart at any timeframe then derives which of
 * its own bars may be shown — and a bar is only shown when the *whole* bucket is
 * inside the known window. That single rule covers the base timeframe and every
 * aggregation of it:
 *
 *  - at the dataset's native timeframe, a bar is known when its close time ≤ knownUntil;
 *  - at a coarser timeframe, the bar under construction is withheld entirely,
 *    because its high/low/close would otherwise contain bars the user may not know;
 *  - switching timeframe or timezone mid-replay re-derives the cursor from the same
 *    instant, so navigation cannot be used to smuggle future rows into view.
 */

import type { CandleSeries } from '../data/series.ts';
import { timeframe, type TimeframeId } from '../time/timeframes.ts';
import { bucketEnd } from '../time/tz.ts';

/** End (exclusive) of the time span a bar represents. */
export function barEndMs(series: CandleSeries, i: number): number {
  const t = series.time(i);
  if (Number.isNaN(t)) return NaN;
  if (series.stepMs !== undefined) return t + series.stepMs;
  const tf = series.tf as TimeframeId;
  const end = bucketEnd(t, tf, series.tz);
  if (Number.isFinite(end) && end > t) return end;
  const fallback = timeframe(tf).ms;
  return fallback ? t + fallback : t + 1;
}

/**
 * Sentinel meaning "the replay has reached the end of the dataset": every bar is
 * known. Kept finite and JSON-safe so a session file can store it.
 */
export const ALL_KNOWN = Number.MAX_SAFE_INTEGER;

export function isAllKnown(knownUntil: number | null | undefined): boolean {
  return knownUntil === null || knownUntil === undefined || knownUntil >= ALL_KNOWN - 1;
}

/** True when every base row inside bar `i` is at or before `knownUntil`. */
export function isBarKnown(series: CandleSeries, i: number, knownUntil: number): boolean {
  if (i < 0 || i >= series.total) return false;
  if (isAllKnown(knownUntil)) return true;
  const end = barEndMs(series, i);
  return Number.isFinite(end) && end - 1 <= knownUntil;
}

/**
 * Newest index fully inside the known window. -1 when even the first bar is not
 * known yet (the chart then shows the axis only).
 */
export function cursorForKnownUntil(series: CandleSeries, knownUntil: number | null): number {
  const n = series.total;
  if (n === 0) return -1;
  if (isAllKnown(knownUntil)) return n - 1;
  if (!isBarKnown(series, 0, knownUntil as number)) return -1;
  // `isBarKnown` is monotone in i, so a binary search finds the boundary.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (isBarKnown(series, mid, knownUntil as number)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The boundary implied by having revealed through bar `cursor`: everything before
 * the end of that bar is known. Reaching the dataset's last bar means everything is.
 */
export function knownUntilForCursor(series: CandleSeries, cursor: number): number {
  if (!series || series.total === 0) return ALL_KNOWN;
  const i = Math.max(0, Math.min(series.total - 1, cursor));
  if (i >= series.total - 1) return ALL_KNOWN;
  const end = barEndMs(series, i);
  return Number.isFinite(end) ? end - 1 : (series.time(i) ?? ALL_KNOWN);
}

