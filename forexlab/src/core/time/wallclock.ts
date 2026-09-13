/**
 * Fast wall-clock → instant resolution for a chosen timezone.
 *
 * Importing years of 1-minute rows means millions of conversions, so an
 * `Intl.DateTimeFormat` call per row is out of the question. Day-level offsets
 * are memoised; only days that contain a DST transition (roughly two per year)
 * fall back to the exact per-instant path.
 */

import { tzOffsetMs, UTC } from './tz.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface WallClockResolver {
  readonly tz: string;
  readonly isUtc: boolean;
  /** Convert a wall-clock reading (encoded as if it were UTC) to an absolute instant. */
  toInstant(wall: number): number;
  /** Offset (ms east of UTC) in force at an absolute instant. */
  offsetAt(instant: number): number;
}

export function createResolver(tz: string): WallClockResolver {
  const isUtc = tz === UTC || tz === '' || tz.toLowerCase() === 'utc';
  if (isUtc) {
    return { tz: UTC, isUtc: true, toInstant: (wall) => wall, offsetAt: () => 0 };
  }
  const dayOffsets = new Map<number, number>();

  const dayOffset = (day: number): number => {
    const hit = dayOffsets.get(day);
    if (hit !== undefined) return hit;
    // Noon local-ish is unambiguous for the usual 02:00/03:00 transitions.
    const off = Math.round(tzOffsetMs(day * DAY + 12 * HOUR, tz) / 60_000) * 60_000;
    dayOffsets.set(day, off);
    return off;
  };

  const dayTransitioned = (day: number): boolean => dayOffset(day) !== dayOffset(day + 1);

  const resolve = (wall: number): number => {
    const day = Math.floor(wall / DAY);
    if (dayTransitioned(day) || dayTransitioned(day - 1)) {
      // Ambiguous/skipped local times on transition days: converge with the
      // exact formatter, preferring the earlier instant for repeated hours.
      let t = wall - dayOffset(day);
      for (let i = 0; i < 4; i++) {
        const off = tzOffsetMs(t, tz);
        const next = wall - off;
        if (next === t) return t;
        t = next;
      }
      return t;
    }
    return wall - dayOffset(day);
  };

  return {
    tz,
    isUtc: false,
    toInstant: resolve,
    offsetAt: (instant: number) => tzOffsetMs(instant, tz),
  };
}
