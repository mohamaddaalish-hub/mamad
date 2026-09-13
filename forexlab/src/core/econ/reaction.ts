/**
 * News reaction measurement (stage 10).
 *
 * Two rules make this trustworthy rather than decorative:
 *
 * 1. The bar that *contains* the release is never measured. Its high/low span
 *    covers both the pre- and post-release world in an unknown order, so any
 *    excursion inside it would be an assumption about the intrabar sequence. The
 *    reference price is the close of the last bar that fully closed before the
 *    release, and measurement starts at the next bar's open.
 * 2. A window that is not fully present in the data — or that the replay barrier
 *    has not revealed yet — is reported as unavailable with a reason, never as a
 *    partial number wearing a full-number label.
 */

import type { CandleSeries } from '../data/series.ts';
import { bucketEnd } from '../time/tz.ts';
import { timeframeMs } from '../time/timeframes.ts';
import type { TimeframeId } from '../time/timeframes.ts';
import type { EconEvent, ImpactLabel } from './types.ts';

export type HorizonId = '1m' | '5m' | '15m' | '30m' | '1H' | '4H' | '1D';

export const PRE_HORIZONS: { id: HorizonId; label: string; ms: number }[] = [
  { id: '5m', label: '-5m', ms: 5 * 60_000 },
  { id: '15m', label: '-15m', ms: 15 * 60_000 },
  { id: '30m', label: '-30m', ms: 30 * 60_000 },
  { id: '1H', label: '-1h', ms: 3_600_000 },
  { id: '4H', label: '-4h', ms: 4 * 3_600_000 },
  { id: '1D', label: '-1d', ms: 86_400_000 },
];

export const POST_HORIZONS: { id: HorizonId; label: string; ms: number }[] = [
  { id: '1m', label: '+1m', ms: 60_000 },
  { id: '5m', label: '+5m', ms: 5 * 60_000 },
  { id: '15m', label: '+15m', ms: 15 * 60_000 },
  { id: '30m', label: '+30m', ms: 30 * 60_000 },
  { id: '1H', label: '+1h', ms: 3_600_000 },
  { id: '4H', label: '+4h', ms: 4 * 3_600_000 },
  { id: '1D', label: '+1d', ms: 86_400_000 },
];

export type ImpactLabelled = Exclude<ImpactLabel, 'unknown'>;

export interface ReactionConfig {
  /** 'pips' uses fixed per-class sizes, 'atr' scales with pre-news ATR. */
  impactMode: 'pips' | 'atr';
  impactPips: Record<ImpactLabelled, number>;
  impactAtrMultiple: Record<ImpactLabelled, number>;
  atrPeriod: number;
  /** Below this fraction of the class size the release did not move the market. */
  noReactionFactor: number;
  /** A peak that gives back at least this fraction of itself is a fade. */
  fadeFactor: number;
  /** Fraction of the peak retained for the move to count as continuation. */
  continuationFactor: number;
  /** Share of the window treated as "the opening phase" for the delayed test. */
  earlyFraction: number;
}

export const DEFAULT_REACTION_CONFIG: ReactionConfig = {
  impactMode: 'pips',
  impactPips: { none: 0, low: 5, medium: 15, high: 40 },
  impactAtrMultiple: { none: 0, low: 0.5, medium: 1, high: 2 },
  atrPeriod: 14,
  noReactionFactor: 0.25,
  fadeFactor: 0.5,
  continuationFactor: 0.75,
  earlyFraction: 0.25,
};

export interface HorizonMeasure {
  horizon: HorizonId;
  label: string;
  side: 'pre' | 'post';
  available: boolean;
  reason: string | null;
  bars: number;
  fromIndex: number | null;
  toIndex: number | null;
  fromTime: number | null;
  toTime: number | null;
  /** Close of the last bar in the window minus the pre-news reference price. */
  change: number | null;
  pips: number | null;
  pct: number | null;
  /** Highest point above the reference, and lowest point below it, in pips. */
  mfePips: number | null;
  maePips: number | null;
  /** Larger of the two, unsigned. */
  maxExcursionPips: number | null;
  /** Reference price this window was measured from (post: pre-news close; pre: the
   * close of the bar before the window, so the run-up itself is what is reported).
   * Kept implicit on the row to avoid a second, easily-confused field. */
  /** Pre-news ATR, pips. Same value on every row: it is the regime being measured against. */
  volatilityBeforePips: number | null;
  /** Mean true range inside this window, pips. */
  volatilityAfterPips: number | null;
  /** Post windows only: expansion (or contraction) of the range. */
  volatilityChangePct: number | null;
  direction: 'up' | 'down' | 'flat' | null;
}

export type ReactionPattern = 'continuation' | 'reversal' | 'spike & fade' | 'no reaction' | 'delayed' | 'unknown';

export interface ReactionPath {
  horizon: HorizonId;
  /** Pre-news reference price. */
  reference: number;
  initialPips: number | null;
  finalPips: number | null;
  /** Extreme reached in the direction of the initial impulse. */
  peakPips: number | null;
  peakIndex: number | null;
  peakTime: number | null;
  timeToPeakMs: number | null;
  /** Extreme reached against the initial impulse. */
  adversePips: number | null;
  /** First bar close back inside `noReactionFactor × class size` of the reference. */
  durationMs: number | null;
  /** First time the close retakes the pre-news price. */
  returnToPreNewsMs: number | null;
  classSizePips: number | null;
  pattern: ReactionPattern;
  /** The rule that fired, with the numbers it used — nothing here is a black box. */
  trace: string[];
}

export interface EventReaction {
  eventId: string;
  /** Last bar fully closed before the release; null when nothing closed before it. */
  preIndex: number | null;
  /** First bar opening at or after the release; null when it is not revealed yet. */
  startIndex: number | null;
  referencePrice: number | null;
  /** True when the release landed inside a bar rather than exactly on an open. */
  intrabar: boolean;
  classSizePips: number | null;
  classSizeKind: 'pips' | 'atr' | null;
  pre: HorizonMeasure[];
  post: HorizonMeasure[];
  path: ReactionPath | null;
  /** Why nothing could be measured at all. */
  unavailable: string | null;
  measuredOn: { tf: TimeframeId; symbol: string; bars: number; lastIndex: number };
}

export interface MeasureOptions {
  series: CandleSeries;
  tz: string;
  /** Price units per pip. */
  pip: number;
  config?: Partial<ReactionConfig>;
  preHorizons?: HorizonId[];
  postHorizons?: HorizonId[];
}

function mergeConfig(patch?: Partial<ReactionConfig>): ReactionConfig {
  return { ...DEFAULT_REACTION_CONFIG, ...(patch ?? {}) };
}

/** Mean true range in pips over `period` bars ending at `toIndex` (inclusive). */
export function atrPipsAt(series: CandleSeries, toIndex: number, period: number, pip: number): number | null {
  if (toIndex < period) return null;
  let acc = 0;
  let prevClose = series.candle(toIndex - period)!.c;
  for (let i = toIndex - period + 1; i <= toIndex; i++) {
    const c = series.candle(i);
    if (!c) return null;
    acc += Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
    prevClose = c.c;
  }
  return acc / period / pip;
}

/** Index of the last bar whose close (bucket end) is at or before `instant`. */
export function lastClosedBefore(series: CandleSeries, instant: number, tz: string): number | null {
  let lo = 0;
  let hi = series.count - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bucketEnd(series.time(mid), series.tf, tz) <= instant) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** First bar that opens at or after `instant`. */
export function firstOpenAtOrAfter(series: CandleSeries, instant: number): number | null {
  const i = series.indexAtOrBefore(instant);
  if (i === null) return null;
  if (series.time(i) >= instant) return i;
  return i + 1 < series.count ? i + 1 : null;
}

interface Window {
  from: number;
  to: number;
}

/** Bars fully inside the horizon, on the requested side of the release. */
function windowFor(
  series: CandleSeries,
  side: 'pre' | 'post',
  ms: number,
  instant: number,
  preIndex: number,
  startIndex: number,
  tz: string,
): (Window & { short: boolean }) | null {
  const last = series.count - 1;
  if (side === 'post') {
    if (startIndex > last) return null;
    const limit = instant + ms;
    let to = startIndex - 1;
    for (let i = startIndex; i <= last; i++) {
      if (bucketEnd(series.time(i), series.tf, tz) <= limit) to = i;
      else break;
    }
    if (to < startIndex) return null;
    // The window is short when the data ran out before the horizon elapsed.
    return { from: startIndex, to, short: bucketEnd(series.time(to), series.tf, tz) < limit && to === last };
  }
  const limit = instant - ms;
  let from = preIndex + 1;
  for (let i = preIndex; i >= 0; i--) {
    if (series.time(i) >= limit) from = i;
    else break;
  }
  if (from > preIndex) return null;
  return { from, to: preIndex, short: series.time(from) > limit && from === 0 };
}

function measureHorizon(
  series: CandleSeries,
  ctx: { tz: string; pip: number; reference: number; preIndex: number; startIndex: number; volBefore: number | null },
  side: 'pre' | 'post',
  spec: { id: HorizonId; label: string; ms: number },
  instant: number,
): HorizonMeasure {
  const out: HorizonMeasure = {
    horizon: spec.id,
    label: spec.label,
    side,
    available: false,
    reason: null,
    bars: 0,
    fromIndex: null,
    toIndex: null,
    fromTime: null,
    toTime: null,
    change: null,
    pips: null,
    pct: null,
    mfePips: null,
    maePips: null,
    maxExcursionPips: null,
    volatilityBeforePips: ctx.volBefore,
    volatilityAfterPips: null,
    volatilityChangePct: null,
    direction: null,
  };
  if (series.count === 0) {
    out.reason = 'no candles loaded';
    return out;
  }
  const win = windowFor(series, side, spec.ms, instant, ctx.preIndex, ctx.startIndex, ctx.tz);
  if (!win) {
    out.reason = `no completed bar ${side === 'post' ? 'after' : 'before'} the release within ${spec.label}`;
    return out;
  }
  if (win.short) {
    out.reason = `${spec.label} window extends past the ${side === 'post' ? 'end' : 'start'} of the imported data`;
    return out;
  }
  let hi = -Infinity;
  let lo = Infinity;
  let tr = 0;
  let trN = 0;
  let prevClose = side === 'post' ? ctx.reference : win.from > 0 ? series.candle(win.from - 1)!.c : series.candle(win.from)!.o;
  for (let i = win.from; i <= win.to; i++) {
    const c = series.candle(i)!;
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
    tr += Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
    trN++;
    prevClose = c.c;
  }
  const lastC = series.candle(win.to)!;
  const firstC = series.candle(win.from)!;
  // Pre windows describe the run-up, so they are measured from the bar before the
  // window; post windows are always measured from the pre-news reference close.
  const windowRef = side === 'post' ? ctx.reference : win.from > 0 ? series.candle(win.from - 1)!.c : series.candle(win.from)!.o;
  const change = lastC.c - windowRef;
  const volAfter = trN > 0 ? tr / trN / ctx.pip : null;
  out.available = true;
  out.bars = win.to - win.from + 1;
  out.fromIndex = win.from;
  out.toIndex = win.to;
  out.fromTime = firstC.t;
  out.toTime = lastC.t;
  out.change = change;
  out.pips = change / ctx.pip;
  out.pct = windowRef !== 0 ? (change / windowRef) * 100 : null;
  out.mfePips = Math.max(0, hi - windowRef) / ctx.pip;
  out.maePips = Math.max(0, windowRef - lo) / ctx.pip;
  out.maxExcursionPips = Math.max(Math.max(hi - windowRef, 0), Math.max(windowRef - lo, 0)) / ctx.pip;
  out.volatilityAfterPips = volAfter;
  out.volatilityChangePct =
    side === 'post' && ctx.volBefore !== null && ctx.volBefore > 0 && volAfter !== null ? (volAfter / ctx.volBefore - 1) * 100 : null;
  out.direction = Math.abs(change) < 1e-12 ? 'flat' : change > 0 ? 'up' : 'down';
  return out;
}

function classSize(
  series: CandleSeries,
  preIndex: number,
  impact: ImpactLabel,
  config: ReactionConfig,
  pip: number,
): { pips: number | null; kind: 'pips' | 'atr' | null } {
  if (impact === 'unknown') return { pips: null, kind: null };
  const label = impact as ImpactLabelled;
  if (config.impactMode === 'pips') return { pips: config.impactPips[label] ?? null, kind: 'pips' };
  const atr = atrPipsAt(series, preIndex, config.atrPeriod, pip);
  return { pips: atr === null ? null : atr * (config.impactAtrMultiple[label] ?? 0), kind: 'atr' };
}

export interface PatternInput {
  initialPips: number;
  finalPips: number;
  peakPips: number;
  adversePips: number;
  earlyPips: number;
  classSizePips: number | null;
  config: ReactionConfig;
}

/**
 * Reaction shape, from explicit numbers and a fixed rule order. Returns the rule
 * text that fired so the UI can show why a release was called a fade.
 */
export function classifyPattern(input: PatternInput): { pattern: ReactionPattern; trace: string[] } {
  const { config } = input;
  const trace: string[] = [];
  if (input.classSizePips === null) {
    trace.push(
      `class size unavailable (${config.impactMode === 'atr' ? `ATR(${config.atrPeriod}) not computable at this position` : 'no pip size configured for this impact class'}) — pattern left unknown`,
    );
    return { pattern: 'unknown', trace };
  }
  const threshold = input.classSizePips * config.noReactionFactor;
  const impulse = Math.max(Math.abs(input.peakPips), Math.abs(input.adversePips));
  trace.push(`class size ${input.classSizePips.toFixed(1)}p → "moved" needs ${threshold.toFixed(1)}p, largest excursion ${impulse.toFixed(1)}p`);
  if (impulse < threshold) {
    trace.push(`${impulse.toFixed(1)}p < ${threshold.toFixed(1)}p → no reaction`);
    return { pattern: 'no reaction', trace };
  }
  const dir: 1 | -1 = input.initialPips >= 0 ? 1 : -1;
  const signedPeak = dir > 0 ? input.peakPips : -input.adversePips;
  const finalAligned = input.finalPips * dir;
  const earlyAligned = input.earlyPips * dir;
  const sizeAlignedPeak = Math.abs(signedPeak);
  if (earlyAligned < threshold && Math.abs(input.finalPips) >= threshold) {
    trace.push(
      `opening phase reached ${earlyAligned.toFixed(1)}p (< ${threshold.toFixed(1)}p) while the full window ended at ${input.finalPips.toFixed(1)}p → delayed`,
    );
    return { pattern: 'delayed', trace };
  }
  if (finalAligned < 0) {
    trace.push(
      `initial impulse ${input.initialPips.toFixed(1)}p, window closed ${input.finalPips.toFixed(1)}p on the far side of the reference → reversal`,
    );
    return { pattern: 'reversal', trace };
  }
  if (sizeAlignedPeak > 0 && finalAligned < sizeAlignedPeak * (1 - config.fadeFactor)) {
    trace.push(
      `peak ${sizeAlignedPeak.toFixed(1)}p surrendered to ${finalAligned.toFixed(1)}p (more than ${Math.round(config.fadeFactor * 100)}% given back) → spike & fade`,
    );
    return { pattern: 'spike & fade', trace };
  }
  if (sizeAlignedPeak > 0 && finalAligned >= sizeAlignedPeak * config.continuationFactor) {
    trace.push(
      `close kept ${((finalAligned / sizeAlignedPeak) * 100).toFixed(0)}% of the ${sizeAlignedPeak.toFixed(1)}p peak (≥ ${Math.round(config.continuationFactor * 100)}%) → continuation`,
    );
    return { pattern: 'continuation', trace };
  }
  trace.push(
    `peak ${sizeAlignedPeak.toFixed(1)}p, close ${finalAligned.toFixed(1)}p: neither held (≥${Math.round(config.continuationFactor * 100)}% of the peak) nor faded (≤${Math.round((1 - config.fadeFactor) * 100)}%) → indeterminate`,
  );
  return { pattern: 'unknown', trace };
}

/** Full reaction record for one event, measured on a series that may be replay-clipped. */
export function measureReaction(event: EconEvent, opts: MeasureOptions): EventReaction {
  const { series, tz, pip } = opts;
  const config = mergeConfig(opts.config);
  const preIndex = lastClosedBefore(series, event.instant, tz);
  const startIndex = firstOpenAtOrAfter(series, event.instant);
  const reaction: EventReaction = {
    eventId: event.id,
    preIndex,
    startIndex,
    referencePrice: null,
    intrabar: true,
    classSizePips: null,
    classSizeKind: null,
    pre: [],
    post: [],
    path: null,
    unavailable: null,
    measuredOn: { tf: series.tf, symbol: series.symbol, bars: series.count, lastIndex: series.count - 1 },
  };
  if (preIndex === null) {
    reaction.unavailable = 'no bar closed before the release inside the visible range (data starts later, or replay has not reached it)';
    return reaction;
  }
  if (startIndex === null) {
    reaction.unavailable = 'no bar opens after the release inside the visible range (replay has not revealed it yet, or the file ends here)';
    return reaction;
  }
  const reference = series.candle(preIndex)!.c;
  reaction.referencePrice = reference;
  reaction.intrabar = series.time(startIndex) > event.instant;
  const size = classSize(series, preIndex, event.impact, config, pip);
  reaction.classSizePips = size.pips;
  reaction.classSizeKind = size.kind;

  const wantPre = opts.preHorizons ?? PRE_HORIZONS.map((h) => h.id);
  const wantPost = opts.postHorizons ?? POST_HORIZONS.map((h) => h.id);
  const volBefore = atrPipsAt(series, preIndex, config.atrPeriod, pip);
  const ctx = { tz, pip, reference, preIndex, startIndex, volBefore };
  for (const spec of PRE_HORIZONS) if (wantPre.includes(spec.id)) reaction.pre.push(measureHorizon(series, ctx, 'pre', spec, event.instant));
  for (const spec of POST_HORIZONS) if (wantPost.includes(spec.id)) reaction.post.push(measureHorizon(series, ctx, 'post', spec, event.instant));

  const widest = [...reaction.post].reverse().find((m) => m.available) ?? null;
  if (!widest || widest.fromIndex === null || widest.toIndex === null) {
    reaction.unavailable = reaction.post[0]?.reason ?? 'no post-event window is available';
    return reaction;
  }
  const from = widest.fromIndex;
  const to = widest.toIndex;
  let peak = -Infinity;
  let peakIndex = from;
  let trough = Infinity;
  for (let i = from; i <= to; i++) {
    const c = series.candle(i)!;
    if (c.h > peak) {
      peak = c.h;
      peakIndex = i;
    }
    if (c.l < trough) trough = c.l;
  }
  const initialPips = (series.candle(from)!.c - reference) / pip;
  const earlyCut = from + Math.max(0, Math.ceil((to - from) * config.earlyFraction) - 1);
  const earlyPips = (series.candle(Math.min(to, earlyCut))!.c - reference) / pip;
  const { pattern, trace } = classifyPattern({
    initialPips,
    finalPips: widest.pips ?? 0,
    peakPips: (peak - reference) / pip,
    adversePips: (reference - trough) / pip,
    earlyPips,
    classSizePips: reaction.classSizePips,
    config,
  });
  const dir: 1 | -1 = initialPips >= 0 ? 1 : -1;
  let durationMs: number | null = null;
  let returnMs: number | null = null;
  const inner = reaction.classSizePips === null ? Infinity : reaction.classSizePips * config.noReactionFactor;
  for (let i = from; i <= to; i++) {
    const moved = (series.candle(i)!.c - reference) / pip;
    if (durationMs === null && Math.abs(moved) <= inner) durationMs = bucketEnd(series.time(i), series.tf, tz) - event.instant;
    if (returnMs === null && moved * dir <= 0) returnMs = bucketEnd(series.time(i), series.tf, tz) - event.instant;
    if (durationMs !== null && returnMs !== null) break;
  }
  reaction.path = {
    horizon: widest.horizon,
    reference,
    initialPips,
    finalPips: widest.pips ?? null,
    peakPips: (peak - reference) / pip,
    peakIndex,
    peakTime: series.time(peakIndex),
    timeToPeakMs: series.time(peakIndex) + timeframeMs(series.tf) - event.instant,
    adversePips: (reference - trough) / pip,
    durationMs,
    returnToPreNewsMs: returnMs,
    classSizePips: reaction.classSizePips,
    pattern,
    trace,
  };
  return reaction;
}
