/**
 * Drawing engine unit tests: time/price anchoring, geometry, hit testing, store
 * semantics (undo/redo, lock, visibility) and persistence.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { aggregateSeries, CandleSeries } from '../src/core/data/series.ts';
import { syntheticCandles } from '../src/core/data/synthetic.ts';
import { Viewport, geometry } from '../src/core/chart/viewport.ts';
import {
  anchorIndex,
  boxOf,
  cloneDrawing,
  deserialize,
  fibExtLevels,
  fibLevels,
  hitTest,
  indexSpan,
  moveDrawing,
  newDrawing,
  priceSpan,
  project,
  serialize,
  snapPrice,
  touchesReplayBoundary,
  unproject,
  type Anchor,
} from '../src/core/draw/model.ts';
import { DrawingStore } from '../src/core/draw/store.ts';

const T0 = Date.UTC(2024, 0, 2, 8, 0);
const MIN = 60_000;

function makeSeries(bars = 600, tf: '1m' | '5m' = '1m') {
  const { cols } = syntheticCandles({ bars, tf, start: T0, seed: 42 });
  return new CandleSeries({ symbol: 'EURUSD', tf, tz: 'UTC', cols, hasVolume: true });
}

function makeView(count: number) {
  const geom = geometry(1200, 700, 2);
  const view = new Viewport(geom, { rightIndex: count - 1, pxPerBar: 6, priceMin: 1.05, priceMax: 1.12 });
  return { view, geom };
}

describe('anchors survive every view transformation', () => {
  it('maps an anchor to the bar that owns its time', () => {
    const series = makeSeries();
    const { view } = makeView(series.count);
    const anchor: Anchor = { t: series.time(120), p: 1.09 };
    const pt = project(anchor, view, series);
    expect(pt.index).toBe(120);
    expect(pt.x).toBeCloseTo(view.indexToX(120), 6);
    expect(pt.y).toBeCloseTo(view.priceToY(1.09), 6);
  });

  it('is invariant to zoom, pan and price-scale changes', () => {
    const series = makeSeries();
    const { view } = makeView(series.count);
    const anchor: Anchor = { t: series.time(200), p: 1.0875 };
    const before = project(anchor, view, series);
    view.pxPerBar = 17;
    view.rightIndex -= 40;
    view.priceMin = 1.02;
    view.priceMax = 1.15;
    const after = project(anchor, view, series);
    expect(after.index).toBe(before.index);
    expect(after.x).not.toBe(before.x); // pixels moved…
    // …but the anchored bar and price are untouched.
    expect(series.time(after.index)).toBe(anchor.t);
    expect(after.y).toBeCloseTo(view.priceToY(anchor.p), 9);
  });

  it('keeps the same bar anchor when the timeframe changes', () => {
    const base = makeSeries(1200, '1m');
    const h1 = aggregateSeries(base, '1H', 'UTC');
    const anchorTime = base.time(180); // 03:00 on day one of the fixture
    const { view } = makeView(h1.count);
    const pt = project({ t: anchorTime, p: 1.09 }, view, h1);
    expect(h1.time(pt.index)).toBe(anchorTime);
    const [lo, hi] = indexSpan(newDrawing('trend', [{ t: anchorTime, p: 1.09 }, { t: base.time(600), p: 1.1 }]), h1);
    expect(lo).toBe(pt.index);
    expect(hi).toBeGreaterThan(lo);
  });

  it('round-trips screen → anchor → screen', () => {
    const series = makeSeries();
    const { view } = makeView(series.count);
    const anchor = unproject(640, 300, view, series);
    const back = project(anchor, view, series);
    // Anchors snap to the bar under the cursor, so the round trip is exact in
    // index space and within half a bar in pixels.
    expect(Math.abs(back.x - 640)).toBeLessThanOrEqual(view.pxPerBar / 2 + 0.5);
    expect(back.y).toBeCloseTo(300, 0);
    expect(anchor.t).toBe(series.time(Math.round(view.xToIndex(640))));
  });

  it('snaps to bar extremes within tolerance and leaves distant prices alone', () => {
    const series = makeSeries();
    const { view } = makeView(series.count);
    const i = 50;
    const candle = series.candle(i)!;
    // Exactly on the high: the high wins.
    expect(snapPrice(series, i, view.yToPrice(view.priceToY(candle.h)), 6, view)).toBe(candle.h);
    // Near the high: one of the four real levels, never an invented price.
    const near = snapPrice(series, i, view.yToPrice(view.priceToY(candle.h) + 2), 6, view);
    expect([candle.h, candle.l, candle.o, candle.c]).toContain(near);
    const far = view.priceToY(candle.h) + 60;
    const price = view.yToPrice(far);
    expect(snapPrice(series, i, price, 6, view)).toBe(price);
  });

  it('clamps a move to the ends of the series instead of drifting off data', () => {
    const series = makeSeries(50);
    const d = newDrawing('trend', [{ t: series.time(1), p: 1.08 }, { t: series.time(3), p: 1.09 }]);
    const moved = moveDrawing(d, 1000, 0, series);
    expect(anchorIndex(series, moved.anchors[0].t)).toBe(series.count - 1);
    const back = moveDrawing(d, -1000, 0, series);
    expect(anchorIndex(series, back.anchors[1].t)).toBe(0);
    expect(moveDrawing(d, 0, 0, series)).toBe(d);
  });

  it('resolves an anchor older than the first bar to bar zero', () => {
    const series = makeSeries();
    const { view } = makeView(series.count);
    expect(project({ t: T0 - 10 * 86_400_000, p: 1.09 }, view, series).index).toBe(0);
  });
});

describe('shape geometry', () => {
  it('computes box from either drag direction', () => {
    const box = boxOf({ x: 100, y: 200, index: 1 }, { x: 40, y: 90, index: 2 });
    expect(box).toEqual({ x: 40, y: 90, w: 60, h: 110 });
  });

  it('fib retracement levels run from the swing end backwards', () => {
    const d = newDrawing('fib', [
      { t: T0, p: 1.0 },
      { t: T0 + 60 * MIN, p: 1.1 },
    ]);
    const levels = fibLevels(d);
    expect(levels[0].price).toBeCloseTo(1.1, 10); // 0.0 → swing high
    expect(levels.find((l) => l.level === 0.5)!.price).toBeCloseTo(1.05, 10);
    expect(levels.find((l) => l.level === 1)!.price).toBeCloseTo(1.0, 10);
    expect(levels.find((l) => l.level === 1.618)!.price).toBeCloseTo(1.0 - 0.1 * 0.618, 10);
  });

  it('fib extension projects from the third anchor', () => {
    const d = newDrawing('fibext', [
      { t: T0, p: 1.0 },
      { t: T0 + 60 * MIN, p: 1.1 },
      { t: T0 + 120 * MIN, p: 1.05 },
    ]);
    const levels = fibExtLevels(d);
    const one = levels.find((l) => l.level === 1)!.price;
    expect(one).toBeCloseTo(1.15, 10); // retracement + full swing
  });

  it('price span includes fib levels', () => {
    const d = newDrawing('fib', [
      { t: T0, p: 1.0 },
      { t: T0 + 60 * MIN, p: 1.1 },
    ]);
    const [lo, hi] = priceSpan(d);
    expect(lo).toBeLessThanOrEqual(1.0);
    expect(hi).toBeGreaterThanOrEqual(1.1);
  });

  it('rays and extended lines span the visible data', () => {
    const series = makeSeries(100);
    const ray = newDrawing('ray', [{ t: series.time(90), p: 1.08 }, { t: series.time(95), p: 1.09 }]);
    expect(indexSpan(ray, series)).toEqual([90, 99]);
    const xline = newDrawing('xline', [{ t: series.time(10), p: 1.08 }, { t: series.time(20), p: 1.09 }]);
    expect(indexSpan(xline, series)).toEqual([0, 99]);
  });
});

describe('hit testing', () => {
  const series = makeSeries();
  const { view } = makeView(series.count);

  it('finds a horizontal line only near its y', () => {
    const d = newDrawing('hline', [{ t: series.time(10), p: 1.09 }]);
    const y = project(d.anchors[0], view, series).y;
    expect(hitTest(d, view, series, 300, y)).toEqual({ type: 'body' });
    expect(hitTest(d, view, series, 300, y + 25)).toBeNull();
    expect(hitTest(d, view, series, 300, y + 3)).toEqual({ type: 'body' });
  });

  it('prefers an anchor handle over the body', () => {
    const a = { t: series.time(40), p: 1.085 };
    const b = { t: series.time(120), p: 1.095 };
    const d = newDrawing('trend', [a, b]);
    const pa = project(a, view, series);
    expect(hitTest(d, view, series, pa.x + 2, pa.y + 2)).toEqual({ type: 'anchor', index: 0 });
    const mid = { x: (pa.x + project(b, view, series).x) / 2, y: (pa.y + project(b, view, series).y) / 2 };
    expect(hitTest(d, view, series, mid.x, mid.y)).toEqual({ type: 'body' });
  });

  it('hits rects through the fill and circles on the ring', () => {
    const rect = newDrawing('rect', [
      { t: series.time(20), p: 1.09 },
      { t: series.time(60), p: 1.08 },
    ]);
    const p0 = project(rect.anchors[0], view, series);
    const p1 = project(rect.anchors[1], view, series);
    expect(hitTest(rect, view, series, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2)).toEqual({ type: 'body' });
    expect(hitTest(rect, view, series, p0.x - 200, p0.y - 200)).toBeNull();

    const circle = newDrawing('circle', [
      { t: series.time(30), p: 1.09 },
      { t: series.time(50), p: 1.085 },
    ]);
    const c0 = project(circle.anchors[0], view, series);
    const c1 = project(circle.anchors[1], view, series);
    const cx = (c0.x + c1.x) / 2;
    const cy = (c0.y + c1.y) / 2;
    const r = Math.abs(c1.x - c0.x) / 2;
    expect(hitTest(circle, view, series, cx + r, cy)).toEqual({ type: 'body' });
    expect(hitTest(circle, view, series, cx + r * 1.9, cy)).toBeNull();
  });

  it('hits fib levels and text boxes', () => {
    const fib = newDrawing('fib', [
      { t: series.time(10), p: 1.08 },
      { t: series.time(80), p: 1.1 },
    ]);
    const level = fibLevels(fib)[2];
    const y = view.priceToY(level.price);
    const x = project(fib.anchors[1], view, series).x - 30;
    expect(hitTest(fib, view, series, x, y)).toEqual({ type: 'body' });
    // 150px away sits between two levels, so nothing should be grabbed.
    expect(hitTest(fib, view, series, x, y + 150)).toBeNull();

    const text = { ...newDrawing('text', [{ t: series.time(30), p: 1.09 }]), text: 'support' };
    const tp = project(text.anchors[0], view, series);
    // Dead centre is the anchor handle; the label body is grabbed beside it.
    expect(hitTest(text, view, series, tp.x, tp.y)).toEqual({ type: 'anchor', index: 0 });
    expect(hitTest(text, view, series, tp.x + 20, tp.y)).toEqual({ type: 'body' });
    expect(hitTest(text, view, series, tp.x, tp.y + 60)).toBeNull();
  });
});

describe('store semantics', () => {
  let store: DrawingStore;
  beforeEach(() => {
    store = new DrawingStore();
  });

  it('adds, updates and removes with history', () => {
    const a = { t: T0, p: 1.08 };
    const d = store.add('hline', [a]);
    expect(store.count()).toBe(1);
    store.update(d.id, { text: 'x' });
    expect(store.get(d.id)!.text).toBe('x');
    expect(store.undo()).not.toBeNull();
    expect(store.get(d.id)!.text).toBe('');
    expect(store.redo()).not.toBeNull();
    expect(store.get(d.id)!.text).toBe('x');
    store.remove(d.id);
    expect(store.count()).toBe(0);
    store.undo();
    expect(store.count()).toBe(1);
    expect(store.get(d.id)!.anchors[0]).toEqual(a);
  });

  it('coalesces a drag gesture into one undo step', () => {
    const d = store.add('trend', [
      { t: T0, p: 1.08 },
      { t: T0 + 10 * MIN, p: 1.09 },
    ]);
    store.begin('move');
    for (let i = 1; i <= 8; i++) {
      store.setAnchors(d.id, [{ t: T0 + i * MIN, p: 1.08 + i * 0.001 }, { t: T0 + (10 + i) * MIN, p: 1.09 }], { transient: true });
    }
    store.end();
    expect(store.canUndo).toBe(true);
    const before = store.get(d.id)!.anchors[0];
    store.undo();
    const after = store.get(d.id)!.anchors[0];
    expect(after.t).toBe(T0);
    expect(before.t).not.toBe(T0);
    // Exactly one history entry was consumed by the whole drag.
    // The creation itself is a separate, earlier step.
    store.redo();
    expect(store.get(d.id)!.anchors[0].t).not.toBe(T0);
    store.undo();
    expect(store.get(d.id)!.anchors[0].t).toBe(T0);
    store.undo();
    expect(store.count()).toBe(0);
  });

  it('refuses to edit or delete a locked drawing but still allows unlocking', () => {
    const d = store.add('hline', [{ t: T0, p: 1.08 }]);
    store.setLocked(d.id, true);
    store.update(d.id, { text: 'ignored' });
    expect(store.get(d.id)!.text).toBe('');
    store.remove(d.id);
    expect(store.count()).toBe(1);
    store.setLocked(d.id, false);
    store.update(d.id, { text: 'allowed' });
    expect(store.get(d.id)!.text).toBe('allowed');
    store.remove(d.id);
    expect(store.count()).toBe(0);
  });

  it('duplicates with a new id, shifted order, and independent anchors', () => {
    const d = store.add('rect', [
      { t: T0, p: 1.08 },
      { t: T0 + 30 * MIN, p: 1.09 },
    ]);
    const [copyId] = store.duplicate(d.id);
    expect(copyId).not.toBe(d.id);
    const copy = store.get(copyId)!;
    expect(copy.anchors.map((a) => a.t)).toEqual(d.anchors.map((a) => a.t));
    copy.anchors[0].p = 1.5;
    expect(store.get(d.id)!.anchors[0].p).toBe(1.08);
    expect(copy.order).toBeGreaterThan(d.order);
  });

  it('serialises and restores exactly, dropping junk rows', () => {
    const d = store.add('trend', [
      { t: T0, p: 1.08123 },
      { t: T0 + 5 * MIN, p: 1.09876 },
    ]);
    store.update(d.id, { style: { ...d.style, color: '#123456', width: 3, style: 'dot' }, hidden: true, levels: [0, 0.5, 1] });
    const json = JSON.stringify([serialize(store.get(d.id)!)]);
    const restored = deserialize(JSON.parse(json)[0]);
    expect(restored).toEqual(store.get(d.id));
    expect(deserialize({ kind: 'trend' } as never)).toBeNull();
    expect(deserialize({ kind: 'trend', anchors: [{ t: NaN, p: 1 }, { t: T0, p: 1.09 }] } as never)!.anchors).toHaveLength(1);
  });

  it('imports and can replace the existing set', () => {
    store.add('hline', [{ t: T0, p: 1.08 }]);
    const payload = JSON.stringify({
      app: 'forexlab',
      kind: 'drawings',
      v: 1,
      drawings: [
        serialize(newDrawing('hline', [{ t: T0 + MIN, p: 1.07 }])),
        serialize(newDrawing('vline', [{ t: T0 + 2 * MIN, p: 0 }])),
      ],
    });
    expect(store.importJson(payload)).toBe(2);
    expect(store.count()).toBe(3);
    expect(store.importJson('{"drawings":[]}')).toBe(0);
    expect(store.importJson('not json')).toBe(0);
    expect(JSON.parse(store.exportJson()).drawings).toHaveLength(3);
  });

  it('reorders without duplicating entries', () => {
    const a = store.add('hline', [{ t: T0, p: 1.08 }]);
    const b = store.add('hline', [{ t: T0, p: 1.09 }]);
    expect(store.visibleFor(null).map((d) => d.id)).toEqual([a.id, b.id]);
    store.raise(a.id, 1);
    expect(store.visibleFor(null).map((d) => d.id)).toEqual([b.id, a.id]);
    store.raise(a.id, 1);
    expect(store.visibleFor(null).map((d) => d.id)).toEqual([b.id, a.id]);
    expect(store.count()).toBe(2);
  });

  it('clips at the replay boundary instead of showing future anchors', () => {
    const series = makeSeries(200);
    const d = newDrawing('trend', [
      { t: series.time(150), p: 1.08 },
      { t: series.time(180), p: 1.09 },
    ]);
    expect(touchesReplayBoundary(d, series, 120)).toBe(true);
    expect(touchesReplayBoundary(d, series, 160)).toBe(false);
    // Price-only shapes span all time, so they are never hidden by the barrier.
    const past = newDrawing('hline', [{ t: series.time(5), p: 1.08 }]);
    expect(touchesReplayBoundary(past, series, 0)).toBe(false);
    // A vertical line pinned to a future bar is.
    const vline = newDrawing('vline', [{ t: series.time(150), p: 1.08 }]);
    expect(touchesReplayBoundary(vline, series, 120)).toBe(true);
    expect(touchesReplayBoundary(vline, series, 150)).toBe(false);
  });

  it('cloneDrawing produces an independent snapshot', () => {
    const d = store.add('fib', [
      { t: T0, p: 1.08 },
      { t: T0 + 10 * MIN, p: 1.1 },
    ]);
    const copy = cloneDrawing(d, { levels: [0, 1] });
    copy.levels.push(0.5);
    expect(store.get(d.id)!.levels).toHaveLength(10);
    expect(copy.levels).toHaveLength(3);
  });
});

describe('store ↔ IndexedDB persistence', () => {
  it('saves per dataset and reloads after a dataset switch', async () => {
    const store = new DrawingStore();
    await store.useDataset('ds-1');
    const d = store.add('trend', [
      { t: T0, p: 1.08 },
      { t: T0 + 30 * MIN, p: 1.09 },
    ]);
    store.update(d.id, { text: 'neckline' });
    await store.flush();
    await store.useDataset('ds-2');
    expect(store.count()).toBe(0);
    const other = store.add('hline', [{ t: T0, p: 1.0 }]);
    await store.flush();
    await store.useDataset('ds-1');
    expect(store.count()).toBe(1);
    expect(store.get(d.id)!.text).toBe('neckline');
    // Dataset 2 keeps its own set, and deleting a dataset clears its drawings.
    await store.useDataset('ds-2');
    expect(store.get(other.id)!.kind).toBe('hline');
    await store.deleteForDataset('ds-2');
    await store.useDataset('ds-1');
    await store.useDataset('ds-2');
    expect(store.count()).toBe(0);
  });

  it('does not leak listeners across subscribers', () => {
    const store = new DrawingStore();
    let hits = 0;
    const off = store.subscribe(() => hits++);
    store.add('hline', [{ t: T0, p: 1.08 }]);
    expect(hits).toBe(1);
    off();
    store.add('hline', [{ t: T0, p: 1.09 }]);
    expect(hits).toBe(1);
  });
});
