/**
 * Timeframe definitions and calendar-correct bucket arithmetic.
 *
 * All bucket math is timezone-aware so 1D/1W/1M candles align to the user's
 * chosen chart timezone (forex convention: UTC or New York anchored days).
 *
 * No function here may invent candles: buckets only describe where a candle
 * *would* start, missing buckets stay missing.
 */

export type TimeframeId =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1H'
  | '2H'
  | '4H'
  | '6H'
  | '8H'
  | '12H'
  | '1D'
  | '1W'
  | '1M';

export type TimeframeKind = 'intraday' | 'day' | 'week' | 'month';

export interface Timeframe {
  id: TimeframeId;
  label: string;
  kind: TimeframeKind;
  /** Duration in ms, exact for intraday/day/week. Undefined for 1M. */
  ms?: number;
  /** Months spanned (1M only). */
  months?: number;
  /** Sort order from finest to coarsest. */
  rank: number;
}

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;

export const TIMEFRAMES: readonly Timeframe[] = [
  { id: '1m', label: '1 minute', kind: 'intraday', ms: 1 * M, rank: 0 },
  { id: '3m', label: '3 minutes', kind: 'intraday', ms: 3 * M, rank: 1 },
  { id: '5m', label: '5 minutes', kind: 'intraday', ms: 5 * M, rank: 2 },
  { id: '15m', label: '15 minutes', kind: 'intraday', ms: 15 * M, rank: 3 },
  { id: '30m', label: '30 minutes', kind: 'intraday', ms: 30 * M, rank: 4 },
  { id: '1H', label: '1 hour', kind: 'intraday', ms: 1 * H, rank: 5 },
  { id: '2H', label: '2 hours', kind: 'intraday', ms: 2 * H, rank: 6 },
  { id: '4H', label: '4 hours', kind: 'intraday', ms: 4 * H, rank: 7 },
  { id: '6H', label: '6 hours', kind: 'intraday', ms: 6 * H, rank: 8 },
  { id: '8H', label: '8 hours', kind: 'intraday', ms: 8 * H, rank: 9 },
  { id: '12H', label: '12 hours', kind: 'intraday', ms: 12 * H, rank: 10 },
  { id: '1D', label: '1 day', kind: 'day', ms: 1 * D, rank: 11 },
  { id: '1W', label: '1 week', kind: 'week', ms: 7 * D, rank: 12 },
  { id: '1M', label: '1 month', kind: 'month', months: 1, rank: 13 },
] as const;

const BY_ID = new Map<TimeframeId, Timeframe>(TIMEFRAMES.map((tf) => [tf.id, tf]));

export function timeframe(id: TimeframeId | string): Timeframe {
  const tf = BY_ID.get(id as TimeframeId);
  if (!tf) throw new Error(`Unknown timeframe: ${String(id)}`);
  return tf;
}

export function isTimeframeId(value: unknown): value is TimeframeId {
  return typeof value === 'string' && BY_ID.has(value as TimeframeId);
}

export function timeframeRank(id: TimeframeId): number {
  return timeframe(id).rank;
}

/** True when `coarse` can be derived from `fine` (same or finer base data). */
export function canAggregate(from: TimeframeId, to: TimeframeId): boolean {
  return timeframeRank(from) <= timeframeRank(to);
}

/** Nominal duration used for scale/spacing heuristics (approximate for 1M). */
export function timeframeMs(id: TimeframeId): number {
  const tf = timeframe(id);
  if (tf.ms !== undefined) return tf.ms;
  return 30 * D; // 1M approximation, only used for pixel heuristics
}

/**
 * A timeframe is "regular" when consecutive buckets are exactly `ms` apart,
 * which makes index<->time arithmetic O(1). Months are not regular.
 */
export function isRegular(id: TimeframeId): boolean {
  return timeframe(id).kind !== 'month';
}
