/**
 * Raw CSV cell → number / date-time conversion.
 *
 * Deliberately conservative: anything unrecognised comes back as `null` so the
 * importer can report the row as invalid instead of guessing. Nothing here ever
 * adjusts a price or fills a hole.
 */

import type { WallClockResolver } from '../time/wallclock.ts';

export interface NumberOptions {
  /** '.' , ',' or 'auto' (default). */
  decimalSeparator?: '.' | ',' | 'auto';
  /** Accept values wrapped in parentheses as negative (accounting style). */
  allowParens?: boolean;
}

const THOUSANDS = /^(?:\d{1,3}(?:,\d{3})+|\d+)$/;

export function parseNumber(raw: string | undefined | null, opts: NumberOptions = {}): number | null {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (s.length === 0) return null;
  if (/^(?:n\/?a|na|null|nan|undefined|-+|—|–|\.)$/i.test(s)) return null;
  let sign = 1;
  if (opts.allowParens !== false && s.startsWith('(') && s.endsWith(')')) {
    sign = -1;
    s = s.slice(1, -1).trim();
  }
  // Percent signs are stripped but the magnitude is kept as reported
  // (economic releases are quoted in percent points; scaling here would
  // silently change what the user imported).
  if (s.endsWith('%')) s = s.slice(0, -1).trim();
  else if (s.endsWith('pct')) s = s.slice(0, -3).trim();
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('$') || s.startsWith('€')) s = s.slice(1);
  if (/\s/.test(s) && !/^[\d.,eE+-]+$/.test(s.replace(/\s/g, ''))) return null;
  s = s.replace(/\s/g, '').replace(/_/g, '');
  if (s.length === 0) return null;
  // Thousands-grouped integer, e.g. "10,240" or "1.024.000".
  if (THOUSANDS.test(s)) {
    const plain = s.replace(/[.,](?=\d{3}(?:[.,]\d{3})*$)/g, '');
    if (/^\d+(?:\.\d+)?$/.test(plain)) return (negative ? -1 : 1) * sign * Number(plain);
  }

  const sep = decideDecimalSeparator(s, opts.decimalSeparator ?? 'auto');
  if (sep === null) return null;
  // Decimal mark becomes '.', the other one is grouping and disappears.
  const other = sep === '.' ? ',' : '.';
  const normalized = s.replaceAll(other, '').replaceAll(sep, '.');
  if (!/^-?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return (negative ? -1 : 1) * sign * value;
}

/** '.' when the dot is the decimal mark, ',' when the comma is, null if malformed. */
function decideDecimalSeparator(s: string, mode: '.' | ',' | 'auto'): '.' | ',' | null {
  const dots = s.split('.').length - 1;
  const commas = s.split(',').length - 1;
  if (mode === '.') return commas === 0 || THOUSANDS.test(s) ? '.' : null;
  if (mode === ',') return dots === 0 || /^[.,\d]+$/.test(s) ? ',' : null;
  if (dots === 0 && commas === 0) return '.';
  if (dots === 0) {
    // Only commas: decimal comma unless it looks like thousands grouping.
    if (commas === 1 && THOUSANDS.test(s)) return null; // e.g. "1,234" -> ambiguous, treat as thousands
    return commas === 1 ? ',' : null;
  }
  if (commas === 0) return dots === 1 ? '.' : null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  return lastDot > lastComma ? '.' : ',';
}

/** Excel's day-0 for the 1900 date system. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface DateToken {
  /** Wall-clock components encoded as a UTC timestamp, or null when unparseable. */
  wall: number | null;
  /** Absolute instant when the token carried its own zone (Z / ±hh:mm). */
  absolute: number | null;
  /** Detected shape, surfaced in the importer so the user can sanity-check it. */
  format: string | null;
  error?: string;
}

/**
 * Parse the date portion of a cell.
 * Recognised: ISO, `YYYY/MM/DD`, `DD.MM.YYYY`, `DD/MM/YYYY` or `MM/DD/YYYY`
 * (per `dayFirst`), `15-Mar-2024`, `Mar 15, 2024`, compact `YYYYMMDD`,
 * Excel serial numbers, and unix epoch seconds/milliseconds.
 */
export function parseDateToken(raw: string | undefined, dayFirst: boolean): DateToken {
  const none: DateToken = { wall: null, absolute: null, format: null };
  if (raw === undefined) return none;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (s.length === 0) return none;

  // ISO 8601 (optionally with time + zone)
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (m) {
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), padMs(m[7]));
    if (!validParts(+m[2], +m[3])) return { ...none, error: `date parts out of range: ${s}` };
    if (m[8]) return { wall, absolute: applyZone(wall, m[8]), format: 'ISO-8601' };
    return { wall, absolute: null, format: 'ISO-8601' };
  }

  // Slash / dot delimited numeric with optional time
  m = /^(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:\d{1,3})?\s*(AM|PM|Z)?)?$/i.exec(s);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    let y = +m[3];
    let format = '';
    let mo: number;
    let d: number;
    if (String(m[1]).length === 4) {
      y = a; mo = b; d = +m[3];
      format = 'YYYY/MM/DD';
    } else if (a > 12 && b <= 12) {
      d = a; mo = b; format = 'DD/MM/YYYY';
    } else if (b > 12 && a <= 12) {
      d = b; mo = a; format = 'MM/DD/YYYY';
    } else {
      if (dayFirst) { d = a; mo = b; format = 'DD/MM/YYYY (day-first)'; }
      else { d = b; mo = a; format = 'MM/DD/YYYY (month-first)'; }
    }
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (!validParts(mo, d)) return { ...none, error: `date parts out of range: ${s}` };
    let hour = +(m[4] ?? 0);
    const minute = +(m[5] ?? 0);
    const second = +(m[6] ?? 0);
    if (m[8] === 'PM' && hour < 12) hour += 12;
    if (m[8] === 'AM' && hour === 12) hour = 0;
    const wall = Date.UTC(y, mo - 1, d, hour, minute, second);
    if (m[8] === 'Z') return { wall, absolute: wall, format: `${format} +Z` };
    return { wall, absolute: null, format };
  }

  // Month-name forms: 15-Mar-2024 | Mar 15 2024 | 15 Mar 2024
  m = /^(?:(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{2,4})|([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{2,4}))$/.exec(s);
  if (m) {
    const d = m[1] ? +m[1] : +m[5];
    const name = (m[2] ?? m[4] ?? '').slice(0, 3).toLowerCase();
    const y0 = m[1] ? +m[3] : +m[6];
    const mo = MONTHS[name];
    if (!mo) return { ...none, error: `unknown month name in ${s}` };
    const y = y0 < 100 ? y0 + (y0 < 70 ? 2000 : 1900) : y0;
    if (!validParts(mo, d)) return { ...none, error: `date parts out of range: ${s}` };
    return { wall: Date.UTC(y, mo - 1, d), absolute: null, format: 'DD-Mon-YYYY' };
  }

  // Compact YYYYMMDD, optionally with HHMM / HHMMSS appended
  m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/.exec(s);
  if (m) {
    if (!validParts(+m[2], +m[3])) return { ...none, error: `date parts out of range: ${s}` };
    const hour = +(m[4] ?? 0);
    const minute = +(m[5] ?? 0);
    const second = +(m[6] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) return { ...none, error: `time out of range in ${s}` };
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], hour, minute, second);
    return { wall, absolute: null, format: 'YYYYMMDD (compact)' };
  }

  // Excel serial date: whole days since 1899-12-30 (the 1900 leap-year quirk is
  // baked into that reference date), fraction = time of day.
  if (/^\d{5}(?:\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const ms = Math.round(EXCEL_EPOCH_UTC + serial * 86_400_000);
      return { wall: ms, absolute: null, format: 'Excel serial' };
    }
  }

  // Unix epoch in s / ms / us / ns
  if (/^\d{10}(?:\.\d+)?$/.test(s)) return { wall: null, absolute: Math.round(Number(s) * 1000), format: 'epoch seconds' };
  if (/^\d{13}(?:\.\d+)?$/.test(s)) return { wall: null, absolute: Number(s), format: 'epoch ms' };
  if (/^\d{16}$/.test(s)) return { wall: null, absolute: Number(s) / 1000, format: 'epoch µs' };
  if (/^\d{19}$/.test(s)) return { wall: null, absolute: Number(s) / 1e6, format: 'epoch ns' };

  return { ...none, error: `unrecognised date "${s}"` };
}

function padMs(frac: string | undefined): number {
  if (!frac) return 0;
  return Number(frac.padEnd(3, '0').slice(0, 3));
}

function applyZone(wall: number, zone: string): number {
  const sign = zone[0] === '-' ? -1 : 1;
  if (zone === 'Z') return wall;
  const digits = zone.slice(1).replace(':', '');
  const off = sign * (Number(digits.slice(0, 2)) * 3_600_000 + Number(digits.slice(2, 4) || 0) * 60_000);
  return wall - off;
}

function validParts(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** `16:30`, `16:30:00`, `4:00 PM`, `1630`, `163000` → ms into the day. */
export function parseTimeToken(raw: string | undefined | null): { ms: number | null; meridiem: boolean; format: string | null } {
  if (raw === undefined || raw === null) return { ms: null, meridiem: false, format: null };
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, ' ');
  if (s.length === 0) return { ms: null, meridiem: false, format: null };
  let m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?(?:\s*(AM|PM))?$/.exec(s);
  if (m) {
    let hour = +m[1];
    const meridiem = m[5] === 'AM' || m[5] === 'PM';
    if (m[5] === 'PM' && hour < 12) hour += 12;
    if (m[5] === 'AM' && hour === 12) hour = 0;
    if (hour > 23) return { ms: null, meridiem, format: null };
    const ms = hour * 3_600_000 + +m[2] * 60_000 + +(m[3] ?? 0) * 1000 + +(m[4] ? m[4].padEnd(3, '0') : 0);
    return { ms, meridiem, format: m[5] ? 'hh:mm AM/PM' : 'HH:mm' };
  }
  m = /^(\d{2})(\d{2})(\d{2})?$/.exec(s.replace(/[^0-9]/g, ''));
  if (m && +m[1] <= 23 && +m[2] <= 59 && (m[3] === undefined || +m[3] <= 59)) {
    return { ms: +m[1] * 3_600_000 + +m[2] * 60_000 + +(m[3] ?? 0) * 1000, meridiem: false, format: 'HHMMSS' };
  }
  // Fractional day (Excel time column)
  if (/^0?\.\d+$/.test(s)) {
    const frac = Number(s);
    return { ms: Math.round(frac * 86_400_000), meridiem: false, format: 'Excel fraction' };
  }
  return { ms: null, meridiem: false, format: null };
}

/**
 * Combine a date cell and an optional time cell into an absolute instant.
 * `resolver` maps zone wall-clock to an instant; a token carrying its own zone
 * wins over the selected timezone.
 */
export function toInstant(
  date: DateToken,
  timeMs: number | null,
  resolver: WallClockResolver,
): { instant: number | null; format: string | null; error?: string } {
  if (date.absolute !== null) {
    const base = date.absolute;
    if (timeMs === null) return { instant: base, format: date.format };
    return { instant: floorDayUtc(base) + timeMs, format: date.format };
  }
  if (date.wall === null) return { instant: null, format: null, error: date.error ?? 'missing date' };
  const wall = timeMs === null ? date.wall : floorDayUtc(date.wall) + timeMs;
  return { instant: roundMs(resolver.toInstant(wall)), format: date.format };
}

export function floorDayUtc(t: number): number {
  return Math.floor(t / 86_400_000) * 86_400_000;
}

export function roundMs(t: number): number {
  return Math.round(t);
}
