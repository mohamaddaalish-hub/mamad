import { describe, expect, it } from 'vitest';
import { TIMEFRAMES, canAggregate, isTimeframeId, timeframe } from '../src/core/time/timeframes.ts';
import {
  addMonthsZoned,
  bucketEnd,
  floorToTimeframe,
  formatDate,
  formatTime,
  nextBucket,
  tzOffsetMs,
  zonedToInstant,
} from '../src/core/time/tz.ts';
import { medianPositiveDelta, matchTimeframe } from '../src/core/csv/market.ts';
import { createResolver } from '../src/core/time/wallclock.ts';

const DAY = 86_400_000;

describe('timeframe definitions', () => {
  it('covers every required timeframe in finest→coarsest order', () => {
    expect(TIMEFRAMES.map((t) => t.id)).toEqual([
      '1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '8H', '12H', '1D', '1W', '1M',
    ]);
    expect(TIMEFRAMES.every((t, i) => i === 0 || t.rank > TIMEFRAMES[i - 1].rank)).toBe(true);
  });

  it('intraday steps divide a UTC day evenly (no drifting buckets)', () => {
    for (const tf of TIMEFRAMES) {
      if (tf.kind !== 'intraday') continue;
      expect(DAY % tf.ms!).toBe(0);
    }
  });

  it('only aggregates finer into coarser', () => {
    expect(canAggregate('1m', '1H')).toBe(true);
    expect(canAggregate('1H', '1m')).toBe(false);
    expect(canAggregate('5m', '5m')).toBe(true);
    expect(isTimeframeId('2H')).toBe(true);
    expect(isTimeframeId('45m')).toBe(false);
  });
});

describe('calendar bucket arithmetic', () => {
  it('floors intraday buckets in UTC', () => {
    const t = Date.UTC(2024, 2, 15, 16, 37, 12);
    expect(floorToTimeframe(t, '15m', 'UTC')).toBe(Date.UTC(2024, 2, 15, 16, 30));
    expect(floorToTimeframe(t, '1H', 'UTC')).toBe(Date.UTC(2024, 2, 15, 16));
    expect(floorToTimeframe(t, '4H', 'UTC')).toBe(Date.UTC(2024, 2, 15, 16));
    expect(floorToTimeframe(t, '12H', 'UTC')).toBe(Date.UTC(2024, 2, 15, 12));
    expect(floorToTimeframe(t, '8H', 'UTC')).toBe(Date.UTC(2024, 2, 15, 16));
  });

  it('1D/1W/1M align to the chart timezone, not to UTC midnight', () => {
    // 22:00 UTC on a Friday is Saturday 00:00 in Tokyo (+09:00).
    const t = Date.UTC(2024, 2, 15, 22);
    expect(formatDate(floorToTimeframe(t, '1D', 'UTC'), 'UTC')).toBe('2024-03-15');
    expect(formatDate(floorToTimeframe(t, '1D', 'Asia/Tokyo'), 'Asia/Tokyo')).toBe('2024-03-16');
    // Week starts Monday.
    expect(new Date(floorToTimeframe(t, '1W', 'UTC')).getUTCDay()).toBe(1);
    expect(floorToTimeframe(t, '1M', 'UTC')).toBe(Date.UTC(2024, 2, 1));
  });

  it('month buckets are calendar-exact (28/29/31 day months)', () => {
    expect(bucketEnd(Date.UTC(2024, 1, 1), '1M', 'UTC') - Date.UTC(2024, 1, 1)).toBe(29 * DAY); // leap
    expect(bucketEnd(Date.UTC(2023, 1, 1), '1M', 'UTC') - Date.UTC(2023, 1, 1)).toBe(28 * DAY);
    expect(bucketEnd(Date.UTC(2024, 0, 1), '1M', 'UTC')).toBe(Date.UTC(2024, 1, 1));
    expect(nextBucket(Date.UTC(2024, 0, 15), '1M', 'UTC')).toBe(Date.UTC(2024, 1, 1));
    expect(addMonthsZoned(Date.UTC(2024, 0, 31), 1, 'UTC')).toBe(Date.UTC(2024, 1, 29));
  });

  it('DST transitions are honoured by the zone (Europe/London springs forward)', () => {
    const before = Date.UTC(2024, 2, 31, 0, 30); // 00:30 GMT
    const after = Date.UTC(2024, 2, 31, 1, 30); // 02:30 BST (01:30 skipped)
    expect(tzOffsetMs(before, 'Europe/London')).toBe(0);
    expect(tzOffsetMs(after, 'Europe/London')).toBe(3_600_000);
    // A 1D bucket across the transition day is 23 hours long.
    const dayStart = floorToTimeframe(before, '1D', 'Europe/London');
    expect(bucketEnd(dayStart, '1D', 'Europe/London') - dayStart).toBe(23 * 3_600_000);
    // And the autumn fall-back day is 25 hours long.
    const autumn = floorToTimeframe(Date.UTC(2024, 9, 27, 3), '1D', 'Europe/London');
    expect(bucketEnd(autumn, '1D', 'Europe/London') - autumn).toBe(25 * 3_600_000);
  });

  it('formats and parses zoned wall clock round-trip', () => {
    const instant = Date.UTC(2024, 2, 15, 16, 0);
    expect(formatDate(instant, 'UTC')).toBe('2024-03-15');
    expect(formatTime(instant, 'America/New_York')).toBe('12:00');
    expect(zonedToInstant('2024-03-15 16:00', 'UTC')).toBe(instant);
    expect(zonedToInstant('2024-03-15 12:00', 'America/New_York')).toBe(instant);
    expect(zonedToInstant('2024-03-15T16:00:00Z', 'Asia/Tokyo')).toBe(instant);
    expect(zonedToInstant('garbage', 'UTC')).toBeNull();
    expect(zonedToInstant('2024-13-45', 'UTC')).toBeNull();
  });
});

describe('timezone resolution for bulk import', () => {
  it('matches Intl offsets on ordinary days and DST days', () => {
    const tz = 'America/New_York';
    const r = createResolver(tz);
    const samples = [
      Date.UTC(2024, 0, 5, 12),
      Date.UTC(2024, 2, 10, 6), // day before US spring-forward
      Date.UTC(2024, 2, 10, 8),
      Date.UTC(2024, 6, 15),
      Date.UTC(2024, 10, 3, 5), // US fall-back day
    ];
    for (const utc of samples) {
      const wall = utc + tzOffsetMs(utc, tz);
      const back = r.toInstant(wall);
      // Within an hour on ambiguous local times; exact otherwise.
      expect(Math.abs(back - utc)).toBeLessThanOrEqual(3_600_000);
      if (utc !== Date.UTC(2024, 10, 3, 5)) expect(back).toBe(utc);
    }
  });

  it('UTC resolver is identity', () => {
    const r = createResolver('UTC');
    expect(r.isUtc).toBe(true);
    expect(r.toInstant(123456789)).toBe(123456789);
    expect(r.offsetAt(0)).toBe(0);
  });
});

describe('timeframe inference from row spacing', () => {
  it('recognises standard spacings', () => {
    const tf = timeframe('1m');
    const times = Float64Array.from({ length: 100 }, (_, i) => i * tf.ms!);
    expect(matchTimeframe(medianPositiveDelta(times))).toBe('1m');
    expect(matchTimeframe(medianPositiveDelta(Float64Array.from({ length: 50 }, (_, i) => i * 900_000)))).toBe('15m');
    expect(matchTimeframe(medianPositiveDelta(Float64Array.from({ length: 40 }, (_, i) => i * DAY)))).toBe('1D');
    expect(matchTimeframe(7 * DAY)).toBe('1W');
    expect(matchTimeframe(0)).toBeNull();
    expect(matchTimeframe(7 * 60_000)).toBeNull();
  });
});
