/**
 * Pre-release context: session, clustering/isolation, pre-news trend and
 * volatility regime. Every calculation reads bars strictly *before* the release
 * instant through a `CandleSeries` that the caller has already gated, so a
 * future bar is unreachable even if the caller forgets to clip (the series
 * accessors return NaN/null past their limit).
 */

import type { CandleSeries } from '../data/series.ts';
import { floorToDay, zonedParts } from '../time/tz.ts';
import { priceToPips } from '../util/pips.ts';
import {
  type EconEvent,
  type Isolation,
  type Maybe,
  type Session,
  type Trend,
  type VolRegime,
  IMPACT_WEIGHT,
  MINUTE,
  ok,
  unavailable,
} from './types.ts';
import type { EventIndex } from './surprise.ts';

/* ------------------------------------------------------------------ session */

/**
 * Sessions are defined on local exchange clocks so DST is honoured:
 *  Asia    08:00–17:00 Tokyo (covers Sydney/Tokyo/Singapore business hours)
 *  London  08:00–17:00 London
 *  NY      08:00–17:00 New York
 *  Overlap = both London and New York open.
 */
export function classifySession(t: number): Session {
  const ny = zonedParts(t, 'America/New_York');
  const ldn = zonedParts(t, 'Europe/London');
  const tky = zonedParts(t, 'Asia/Tokyo');
  const nyOpen = ny.hour >= 8 && ny.hour < 17;
  const ldnOpen = ldn.hour >= 8 && ldn.hour < 17;
  const tkyOpen = tky.hour >= 7 && tky.hour < 17;
  if (nyOpen && ldnOpen) return 'overlap';
  if (nyOpen) return 'newYork';
  if (ldnOpen) return 'london';
  if (tkyOpen) return 'asia';
  return 'off';
}

/* ------------------------------------------------------------------ clusters */

export interface ClusterInfo {
  isolation: Isolation;
  /** Other events inside ±windowMin (ids). */
  neighbours: string[];
  /** Neighbours that are at least "high" calendar impact — attribution warning. */
  highImpactNeighbours: string[];
  /** Same-instant releases (e.g. NFP + Unemployment + AHE). */
  simultaneous: string[];
  ambiguous: boolean;
  windowMin: number;
}

export function clusterFor(event: EconEvent, index: EventIndex, windowMin = 30, sameCurrencyOnly = false): ClusterInfo {
  const w = windowMin * MINUTE;
  const around = index.between(event.time - w, event.time + w);
  const neighbours: string[] = [];
  const high: string[] = [];
  const simultaneous: string[] = [];
  for (const e of around) {
    if (e.id === event.id) continue;
    if (sameCurrencyOnly && e.currency !== event.currency) continue;
    neighbours.push(e.id);
    if (e.time === event.time) simultaneous.push(e.id);
    if (e.impact && IMPACT_WEIGHT[e.impact] >= IMPACT_WEIGHT.high) high.push(e.id);
  }
  const isolation: Isolation = neighbours.length === 0 ? 'isolated' : simultaneous.length > 0 ? 'overlapping' : 'clustered';
  return { isolation, neighbours, highImpactNeighbours: high, simultaneous, ambiguous: high.length > 0, windowMin };
}

/* ------------------------------------------------------------ pre-news context */

export interface PreNewsContext {
  /** Close of the last bar that ended at or before the release. */
  refPrice: Maybe<number>;
  refTime: number | null;
  change30m: Maybe<number>; // pips
  change1h: Maybe<number>;
  change4h: Maybe<number>;
  /** ATR-style mean true range of the last `atrBars` bars before release, in pips. */
  atrPips: Maybe<number>;
  /** Realised volatility (stdev of 1-bar returns) over the pre-window, in pips. */
  preVolPips: Maybe<number>;
  trend: Trend;
  distDayHigh: Maybe<number>; // pips, ≥0
  distDayLow: Maybe<number>;
  distPrevDayHigh: Maybe<number>;
  distPrevDayLow: Maybe<number>;
  regime: Maybe<VolRegime>;
  /** Percentile of atr among the long-run pre-window distribution (0..1). */
  regimePercentile: number | null;
}

export interface ContextConfig {
  atrBars: number;
  /** Trend lookback in bars. */
  trendBars: number;
  /** Trend requires |move| ≥ trendAtrMultiple × ATR to be called bullish/bearish. */
  trendAtrMultiple: number;
  regimeMode: 'percentile' | 'atr';
  /** Percentile boundaries for low/normal/high. */
  regimePercentiles: { low: number; high: number };
  /** Absolute ATR thresholds (pips) when regimeMode === 'atr'. */
  regimeAtrPips: { low: number; high: number };
  /** Bars sampled (ending before release) to form the long-run ATR distribution. */
  regimeLookbackBars: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  atrBars: 14,
  trendBars: 60,
  trendAtrMultiple: 1.5,
  regimeMode: 'percentile',
  regimePercentiles: { low: 0.33, high: 0.67 },
  regimeAtrPips: { low: 1.5, high: 4 },
  regimeLookbackBars: 2000,
};

/** Index of the last bar whose *close* is at or before `t` (i.e. bar fully formed before t). */
export function lastClosedBarBefore(series: CandleSeries, t: number): number {
  const step = series.stepMs ?? 0;
  // bar i is closed at t when time(i) + step <= t
  const i = series.upper(t - step) - 1;
  return i >= 0 && i < series.count ? i : -1;
}

export function atrPipsAt(series: CandleSeries, endIdx: number, bars: number, decimals: number): number | null {
  if (endIdx < 1 || bars < 1) return null;
  const from = Math.max(1, endIdx - bars + 1);
  const { h, l, c } = series.cols;
  let sum = 0;
  let n = 0;
  for (let i = from; i <= endIdx; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    sum += tr;
    n++;
  }
  if (n < Math.min(bars, 3)) return null;
  return priceToPips(sum / n, decimals);
}

export function quoteDecimals(series: CandleSeries): number {
  // Sample a few closes to infer precision (EURUSD → 5, USDJPY → 3).
  const n = Math.min(series.count, 50);
  let best = 0;
  for (let i = 0; i < n; i++) {
    const s = series.cols.c[i].toString();
    const d = s.includes('.') ? s.split('.')[1].length : 0;
    if (d > best) best = d;
  }
  return best === 0 ? 5 : Math.min(best, 5) < 3 ? 3 : Math.min(best, 5);
}

function pctRank(sorted: Float64Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length ? lo / sorted.length : 0;
}

/**
 * Long-run ATR sample for percentile regimes. Cached per (series identity, endIdx bucket)
 * by the caller if needed; it is O(lookback) per call.
 */
export function atrDistribution(series: CandleSeries, endIdx: number, cfg: ContextConfig, decimals: number): Float64Array {
  const stride = Math.max(1, cfg.atrBars);
  const out: number[] = [];
  const start = Math.max(cfg.atrBars, endIdx - cfg.regimeLookbackBars);
  for (let i = start; i <= endIdx; i += stride) {
    const a = atrPipsAt(series, i, cfg.atrBars, decimals);
    if (a !== null) out.push(a);
  }
  return Float64Array.from(out).sort();
}

export function preNewsContext(
  series: CandleSeries | null,
  releaseTime: number,
  cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG,
  tz = 'UTC',
): PreNewsContext {
  const u = (r: string) => unavailable(r);
  const empty: PreNewsContext = {
    refPrice: u('no price data'),
    refTime: null,
    change30m: u('no price data'),
    change1h: u('no price data'),
    change4h: u('no price data'),
    atrPips: u('no price data'),
    preVolPips: u('no price data'),
    trend: 'unknown',
    distDayHigh: u('no price data'),
    distDayLow: u('no price data'),
    distPrevDayHigh: u('no price data'),
    distPrevDayLow: u('no price data'),
    regime: u('no price data'),
    regimePercentile: null,
  };
  if (!series || series.count === 0) return empty;
  const decimals = quoteDecimals(series);
  const ref = lastClosedBarBefore(series, releaseTime);
  if (ref < 0) return { ...empty, refPrice: u('release precedes price history') };
  const step = series.stepMs ?? MINUTE;
  const refTime = series.time(ref);
  if (releaseTime - (refTime + step) > 3 * 86_400_000) {
    return { ...empty, refPrice: u('price history ends more than 3 days before release') };
  }
  const refPrice = series.cols.c[ref];
  const changeOver = (ms: number): Maybe<number> => {
    const j = lastClosedBarBefore(series, releaseTime - ms);
    if (j < 0) return u('insufficient pre-release history');
    return ok(priceToPips(refPrice - series.cols.c[j], decimals));
  };
  const atr = atrPipsAt(series, ref, cfg.atrBars, decimals);
  // realised vol of close-to-close over trendBars
  let preVol: Maybe<number> = u('insufficient history');
  const vFrom = Math.max(1, ref - cfg.trendBars + 1);
  if (ref - vFrom >= 5) {
    const diffs: number[] = [];
    for (let i = vFrom; i <= ref; i++) diffs.push(series.cols.c[i] - series.cols.c[i - 1]);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    let ss = 0;
    for (const d of diffs) ss += (d - mean) ** 2;
    preVol = ok(priceToPips(Math.sqrt(ss / (diffs.length - 1)), decimals));
  }
  // trend
  let trend: Trend = 'unknown';
  const tFrom = ref - cfg.trendBars;
  if (tFrom >= 0 && atr !== null && atr > 0) {
    const move = priceToPips(refPrice - series.cols.c[tFrom], decimals);
    const thr = cfg.trendAtrMultiple * atr;
    trend = move > thr ? 'bullish' : move < -thr ? 'bearish' : 'range';
  }
  // day / previous-day extremes (bars strictly before release)
  const dayStart = floorToDay(releaseTime, tz);
  const range = (from: number, to: number): { hi: number; lo: number } | null => {
    const a = series.lower(from);
    const b = Math.min(ref + 1, series.upper(to - 1));
    if (b <= a) return null;
    const bnd = series.bounds(a, b);
    return { hi: bnd.max, lo: bnd.min };
  };
  const today = range(dayStart, releaseTime);
  const prev = range(dayStart - 86_400_000, dayStart);
  const dist = (x: number | undefined, sign: 1 | -1): Maybe<number> =>
    x === undefined ? u('no bars in window') : ok(priceToPips(sign * (x - refPrice), decimals));
  // regime
  let regime: Maybe<VolRegime> = u('atr unavailable');
  let pct: number | null = null;
  if (atr !== null) {
    if (cfg.regimeMode === 'atr') {
      regime = ok(atr < cfg.regimeAtrPips.low ? 'low' : atr > cfg.regimeAtrPips.high ? 'high' : 'normal');
    } else {
      const dist = atrDistribution(series, ref, cfg, decimals);
      if (dist.length < 20) regime = u(`insufficient history for percentile regime (${dist.length} samples)`);
      else {
        pct = pctRank(dist, atr);
        regime = ok(pct < cfg.regimePercentiles.low ? 'low' : pct > cfg.regimePercentiles.high ? 'high' : 'normal');
      }
    }
  }
  return {
    refPrice: ok(refPrice),
    refTime,
    change30m: changeOver(30 * MINUTE),
    change1h: changeOver(60 * MINUTE),
    change4h: changeOver(240 * MINUTE),
    atrPips: atr === null ? u('insufficient bars for ATR') : ok(atr),
    preVolPips: preVol,
    trend,
    distDayHigh: dist(today?.hi, 1),
    distDayLow: dist(today?.lo, -1),
    distPrevDayHigh: dist(prev?.hi, 1),
    distPrevDayLow: dist(prev?.lo, -1),
    regime,
    regimePercentile: pct,
  };
}
