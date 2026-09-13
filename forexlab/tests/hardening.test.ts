// @vitest-environment jsdom
/**
 * Hardening for the sizes that actually matter: tens of thousands of imported rows,
 * a reload from IndexedDB, incremental evaluation of a long open trade, windowed
 * lists, and listener/provider bookkeeping across remounts.
 *
 * These are correctness-plus-cost checks: each one asserts the result is identical
 * to the naive path, because an optimisation that changes an answer is a bug.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarketCsvBuilder } from '../src/core/csv/market.ts';
import { detectColumns } from '../src/core/csv/columns.ts';
import { parseCsv } from '../src/core/csv/parser.ts';
import { aggregateSeries, seriesFromArrays } from '../src/core/data/series.ts';
import { Pyramid } from '../src/core/data/pyramid.ts';
import { datasetRegistry, newDatasetId } from '../src/core/data/datasets.ts';
import { installCanvasStub } from './helpers/canvas.ts';
import { evaluateTrade, makeTrade, type Trade } from '../src/core/backtest/trade.ts';
import { DEFAULT_ACCOUNT } from '../src/core/backtest/account.ts';
import { datasetRecordFromReport } from '../src/core/app/actions.ts';
import { tradeLedger, backtestStore, setAccount } from '../src/core/backtest/store.ts';
import { appStore, initialAppState } from '../src/core/app/state.ts';
import { chartHost } from '../src/core/chart/host.ts';

installCanvasStub();

const T0 = Date.UTC(2022, 0, 3, 0, 0);

function csv(rows: number): string {
  const out = ['timestamp,open,high,low,close,volume'];
  for (let i = 0; i < rows; i++) {
    const t = new Date(T0 + i * 60_000).toISOString().replace('T', ' ').replace('.000Z', '');
    const p = 1.1 + Math.sin(i / 500) * 0.02;
    out.push(`${t},${p.toFixed(5)},${(p + 0.0006).toFixed(5)},${(p - 0.0006).toFixed(5)},${(p + 0.0002).toFixed(5)},${100 + (i % 50)}`);
  }
  return out.join('\n');
}

describe('large imports stay bounded', () => {
  it('parses and folds 40 000 one-minute rows into the native series', () => {
    const text = csv(40_000);
    const started = performance.now();
    const parsed = parseCsv(text, {});
    const builder = new MarketCsvBuilder({ tz: 'UTC', symbol: 'EURUSD', tf: '1m', fileName: 'big.csv' });
    builder.setMap(detectColumns(parsed.slice(0, 50)).roles);
    for (const row of parsed) builder.feed(row);
    const { cols, report } = builder.finish();
    const elapsed = performance.now() - started;
    expect(report.accepted).toBe(40_000);
    expect(report.rejected).toBe(0);
    expect(cols.len).toBe(40_000);
    expect(report.timeframe).toBe('1m');
    expect(report.priceDecimals).toBe(5);
    // A synchronous parse of this size must stay far below a freeze-worthy budget.
    expect(elapsed).toBeLessThan(8_000);
  });

  it('aggregates the whole file once and keeps the pyramid bounded', () => {
    const series = seriesFromArrays(
      Array.from({ length: 50_000 }, (_, i) => T0 + i * 60_000),
      Array.from({ length: 50_000 }, (_, i) => 1 + (i % 7) * 0.001),
      Array.from({ length: 50_000 }, (_, i) => 1.002 + (i % 7) * 0.001),
      Array.from({ length: 50_000 }, (_, i) => 0.998 + (i % 7) * 0.001),
      Array.from({ length: 50_000 }, (_, i) => 1.001 + (i % 7) * 0.001),
      undefined,
      { symbol: 'EURUSD', tf: '1m', tz: 'UTC' },
    );
    const hour = aggregateSeries(series, '1H', 'UTC');
    expect(hour.count).toBe(Math.ceil(50_000 / 60));
    const pyramid = new Pyramid(series.cols);
    // A full-history fit still renders at most the pixel budget of rows.
    const plan = pyramid.plan(0, series.count, series.count, 1800 / 1.6);
    expect(plan.primitives).toBeLessThanOrEqual(Math.ceil(1800 / 1.6) + 2);
    expect(plan.segments.length).toBeGreaterThan(0);
    expect(plan.baseTo).toBeLessThanOrEqual(series.count);
    const bounds = pyramid.boundsFor(plan);
    expect(bounds.max).toBeGreaterThan(bounds.min);
  });

  it('round-trips a 20 000-bar dataset through IndexedDB unchanged', async () => {
    const text = csv(20_000);
    const builder = new MarketCsvBuilder({ tz: 'UTC', symbol: 'EURUSD', tf: '1m', fileName: 'round-trip.csv' });
    const rows = parseCsv(text, {});
    builder.setMap(detectColumns(rows.slice(0, 50)).roles);
    for (const row of rows) builder.feed(row);
    const { cols, report } = builder.finish();
    expect(report.accepted).toBe(20_000);
    const id = newDatasetId();
    const record = { ...datasetRecordFromReport(report, text.length, 'round-trip.csv'), id, createdAt: Date.now() };
    await datasetRegistry.register(record, cols);
    const loaded = await datasetRegistry.base(id);
    expect(loaded?.count).toBe(cols.len);
    expect(loaded?.time(cols.len - 1)).toBe(cols.t[cols.len - 1]);
    // Evict from memory only, then come back through storage.
    datasetRegistry.releaseMemory(id);
    expect(datasetRegistry.cachedView(id, '1m', 'UTC')).toBeNull();
    const again = await datasetRegistry.base(id);
    expect(again).not.toBeNull();
    expect(again!.count).toBe(cols.len);
    for (const i of [0, 999, 12_345, cols.len - 1]) {
      expect(again!.cols.c[i]).toBe(cols.c[i]);
      expect(again!.cols.h[i]).toBe(cols.h[i]);
      expect(again!.cols.t[i]).toBe(cols.t[i]);
    }
    await datasetRegistry.remove(id);
    await expect(datasetRegistry.base(id)).rejects.toThrow(/unknown dataset/);
  });
});

describe('incremental evaluation of a long open trade', () => {
  const series = (() => {
    const n = 5_000;
    const t: number[] = [];
    const o: number[] = [];
    const h: number[] = [];
    const l: number[] = [];
    const c: number[] = [];
    for (let i = 0; i < n; i++) {
      const mid = 1.1 + Math.sin(i / 37) * 0.01 + i * 1e-6;
      t.push(T0 + i * 60_000);
      o.push(mid);
      h.push(mid + 0.0015);
      l.push(mid - 0.0012);
      c.push(mid + 0.0004);
    }
    return seriesFromArrays(t, o, h, l, c, undefined, { symbol: 'EURUSD', tf: '1m', tz: 'UTC' });
  })();

  function tradeAt(entryBar: number, stop: number | null): Trade {
    const acc = { ...DEFAULT_ACCOUNT, spreadPips: 0.8, slippagePips: 0.2, decimals: 5 };
    return makeTrade(
      {
        symbol: 'EURUSD',
        tf: '1m',
        side: 'buy',
        size: 10_000,
        entryKind: 'market',
        entryBar,
        entryPrice: series.candle(entryBar)!.c,
        stop,
        target: null,
        manualExitBar: null,
        note: '',
      } as never,
      acc,
    );
  }

  it('matches a cold scan at every cursor after the entry', () => {
    const acc = { ...DEFAULT_ACCOUNT, spreadPips: 0.8, slippagePips: 0.2, decimals: 5 };
    const t = tradeAt(10, 1.05);
    let state: ReturnType<typeof evaluateTrade>['scanState'] = null;
    for (let cursor = 11; cursor < 400; cursor++) {
      const gated = series.withLimit(cursor + 1);
      const resumed = evaluateTrade(t, { series: gated, account: acc, quoteCcy: 'USD', resume: state }, 10_000);
      const cold = evaluateTrade(t, { series: gated, account: acc, quoteCcy: 'USD' }, 10_000);
      expect(resumed.mfePips).toBeCloseTo(cold.mfePips!, 6);
      expect(resumed.maePips).toBeCloseTo(cold.maePips!, 6);
      expect(resumed.netPips).toBeCloseTo(cold.netPips, 6);
      expect(resumed.markedAt?.index).toBe(cursor);
      state = resumed.scanState;
      expect(state).not.toBeNull();
    }
  });

  it('a resumed scan cannot skip a stop that only becomes reachable later', () => {
    const acc = { ...DEFAULT_ACCOUNT, spreadPips: 0, slippagePips: 0, decimals: 5 };
    // Stop far below, so nothing resolves until the dip arrives.
    const t = tradeAt(0, 1.0895);
    let state: ReturnType<typeof evaluateTrade>['scanState'] = null;
    let resolved = false;
    for (let cursor = 1; cursor < 900 && !resolved; cursor++) {
      const gated = series.withLimit(cursor + 1);
      const out = evaluateTrade(t, { series: gated, account: acc, quoteCcy: 'USD', resume: state }, 10_000);
      const cold = evaluateTrade(t, { series: gated, account: acc, quoteCcy: 'USD' }, 10_000);
      expect(out.status).toBe(cold.status);
      expect(out.exit?.price ?? null).toBe(cold.exit?.price ?? null);
      expect(out.exit?.index ?? null).toBe(cold.exit?.index ?? null);
      if (cold.status === 'closed') resolved = true;
      state = out.scanState;
    }
    expect(resolved).toBe(true);
  });

  it('the ledger memoises results so a repaint does not re-scan', () => {
    appStore.set({ ...initialAppState, datasetId: null, replay: { active: false, cursor: 0, knownUntil: null, total: 0, playing: false, speed: 1, follow: false } });
    const stub = {
      getSeries: () => series.withLimit(600),
      getBaseSeries: () => series,
      getReplayBarrier: () => null,
      setReplayBarrier: () => undefined,
      requestRender: () => undefined,
      setLegendNote: () => undefined,
      getVisibleRange: () => ({ from: 0, to: 600 }),
      goToTime: () => true,
    } as never;
    chartHost.engine = stub;
    try {
      tradeLedger.clear();
      tradeLedger.open({ side: 'buy', bar: 5, price: series.time(5), size: 1_000, stop: null, target: null });
      const first = tradeLedger.results();
      const second = tradeLedger.results();
      expect(second).toBe(first); // same array identity: nothing was recomputed
      appStore.set({ tf: '5m' });
      const third = tradeLedger.results();
      expect(third).not.toBe(first);
      tradeLedger.clear();
    } finally {
      chartHost.engine = null;
    }
  });
});

describe('UI stays light on the main thread', () => {
  it('windowed rows: a 500-item list renders a fraction of the nodes', async () => {
    const { createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    const { VirtualList } = await import('../src/ui/kit.tsx');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const items = Array.from({ length: 500 }, (_, i) => ({ n: i }));
    await act(async () => {
      root.render(
        createElement(VirtualList as never, {
          items,
          rowHeight: 50,
          maxHeight: 300,
          render: (item: { n: number }) => createElement('div', { className: 'list-row' }, `row ${item.n}`),
        } as never),
      );
    });
    const rows = host.querySelectorAll('.list-row');
    expect(rows.length).toBeGreaterThan(4);
    expect(rows.length).toBeLessThan(40);
    // The first row is visible and the container reserves the full scroll height.
    expect(rows[0].textContent).toBe('row 0');
    const scroller = host.querySelector('.scroll-y') as HTMLElement;
    const spacer = scroller.firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe('25000px');
    expect(scroller.style.maxHeight).toBe('300px');
    await act(async () => root.unmount());
    host.remove();
  });

  it('no reactive app state ever holds a candle series', () => {
    const keys = Object.keys(appStore.get());
    for (const key of keys) {
      const value = (appStore.get() as unknown as Record<string, unknown>)[key];
      expect(value === null || typeof value !== 'object' || !('total' in (value as object)) || typeof (value as { total?: unknown }).total !== 'number' || !('candle' in (value as object))).toBe(true);
    }
    expect(keys).not.toContain('series');
    expect(keys).not.toContain('cols');
  });
});

describe('remount hygiene', () => {
  let canvasAdds = 0;
  let canvasRemoves = 0;
  let windowKeydown = 0;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    canvasAdds = 0;
    canvasRemoves = 0;
    windowKeydown = 0;
    const proto = EventTarget.prototype;
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    proto.addEventListener = function (this: EventTarget, ...args: Parameters<typeof add>): void {
      if (this instanceof HTMLCanvasElement) canvasAdds += 1;
      if (this === window && args[0] === 'keydown') windowKeydown += 1;
      return add.apply(this, args);
    };
    proto.removeEventListener = function (this: EventTarget, ...args: Parameters<typeof remove>): void {
      if (this instanceof HTMLCanvasElement) canvasRemoves += 1;
      return remove.apply(this, args);
    };
    restore = () => {
      proto.addEventListener = add;
      proto.removeEventListener = remove;
    };
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('every canvas listener the chart installs is released on unmount', async () => {
    const { createRoot } = await import('react-dom/client');
    const { createElement } = await import('react');
    const { App } = await import('../src/ui/shell/App.tsx');
    for (let cycle = 0; cycle < 3; cycle++) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      Object.defineProperty(host, 'clientWidth', { value: 1200, configurable: true });
      Object.defineProperty(host, 'clientHeight', { value: 700, configurable: true });
      const root = createRoot(host);
      root.render(createElement(App));
      await new Promise((resolve) => setTimeout(resolve, 40));
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 10));
      host.remove();
    }
    expect(canvasAdds).toBeGreaterThan(0);
    expect(canvasRemoves).toBe(canvasAdds);
    // The global shortcut handler is installed once per page, not once per mount.
    expect(windowKeydown).toBeLessThanOrEqual(1);
  });

  it('dataset memory is bounded and re-loadable after release', async () => {
    const text = csv(600);
    const rows = parseCsv(text, {});
    const builder = new MarketCsvBuilder({ tz: 'UTC', symbol: 'EURUSD', tf: '1m', fileName: 'bounded.csv' });
    builder.setMap(detectColumns(rows.slice(0, 50)).roles);
    for (const row of rows) builder.feed(row);
    const { cols, report } = builder.finish();
    const id = newDatasetId();
    await datasetRegistry.register({ ...datasetRecordFromReport(report, text.length, 'bounded.csv'), id, createdAt: Date.now() }, cols);
    expect(datasetRegistry.inMemoryBytes()).toBeGreaterThan(0);
    datasetRegistry.releaseMemory(id);
    expect(datasetRegistry.inMemoryBytes()).toBe(0);
    const again = await datasetRegistry.base(id);
    expect(again?.count).toBe(600);
    await datasetRegistry.remove(id);
  });

  it('the ledger and the account settings survive a reset cleanly', () => {
    setAccount({ riskPerTradePct: 2 });
    expect(backtestStore.get().account.riskPerTradePct).toBe(2);
    tradeLedger.clear();
    expect(tradeLedger.count()).toBe(0);
    expect(tradeLedger.results()).toEqual([]);
  });
});

