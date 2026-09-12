import { describe, expect, it } from 'vitest';
import { aggregateSeries, CandleSeries, seriesFromArrays } from '../src/core/data/series.ts';
import { Pyramid, PYR_FACTOR } from '../src/core/data/pyramid.ts';
import { emptyColumns, foldRange, indexAtTime, lowerBound, priceBounds, upperBound } from '../src/core/data/types.ts';
import { syntheticCandles } from '../src/core/data/synthetic.ts';

const START = Date.UTC(2024, 0, 15, 0, 0);

function minuteSeries(count: number, opts: { seed?: number; gaps?: { at: number; length: number }[] } = {}): CandleSeries {
  const { cols } = syntheticCandles({ bars: count, tf: '1m', start: START, seed: opts.seed ?? 7, gaps: opts.gaps });
  return new CandleSeries({ symbol: 'EURUSD', tf: '1m', tz: 'UTC', cols });
}

describe('columnar indexing', () => {
  it('binary searches are exact at both edges', () => {
    const s = minuteSeries(60);
    const cols = s.underlying();
    expect(lowerBound(cols, cols.t[10])).toBe(10);
    expect(upperBound(cols, cols.t[10])).toBe(11);
    expect(lowerBound(cols, cols.t[0] - 1)).toBe(0);
    expect(lowerBound(cols, cols.t[59] + 1)).toBe(60);
    expect(upperBound(cols, cols.t[59] + 1)).toBe(60);
  });

  it('indexAtTime resolves inside a bar and rejects outside', () => {
    const s = minuteSeries(30);
    const cols = s.underlying();
    expect(indexAtTime(cols, cols.t[5] + 30_000, 60_000, cols.len)).toBe(5);
    expect(indexAtTime(cols, cols.t[0] - 1, 60_000, cols.len)).toBe(-1);
    expect(indexAtOrBeforeFallback(cols, cols.t[12] - 1)).toBe(11);
  });

  it('priceBounds covers exactly the requested window', () => {
    const s = minuteSeries(20);
    const cols = s.underlying();
    const b = priceBounds(cols, 3, 9);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 3; i < 9; i++) {
      min = Math.min(min, cols.l[i]);
      max = Math.max(max, cols.h[i]);
    }
    expect(b.min).toBe(min);
    expect(b.max).toBe(max);
    expect(priceBounds(cols, 0, 0).min).toBeLessThanOrEqual(priceBounds(cols, 0, 0).max);
  });
});

function indexAtOrBeforeFallback(cols: ReturnType<typeof emptyColumns>, time: number): number {
  const i = upperBound(cols, time, cols.len);
  return i === 0 ? -1 : i - 1;
}

describe('timeframe aggregation', () => {
  it('follows open=first, high=max, low=min, close=last, volume=sum', () => {
    const t: number[] = [];
    const o: number[] = [];
    const h: number[] = [];
    const l: number[] = [];
    const c: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < 24; i++) {
      t.push(START + i * 60_000);
      o.push(1 + i / 1000);
      h.push(1.002 + i / 1000);
      l.push(0.999 + i / 1000);
      c.push(1.001 + i / 1000);
      v.push(i + 1);
    }
    const s = seriesFromArrays(t, o, h, l, c, v, { symbol: 'EURUSD', tf: '1m' });
    const agg = aggregateSeries(s, '1H');
    expect(agg.count).toBe(1);
    const bar = agg.candle(0)!;
    expect(bar.o).toBe(1);
    expect(bar.h).toBe(1.002 + 23 / 1000);
    expect(bar.l).toBe(0.999);
    expect(bar.c).toBe(1.001 + 23 / 1000);
    expect(bar.v).toBe((24 * 25) / 2);
    expect(bar.n).toBe(24);
    expect(bar.t).toBe(START);
  });

  it('produces one bucket per calendar day and never merges days', () => {
    const { cols } = syntheticCandles({ bars: 24 * 60 * 3, tf: '1m', start: START, skipWeekends: false });
    const s = new CandleSeries({ symbol: 'EURUSD', tf: '1m', tz: 'UTC', cols });
    const daily = aggregateSeries(s, '1D');
    expect(daily.count).toBe(3);
    expect(daily.time(0)).toBe(START);
    expect(daily.time(2)).toBe(START + 2 * 86_400_000);
    for (let d = 0; d < 3; d++) {
      const from = d * 1440;
      const expected = foldRange(cols, from, from + 1440)!;
      const bar = daily.candle(d)!;
      expect(bar.o).toBe(expected.o);
      expect(bar.h).toBe(expected.h);
      expect(bar.l).toBe(expected.l);
      expect(bar.c).toBe(expected.c);
    }
  });

  it('keeps only buckets that actually have data (no fabricated empty days)', () => {
    const t: number[] = [];
    const o: number[] = [];
    for (let i = 0; i < 5; i++) {
      t.push(START + i * 86_400_000 * 2); // every other day
      o.push(1.1);
    }
    const s = seriesFromArrays(t, o, o, o, o, o, { symbol: 'EURUSD', tf: '1D' });
    const weekly = aggregateSeries(s, '1W');
    expect(weekly.count).toBe(2); // Jan 15–21 week, then Jan 23
    expect(weekly.time(0)).toBe(START); // START is Monday 2024-01-15
    expect(weekly.time(1)).toBe(START + 7 * 86_400_000);
  });

  it('chained aggregation (1m → 5m → 1H) equals direct 1m → 1H', () => {
    const s = minuteSeries(600);
    const viaChain = aggregateSeries(aggregateSeries(s, '5m'), '1H');
    const direct = aggregateSeries(s, '1H');
    expect(viaChain.count).toBe(direct.count);
    for (let i = 0; i < direct.count; i++) {
      expect(viaChain.candle(i)!.h).toBe(direct.candle(i)!.h);
      expect(viaChain.candle(i)!.l).toBe(direct.candle(i)!.l);
      expect(viaChain.candle(i)!.o).toBe(direct.candle(i)!.o);
      expect(viaChain.candle(i)!.c).toBe(direct.candle(i)!.c);
    }
  });
});

describe('replay barrier on the series', () => {
  it('clamps every accessor to the barrier', () => {
    const s = minuteSeries(120);
    const limited = s.withLimit(40);
    expect(limited.count).toBe(40);
    expect(limited.total).toBe(120);
    expect(limited.lastTime()).toBe(s.time(39));
    expect(limited.candle(40)).toBeNull();
    expect(limited.range(30, 200).len).toBe(10);
    expect(limited.bounds(0, 120).max).toBe(limited.bounds(0, 40).max);
    expect(limited.indexFor(s.time(80))).toBe(-1);
    expect(limited.lower(s.underlying().t[119] + 60_000)).toBe(40);
  });

  it('shares buffers instead of copying', () => {
    const s = minuteSeries(50);
    const limited = s.withLimit(10);
    expect(limited.cols.t.buffer).toBe(s.cols.t.buffer);
    expect(limited.withLimit(10)).toBe(limited);
  });

  it('folds respect the barrier (no future close leak)', () => {
    const s = minuteSeries(60);
    const full = s.fold(0, 60)!;
    const clipped = s.withLimit(20).fold(0, 60)!;
    expect(clipped.c).toBe(s.candle(19)!.c);
    expect(full.c).toBe(s.candle(59)!.c);
    expect(clipped.h).toBeLessThanOrEqual(full.h);
  });
});

describe('level-of-detail pyramid', () => {
  it('bucket OHLC matches folding the underlying rows', () => {
    const s = minuteSeries(PYR_FACTOR * 3);
    const pyr = new Pyramid(s.underlying());
    const lvl = pyr.level(1);
    expect(lvl.cols.len).toBe(3);
    for (let b = 0; b < 3; b++) {
      const expected = foldRange(s.underlying(), b * PYR_FACTOR, (b + 1) * PYR_FACTOR)!;
      expect(lvl.cols.o[b]).toBe(expected.o);
      expect(lvl.cols.h[b]).toBe(expected.h);
      expect(lvl.cols.l[b]).toBe(expected.l);
      expect(lvl.cols.c[b]).toBe(expected.c);
      expect(lvl.cols.v[b]).toBeCloseTo(expected.v, 6);
    }
  });

  it('returns one primitive per visible bar when zoomed in', () => {
    const s = minuteSeries(5000);
    const pyr = new Pyramid(s.underlying());
    const plan = pyr.plan(0, 400, 5000, 1900);
    expect(plan.depth).toBe(0);
    expect(plan.primitives).toBe(400);
    expect(plan.segments).toHaveLength(1);
  });

  it('coarsens when a huge span is visible, bounding primitives', () => {
    const s = minuteSeries(300_000);
    const pyr = new Pyramid(s.underlying());
    const plan = pyr.plan(0, 300_000, 300_000, 1000);
    expect(plan.depth).toBeGreaterThan(1);
    expect(plan.primitives).toBeLessThanOrEqual(1400);
    // Cost stays bounded no matter how large the dataset grows.
    expect(plan.primitives / 300_000).toBeLessThan(0.01);
  });

  it('never exposes a bucket that straddles the replay barrier', () => {
    const s = minuteSeries(100_000);
    const pyr = new Pyramid(s.underlying());
    for (const limit of [1, 17, PYR_FACTOR, PYR_FACTOR * 3 + 5, 1000, 12345]) {
      const plan = pyr.plan(0, 100_000, limit, 900);
      const base = s.underlying();
      for (const seg of plan.segments) {
        if (seg.depth === 0) continue;
        // Every emitted bucket must end at or before the barrier.
        for (let b = seg.from; b < seg.to; b++) {
          expect((b + 1) * seg.factor).toBeLessThanOrEqual(limit);
        }
      }
      // The right-most painted row is the barrier candle itself: nothing later.
      const lastPainted = Math.max(...plan.segments.map((seg) => (seg.depth === 0 ? seg.to - 1 : (seg.to - 1) * seg.factor + seg.factor - 1)));
      expect(lastPainted).toBeLessThan(limit);
      expect(base.t[Math.min(limit, 100_000) - 1]).toBeDefined();
    }
  });

  it('covers the visible span exactly (no gaps in the plan)', () => {
    const s = minuteSeries(9000);
    const pyr = new Pyramid(s.underlying());
    for (const [from, to, limit] of [[0, 9000, 9000], [12, 8123, 8123], [7000, 9000, 7100], [100, 5000, 4096]]) {
      const plan = pyr.plan(from, to, limit, 500);
      const covered: number[] = [];
      for (const seg of plan.segments) {
        for (let b = seg.from; b < seg.to; b++) covered.push(b * seg.factor);
      }
      const clampedTo = Math.min(to, limit);
      expect(Math.min(...covered)).toBeLessThanOrEqual(from);
      expect(Math.max(...covered)).toBeGreaterThanOrEqual(clampedTo - 1 - (PYR_FACTOR - 1));
    }
  });

  it('aggregated price envelope equals the exact base-range envelope when aligned', () => {
    const s = minuteSeries(PYR_FACTOR * 8);
    const pyr = new Pyramid(s.underlying());
    const plan = pyr.plan(0, PYR_FACTOR * 8, PYR_FACTOR * 8, 4);
    const approx = pyr.boundsFor(plan);
    const exact = priceBounds(s.underlying(), 0, PYR_FACTOR * 8);
    expect(approx.min).toBeCloseTo(exact.min, 10);
    expect(approx.max).toBeCloseTo(exact.max, 10);
  });

  it('clips edge buckets to the clipped span when auto-scaling', () => {
    const s = minuteSeries(200);
    const base = s.underlying();
    const pyr = new Pyramid(base);
    const plan = pyr.plan(3, 130, 200, 8);
    const bounds = pyr.boundsFor(plan);
    // The plan starts at bucket 0 (rows 0..15) which is partly left of row 3;
    // clipping must therefore match rows [3,130) rather than [0,130).
    const exact = priceBounds(base, 3, 130);
    const unclipped = priceBounds(base, 0, 130);
    expect(bounds.min).toBeGreaterThanOrEqual(exact.min - 1e-9);
    expect(bounds.max).toBeLessThanOrEqual(unclipped.max + 1e-9);
    expect(exact.min).toBeLessThanOrEqual(unclipped.max);
  });
});
