/**
 * Time and price axis tick generation.
 *
 * Ticks are chosen in the *time* domain (so labels land on real bar boundaries:
 * 00:00, 04:00, first of month…) and then mapped through the series to index
 * space, which keeps labels sane even across weekend gaps.
 */

import type { CandleSeries } from '../data/series.ts';
import type { Viewport } from './viewport.ts';
import { addMonthsZoned, floorToDay, floorToMonth, floorToWeek, formatTime, zonedParts } from '../time/tz.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Span {
  ms?: number;
  months?: number;
  label: 'time' | 'date' | 'month' | 'year';
  major: boolean;
}

/** Ordered fine → coarse. */
export const TIME_SPANS: Span[] = [
  { ms: 1 * MIN, label: 'time', major: false },
  { ms: 5 * MIN, label: 'time', major: false },
  { ms: 15 * MIN, label: 'time', major: false },
  { ms: 30 * MIN, label: 'time', major: false },
  { ms: 1 * HOUR, label: 'time', major: false },
  { ms: 2 * HOUR, label: 'time', major: false },
  { ms: 4 * HOUR, label: 'time', major: false },
  { ms: 6 * HOUR, label: 'time', major: false },
  { ms: 12 * HOUR, label: 'time', major: false },
  { ms: DAY, label: 'date', major: true },
  { ms: 2 * DAY, label: 'date', major: true },
  { ms: 4 * DAY, label: 'date', major: true },
  { ms: 7 * DAY, label: 'date', major: true },
  { months: 1, label: 'month', major: true },
  { months: 3, label: 'month', major: true },
  { months: 6, label: 'month', major: true },
  { months: 12, label: 'year', major: true },
];

export interface TimeTick {
  x: number;
  label: string;
  major: boolean;
  time: number;
  /** Index of the candle the tick was anchored to. */
  index: number;
}

const HOUR_MS = 3_600_000;

/**
 * Align an instant down to a multiple of `ms`.
 *
 * Sub-day spans anchor to local midnight (so a 4H grid ticks at 00/04/08/12 in
 * the chart zone, not in UTC). Day multiples anchor to whole days; months use
 * the calendar.
 */
export function floorSpan(t: number, ms: number, tz: string): number {
  if (ms === 7 * DAY) return floorToWeek(t, tz); // weeks anchor to Monday, not to the epoch
  if (ms % DAY === 0 && ms >= DAY) {
    const days = Math.round(ms / DAY);
    const anchorDay = Math.floor(floorToDay(t, tz) / DAY);
    const k = Math.floor(anchorDay / days) * days;
    return floorToDay(k * DAY + 12 * HOUR_MS, tz);
  }
  const localMidnight = floorToDay(t, tz);
  if (t < localMidnight) return localMidnight - ms + Math.floor((t - (localMidnight - ms)) / ms) * ms;
  return localMidnight + Math.floor((t - localMidnight) / ms) * ms;
}

function nextBucket(t: number, span: Span, tz: string): number {
  if (span.months) return addMonthsZoned(t, span.months, tz);
  const ms = span.ms ?? DAY;
  const next = floorSpan(t + ms + 1, ms, tz);
  return next > t ? next : t + ms;
}

export interface TimeTickOptions {
  minLabelPx?: number;
  tz: string;
}

/** Pick the span that keeps labels at least `minLabelPx` apart. */
export function chooseSpan(series: CandleSeries, pxPerBar: number, minLabelPx = 92): Span {
  const nominal = nominalStep(series);
  for (const span of TIME_SPANS) {
    const width = ((span.ms ?? nominal * 30) / nominal) * pxPerBar;
    if (width >= minLabelPx) return span;
  }
  return TIME_SPANS[TIME_SPANS.length - 1];
}

function nominalStep(series: CandleSeries): number {
  if (series.stepMs && series.stepMs > 0) return series.stepMs;
  const cols = series.underlying();
  if (cols.len > 1) {
    const d = cols.t[Math.floor(cols.len / 2)] - cols.t[Math.floor(cols.len / 2) - 1];
    if (d > 0) return d;
  }
  return DAY;
}

export function computeTimeTicks(
  series: CandleSeries,
  view: Viewport,
  range: { from: number; to: number },
  opts: TimeTickOptions,
): TimeTick[] {
  const out: TimeTick[] = [];
  if (range.to - range.from <= 0) return out;
  const span = chooseSpan(series, view.pxPerBar, opts.minLabelPx);
  const tz = opts.tz;
  const firstTime = series.time(range.from);
  const lastTime = series.time(Math.min(range.to, series.count) - 1);
  let t = span.months
    ? floorToMonth(firstTime, tz, span.months)
    : floorSpan(firstTime, span.ms!, tz);
  if (t < firstTime) t = nextBucket(t, span, tz);
  let guard = 0;
  while (t <= lastTime && guard++ < 5000) {
    const i = series.lower(t);
    if (i >= series.count || i >= range.to) break;
    if (i >= range.from) {
      const x = view.indexToX(i);
      if (x > view.geom.plotLeft + 26 && x < view.geom.plotRight - 10) {
        const actual = series.time(i);
        out.push({ x, label: formatTickLabel(actual, span, tz), major: span.major, time: actual, index: i });
      }
    }
    const next = nextBucket(t, span, tz);
    if (next <= t) break;
    t = next;
  }
  return dedupeTicks(out);
}

function dedupeTicks(ticks: TimeTick[]): TimeTick[] {
  const out: TimeTick[] = [];
  for (const tick of ticks) {
    const prev = out[out.length - 1];
    if (prev && tick.x - prev.x < 48) continue;
    out.push(tick);
  }
  return out;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatTickLabel(t: number, span: Span, tz: string): string {
  const p = zonedParts(t, tz);
  const month = MONTHS_SHORT[p.month - 1];
  switch (span.label) {
    case 'time':
      return formatTime(t, tz);
    case 'date':
      return `${month} ${p.day}`;
    case 'month':
      return p.month === 1 ? `${String(p.year)}` : `${month}`;
    case 'year':
      return `${p.year}`;
  }
}

/** Long form used by the crosshair label. */
export function formatAxisDateTime(t: number, tz: string, includeTime: boolean): string {
  const p = zonedParts(t, tz);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return includeTime ? `${date}  ${formatTime(t, tz)}` : date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export interface PriceTick {
  y: number;
  label: string;
  price: number;
}

/** Nice-number price ticks: 1/2/2.5/5 × 10^k. */
export function computePriceTicks(view: Viewport, targetCount: number): PriceTick[] {
  const span = view.priceMax - view.priceMin;
  const out: PriceTick[] = [];
  if (!(span > 0) || !Number.isFinite(span)) return out;
  const rawStep = span / Math.max(2, targetCount);
  const step = niceNumber(rawStep);
  const first = Math.ceil(view.priceMin / step) * step;
  const decimals = decimalsForStep(step);
  for (let p = first; p <= view.priceMax + step * 0.5; p += step) {
    const y = view.priceToY(p);
    if (y < view.geom.plotTop - 1 || y > view.geom.plotBottom + 1) continue;
    out.push({ y, label: p.toFixed(decimals), price: p });
  }
  return out;
}

export function niceNumber(x: number): number {
  if (!(x > 0)) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const frac = x / base;
  // Round up to the next nice value so a target tick count is never exceeded.
  let mult = 1;
  if (frac > 6) mult = 10;
  else if (frac > 2.6) mult = 5;
  else if (frac > 2.1) mult = 2.5;
  else if (frac > 1.1) mult = 2;
  return mult * base;
}

/** Smallest number of decimals that can render this step exactly. */
export function decimalsForStep(step: number): number {
  if (!(step > 0)) return 2;
  for (let d = 0; d <= 8; d++) {
    const scaled = step * Math.pow(10, d);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d;
  }
  return 8;
}
