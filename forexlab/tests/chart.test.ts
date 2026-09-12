import { describe, expect, it } from 'vitest';
import { geometry, Viewport, MAX_PX_PER_BAR, MIN_PX_PER_BAR } from '../src/core/chart/viewport.ts';
import { chooseSpan, computePriceTicks, computeTimeTicks, decimalsForStep, floorSpan, niceNumber } from '../src/core/chart/axes.ts';
import { CandleSeries, aggregateSeries } from '../src/core/data/series.ts';
import { Pyramid } from '../src/core/data/pyramid.ts';
import { syntheticCandles } from '../src/core/data/synthetic.ts';
import { PRESETS, resolveStyle } from '../src/core/chart/style.ts';

const START = Date.UTC(2024, 3, 1, 0, 0);

function series(bars = 3000, tf: '1m' | '5m' | '15m' | '1H' = '1m') {
  const { cols } = syntheticCandles({ bars: tf === '1m' ? bars : bars * 12, tf: '1m', start: START, seed: 5 });
  const s = new CandleSeries({ symbol: 'EURUSD', tf: '1m', tz: 'UTC', cols });
  return tf === '1m' ? s : aggregateSeries(s, tf);
}

const geom = geometry(1600, 900, 1);

describe('viewport transforms', () => {
  it('index↔x and price↔y round-trip', () => {
    const view = new Viewport(geom, { rightIndex: 500, pxPerBar: 8, priceMin: 1.08, priceMax: 1.09 });
    for (const i of [400, 480, 500, 505]) {
      const x = view.indexToX(i);
      expect(view.xToIndex(x)).toBeCloseTo(i, 8);
    }
    for (const p of [1.0801, 1.085, 1.0899]) {
      const y = view.priceToY(p);
      expect(view.yToPrice(y)).toBeCloseTo(p, 10);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(geom.plotBottom);
    }
  });

  it('keeps the candle under the cursor fixed while zooming', () => {
    const view = new Viewport(geom, { rightIndex: 1000, pxPerBar: 6 });
    const cursorX = 640;
    const before = view.xToIndex(cursorX);
    view.zoomAt(cursorX, 1.35, 5000);
    const after = view.xToIndex(cursorX);
    expect(after).toBeCloseTo(before, 6);
    expect(view.pxPerBar).toBeCloseTo(6 * 1.35, 6);
  });

  it('clamps zoom to sane spacing', () => {
    const view = new Viewport(geom, { rightIndex: 10, pxPerBar: 6 });
    for (let i = 0; i < 80; i++) view.zoomAt(800, 1.5, 1000);
    expect(view.pxPerBar).toBeLessThanOrEqual(MAX_PX_PER_BAR);
    for (let i = 0; i < 200; i++) view.zoomAt(800, 1 / 1.5, 1000);
    expect(view.pxPerBar).toBeGreaterThanOrEqual(MIN_PX_PER_BAR);
  });

  it('visible range only ever includes accessible candles', () => {
    const s = series(1200);
    const view = new Viewport(geom, { rightIndex: s.count + 500, pxPerBar: 4 });
    const range = view.visibleRange(s.count);
    expect(range.to).toBeLessThanOrEqual(s.count);
    expect(range.from).toBeGreaterThanOrEqual(0);
  });

  it('panning cannot walk into the future beyond the barrier', () => {
    const s = series(500).withLimit(200);
    const view = new Viewport(geom, { rightIndex: 199, pxPerBar: 10 });
    for (let i = 0; i < 40; i++) view.panBy(-400, s.count);
    expect(view.rightIndex).toBeLessThanOrEqual(s.count - 1 + view.visibleBars() * 0.6 + 1);
    expect(s.lastTime()).toBe(s.underlying().t[199]);
  });

  it('fitAll shows the whole accessible span', () => {
    const s = series(900);
    const view = new Viewport(geom);
    view.fitAll(s.count);
    const range = view.visibleRange(s.count);
    expect(range.from).toBe(0);
    expect(view.indexToX(s.count - 1)).toBeLessThanOrEqual(geom.plotRight);
  });

  it('auto price bounds add symmetric padding', () => {
    const view = new Viewport(geom);
    view.applyPriceBounds(1.08, 1.09);
    expect(view.priceMax - view.priceMin).toBeGreaterThan(0.01);
    expect(view.priceMax).toBeGreaterThan(1.09);
    expect(view.priceMin).toBeLessThan(1.08);
    view.applyPriceBounds(1.08, 1.08); // flat market still yields a usable scale
    expect(view.priceMax).toBeGreaterThan(view.priceMin);
  });
});

describe('axis tick generation', () => {
  it('time ticks land on real bar boundaries and stay inside the plot', () => {
    const s = series(2000, '1m');
    const view = new Viewport(geom, { rightIndex: s.count - 1, pxPerBar: 6, priceMin: 1, priceMax: 1.2 });
    const range = view.visibleRange(s.count);
    const ticks = computeTimeTicks(s, view, range, { tz: 'UTC' });
    expect(ticks.length).toBeGreaterThan(3);
    for (const tick of ticks) {
      expect(tick.x).toBeGreaterThan(0);
      expect(tick.x).toBeLessThan(geom.plotRight);
      expect(tick.index).toBeGreaterThanOrEqual(range.from);
      expect(tick.index).toBeLessThan(s.count);
    }
    // Monotonic x and increasing time.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].x).toBeGreaterThan(ticks[i - 1].x);
      expect(ticks[i].time).toBeGreaterThan(ticks[i - 1].time);
    }
  });

  it('picks coarser spans as the view zooms out, and never overlaps labels', () => {
    const s = series(2000, '1m');
    const fine = chooseSpan(s, 12);
    const coarse = chooseSpan(s, 0.5);
    expect(fine.ms!).toBeLessThan(coarse.ms ?? Infinity);
    const view = new Viewport(geom, { rightIndex: s.count - 1, pxPerBar: 0.5, priceMin: 1, priceMax: 1.2 });
    const ticks = computeTimeTicks(s, view, view.visibleRange(s.count), { tz: 'UTC' });
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].x - ticks[i - 1].x).toBeGreaterThanOrEqual(48);
  });

  it('sub-day spans anchor to local midnight in the chart timezone', () => {
    const t = Date.UTC(2024, 6, 10, 13, 17);
    expect(floorSpan(t, 4 * 3_600_000, 'UTC')).toBe(Date.UTC(2024, 6, 10, 12));
    // Jul 10 12:00 in Tokyo = Jul 10 03:00 UTC.
    // 13:17 UTC is 22:17 in Tokyo, so the 4H grid floor is 20:00 JST = 11:00 UTC.
    expect(floorSpan(t, 4 * 3_600_000, 'Asia/Tokyo')).toBe(Date.UTC(2024, 6, 10, 11));
    expect(floorSpan(t, 86_400_000, 'UTC')).toBe(Date.UTC(2024, 6, 10));
    expect(floorSpan(t, 7 * 86_400_000, 'UTC')).toBe(Date.UTC(2024, 6, 8)); // Monday
  });

  it('price ticks use a nice step with enough decimals', () => {
    const view = new Viewport(geom, { priceMin: 1.08431, priceMax: 1.09122 });
    const ticks = computePriceTicks(view, 12);
    expect(ticks.length).toBeGreaterThan(4);
    const step = ticks[1].price - ticks[0].price;
    expect(step).toBeGreaterThan(0);
    expect(niceNumber(0.00072)).toBeCloseTo(0.001, 12);
    expect(decimalsForStep(0.0025)).toBe(4);
    expect(decimalsForStep(0.0001)).toBe(4);
    expect(decimalsForStep(0.005)).toBe(3);
    expect(decimalsForStep(0.1)).toBe(1);
    for (const tick of ticks) expect(tick.label).toMatch(/^1\.\d{3,}$/);
  });
});

describe('chart styles', () => {
  it('every preset defines the full colour contract', () => {
    const keys = Object.keys(PRESETS.darkProfessional);
    for (const name of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      expect(Object.keys(PRESETS[name]).sort()).toEqual(keys.sort());
      const style = PRESETS[name];
      expect(style.background).toMatch(/^#/);
      expect(style.bull).not.toBe(style.bear);
    }
  });

  it('user overrides layer on top of a preset', () => {
    const style = resolveStyle({ theme: 'minimal', overrides: { bull: '#ffffff', gridOpacity: 0.25 } });
    expect(style.bull).toBe('#ffffff');
    expect(style.gridOpacity).toBe(0.25);
    expect(style.name).toBe(PRESETS.minimal.name);
  });
});

describe('replay-safe rendering', () => {
  it('aggregating for display never reveals a candle past the barrier', () => {
    const s = series(4000);
    const limit = 1234;
    const visible = s.withLimit(limit);
    const pyr = new Pyramid(s.cols);
    const plan = pyr.plan(0, 4000, limit, 900);
    const base = s.underlying();
    // Nothing painted may touch a base row >= limit.
    let maxRow = -1;
    for (const seg of plan.segments) {
      if (seg.depth === 0) maxRow = Math.max(maxRow, seg.to - 1);
      else maxRow = Math.max(maxRow, (seg.to - 1) * seg.factor + seg.factor - 1);
    }
    expect(maxRow).toBeLessThan(limit);
    const bounds = pyr.boundsFor(plan);
    const exactHigh = Math.max(...Array.from(base.h.slice(0, limit)));
    expect(bounds.max).toBeLessThanOrEqual(exactHigh + 1e-12);
    expect(visible.lastTime()).toBe(base.t[limit - 1]);
  });

  it('the last painted primitive is always the barrier candle', () => {
    const s = series(3000);
    const pyr = new Pyramid(s.cols);
    for (const limit of [1, 16, 17, 256, 257]) {
      const plan = pyr.plan(0, 3000, limit, 400);
      const cols = s.underlying();
      const lastSeg = plan.segments[plan.segments.length - 1];
      const lastRow = lastSeg.depth === 0 ? lastSeg.to - 1 : (lastSeg.to - 1) * lastSeg.factor + Math.min(lastSeg.factor, limit - (lastSeg.to - 1) * lastSeg.factor) - 1;
      expect(lastRow).toBeGreaterThanOrEqual(0);
      expect(cols.t[lastRow]).toBeLessThanOrEqual(cols.t[limit - 1]);
    }
  });
});
