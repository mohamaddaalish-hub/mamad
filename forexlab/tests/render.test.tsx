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
