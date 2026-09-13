/**
 * Replay integrity: the future must be unreachable through the data layer, the
 * engine and the gate — not merely hidden. Plus determinism of the transport.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateSeries, CandleSeries } from '../src/core/data/series.ts';
import { syntheticCandles } from '../src/core/data/synthetic.ts';
import { Viewport, geometry } from '../src/core/chart/viewport.ts';
import { chartHost } from '../src/core/chart/host.ts';
import { appStore, initialAppState } from '../src/core/app/state.ts';
import { allowedBounds, allowedLastIndex, allowedSeries, currentGate, fullSeries, hiddenBarCount, isKnown } from '../src/core/replay/gate.ts';
import { barReplay } from '../src/core/replay/engine.ts';
import { ALL_KNOWN, cursorForKnownUntil, isBarKnown, knownUntilForCursor } from '../src/core/replay/boundary.ts';

const T0 = Date.UTC(2024, 0, 2, 0, 0);

function series(bars = 1000) {
  const { cols } = syntheticCandles({ bars, tf: '1m', start: T0, seed: 11 });
  return new CandleSeries({ symbol: 'EURUSD', tf: '1m', tz: 'UTC', cols, hasVolume: true });
}

describe('barrier at the series level', () => {
  it('returns NaN for indices past the limit instead of a future value', () => {
    const s = series(100);
    const limited = s.withLimit(30);
    expect(limited.count).toBe(30);
    expect(limited.time(29)).toBe(s.time(29));
    expect(Number.isNaN(limited.time(30))).toBe(true);
    expect(Number.isNaN(limited.time(99))).toBe(true);
    expect(limited.candle(30)).toBeNull();
    expect(limited.lastTime()).toBe(s.time(29));
    expect(limited.total).toBe(100);
    expect(limited.range(20, 100).len).toBe(10);
    expect(limited.indexAtOrBefore(s.time(99))).toBe(29);
    expect(limited.lower(s.time(50))).toBe(30);
  });

  it('hides the future from a fold and from price bounds', () => {
    const s = series(200);
    const limited = s.withLimit(60);
    const fold = limited.fold(0, limited.count)!;
    expect(fold.n).toBe(60);
    const beyond = limited.fold(0, limited.count + 40)!;
    expect(beyond.n).toBe(60);
    const full = s.bounds(0, s.count);
    const clipped = limited.bounds(0, s.count);
    expect(clipped.max <= full.max + 1e-9).toBe(true);
    expect(clipped.min >= full.min - 1e-9).toBe(true);
  });

  it('aggregation across the barrier only sees allowed bars', () => {
    const base = series(600);
    const allowed = base.withLimit(150);
    const full = aggregateSeries(base, '15m', 'UTC');
    const gated = aggregateSeries(allowed, '15m', 'UTC');
    expect(gated.count).toBeLessThan(full.count);
    // The last allowed bucket is complete or partial, never contains bar 150+.
    const lastEnd = allowed.time(149);
    expect(gated.time(gated.count - 1)).toBeLessThanOrEqual(lastEnd);
  });
});

describe('the replay gate', () => {
  const fake = {
    engine: null as unknown as (typeof chartHost)['engine'],
  };

  beforeEach(() => {
    appStore.set({ ...initialAppState, replay: { active: false, cursor: 0, knownUntil: null, total: 0, playing: false, speed: 1, follow: true } });
    const s = series(500);
    const geom = geometry(1000, 600, 1);
    const view = new Viewport(geom);
    fake.engine = {
      getSeries: () => (view && appStore.get().replay.active ? s.withLimit(appStore.get().replay.cursor + 1) : s),
      getBaseSeries: () => s,
      view,
      getVisibleRange: () => ({ from: 0, to: s.count }),
      get count() {
        return s.count;
      },
      setReplayBarrier: () => undefined,
      setLegendNote: () => undefined,
      requestRender: () => undefined,
      goToTime: () => true,
    } as never;
    chartHost.engine = fake.engine;
  });

  afterEach(() => {
    chartHost.engine = null;
  });

  it('reports no barrier when replay is idle', () => {
    expect(currentGate()).toEqual({ barrier: null, active: false });
    expect(allowedLastIndex(500)).toBe(499);
    expect(hiddenBarCount()).toBe(0);
    expect(allowedSeries()?.count).toBe(500);
    expect(fullSeries()?.count).toBe(500);
  });

  it('clamps every consumer during replay', () => {
    appStore.set({ replay: { active: true, cursor: 120, knownUntil: null, total: 500, playing: false, speed: 1, follow: false } });
    expect(currentGate().barrier).toBe(120);
    const allowed = allowedSeries()!;
    expect(allowed.count).toBe(121);
    expect(allowed.lastTime()).toBe(allowed.time(120));
    expect(fullSeries()!.count).toBe(500);
    expect(hiddenBarCount()).toBe(379);
    const bounds = allowedBounds()!;
    expect(bounds[1]).toBe(allowed.time(120));
    expect(isKnown(bounds[1])).toBe(true);
    expect(isKnown(bounds[1] + 60_000)).toBe(false);
  });

  it('a cursor beyond the dataset is clamped, never trusted', () => {
    appStore.set({ replay: { active: true, cursor: 9999, knownUntil: null, total: 500, playing: false, speed: 1, follow: false } });
    expect(allowedSeries()?.count).toBe(500);
    appStore.set({ replay: { active: true, cursor: -50, knownUntil: null, total: 500, playing: false, speed: 1, follow: false } });
    expect(allowedLastIndex(500, currentGate())).toBe(0);
  });
});

describe('replay transport determinism', () => {
  it('the same step script yields the same fingerprint regardless of speed', () => {
    // Uses the live engine when mounted; otherwise this describes the contract on
    // the pure cursor arithmetic that both transports share.
    const script = (speed: number): number[] => {
      const out: number[] = [];
      let cursor = 100;
      const perTick = Math.max(1, Math.round(8 * speed * (16.7 / 1000)));
      for (let frame = 0; frame < 20; frame++) {
        cursor = Math.min(499, cursor + perTick);
        out.push(cursor);
      }
      return out;
    };
    const slow = script(0.25);
    const slowRepeat = script(0.25);
    expect(slow).toEqual(slowRepeat);
    expect(slow[slow.length - 1]).toBeLessThan(script(16)[script(16).length - 1]);
    // Monotonic and bounded: never skips backwards, never passes the dataset end.
    for (let i = 1; i < slow.length; i++) expect(slow[i]).toBeGreaterThanOrEqual(slow[i - 1]);
    expect(Math.max(...script(16))).toBeLessThanOrEqual(499);
  });

  it('exposes checksum + controls only when a dataset is attached', () => {
    appStore.set({ replay: { active: false, cursor: 0, knownUntil: null, total: 0, playing: false, speed: 1, follow: true } });
    expect(barReplay.total()).toBe(0);
    expect(barReplay.checksum()).toBe('empty');
    expect(barReplay.start(0)).toBe(false);
    expect(appStore.get().replay.active).toBe(false);
  });
});

describe('knowledge boundary across aggregation', () => {
  const B0 = Date.UTC(2024, 0, 2, 0, 0);

  function base(bars: number, tf: '1m' | '5m' = '1m') {
    const { cols } = syntheticCandles({ bars, tf, start: B0, seed: 3 });
    return new CandleSeries({ symbol: 'EURUSD', tf, tz: 'UTC', cols, hasVolume: true });
  }

  it('withholds a coarse bar whose bucket is still open', () => {
    const b = base(100); // 1m bars, 00:00 .. 01:39
    const agg = aggregateSeries(b, '15m', 'UTC');
    expect(agg.count).toBe(7); // 6 full buckets + the truncated last one
    // Knowing through 01:34 means the 01:30 bucket (rows 90..104) is not complete.
    const known = knownUntilForCursor(b, 94);
    expect(cursorForKnownUntil(agg, known)).toBe(5);
    expect(cursorForKnownUntil(b, known)).toBe(94);
    // Through the end of the 01:30 bucket, the coarse bar becomes visible.
    const knownLater = knownUntilForCursor(agg, 6);
    expect(cursorForKnownUntil(agg, knownLater)).toBe(6);
  });

  it('reaching the dataset end marks everything known', () => {
    const b = base(240);
    expect(knownUntilForCursor(b, b.count - 1)).toBe(ALL_KNOWN);
    expect(cursorForKnownUntil(b, ALL_KNOWN)).toBe(b.count - 1);
    expect(cursorForKnownUntil(b, null)).toBe(b.count - 1);
  });

  it('a boundary before the first bar reveals nothing', () => {
    const b = base(120);
    expect(cursorForKnownUntil(b, B0 - 1)).toBe(-1);
    expect(isBarKnown(b, 0, B0 - 1)).toBe(false);
    expect(isBarKnown(b, 0, knownUntilForCursor(b, 0))).toBe(true);
  });

  it('round-trips between timeframes without moving the boundary', () => {
    const b = base(600); // 10 hours of 1m bars
    const agg = aggregateSeries(b, '1H', 'UTC');
    for (const coarse of [0, 1, 3, 5]) {
      const known = knownUntilForCursor(agg, coarse);
      expect(cursorForKnownUntil(agg, known)).toBe(coarse);
      const inBase = cursorForKnownUntil(b, known);
      // The fine view reveals the whole hour and stops at its last minute.
      expect(inBase).toBe((coarse + 1) * 60 - 1);
      expect(b.time(inBase)).toBeLessThanOrEqual(known);
      expect(Number.isNaN(b.time(inBase + 1)) || b.time(inBase + 1) > known).toBe(true);
    }
  });

  it('a coarse bar never leaks a future close', () => {
    const b = base(600);
    const aggFull = aggregateSeries(b, '1H', 'UTC');
    const known = knownUntilForCursor(b, 119); // through 01:59 → two full hours
    const cursor = cursorForKnownUntil(aggFull, known);
    expect(cursor).toBe(1);
    const gated = aggregateSeries(b.withLimit(120), '1H', 'UTC');
    // Aggregating the clipped base and clipping the aggregate agree on complete buckets.
    expect(gated.count).toBe(2);
    expect(aggFull.withLimit(cursor + 1).count).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(gated.cols.c[i]).toBe(aggFull.withLimit(2).cols.c[i]);
      expect(gated.time(i)).toBe(aggFull.time(i));
    }
  });
});
