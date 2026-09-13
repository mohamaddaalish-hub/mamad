/**
 * Reaction engine: how price moved around a release.
 *
 * Reference price = close of the last bar fully formed before the release.
 * A horizon +H is the close of the last bar formed at or before release+H.
 * MFE / MAE over a horizon use bar highs/lows in (release, release+H].
 *
 * Look-ahead contract: the caller passes a `CandleSeries` whose limit is the
 * replay barrier. Any horizon whose end lies beyond the last known bar is
 * UNAVAILABLE, never approximated with the bars that happen to exist.
 */

import type { CandleSeries } from '../data/series.ts';
import { priceToPips } from '../util/pips.ts';
import { atrPipsAt, lastClosedBarBefore, quoteDecimals } from './context.ts';
import {
  MINUTE,
  POST_HORIZONS_MIN,
  PRE_HORIZONS_MIN,
  type Maybe,
  type ReactionPattern,
  ok,
  unavailable,
} from './types.ts';

export interface HorizonReaction {
  minutes: number;
  /** Close-to-reference change, pips (positive = quote up). */
  pips: Maybe<number>;
  pct: Maybe<number>;
  price: Maybe<number>;
  /** Max favourable excursion for a *long*, pips (≥0). Callers flip for shorts. */
  mfeUp: Maybe<number>;
  /** Max excursion downwards, pips (≥0). */
  mfeDown: Maybe<number>;
  /** ATR(atrBars) ending at the horizon vs pre-release ATR, as a ratio. */
  volRatio: Maybe<number>;
}

export interface ReactionConfig {
  atrBars: number;
  /** |move| below this many pips at +5m/+15m counts as "no reaction". */
  noReactionPips: number;
  /** Fraction of the peak move given back by +1H that counts as a fade. */
  fadeFraction: number;
  /** Minimum peak-to-now retracement to call it a reversal. */
  reversalFraction: number;
}

export const DEFAULT_REACTION_CONFIG: ReactionConfig = {
  atrBars: 14,
  noReactionPips: 3,
  fadeFraction: 0.6,
  reversalFraction: 1.0,
};

export interface ReactionResult {
  refPrice: Maybe<number>;
  refIndex: number;
  decimals: number;
  pre: HorizonReaction[];
  post: HorizonReaction[];
  /** First-minute move, pips. */
  initialMove: Maybe<number>;
  /** Largest absolute close-based move over the post window (signed). */
  peakMove: Maybe<number>;
  peakTime: number | null;
  timeToPeakMin: number | null;
  /** Minutes until |move| stays below noReactionPips for ≥ 5 consecutive bars, ≤ 1D. */
  impactDurationMin: Maybe<number>;
  returnToPreMin: Maybe<number>;
  pattern: ReactionPattern;
  /** Normalised curve at CURVE horizons (pips), used for comparisons. */
  curve: (number | null)[];
  curveHorizons: number[];
}

function horizonEndIdx(series: CandleSeries, ref: number, endTime: number): number {
  const j = lastClosedBarBefore(series, endTime + 1e-6); // bars closed at or before endTime
  return j > ref ? j : -1;
}

export function computeReaction(
  series: CandleSeries | null,
  releaseTime: number,
  cfg: ReactionConfig = DEFAULT_REACTION_CONFIG,
  curveHorizons: readonly number[] = [-30, -15, -5, 0, 1, 5, 15, 30, 60, 240, 1440],
): ReactionResult {
  const u = (r: string) => unavailable(r);
  const mk = (m: number, r: string): HorizonReaction => ({ minutes: m, pips: u(r), pct: u(r), price: u(r), mfeUp: u(r), mfeDown: u(r), volRatio: u(r) });
  const nothing = (reason: string): ReactionResult => ({
    refPrice: u(reason),
    refIndex: -1,
    decimals: 5,
    pre: PRE_HORIZONS_MIN.map((m) => mk(m, reason)),
    post: POST_HORIZONS_MIN.map((m) => mk(m, reason)),
    initialMove: u(reason),
    peakMove: u(reason),
    peakTime: null,
    timeToPeakMin: null,
    impactDurationMin: u(reason),
    returnToPreMin: u(reason),
    pattern: 'unavailable',
    curve: curveHorizons.map(() => null),
    curveHorizons: [...curveHorizons],
  });
  if (!series || series.count === 0) return nothing('no price data');
  const step = series.stepMs ?? MINUTE;
  const ref = lastClosedBarBefore(series, releaseTime);
  if (ref < 0) return nothing('release precedes price history');
  if (releaseTime - (series.time(ref) + step) > 3 * 86_400_000) return nothing('no price bars near release');
  const decimals = quoteDecimals(series);
  const refPrice = series.cols.c[ref];
  const preAtr = atrPipsAt(series, ref, cfg.atrBars, decimals);
  const lastKnownEnd = series.time(series.count - 1) + step;
  const { h, l, c } = series.cols;

  const pre = PRE_HORIZONS_MIN.map((m): HorizonReaction => {
    const j = lastClosedBarBefore(series, releaseTime + m * MINUTE);
    if (j < 0) return mk(m, 'insufficient pre-release history');
    const d = refPrice - c[j];
    return { minutes: m, pips: ok(priceToPips(d, decimals)), pct: ok((d / c[j]) * 100), price: ok(c[j]), mfeUp: u('n/a'), mfeDown: u('n/a'), volRatio: u('n/a') };
  });

  const post = POST_HORIZONS_MIN.map((m): HorizonReaction => {
    const end = releaseTime + m * MINUTE;
    if (end > lastKnownEnd) return mk(m, 'horizon not yet known');
    const j = horizonEndIdx(series, ref, end);
    if (j < 0) return mk(m, 'no bars in horizon');
    // Guard: bars must actually cover the horizon (gap tolerance: 1 step short).
    if (series.time(j) + step < end - step * 2 && m <= 60) return mk(m, 'missing bars in horizon');
    const d = c[j] - refPrice;
    let up = 0;
    let down = 0;
    for (let i = ref + 1; i <= j; i++) {
      if (h[i] - refPrice > up) up = h[i] - refPrice;
      if (refPrice - l[i] > down) down = refPrice - l[i];
    }
    const postAtr = atrPipsAt(series, j, Math.min(cfg.atrBars, j - ref), decimals);
    return {
      minutes: m,
      pips: ok(priceToPips(d, decimals)),
      pct: ok((d / refPrice) * 100),
      price: ok(c[j]),
      mfeUp: ok(priceToPips(up, decimals)),
      mfeDown: ok(priceToPips(down, decimals)),
      volRatio: preAtr && postAtr !== null && preAtr > 0 ? ok(postAtr / preAtr) : u('atr unavailable'),
    };
  });

  // Peak / duration scan over the known part of the 1D window.
  const dayEnd = Math.min(releaseTime + 1440 * MINUTE, lastKnownEnd);
  const lastIdx = horizonEndIdx(series, ref, dayEnd);
  let peak = 0;
  let peakIdx = -1;
  let impactEnd: number | null = null;
  let quiet = 0;
  let returnIdx = -1;
  const thr = cfg.noReactionPips;
  if (lastIdx > ref) {
    let crossed = false;
    for (let i = ref + 1; i <= lastIdx; i++) {
      const mv = priceToPips(c[i] - refPrice, decimals);
      if (Math.abs(mv) > Math.abs(peak)) {
        peak = mv;
        peakIdx = i;
      }
      if (Math.abs(mv) > thr) crossed = true;
      if (Math.abs(mv) <= thr) {
        quiet++;
        if (quiet >= 5 && impactEnd === null && crossed) impactEnd = i - 4;
      } else quiet = 0;
      if (returnIdx < 0 && crossed && peakIdx >= 0 && i > peakIdx && Math.sign(mv) !== Math.sign(peak)) returnIdx = i;
    }
  }
  const knownFull = releaseTime + 1440 * MINUTE <= lastKnownEnd;
  const m1 = post[0];
  const m5 = post[1];
  const m15 = post[2];
  const m60 = post[4];
  const val = (x: HorizonReaction): number | null => (x.pips.status === 'ok' ? x.pips.value : null);
  let pattern: ReactionPattern = 'unavailable';
  const v5 = val(m5);
  const v15 = val(m15);
  const v60 = val(m60);
  if (v5 !== null && v15 !== null) {
    if (peakIdx < 0 || Math.abs(peak) < thr) pattern = 'noReaction';
    else if (Math.abs(v5) < thr && Math.abs(v15) < thr && Math.abs(peak) >= 2 * thr) pattern = 'delayed';
    else if (v60 !== null) {
      const initialSign = Math.sign(v5 !== 0 ? v5 : v15);
      const p60 = v60;
      if (Math.sign(p60) === initialSign && Math.abs(p60) >= Math.abs(v15)) pattern = 'continuation';
      else if (Math.sign(p60) !== initialSign && Math.abs(p60) >= cfg.reversalFraction * thr) pattern = 'reversal';
      else if (Math.abs(peak) > thr && Math.abs(p60) <= (1 - cfg.fadeFraction) * Math.abs(peak)) pattern = 'spikeFade';
      else pattern = 'continuation';
    } else pattern = Math.sign(v15) === Math.sign(v5) && Math.abs(v15) >= Math.abs(v5) ? 'continuation' : 'spikeFade';
  }
  const curve = curveHorizons.map((m) => {
    if (m === 0) return 0;
    const list = m < 0 ? pre : post;
    const hit = list.find((x) => x.minutes === m);
    return hit && hit.pips.status === 'ok' ? (m < 0 ? -hit.pips.value : hit.pips.value) : null;
  });
  return {
    refPrice: ok(refPrice),
    refIndex: ref,
    decimals,
    pre,
    post,
    initialMove: m1.pips,
    peakMove: peakIdx >= 0 ? ok(peak) : u(lastIdx > ref ? 'no move' : 'post-release bars not yet known'),
    peakTime: peakIdx >= 0 ? series.time(peakIdx) + step : null,
    timeToPeakMin: peakIdx >= 0 ? Math.round((series.time(peakIdx) + step - releaseTime) / MINUTE) : null,
    impactDurationMin:
      impactEnd !== null ? ok(Math.round((series.time(impactEnd) + step - releaseTime) / MINUTE)) : knownFull ? u('impact did not settle within 1D') : u('window not yet known'),
    returnToPreMin:
      returnIdx >= 0 ? ok(Math.round((series.time(returnIdx) + step - releaseTime) / MINUTE)) : knownFull ? u('did not return within 1D') : u('window not yet known'),
    pattern,
    curve,
    curveHorizons: [...curveHorizons],
  };
}

/** Signed pips for a direction (+1 long / −1 short). */
export function directional(pips: number, dir: 1 | -1): number {
  return pips * dir;
}
