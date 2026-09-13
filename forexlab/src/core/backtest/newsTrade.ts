/**
 * Trade simulation primitives shared by the manual backtester and the automated
 * news backtester.
 *
 * - Costs: spread (paid at entry: buy at ask = mid + spread/2, sell at bid),
 *   slippage per side, commission per round trip — all in pips.
 * - TP/SL detection on OHLC bars. When both are touched inside one bar the
 *   sequence is unknowable from OHLC, so an explicit `AmbiguityPolicy` decides:
 *   'worst' (SL first), 'best' (TP first), 'skip' (trade voided and counted as
 *   ambiguous). There is no "guess by open-close direction" option.
 */

import type { CandleSeries } from '../data/series.ts';
import { pipSizeFromDecimals, priceToPips } from '../util/pips.ts';

export type Side = 1 | -1; // long / short
export type AmbiguityPolicy = 'worst' | 'best' | 'skip';

export interface Costs {
  spreadPips: number;
  slippagePips: number;
  commissionPips: number;
}

export const DEFAULT_COSTS: Costs = { spreadPips: 0.8, slippagePips: 0.2, commissionPips: 0.3 };

export interface ExitRule {
  /** Max holding time in minutes; null = only TP/SL. */
  timeMin: number | null;
  tpPips: number | null;
  slPips: number | null;
  ambiguity: AmbiguityPolicy;
}

export interface SimTrade {
  side: Side;
  entryIndex: number;
  entryTime: number;
  /** Fill price after spread + slippage. */
  entryPrice: number;
  exitIndex: number;
  exitTime: number;
  exitPrice: number;
  exitReason: 'tp' | 'sl' | 'time' | 'end' | 'ambiguous';
  grossPips: number;
  netPips: number;
  returnPct: number;
  rMultiple: number | null;
  mfePips: number;
  maePips: number;
  holdingMin: number;
  ambiguousBar: boolean;
}

export interface SimFailure {
  reason: 'no-entry-bar' | 'insufficient-bars' | 'ambiguous-skip' | 'bar-not-known';
  detail: string;
}

/** Simulate one trade from bar `entryIndex` (fill at that bar's open). */
export function simulateTrade(
  series: CandleSeries,
  entryIndex: number,
  side: Side,
  rule: ExitRule,
  costs: Costs,
  decimals: number,
): SimTrade | SimFailure {
  const n = series.count;
  if (entryIndex < 0 || entryIndex >= n) return { reason: 'no-entry-bar', detail: `entry bar ${entryIndex} outside the known series (${n} bars)` };
  const pip = pipSizeFromDecimals(decimals);
  const { o, h, l, c, t } = series.cols;
  const step = series.stepMs ?? 60_000;
  const half = (costs.spreadPips / 2) * pip;
  const slip = costs.slippagePips * pip;
  const entryMid = o[entryIndex];
  const entryPrice = side === 1 ? entryMid + half + slip : entryMid - half - slip;
  const tp = rule.tpPips !== null ? entryPrice + side * rule.tpPips * pip : null;
  const sl = rule.slPips !== null ? entryPrice - side * rule.slPips * pip : null;
  const deadline = rule.timeMin !== null ? t[entryIndex] + rule.timeMin * 60_000 : Number.POSITIVE_INFINITY;
  let mfe = 0;
  let mae = 0;
  let exitIndex = -1;
  let exitPrice = NaN;
  let reason: SimTrade['exitReason'] = 'end';
  let ambiguousBar = false;
  for (let i = entryIndex; i < n; i++) {
    // Exit-at-time: close of the last bar that ends at or before the deadline.
    const barEnd = t[i] + step;
    const fav = side === 1 ? h[i] - entryPrice : entryPrice - l[i];
    const adv = side === 1 ? entryPrice - l[i] : h[i] - entryPrice;
    const hitTp = tp !== null && (side === 1 ? h[i] >= tp : l[i] <= tp);
    const hitSl = sl !== null && (side === 1 ? l[i] <= sl : h[i] >= sl);
    if (hitTp && hitSl) {
      ambiguousBar = true;
      if (rule.ambiguity === 'skip') return { reason: 'ambiguous-skip', detail: `TP and SL both inside bar at ${new Date(t[i]).toISOString()}` };
      if (rule.ambiguity === 'worst') {
        exitIndex = i;
        exitPrice = sl as number;
        reason = 'sl';
        mae = Math.max(mae, Math.abs(entryPrice - (sl as number)));
      } else {
        exitIndex = i;
        exitPrice = tp as number;
        reason = 'tp';
        mfe = Math.max(mfe, Math.abs((tp as number) - entryPrice));
      }
      break;
    }
    if (hitSl) {
      exitIndex = i;
      exitPrice = sl as number;
      reason = 'sl';
      // Excursion up to the stop is what was seen; beyond it we were flat.
      mae = Math.max(mae, Math.abs(entryPrice - (sl as number)));
      mfe = Math.max(mfe, Math.min(fav, tp !== null ? Math.abs(tp - entryPrice) : fav));
      break;
    }
    if (hitTp) {
      exitIndex = i;
      exitPrice = tp as number;
      reason = 'tp';
      mfe = Math.max(mfe, Math.abs((tp as number) - entryPrice));
      mae = Math.max(mae, adv);
      break;
    }
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    if (barEnd >= deadline) {
      exitIndex = i;
      exitPrice = c[i];
      reason = 'time';
      break;
    }
  }
  if (exitIndex < 0) {
    // Ran out of known bars before any exit condition: the trade is not closable yet.
    return { reason: 'insufficient-bars', detail: 'known price history ends before the exit condition' };
  }
  const exitFill = side === 1 ? exitPrice - slip : exitPrice + slip;
  const gross = side * (exitFill - entryPrice);
  const grossPips = priceToPips(gross, decimals);
  const netPips = grossPips - costs.commissionPips;
  const risk = rule.slPips !== null && rule.slPips > 0 ? rule.slPips : null;
  return {
    side,
    entryIndex,
    entryTime: t[entryIndex],
    entryPrice,
    exitIndex,
    exitTime: t[exitIndex] + step,
    exitPrice: exitFill,
    exitReason: reason,
    grossPips,
    netPips,
    returnPct: (netPips * pip / entryPrice) * 100,
    rMultiple: risk ? netPips / risk : null,
    mfePips: priceToPips(mfe, decimals),
    maePips: priceToPips(mae, decimals),
    holdingMin: Math.round((t[exitIndex] + step - t[entryIndex]) / 60_000),
    ambiguousBar,
  };
}

export function isFailure(x: SimTrade | SimFailure): x is SimFailure {
  return (x as SimFailure).reason !== undefined && (x as SimTrade).side === undefined;
}
