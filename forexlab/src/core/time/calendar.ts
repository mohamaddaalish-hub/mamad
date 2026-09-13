/**
 * Calendar helpers for the go-to-date navigator.
 *
 * Day boundaries are computed in the chart timezone (so a "day" means the user's
 * day, not the UTC day) and bar counts per day come from binary searches over the
 * series rather than per-row timezone conversion.
 */

import { lowerBound, upperBound } from '../data/types.ts';
import type { CandleColumns } from '../data/types.ts';
import { daysInMonth, zonedInstant, zonedParts } from './tz.ts';

export interface CalendarDay {
  /** Day of month, 1-based. */
  day: number;
  /** First instant of the local day. */
  start: number;
  /** First instant of the following local day (DST-aware). */
  end: number;
  /** Bars inside [start, end) — 0 means the file has nothing for that day. */
  bars: number;
  /** Day belongs to the previous/next month (padding cells). */
  outside: boolean;
}

/** Normalised instant for a possibly overflowing local date, e.g. 2024-02-31. */
export function zonedDayStart(year: number, month: number, day: number, tz: string): number {
  let y = year;
  let m = month;
  let d = day;
  while (m > 12) {
    m -= 12;
    y++;
  }
  while (m < 1) {
    m += 12;
    y--;
  }
  // Roll forward over months that are too short for the requested day.
  for (let guard = 0; guard < 48; guard++) {
    const dim = daysInMonth(y, m);
    if (d <= dim) break;
    d -= dim;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  while (d < 1) {
    m--;
    if (m < 1) {
      m = 12;
      y--;
    }
    d += daysInMonth(y, m);
  }
  return zonedInstant(y, m, d, 0, 0, 0, tz);
}

/** Monday-first leading padding for a month, 0..6. */
export function leadingCells(weekdayOfFirst: number): number {
  return (weekdayOfFirst + 6) % 7;
}

/**
 * Every day of `month` (1-12) with the number of bars available in `cols` up to
 * `limit`. `limit` is what makes this replay-safe: pass the barrier, never the
 * full array length, and future days report as empty.
 */
export function monthDays(cols: CandleColumns, limit: number, year: number, month: number, tz: string): CalendarDay[] {
  const out: CalendarDay[] = [];
  const weekdayOfFirst = zonedParts(zonedInstant(year, month, 1, 12, 0, 0, tz), tz).weekday;
  for (let i = 0; i < leadingCells(weekdayOfFirst); i++) {
    out.push({ day: 0, start: 0, end: 0, bars: 0, outside: true });
  }
  const count = daysInMonth(year, month);
  for (let day = 1; day <= count; day++) {
    const start = zonedDayStart(year, month, day, tz);
    const end = zonedDayStart(year, month, day + 1, tz);
    const lo = lowerBound(cols, start, limit);
    const hi = upperBound(cols, end - 1, limit);
    out.push({ day, start, end, bars: Math.max(0, hi - lo), outside: false });
  }
  while (out.length % 7 !== 0) out.push({ day: 0, start: 0, end: 0, bars: 0, outside: true });
  return out;
}
