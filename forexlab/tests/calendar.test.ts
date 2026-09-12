/**
 * Go-to-date calendar maths: local day boundaries, per-day coverage, replay
 * barrier awareness and month-length edge cases.
 */

import { describe, expect, it } from 'vitest';
import { leadingCells, monthDays, zonedDayStart } from '../src/core/time/calendar.ts';
import { syntheticCandles } from '../src/core/data/synthetic.ts';
import { aggregateSeries, CandleSeries } from '../src/core/data/series.ts';
import { daysInMonth } from '../src/core/time/tz.ts';

function series(bars: number) {
  const { cols } = syntheticCandles({ bars, tf: '1m', start: Date.UTC(2024, 0, 2, 0, 0), seed: 7 });
  return new CandleSeries({ symbol: 'EURUSD', tf: '1m', tz: 'UTC', cols, hasVolume: true });
}

describe('calendar day boundaries', () => {
  it('normalises overflowing dates instead of rolling into the wrong month', () => {
    expect(zonedDayStart(2024, 1, 1, 'UTC')).toBe(Date.UTC(2024, 0, 1));
    expect(zonedDayStart(2024, 2, 30, 'UTC')).toBe(Date.UTC(2024, 2, 1)); // Feb 2024 has 29 days
    expect(zonedDayStart(2024, 4, 31, 'UTC')).toBe(Date.UTC(2024, 4, 1)); // Apr -> May 1
    expect(zonedDayStart(2024, 12, 32, 'UTC')).toBe(Date.UTC(2025, 0, 1)); // year rollover
    expect(zonedDayStart(2024, 1, 0, 'UTC')).toBe(Date.UTC(2023, 11, 31)); // backwards
    expect(zonedDayStart(2023, 3, 1, 'UTC')).toBe(Date.UTC(2023, 2, 1));
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
  });

  it('uses the zone, not UTC, for a day boundary', () => {
    // Tokyo midnight is the previous day 15:00 UTC.
    expect(zonedDayStart(2024, 3, 15, 'Asia/Tokyo')).toBe(Date.UTC(2024, 2, 14, 15));
    expect(zonedDayStart(2024, 3, 15, 'America/New_York')).toBe(Date.UTC(2024, 2, 15, 4));
  });

  it('spans 23 or 25 hours across DST transitions in the chart zone', () => {
    // 31 March 2024 in London: clocks jump 01:00 -> 02:00 UTC.
    const spring = zonedDayStart(2024, 3, 31, 'Europe/London');
    const next = zonedDayStart(2024, 4, 1, 'Europe/London');
    expect(next - spring).toBe(23 * 3_600_000);
    const autumn = zonedDayStart(2024, 10, 27, 'Europe/London');
    expect(zonedDayStart(2024, 10, 28, 'Europe/London') - autumn).toBe(25 * 3_600_000);
  });

  it('pads a Monday-first grid', () => {
    // 1 April 2024 was a Monday -> no leading blanks; 1 May 2024 Wednesday -> 2.
    expect(leadingCells(1)).toBe(0);
    expect(leadingCells(3)).toBe(2);
    expect(leadingCells(0)).toBe(6);
  });
});

describe('per-day coverage', () => {
  it('counts every bar exactly once across the month', () => {
    const s = series(2000); // 2000 one-minute bars starting 2024-01-02
    const days = monthDays(s.cols, s.count, 2024, 1, 'UTC');
    const real = days.filter((d) => !d.outside);
    expect(real).toHaveLength(31);
    const total = real.reduce((a, d) => a + d.bars, 0);
    const inMonth = (() => {
      const from = zonedDayStart(2024, 1, 1, 'UTC');
      const to = zonedDayStart(2024, 2, 1, 'UTC');
      let n = 0;
      for (let i = 0; i < s.count; i++) if (s.time(i) >= from && s.time(i) < to) n++;
      return n;
    })();
    expect(total).toBe(inMonth);
    expect(total).toBeGreaterThan(1000);
  });

  it('marks weekend days empty because the fixture skips them', () => {
    const s = series(9000); // spans the first weekend of January 2024
    const days = monthDays(s.cols, s.count, 2024, 1, 'UTC');
    const sat = days.find((d) => d.day === 6)!; // Saturday
    const fri = days.find((d) => d.day === 5)!;
    expect(sat.bars).toBe(0);
    expect(fri.bars).toBeGreaterThan(0);
    expect(days.length % 7).toBe(0);
  });

  it('reports a day as empty when the replay barrier hides it', () => {
    const s = series(2000);
    const lastDay = s.count - 1;
    const cut = Math.floor(s.count / 2);
    const before = monthDays(s.cols, lastDay + 1, 2024, 1, 'UTC');
    const after = monthDays(s.cols, cut, 2024, 1, 'UTC');
    const withBars = (list: typeof before) => list.filter((d) => d.bars > 0).length;
    expect(withBars(after)).toBeLessThan(withBars(before));
    // Bars past the barrier must not be counted anywhere.
    const total = after.reduce((a, d) => a + d.bars, 0);
    expect(total).toBe(cut);
  });

  it('works on aggregated series with the same day totals', () => {
    const s = series(2000);
    const h1 = aggregateSeries(s, '1H', 'UTC');
    const a = monthDays(s.cols, s.count, 2024, 1, 'UTC').reduce((x, d) => x + d.bars, 0);
    const b = monthDays(h1.cols, h1.count, 2024, 1, 'UTC').reduce((x, d) => x + d.bars, 0);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThanOrEqual(a);
    // Both cover the identical time span.
    const spanA = monthDays(s.cols, s.count, 2024, 1, 'UTC').filter((d) => d.bars > 0).length;
    const spanB = monthDays(h1.cols, h1.count, 2024, 1, 'UTC').filter((d) => d.bars > 0).length;
    expect(spanB).toBe(spanA);
  });
});
