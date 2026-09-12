/**
 * Timezone helpers built on Intl (no external dependency).
 *
 * Provides wall-clock offset resolution (DST aware), calendar bucket floors for
 * day/week/month timeframes, and formatting used across the app.
 */

import { timeframe, type TimeframeId } from './timeframes.ts';

const MIN = 60_000;

export const UTC = 'UTC';

interface FormatCache {
  dtf: Intl.DateTimeFormat;
  fmt: Intl.DateTimeFormat;
}
const FORMATS = new Map<string, FormatCache>();

function formatters(tz: string): FormatCache {
  let hit = FORMATS.get(tz);
  if (hit) return hit;
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    era: 'short',
  };
  hit = {
    dtf: new Intl.DateTimeFormat('en-CA', opts),
    fmt: new Intl.DateTimeFormat('en-US', { ...opts, era: undefined }),
  };
  FORMATS.set(tz, hit);
  return hit;
}

/** Wall-clock components of instant `t` inside `tz`. */
export function zonedParts(t: number, tz: string): ZonedParts {
  if (tz === UTC || tz === '' || tz.toLowerCase() === 'utc') {
    const d = new Date(t);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      weekday: d.getUTCDay(),
    };
  }
  const { dtf } = formatters(tz);
  const parts = partsFrom(dtf, t);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    weekday: weekdayFromParts(parts.year, parts.month, parts.day),
  };
}

interface RawParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsFrom(dtf: Intl.DateTimeFormat, t: number): RawParts {
  const found: Record<string, string> = {};
  for (const p of dtf.formatToParts(t)) {
    if (p.type !== 'literal') found[p.type] = p.value;
  }
  let hour = Number(found.hour ?? 0);
  if (hour === 24) hour = 0; // some engines render midnight as 24:00:00
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    hour,
    minute: Number(found.minute ?? 0),
    second: Number(found.second ?? 0),
  };
}

function weekdayFromParts(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export interface ZonedParts extends RawParts {
  weekday: number;
}

/** Treat zoned wall clock as UTC to derive the zone offset. DST-correct. */
export function tzOffsetMs(t: number, tz: string): number {
  if (tz === UTC || tz === '' || tz.toLowerCase() === 'utc') return 0;
  const p = zonedParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(t / MIN) * MIN) / MIN) * MIN;
}

export function isKnownTimeZone(tz: string): boolean {
  if (tz === UTC || tz === '') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** floor(t) in the given zone, expressed back as an absolute instant. */
export function floorToDay(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  return toUtcFromZoned(p.year, p.month, p.day, 0, 0, 0, tz);
}

/** Weeks start on Monday (forex/ISO convention). */
export function floorToWeek(t: number, tz: string): number {
  const dayStart = floorToDay(t, tz);
  const wd = zonedParts(dayStart, tz).weekday; // 0=Sun
  const back = (wd === 0 ? 6 : wd - 1) * 86_400_000;
  return adjustToZonedMidnight(dayStart - back, tz);
}

export function floorToMonth(t: number, tz: string, months = 1): number {
  const p = zonedParts(t, tz);
  const m0 = Math.floor((p.month - 1) / months) * months + 1;
  return toUtcFromZoned(p.year, m0, 1, 0, 0, 0, tz);
}

function toUtcFromZoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Correct for the offset in force around the guessed instant (DST edges).
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(guess, tz);
    const corrected = guess - off;
    if (corrected === guess) return guess;
    // Recompute using offset at the corrected instant to handle transitions.
    const off2 = tzOffsetMs(corrected, tz);
    const next = guess - off2;
    if (next === corrected) return corrected;
    if (next === guess) return guess;
    return corrected;
  }
  return guess;
}

function adjustToZonedMidnight(t: number, tz: string): number {
  return floorToDay(t, tz);
}

/** Add calendar months to a zoned instant, clamping the day-of-month (Jan 31 +1M → Feb 28/29). */
export function addMonthsZoned(t: number, months: number, tz: string): number {
  const p = zonedParts(t, tz);
  const total = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const dim = daysInMonth(year, month);
  return toUtcFromZoned(year, month, Math.min(p.day, dim), p.hour, p.minute, p.second, tz);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Start of the bucket containing `t` for timeframe `id`. */
export function floorToTimeframe(t: number, id: TimeframeId, tz: string): number {
  const tf = timeframe(id);
  switch (tf.kind) {
    case 'intraday': {
      const step = tf.ms!;
      if (tz === UTC || tz === '') return Math.floor(t / step) * step;
      // Offset-aware floor for zones with non-hour sub-day shifts.
      const off = tzOffsetMs(t, tz);
      return Math.floor((t + off) / step) * step - off;
    }
    case 'day':
      return floorToDay(t, tz);
    case 'week':
      return floorToWeek(t, tz);
    case 'month':
      return floorToMonth(t, tz, tf.months ?? 1);
  }
}

/**
 * End instant (exclusive) of the bucket starting at `start`.
 *
 * Day/week buckets are calendar-aware in a zone with DST, so a spring-forward
 * day really is 23 hours long — that keeps gap analysis from inventing a
 * missing hour every March.
 */
export function bucketEnd(start: number, id: TimeframeId, tz: string): number {
  const tf = timeframe(id);
  switch (tf.kind) {
    case 'intraday':
      return start + tf.ms!;
    case 'day':
    case 'week': {
      const nominal = start + tf.ms!;
      if (tz === UTC || tz === '' || tz.toLowerCase() === 'utc') return nominal;
      // Probe past the nominal end: a DST day is 23h or 25h long, so the next
      // bucket start is the next *zoned* day boundary, not start + 24h.
      const probe = floorToTimeframe(nominal + 6 * 3_600_000, id, tz);
      return probe > start ? probe : nominal;
    }
    case 'month':
      return addMonthsZoned(start, tf.months ?? 1, tz);
  }
}

/** The next bucket start strictly after `t`. */
export function nextBucket(t: number, id: TimeframeId, tz: string): number {
  const f = floorToTimeframe(t, id, tz);
  const e = bucketEnd(f, id, tz);
  return t < e ? e : bucketEnd(e, id, tz);
}

const PAD = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatDate(t: number, tz = UTC): string {
  const p = zonedParts(t, tz);
  return `${p.year}-${PAD(p.month)}-${PAD(p.day)}`;
}

export function formatTime(t: number, tz = UTC, withSeconds = false): string {
  const p = zonedParts(t, tz);
  return withSeconds
    ? `${PAD(p.hour)}:${PAD(p.minute)}:${PAD(p.second)}`
    : `${PAD(p.hour)}:${PAD(p.minute)}`;
}

export function formatDateTime(t: number, tz = UTC, withSeconds = false): string {
  return `${formatDate(t, tz)} ${formatTime(t, tz, withSeconds)}`;
}

/** Parse `YYYY-MM-DD[THH:mm[:ss]]` in the given zone into an absolute instant. */
export function zonedToInstant(input: string, tz: string): number | null {
  const m =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      input.trim(),
    );
  if (!m) return null;
  const [, ys, mos, ds, hs = '0', ms = '0', ss = '0', frac, zone] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(ms);
  const second = Number(ss);
  const milli = frac ? Number(frac.padEnd(3, '0')) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  if (zone === 'Z') return Date.UTC(year, month - 1, day, hour, minute, second, milli);
  if (zone) {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const off = sign * (Number(digits.slice(0, 2)) * 3_600_000 + Number(digits.slice(2, 4) || 0) * 60_000);
    return Date.UTC(year, month - 1, day, hour, minute, second, milli) - off;
  }
  return toUtcFromZoned(year, month, day, hour, minute, second, tz);
}
