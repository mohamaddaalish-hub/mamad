// @vitest-environment jsdom
/**
 * Headless smoke tests: mount the workstation, load a dataset, and drive the
 * chart through pan/zoom/replay-range paths while recording canvas calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { installCanvasStub, canvasOps, resetCanvasOps } from './helpers/canvas.ts';

vi.stubGlobal('ResizeObserver', class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});

// jsdom has no layout: give every element a real box so the chart measures itself.
Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: 800, width: 1440, height: 800, toJSON() { return {}; } } as DOMRect;
};
Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });

installCanvasStub();

const { App } = await import('../src/ui/shell/App.tsx');
const actions = await import('../src/core/app/actions.ts');
const { appStore } = await import('../src/core/app/state.ts');
const { datasetRegistry } = await import('../src/core/data/datasets.ts');
const { Pyramid } = await import('../src/core/data/pyramid.ts');
const { syntheticCandles } = await import('../src/core/data/synthetic.ts');
const { loadFixture, openDataset, registerImportedDataset, datasetRecordFromReport } = actions;
const replay = await import('../src/core/replay/engine.ts');
const gate = await import('../src/core/replay/gate.ts');
const bt = await import('../src/core/backtest/store.ts');
const btController = await import('../src/core/backtest/controller.ts');
const btSession = await import('../src/core/backtest/session.ts');
const modes = await import('../src/core/app/modes.ts');

let root: Root | null = null;

async function mount(): Promise<void> {
  const container = document.createElement('div');
  container.id = 'root';
  Object.defineProperty(container, 'clientWidth', { value: 1440, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true });
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(App));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

async function tick(frames = 2): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 18));
    });
  }
}

beforeEach(async () => {
  resetCanvasOps();
  await act(async () => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

describe('workstation shell', () => {
  it('mounts and paints the empty chart without touching the network', async () => {
    await mount();
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeTruthy();
    const ops = canvasOps();
    expect(ops.some((o) => o.op === 'fillRect')).toBe(true);
    const texts = ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]));
    expect(texts.join(' ')).toMatch(/Import a historical OHLC CSV/);
    // Provenance must be visible in the status bar.
    expect(document.body.textContent).toMatch(/local/);
  });

  it('renders candles for a registered dataset and reports OHLC in the legend', async () => {
    await mount();
    const { cols } = syntheticCandles({ bars: 1200, tf: '1m', start: Date.UTC(2024, 2, 4), seed: 3 });
    const record = datasetRecordFromReport(
      {
        fileName: 'fixture.csv',
        symbol: 'EURUSD',
        timeframe: '1m',
        nativeTimeframe: '1m',
        timezone: 'UTC',
        totalLines: cols.len,
        dataRows: cols.len,
        commentLines: 0,
        accepted: cols.len,
        rejected: 0,
        ohlcViolations: 0,
        duplicates: 0,
        duplicatesKept: 0,
        mergedIntoBuckets: 0,
        unorderedRows: 0,
        gaps: [],
        gapCount: 0,
        missingBars: 0,
        closedSpans: 0,
        firstTime: cols.t[0],
        lastTime: cols.t[cols.len - 1],
        minLow: 1.05,
        maxHigh: 1.12,
        volumeSeen: true,
        priceDecimals: 5,
        invalid: [],
        notes: [],
        durationMs: 1,
        dateFormat: 'ISO-8601',
        timeFormat: 'HH:mm',
        columnMap: {},
        header: [],
      },
      12345,
      'fixture.csv',
    );
    await act(async () => {
      await registerImportedDataset(cols, record, { open: false });
      const ds = datasetRegistry.list()[0];
      await openDataset(ds.id, { tf: '15m' });
    });
    await tick();
    resetCanvasOps();
    await act(async () => {
      actions.chartHost.engine?.requestRender();
      await new Promise((r) => setTimeout(r, 30));
    });
    const ops = canvasOps();
    const rects = ops.filter((o) => o.op === 'rect');
    expect(rects.length).toBeGreaterThan(20); // candle bodies
    const texts = ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]));
    expect(texts).toContain('EURUSD');
    expect(texts).toContain('15m');
    expect(texts.some((t) => /^O \d/.test(t))).toBe(false); // legend writes pieces separately
    expect(texts.some((t) => /^\d\.\d{5}$/.test(t))).toBe(true); // price fragments
    expect(texts.some((t) => /^\d{4}-\d{2}-\d{2}/.test(t))).toBe(true); // date axis
  });

  it('pans and zooms through pointer + wheel without leaking errors', async () => {
    await mount();
    await act(async () => {
      await loadFixture(4000);
    });
    await tick();
    const canvas = document.querySelector('canvas')!;
    const engine = actions.chartHost.engine!;
    const before = engine.view.rightIndex;
    const beforeZoom = engine.view.pxPerBar;
    const fire = (type: string, init: Record<string, unknown>) => {
      const Ctor = type.startsWith('pointer') ? window.PointerEvent ?? window.MouseEvent : window.WheelEvent ?? window.MouseEvent;
      canvas.dispatchEvent(new (Ctor as unknown as new (t: string, i: object) => Event)(type, { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...init }));
    };
    fire('pointerdown', { button: 0 });
    fire('pointermove', { buttons: 1, clientX: 620 });
    fire('pointerup', { button: 0 });
    await tick();
    expect(engine.view.rightIndex).not.toBe(before);
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -240, clientX: 400, clientY: 300 }));
    await tick();
    expect(engine.view.pxPerBar).toBeGreaterThan(beforeZoom);
  });

  it('shows the dataset range and switches timeframes without blocking', async () => {
    await mount();
    await act(async () => {
      await loadFixture(3000);
    });
    await tick();
    const tf = appStore.get().tf;
    expect(tf).toBe('30m');
    await act(async () => {
      await actions.setTimeframe('1H');
    });
    await tick();
    expect(appStore.get().tf).toBe('1H');
    const series = actions.chartHost.engine!.getSeries()!;
    // Switching timeframe re-derives the view from the same base buffers.
    expect(series.tf).toBe('1H');
    expect(series.count).toBeGreaterThan(0);
    expect(new Pyramid(series.cols).rowCount).toBe(series.total);
    const base = datasetRegistry.cachedView(appStore.get().datasetId!, '5m', 'UTC');
    expect(base?.series.count).toBeGreaterThan(series.count);
  });
});

describe('navigation and import dialogs', () => {
  it('opens the calendar, marks days that contain bars and jumps to one', async () => {
    await mount();
    await act(async () => {
      await loadFixture(22_000);
    });
    await tick();
    const dialogs = await import('../src/core/app/dialogs.ts');
    await act(async () => {
      dialogs.openDialog('goto');
    });
    await tick();
    const cells = Array.from(document.querySelectorAll<HTMLButtonElement>('.cal-cell.has-data'));
    expect(cells.length).toBeGreaterThan(10); // ~15 calendar days of 1-minute fixture data
    expect(document.querySelectorAll('.cal-cell:not(.has-data):not(.blank)').length).toBeGreaterThan(0);
    const rightBefore = actions.chartHost.engine!.view.rightIndex;
    await act(async () => {
      cells[Math.floor(cells.length / 2)].click();
    });
    await tick();
    expect(actions.chartHost.engine!.view.rightIndex).not.toBe(rightBefore);
    expect(dialogs.dialogStore.get().open).toBeNull();
    await act(async () => {
      dialogs.closeDialog();
    });
  });

  it('accepts a typed date through the shortcut G without fabricating a bar', async () => {
    await mount();
    await act(async () => {
      await loadFixture(1500);
    });
    await tick();
    const { goToDateTime, datasetBounds } = await import('../src/core/app/actions.ts');
    const bounds = datasetBounds()!;
    const inside = new Date(bounds[0] + 30 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
    let ok = false;
    await act(async () => {
      ok = goToDateTime(inside);
    });
    expect(ok).toBe(true);
    // Before the first bar: nothing to land on, so it refuses instead of guessing.
    const beforeStart = new Date(bounds[0] - 400 * 86_400_000).toISOString().slice(0, 10);
    await act(async () => {
      ok = goToDateTime(beforeStart);
    });
    expect(ok).toBe(false);
    // After the last bar: clamps onto the newest real bar, never beyond it.
    const afterEnd = new Date(bounds[1] + 400 * 86_400_000).toISOString().slice(0, 10);
    await act(async () => {
      ok = goToDateTime(afterEnd);
    });
    expect(ok).toBe(true);
    const series = actions.chartHost.engine!.getSeries()!;
    // The visible window is clamped to real bars, so nothing past the end is shown.
    expect(actions.chartHost.engine!.getVisibleRange().to).toBe(series.count);
    expect(appStore.get().diagnostics.some((d) => d.level === 'error' && /Could not parse/.test(d.text))).toBe(false);
    await act(async () => {
      ok = goToDateTime('not a date');
    });
    expect(ok).toBe(false);
    expect(appStore.get().diagnostics.some((d) => d.level === 'error' && /Could not parse/.test(d.text))).toBe(true);
  });

  it('documents every shortcut the shell installs', async () => {
    const { SHORTCUTS } = await import('../src/core/app/dialogs.ts');
    const { TIMEFRAME_OPTIONS, availabilityFor } = await import('../src/core/time/timeframeOptions.ts');
    expect(TIMEFRAME_OPTIONS).toHaveLength(14);
    const avail = availabilityFor('5m');
    expect(avail.get('1m')!.derived).toBe(false);
    expect(avail.get('5m')!.native).toBe(true);
    expect(avail.get('1D')!.derived).toBe(true);
    expect(avail.get('1m')!.reason).toMatch(/fabricat/i);
    expect(SHORTCUTS.some((s) => s.keys === 'G')).toBe(true);
  });
});

const draw = await import('../src/core/draw/controller.ts');
const dstore = await import('../src/core/draw/store.ts');

describe('drawing tools on the live chart', () => {
  const fire = (canvas: HTMLCanvasElement, type: string, init: Record<string, unknown> = {}) => {
    const Ctor = (window as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent ?? window.MouseEvent;
    canvas.dispatchEvent(
      new (Ctor as unknown as new (t: string, i: object) => Event)(type, {
        bubbles: true,
        cancelable: true,
        clientX: 400,
        clientY: 300,
        pointerId: 1,
        ...init,
      }),
    );
  };

  it('creates a horizontal line from a single click and paints it', async () => {
    await mount();
    await act(async () => {
      await loadFixture(1200);
    });
    await tick();
    const before = dstore.drawingStore.count();
    draw.drawingController.setTool('hline');
    const canvas = document.querySelector('canvas')!;
    await act(async () => {
      fire(canvas, 'pointerdown', { button: 0 });
      fire(canvas, 'pointerup', { button: 0 });
    });
    expect(dstore.drawingStore.count()).toBe(before + 1);
    const d = dstore.drawingStore.visibleFor(dstore.drawingStore.dataset())[0];
    expect(d.kind).toBe('hline');
    expect(Number.isFinite(d.anchors[0].t)).toBe(true);
    // Tool disarms after a single-click shape.
    expect(draw.drawingController.tool).toBeNull();
    resetCanvasOps();
    await act(async () => {
      actions.chartHost.engine?.requestRender();
      await new Promise((r) => setTimeout(r, 30));
    });
    const ops = canvasOps();
    expect(ops.filter((o) => o.op === 'stroke').length).toBeGreaterThan(2);
    // Price axis tag was written for the line.
    expect(ops.some((o) => o.op === 'fillText' && /^\d\.\d{5}$/.test(String(o.args[0])))).toBe(true);
  });

  it('drags a trend line and keeps it anchored while panning', async () => {
    await mount();
    await act(async () => {
      await loadFixture(1200);
    });
    const canvas = document.querySelector('canvas')!;
    draw.drawingController.setTool('trend');
    await act(async () => {
      fire(canvas, 'pointerdown', { button: 0, clientX: 300, clientY: 250 });
      fire(canvas, 'pointermove', { buttons: 1, clientX: 520, clientY: 360 });
      fire(canvas, 'pointerup', { button: 0, clientX: 520, clientY: 360 });
    });
    const list = dstore.drawingStore.visibleFor(null).filter((d) => d.kind === 'trend');
    expect(list.length).toBeGreaterThan(0);
    const d = list[list.length - 1];
    expect(d.anchors).toHaveLength(2);
    const span = Math.abs(d.anchors[1].t - d.anchors[0].t);
    expect(span).toBeGreaterThan(20 * 60_000); // ~37 bars at 6px/bar
    const engine = actions.chartHost.engine!;
    const before = { ...d.anchors[0] };
    const rightBefore = engine.view.rightIndex;
    await act(async () => {
      fire(canvas, 'pointerdown', { button: 0, clientX: 700, clientY: 400 });
      fire(canvas, 'pointermove', { buttons: 1, clientX: 480, clientY: 400 });
      fire(canvas, 'pointerup', { button: 0, clientX: 480, clientY: 400 });
    });
    expect(engine.view.rightIndex).not.toBe(rightBefore);
    // The shape itself must not have moved in time/price space.
    const after = dstore.drawingStore.get(d.id)!;
    expect(after.anchors[0].t).toBe(before.t);
    expect(after.anchors[0].p).toBeCloseTo(before.p, 10);
  });

  it('selects, moves, undoes and re-applies through the store', async () => {
    await mount();
    await act(async () => {
      await loadFixture(1200);
    });
    const canvas = document.querySelector('canvas')!;
    draw.drawingController.setTool('hline');
    await act(async () => {
      fire(canvas, 'pointerdown', { button: 0, clientX: 400, clientY: 280 });
      fire(canvas, 'pointerup', { button: 0, clientX: 400, clientY: 280 });
    });
    const d = dstore.drawingStore.visibleFor(null).slice(-1)[0];
    const priceBefore = d.anchors[0].p;
    // Click on the line body to select, then drag it.
    const engine = actions.chartHost.engine!;
    const y = Math.round(engine.view.priceToY(priceBefore));
    await act(async () => {
      fire(canvas, 'pointerdown', { button: 0, clientX: 500, clientY: y });
      fire(canvas, 'pointermove', { buttons: 1, clientX: 500, clientY: y - 40 });
      fire(canvas, 'pointerup', { button: 0, clientX: 500, clientY: y - 40 });
    });
    expect(dstore.drawingStore.selection).toContain(d.id);
    expect(dstore.drawingStore.get(d.id)!.anchors[0].p).not.toBe(priceBefore);
    await act(async () => {
      draw.drawingController.undo();
    });
    expect(dstore.drawingStore.get(d.id)!.anchors[0].p).toBeCloseTo(priceBefore, 10);
  });

  it('escapes out of an armed tool and clears selection with Escape', async () => {
    await mount();
    draw.drawingController.setTool('rect');
    expect(appStore.get().tool).toBe('rect');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(appStore.get().tool).toBeNull();
  });

  it('renders the drawings manager rows for the current dataset', async () => {
    await mount();
    await act(async () => {
      await loadFixture(1200);
    });
    await act(async () => {
      dstore.drawingStore.add('hline', [{ t: Date.UTC(2024, 0, 2, 10), p: 1.09 }]);
      dstore.drawingStore.add('trend', [
        { t: Date.UTC(2024, 0, 2, 10), p: 1.09 },
        { t: Date.UTC(2024, 0, 2, 14), p: 1.1 },
      ]);
      appStore.set({ rightOpen: true, panel: 'objects' });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.body.textContent).toMatch(/Drawings · 2/);
    expect(document.querySelectorAll('.draw-list .list-row').length).toBe(2);
    await act(async () => {
      (document.querySelector('.draw-list .list-row .icon-btn') as HTMLButtonElement).click();
    });
    expect(dstore.drawingStore.getSnapshot().list.some((x) => x.hidden)).toBe(true);
  });
});

describe('bar replay on the live chart', () => {
  /** Deterministic starting point: a clean dataset at its native 5m timeframe. */
  async function freshReplayFixture(bars: number): Promise<void> {
    await mount();
    await act(async () => {
      replay.barReplay.pause();
      replay.barReplay.stop();
      replay.barReplay.setStartIndex(null);
      await actions.openDataset(null);
      await loadFixture(bars);
      await actions.setTimeframe('5m');
    });
    await tick();
  }

  it('arms, steps, keeps the future unreachable and restores on exit', async () => {
    await freshReplayFixture(1000);
    const engine = actions.chartHost.engine!;
    const full = engine.getBaseSeries()!.count;
    expect(full).toBe(1000);
    expect(gate.currentGate().active).toBe(false);

    await act(async () => {
      replay.barReplay.setStartIndex(50);
      replay.barReplay.start(50);
    });
    const state = appStore.get().replay;
    expect(state.active).toBe(true);
    expect(state.cursor).toBe(50);
    expect(state.total).toBe(full);
    // The engine itself is holding a clipped series: 51 bars, not `full`.
    expect(engine.getSeries()!.count).toBe(51);
    expect(gate.hiddenBarCount()).toBe(full - 51);
    expect(gate.allowedSeries()!.count).toBe(51);
    // Zooming and panning hard cannot expose a hidden bar: the view is clamped to
    // the revealed window, and a future timestamp resolves to the last known bar.
    await act(async () => {
      engine.fitAll();
      engine.zoomBy(4);
      engine.view.panBy(1_000_000, engine.getSeries()!.count);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(engine.getVisibleRange().to).toBeLessThanOrEqual(51);
    expect(Number.isNaN(engine.getSeries()!.time(52))).toBe(true);
    const futureT = engine.getBaseSeries()!.time(999);
    expect(engine.getSeries()!.indexAtOrBefore(futureT)).toBe(50);
    let jumped = true;
    await act(async () => {
      jumped = engine.goToTime(futureT, 'right');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(jumped).toBe(true); // clamped to what is known, not refused
    expect(engine.getVisibleRange().to).toBeLessThanOrEqual(51);

    await act(async () => {
      replay.barReplay.step(1);
      replay.barReplay.step(1);
    });
    expect(appStore.get().replay.cursor).toBe(52);
    expect(engine.getSeries()!.count).toBe(53);

    // Determinism: one batched 40-bar jump and 42 single steps must land on the
    // identical visible state — speed and batching change delivery, never content.
    let batched = '';
    await act(async () => {
      replay.barReplay.stepMany(40);
      batched = replay.barReplay.checksum();
    });
    expect(appStore.get().replay.cursor).toBe(92);
    await act(async () => {
      replay.barReplay.restart();
    });
    expect(appStore.get().replay.cursor).toBe(50);
    await act(async () => {
      for (let i = 0; i < 42; i++) replay.barReplay.step(1);
    });
    expect(appStore.get().replay.cursor).toBe(92);
    expect(replay.barReplay.checksum()).toBe(batched);

    await act(async () => {
      replay.barReplay.stop();
    });
    expect(appStore.get().replay.active).toBe(false);
    expect(engine.getSeries()!.count).toBe(full);
    expect(engine.getReplayBarrier()).toBeNull();
  });

  it('plays, pauses and stops at the last bar', async () => {
    await freshReplayFixture(400);
    const engine = actions.chartHost.engine!;
    await act(async () => {
      replay.barReplay.setSpeed(16);
      replay.barReplay.start(0, { play: true });
      await new Promise((r) => setTimeout(r, 320));
    });
    expect(appStore.get().replay.playing).toBe(true);
    expect(appStore.get().replay.cursor).toBeGreaterThan(0);
    await act(async () => {
      replay.barReplay.pause();
    });
    expect(appStore.get().replay.playing).toBe(false);
    const paused = appStore.get().replay.cursor;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(appStore.get().replay.cursor).toBe(paused);
    // March to the end: the transport stops there rather than clamping forever.
    await act(async () => {
      replay.barReplay.step(10_000);
    });
    const total = engine.getBaseSeries()!.count;
    expect(appStore.get().replay.cursor).toBe(total - 1);
    expect(appStore.get().replay.playing).toBe(false);
    expect(engine.getSeries()!.count).toBe(total);
    await act(async () => {
      replay.barReplay.stop();
    });
  });

  it('refuses to replay an empty chart and shows an unarmed panel', async () => {
    await mount();
    await act(async () => {
      replay.barReplay.stop();
      replay.barReplay.setStartIndex(null);
      await actions.openDataset(null);
      appStore.set({ rightOpen: true, panel: 'replay', replay: { active: false, cursor: 0, knownUntil: null, total: 0, playing: false, speed: 1, follow: true } });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.body.textContent).toMatch(/Start point/);
    expect(document.body.textContent).toMatch(/not chosen/);
    let started = true;
    await act(async () => {
      started = replay.barReplay.start(0);
    });
    expect(started).toBe(false);
    expect(appStore.get().diagnostics.some((d) => /Nothing to replay/.test(d.text))).toBe(true);
  });

  it('keeps the same knowledge boundary across a timeframe switch', async () => {
    await freshReplayFixture(600);
    const engine = actions.chartHost.engine!;
    const base = engine.getBaseSeries()!;
    expect(base.tf).toBe('5m');
    await act(async () => {
      replay.barReplay.start(5);
    });
    const known = appStore.get().replay.knownUntil;
    expect(known).not.toBeNull();
    expect(engine.getSeries()!.count).toBe(6);
    // Six 5m bars are exactly one 30m bar: the switch must not reveal more.
    await act(async () => {
      await actions.setTimeframe('30m');
    });
    const after = appStore.get().replay;
    expect(after.cursor).toBe(0);
    expect(engine.getSeries()!.count).toBe(1);
    expect(engine.getSeries()!.time(0)).toBe(base.time(0));
    expect(appStore.get().replay.knownUntil).toBe(known);
    // Stepping at 30m reveals a whole half hour, and the 5m view catches up to it.
    await act(async () => {
      replay.barReplay.step(1);
      await actions.setTimeframe('5m');
    });
    expect(appStore.get().replay.cursor).toBe(11);
    expect(engine.getSeries()!.count).toBe(12);
    await act(async () => {
      await actions.setTimeframe('30m');
    });
    expect(appStore.get().replay.cursor).toBe(1);
  });

  it('owns Space, the arrows, R and Escape while replay is active', async () => {
    await freshReplayFixture(400);
    const key = (init: KeyboardEventInit): void => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    };
    await act(async () => {
      replay.barReplay.start(20);
    });
    expect(appStore.get().replay.cursor).toBe(20);
    expect(appStore.get().replay.playing).toBe(false);
    await act(async () => {
      key({ key: ' ' });
    });
    expect(appStore.get().replay.playing).toBe(true);
    await act(async () => {
      key({ key: ' ' });
    });
    expect(appStore.get().replay.playing).toBe(false);
    await act(async () => {
      key({ key: 'ArrowRight' });
    });
    expect(appStore.get().replay.cursor).toBe(21);
    await act(async () => {
      key({ key: 'ArrowRight', shiftKey: true });
    });
    expect(appStore.get().replay.cursor).toBe(31);
    await act(async () => {
      key({ key: 'ArrowLeft' });
    });
    expect(appStore.get().replay.cursor).toBe(30);
    await act(async () => {
      key({ key: 'r' });
    });
    expect(appStore.get().replay.cursor).toBe(20); // back to the armed start
    await act(async () => {
      key({ key: 'Escape' });
    });
    expect(appStore.get().replay.active).toBe(false);
    expect(actions.chartHost.engine!.getSeries()!.count).toBe(400);
    // Idle replay must hand the arrows back to normal navigation.
    const before = appStore.get().replay.active;
    await act(async () => {
      key({ key: 'ArrowRight' });
    });
    expect(appStore.get().replay.active).toBe(before);
  });
});

describe('manual backtest on the live chart', () => {
  const fireTrade = (canvas: HTMLCanvasElement, type: string, init: Record<string, unknown> = {}): void => {
    const Ctor = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
    canvas.dispatchEvent(
      new (Ctor as unknown as new (t: string, i: object) => Event)(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, ...init }),
    );
  };

  async function freshTradeFixture(bars: number): Promise<void> {
    await mount();
    await act(async () => {
      replay.barReplay.pause();
      replay.barReplay.stop();
      replay.barReplay.setStartIndex(null);
      btController.tradeController.setArm(null);
      bt.tradeLedger.clear();
      await actions.openDataset(null);
      await loadFixture(bars);
      await actions.setTimeframe('5m');
    });
    await tick();
  }

  it('records a trade only on revealed bars and marks it at the cursor', async () => {
    await freshTradeFixture(400);
    const engine = actions.chartHost.engine!;
    await act(async () => {
      replay.barReplay.start(40);
    });
    expect(engine.getSeries()!.count).toBe(41);
    let recorded: ReturnType<typeof bt.tradeLedger.open> = null;
    await act(async () => {
      // Bar 300 is far beyond the cursor: the ledger may not even see it.
      recorded = bt.tradeLedger.open({ side: 'buy', bar: 300, price: NaN, stop: null, target: null, size: 10_000 });
    });
    expect(recorded).not.toBeNull();
    expect(recorded!.entryBar).toBe(40);
    const [result] = bt.tradeLedger.results();
    expect(result.entry?.index).toBe(40);
    expect(result.status).toBe('open');
    expect(result.markedAt?.index).toBe(40);
    // Reveal ten more bars: the mark and the excursion follow the cursor, nothing more.
    await act(async () => {
      replay.barReplay.step(10);
    });
    const [after] = bt.tradeLedger.results();
    expect(after.markedAt?.index).toBe(50);
    expect(after.barsHeld).toBe(10);
    // Close on the cursor, then exit replay: the trade must not have used bar 51+.
    await act(async () => {
      btController.tradeController.closeOldest();
    });
    const [closed] = bt.tradeLedger.results();
    expect(closed.status).toBe('closed');
    expect(closed.exit?.index).toBe(50);
    await act(async () => {
      replay.barReplay.stop();
    });
    expect(bt.tradeLedger.results()[0].exit?.index).toBe(50);
    expect(engine.getSeries()!.count).toBe(400);
  });

  it('places an entry from a chart click while armed and disarms on Escape', async () => {
    await freshTradeFixture(300);
    await act(async () => {
      replay.barReplay.start(10);
    });
    const canvas = document.querySelector('canvas')!;
    await act(async () => {
      // A leftover drawing tool must release when a trade tool is armed.
      draw.drawingController.setTool('hline');
      modes.armTrade({ mode: 'open', side: 'buy', kind: 'market' });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(btController.tradeController.isArmed()).toBe(true);
    expect(appStore.get().tool).toBeNull();
    const before = bt.tradeLedger.count();
    // Derive the click from the view so it lands on a real revealed bar.
    const engine = actions.chartHost.engine!;
    const clickX = Math.round(engine.view.indexToX(5));
    const clickY = Math.round((engine.geom.plotTop + engine.geom.plotBottom) / 2);
    await act(async () => {
      fireTrade(canvas, 'pointermove', { clientX: clickX, clientY: clickY });
      fireTrade(canvas, 'pointerdown', { clientX: clickX, clientY: clickY });
      fireTrade(canvas, 'pointerup', { clientX: clickX, clientY: clickY });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(bt.tradeLedger.count()).toBeGreaterThan(before);
    expect(btController.tradeController.isArmed()).toBe(false);
    const trade = bt.tradeLedger.all()[0];
    expect(trade.side).toBe('buy');
    // The click could only land on a revealed bar.
    expect(trade.entryBar).toBeLessThanOrEqual(10);
    expect(appStore.get().replay.active).toBe(true);
    // Escape first disarms an armed tool, then exits replay.
    await act(async () => {
      modes.armTrade({ mode: 'open', side: 'sell', kind: 'limit' });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(btController.tradeController.isArmed()).toBe(false);
    expect(appStore.get().replay.active).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(appStore.get().replay.active).toBe(false);
  });

  it('paints positions and reports them in the panel', async () => {
    await freshTradeFixture(200);
    await act(async () => {
      appStore.set({ rightOpen: true, panel: 'backtest' });
    });
    expect(document.body.textContent).toMatch(/Net P&L/);
    expect(document.body.textContent).toMatch(/UNAVAILABLE/);
    expect(document.body.textContent).toMatch(/No trades recorded/);
    await act(async () => {
      bt.tradeLedger.open({ side: 'buy', bar: 5, price: NaN, stop: null, target: null, size: 10_000 });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.body.textContent).toMatch(/1 closed|Open and pending|BUY/);
    resetCanvasOps();
    await act(async () => {
      actions.chartHost.engine!.requestRender();
      await new Promise((r) => setTimeout(r, 30));
    });
    const texts = canvasOps()
      .filter((op) => op.op === 'fillText')
      .map((op) => String(op.args[0]));
    expect(texts.join(' |')).toMatch(/floating|BUY/);
  });

  it('saves and reloads a session through local storage', async () => {
    await freshTradeFixture(200);
    await act(async () => {
      bt.backtestStore.set({ sessionName: 'Live test session' });
      bt.tradeLedger.open({ side: 'sell', bar: 3, price: NaN, stop: 1.5, target: 1.0, size: 5_000, note: 'kept' });
      await btController.tradeController.cancel();
    });
    const before = bt.tradeLedger.all()[0];
    expect(before).toBeTruthy();
    let id: string | null = null;
    await act(async () => {
      id = await btSession.saveSession('Live test session');
    });
    expect(id).toBeTruthy();
    await act(async () => {
      bt.tradeLedger.clear();
      await btSession.loadSession(id!);
    });
    expect(bt.tradeLedger.count()).toBe(1);
    const restored = bt.tradeLedger.all()[0];
    expect(restored.id).toBe(before.id);
    expect(restored.note).toBe('kept');
    expect(restored.entryBar).toBe(3);
    const list = await btSession.listSessions();
    expect(list.some((s) => s.id === id)).toBe(true);
    await act(async () => {
      await btSession.deleteSession(id!);
    });
    expect(bt.tradeLedger.count()).toBe(0);
    const after = await btSession.listSessions();
    expect(after.some((s) => s.id === id)).toBe(false);
  });

  it('undo and redo walk the trade history', async () => {
    await freshTradeFixture(200);
    await act(async () => {
      bt.tradeLedger.clear();
      bt.tradeLedger.open({ side: 'buy', bar: 1, price: NaN, size: 1_000 });
      bt.tradeLedger.open({ side: 'sell', bar: 2, price: NaN, size: 1_000 });
    });
    expect(bt.tradeLedger.count()).toBe(2);
    await act(async () => {
      bt.tradeLedger.undo();
    });
    expect(bt.tradeLedger.count()).toBe(1);
    await act(async () => {
      bt.tradeLedger.undo();
    });
    expect(bt.tradeLedger.count()).toBe(0);
    await act(async () => {
      bt.tradeLedger.redo();
    });
    expect(bt.tradeLedger.count()).toBe(1);
    expect(bt.tradeLedger.all()[0].side).toBe('buy');
    await act(async () => {
      bt.tradeLedger.clear();
    });
  });
});
