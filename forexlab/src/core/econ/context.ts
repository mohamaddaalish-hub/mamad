/**
 * Where an event sits in its surroundings (stage 11): trading session, volatility
 * regime, pre-news structure, and whether other releases crowd the same minute.
 *
 * Everything here is computed from bars that had already closed when the event
 * happened — the day high is the day high *so far*, not the day's eventual high.
 */

import type { CandleSeries } from '../data/series.ts';
import { bucketEnd, floorToDay } from '../time/tz.ts';
import { atrPipsAt, type ReactionConfig } from './reaction.ts';
import type { EconEvent } from './types.ts';

export type SessionId = 'asia' | 'london' | 'newyork' | 'overlap' | 'off';

/** Session windows in UTC hours, [start, end). Editable so the user can match a broker day. */
export interface SessionWindows {
  asia: [number, number];
  london: [number, number];
  newyork: [number, number];
}

export const DEFAULT_SESSION_WINDOWS: SessionWindows = {
  asia: [0, 9],
  london: [8, 17],
  newyork: [13, 22],
};

export const SESSION_LABEL: Record<SessionId, string> = {
  asia: 'Asia',
  london: 'London',
  newyork: 'New York',
  overlap: 'London / New York overlap',
  off: 'Between sessions',
};

export interface SessionInfo {
  id: SessionId;
  label: string;
  /** Local hour+minute of the event in the series timezone. */
  clock: string;
  inOverlap: boolean;
}

export function sessionAt(instant: number, windows: SessionWindows = DEFAULT_SESSION_WINDOWS, tz = 'UTC'): SessionInfo {
  const day = new Date(instant);
  const shift = tz === 'UTC' ? 0 : 0; // sessions are quoted in UTC by convention
  void shift;
  const hour = day.getUTCHours();
  const minute = day.getUTCMinutes();
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const inAsia = hour >= windows.asia[0] && hour < windows.asia[1];
  const inLondon = hour >= windows.london[0] && hour < windows.london[1];
  const inNy = hour >= windows.newyork[0] && hour < windows.newyork[1];
  const overlap = inLondon && inNy;
  const id: SessionId = overlap ? 'overlap' : inLondon ? 'london' : inNy ? 'newyork' : inAsia ? 'asia' : 'off';
  return { id, label: SESSION_LABEL[id], clock, inOverlap: overlap };
}

export type VolRegime = 'low' | 'normal' | 'high';

export interface VolatilityContext {
  regime: VolRegime | null;
  /** Pre-news ATR in pips. */
  atrPips: number | null;
  /** Percentile of that ATR inside the imported range (0-100). */
  percentile: number | null;
  /** Expansion of the post window relative to it, % — filled in from the reaction. */
  note: string | null;
}

/**
 * Volatility regime of the release moment, ranked against the whole visible
 * sample. The ranking uses only bars up to the release for the event's own ATR;
 * the reference distribution is the dataset's, which is the honest way to say
 * "this was a quiet day for this pair" without pretending to know the future.
 */
export function volatilityContext(
  series: CandleSeries,
  preIndex: number | null,
  config: ReactionConfig,
  pip: number,
): VolatilityContext {
  if (preIndex === null) return { regime: null, atrPips: null, percentile: null, note: 'no bar closed before the release' };
  const atr = atrPipsAt(series, preIndex, config.atrPeriod, pip);
  if (atr === null) return { regime: null, atrPips: null, percentile: null, note: `ATR(${config.atrPeriod}) needs ${config.atrPeriod + 1} bars before the release` };
  const step = Math.max(1, Math.floor(series.count / 400));
  const sample: number[] = [];
  for (let i = config.atrPeriod; i < series.count; i += step) {
    const v = atrPipsAt(series, i, config.atrPeriod, pip);
    if (v !== null) sample.push(v);
  }
  if (sample.length < 20) return { regime: null, atrPips: atr, percentile: null, note: 'not enough bars in the visible range to rank volatility' };
  sample.sort((a, b) => a - b);
  let below = 0;
  for (const v of sample) if (v <= atr) below++;
  const pct = (below / sample.length) * 100;
  const regime: VolRegime = pct < 33.34 ? 'low' : pct > 66.66 ? 'high' : 'normal';
  return { regime, atrPips: atr, percentile: pct, note: null };
}

export type TrendLabel = 'bullish' | 'bearish' | 'range' | 'unknown';

export interface PreNewsContext {
  /** Bars examined for the structure reading. */
  lookback: number;
  changePips: number | null;
  rangePips: number | null;
  trend: TrendLabel;
  trendNote: string | null;
  /** Distance from the pre-news close to the day's high/low so far. */
  dayHighPips: number | null;
  dayLowPips: number | null;
  prevDayHighPips: number | null;
  prevDayLowPips: number | null;
  dayNote: string | null;
}

/**
 * Structure just before the release. `lookback` bars ending at the reference bar.
 * Day anchors use the series timezone so "today's high" means the user's trading day.
 */
export function preNewsContext(
  series: CandleSeries,
  event: EconEvent,
  opts: { tz: string; pip: number; lookback?: number; trendBand?: number },
): PreNewsContext {
  const lookback = opts.lookback ?? 60;
  const band = opts.trendBand ?? 0.3;
  const pip = opts.pip;
  const out: PreNewsContext = {
    lookback,
    changePips: null,
    rangePips: null,
    trend: 'unknown',
    trendNote: null,
    dayHighPips: null,
    dayLowPips: null,
    prevDayHighPips: null,
    prevDayLowPips: null,
    dayNote: null,
  };
  const last = series.count - 1;
  let ref = -1;
  for (let i = last; i >= 0; i--) {
    if (bucketEnd(series.time(i), series.tf, opts.tz) <= event.instant) {
      ref = i;
      break;
    }
  }
  if (ref < 1) {
    out.trendNote = 'no completed bar before the release inside the visible range';
    out.dayNote = out.trendNote;
    return out;
  }
  const from = Math.max(0, ref - lookback + 1);
  if (ref - from + 1 < Math.min(lookback, 10)) {
    out.trendNote = `only ${ref - from + 1} bars before the release are visible`;
  }
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i <= ref; i++) {
    const c = series.candle(i)!;
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  const change = series.candle(ref)!.c - series.candle(from)!.c;
  const range = hi - lo;
  out.changePips = change / pip;
  out.rangePips = range / pip;
  if (range <= 0) {
    out.trend = 'unknown';
    out.trendNote = out.trendNote ?? 'flat range window: nothing to lean on';
  } else if (change > range * band) out.trend = 'bullish';
  else if (change < -range * band) out.trend = 'bearish';
  else out.trend = 'range';

  // Day anchors, restricted to bars that closed before the release.
  const dayStart = floorToDay(event.instant, opts.tz);
  let dayHi = -Infinity;
  let dayLo = Infinity;
  let bars = 0;
  for (let i = ref; i >= 0; i--) {
    if (series.time(i) < dayStart) break;
    const c = series.candle(i)!;
    if (c.h > dayHi) dayHi = c.h;
    if (c.l < dayLo) dayLo = c.l;
    bars++;
  }
  if (bars >= 3) {
    out.dayHighPips = (dayHi - series.candle(ref)!.c) / pip;
    out.dayLowPips = (series.candle(ref)!.c - dayLo) / pip;
  } else {
    out.dayNote = `${bars} bar${bars === 1 ? '' : 's'} of the current day visible before the release — day distances unavailable`;
  }
  const prevStart = floorToDay(dayStart - 86_400_000, opts.tz);
  let pHi = -Infinity;
  let pLo = Infinity;
  let pBars = 0;
  for (let i = ref; i >= 0; i--) {
    const t = series.time(i);
    if (t < prevStart) break;
    if (t >= dayStart) continue;
    const c = series.candle(i)!;
    if (c.h > pHi) pHi = c.h;
    if (c.l < pLo) pLo = c.l;
    pBars++;
  }
  if (pBars >= 3) {
    out.prevDayHighPips = (pHi - series.candle(ref)!.c) / pip;
    out.prevDayLowPips = (series.candle(ref)!.c - pLo) / pip;
  } else {
    out.dayNote = [out.dayNote, 'previous day not fully inside the visible range'].filter(Boolean).join('; ');
  }
  return out;
}

export interface ClusterInfo {
  eventId: string;
  /** Nearest other release, and how far. */
  nearestMs: number | null;
  nearestEventId: string | null;
  count15: number;
  count30: number;
  count60: number;
  isolated15: boolean;
  isolated30: boolean;
  isolated60: boolean;
  /** Index within a same-window cluster group (0 = first release of the group). */
  groupSize: number;
  groupMembers: string[];
}

/**
 * Two-pointer sweep over the chronological list: for every event, the other
 * releases within ±15/±30/±60 minutes. Events of any currency are counted — a
 * cluster is about the tape, not about the pair being viewed.
 */
export function analyzeClusters(events: EconEvent[], overlapMinutes = 15): Map<string, ClusterInfo> {
  const out = new Map<string, ClusterInfo>();
  const n = events.length;
  let lo = 0;
  let hi = 0;
  const win = (min: number): number => min * 60_000;
  for (let i = 0; i < n; i++) {
    const t = events[i].instant;
    while (lo < i && t - events[lo].instant > win(60)) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && events[hi + 1].instant - t <= win(60)) hi++;
    let c15 = 0;
    let c30 = 0;
    let c60 = 0;
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      const d = Math.abs(events[j].instant - t);
      if (d <= win(15)) c15++;
      if (d <= win(30)) c30++;
      c60++;
    }
    // Nearest neighbour is reported even when it sits outside the ±60m window,
    // so "isolated here, but a release follows in three hours" is still visible.
    let nearest: { ms: number; id: string } | null = null;
    const reach = win(720);
    for (let j = i - 1; j >= 0 && t - events[j].instant <= reach; j--) {
      const d = t - events[j].instant;
      if (!nearest || d < nearest.ms) nearest = { ms: d, id: events[j].id };
    }
    for (let j = i + 1; j < n && events[j].instant - t <= reach; j++) {
      const d = events[j].instant - t;
      if (!nearest || d < nearest.ms) nearest = { ms: d, id: events[j].id };
    }
    // Group: every event inside ±overlapMinutes, chained transitively.
    const members: string[] = [events[i].id];
    for (let j = i + 1; j < n && events[j].instant - t <= win(overlapMinutes); j++) members.push(events[j].id);
    out.set(events[i].id, {
      eventId: events[i].id,
      nearestMs: nearest ? nearest.ms : null,
      nearestEventId: nearest ? nearest.id : null,
      count15: c15,
      count30: c30,
      count60: c60,
      isolated15: c15 === 0,
      isolated30: c30 === 0,
      isolated60: c60 === 0,
      groupSize: members.length,
      groupMembers: members,
    });
  }
  return out;
}
