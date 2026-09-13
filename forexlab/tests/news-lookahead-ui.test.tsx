// @vitest-environment jsdom
/**
 * Hard look-ahead tests at the UI / service boundary. The replay gate is the
 * single source of truth: news markers, the research snapshot, the event
 * detail lookup and the backtester must all refuse to see a release that lies
 * after the replay cursor — and must reveal it the moment the cursor passes it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { installCanvasStub, resetCanvasOps } from './helpers/canvas.ts';
import { ev } from './helpers/econ.ts';

vi.stubGlobal('ResizeObserver', class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
});
Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 1440, bottom: 800, width: 1440, height: 800, toJSON() { return {}; } } as DOMRect;
};
Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
installCanvasStub();

const { App } = await import('../src/ui/shell/App.tsx');
const actions = await import('../src/core/app/actions.ts');
const { appStore } = await import('../src/core/app/state.ts');
const replay = await import('../src/core/replay/engine.ts');
const store = await import('../src/core/econ/store.ts');
const service = await import('../src/core/econ/service.ts');
const { newsMarkers, openEventDetail } = await import('../src/core/econ/markers.ts');
const { dialogStore } = await import('../src/core/app/dialogs.ts');
const { runNewsBacktest, DEFAULT_STRATEGY } = await import('../src/core/backtest/news.ts');

let root: Root | null = null;
const START = Date.UTC(2024, 0, 2, 0, 0); // loadFixture start, 5m bars

async function mount(): Promise<void> {
  const container = document.createElement('div');
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
async function paint(): Promise<void> {
  await act(async () => {
    actions.chartHost.engine?.requestRender();
    await new Promise((r) => setTimeout(r, 30));
  });
}

const H = 3_600_000;
// Three releases inside the fixture: 10:00, 13:00 and 16:00 on day one.
const EVENTS = [ev(START + 10 * H, { id: 'k1', actual: 3.0, forecast: 2.9 }), ev(START + 13 * H, { id: 'k2', actual: 3.2, forecast: 3.0 }), ev(START + 16 * H, { id: 'k3', actual: 2.7, forecast: 3.0 })];

beforeEach(async () => {
  resetCanvasOps();
  await act(async () => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
  await store.newsRegistry.clear();
  await store.newsRegistry.addBatch(
    { id: 'b-test', fileName: 'fixture.csv', createdAt: 1, count: EVENTS.length, firstTime: EVENTS[0].time, lastTime: EVENTS[2].time, tz: 'UTC', summary: { rejectedRows: [] } as never },
    EVENTS,
  );
});

async function startReplayAt(time: number): Promise<void> {
  await act(async () => {
    const ok = replay.startReplayAtTime(time, 0);
    expect(ok).toBe(true);
    replay.barReplay.pause();
    await new Promise((r) => setTimeout(r, 20));
  });
  await tick();
}

describe('news look-ahead protection (UI boundary)', () => {
  it('hides releases after the cursor from markers, snapshot, detail and backtester — and reveals them as replay advances', async () => {
    await mount();
    await act(async () => {
      await actions.loadFixture(1200);
    });
    await tick();
    // Show a range covering the whole first day so all three events would be on screen if allowed.
    await act(async () => {
      actions.goToTimestamp(START + 13 * H, 'center');
    });
    const engine = actions.chartHost.engine!;
    engine.setBarSpacing(3);
    await tick();

    // Replay cursor at 11:00 → only the 10:00 release exists.
    await startReplayAt(START + 11 * H);
    const until = store.knownUntil();
    expect(until).toBeGreaterThanOrEqual(START + 10 * H);
    expect(until).toBeLessThan(START + 13 * H);

    const snap1 = service.computeResearch();
    expect(snap1.visible.map((e) => e.id)).toEqual(['k1']);
    expect(store.visibleEvent('k2')).toBeNull();
    expect(store.visibleEvent('k3')).toBeNull();
    expect(store.visibleEvent('k1')?.id).toBe('k1');

    await paint();
    const drawn1 = newsMarkers.drawnGlyphs().flatMap((g) => g.events.map((e) => e.id));
    expect(drawn1).not.toContain('k2');
    expect(drawn1).not.toContain('k3');

    // Opening a future event by id must not leak it: dialog opens, but the body reports it unknown.
    await act(async () => {
      openEventDetail('k2');
    });
    await tick();
    expect(dialogStore.get().open).toBe('eventDetail');
    expect(document.body.textContent).toMatch(/not part of known history/);
    expect(document.body.textContent).not.toMatch(/3\.2%/);
    await act(async () => {
      dialogStore.set({ open: null, payload: null });
    });

    // Backtester sees only gated candidates and gated bars.
    const r1 = runNewsBacktest(snap1.filtered, snap1.series!, DEFAULT_STRATEGY, null);
    expect(r1.totalEvents).toBe(1);
    for (const t of r1.trades) expect(t.exitTime).toBeLessThanOrEqual(until);
    expect(snap1.series!.time(snap1.series!.count - 1)).toBeLessThanOrEqual(until);

    // Advance to 14:00 → 13:00 release now exists, 16:00 still not.
    await act(async () => {
      replay.seekReplayToTime(START + 14 * H, 0);
      await new Promise((r) => setTimeout(r, 20));
    });
    await tick();
    const snap2 = service.computeResearch();
    expect(snap2.visible.map((e) => e.id)).toEqual(['k1', 'k2']);
    expect(store.visibleEvent('k3')).toBeNull();
    await paint();
    const drawn2 = newsMarkers.drawnGlyphs().flatMap((g) => g.events.map((e) => e.id));
    expect(drawn2).toContain('k2');
    expect(drawn2).not.toContain('k3');

    // Horizons beyond the cursor are UNAVAILABLE, never guessed.
    const x2 = snap2.enrich(store.visibleEvent('k2')!);
    const h240 = x2.reaction.post.find((p) => p.minutes === 240)!;
    expect(h240.pips.status).toBe('unavailable');
    const h15 = x2.reaction.post.find((p) => p.minutes === 15)!;
    expect(h15.pips.status).toBe('ok');

    // Exit replay → everything known again.
    await act(async () => {
      replay.barReplay.exit();
      await new Promise((r) => setTimeout(r, 20));
    });
    await tick();
    expect(service.computeResearch().visible.map((e) => e.id)).toEqual(['k1', 'k2', 'k3']);
    expect(appStore.get().replay.active).toBe(false);
  });
});

describe('news UI smoke (headless)', () => {
  it('renders News and Research panels, the filter drawer, import dialog and Objects extension without errors', async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { if (!String(a[0]).includes('act(')) errors.push(a); };
    try {
      await mount();
      await act(async () => {
        await actions.loadFixture(1200);
      });
      await tick();
      await act(async () => { appStore.set({ panel: 'news', rightOpen: true }); });
      await tick();
      expect(document.body.textContent).toMatch(/Consumer Price Index/);
      const filterBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Filter')!;
      expect(filterBtn).toBeTruthy();
      await act(async () => { filterBtn.click(); });
      await tick();
      expect(document.querySelector('.filter-drawer')).toBeTruthy();
      await act(async () => { appStore.set({ panel: 'research' }); });
      await tick();
      expect(document.querySelector('.research-panel')).toBeTruthy();
      for (const label of ['Reaction', 'Consistency', 'Distribution', 'Matrix', 'Sessions', 'Volatility', 'History', 'Compare', 'Backtest']) {
        const b = [...document.querySelectorAll('.research-panel button')].find((x) => x.textContent?.trim().startsWith(label));
        if (!b) continue;
        await act(async () => { (b as HTMLButtonElement).click(); });
        await tick();
      }
      const run = [...document.querySelectorAll('button')].find((b) => /Run backtest on/.test(b.textContent ?? ''))!;
      expect(run).toBeTruthy();
      await act(async () => { run.click(); await new Promise((r) => setTimeout(r, 60)); });
      await tick();
      expect(document.body.textContent).toMatch(/Backtest report/);
      await act(async () => { appStore.set({ panel: 'objects' }); });
      await tick();
      expect(document.body.textContent).toMatch(/News markers/);
      await act(async () => { dialogStore.set({ open: 'newsImport', payload: null }); });
      await tick();
      expect(document.body.textContent).toMatch(/Import/);
      await act(async () => { openEventDetail('k1'); });
      await tick();
      expect(document.body.textContent).toMatch(/Historical analysis only/);
    } finally {
      console.error = orig;
    }
    expect(errors).toEqual([]);
  });
});
