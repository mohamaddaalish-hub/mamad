/**
 * Controlled optimisation: a small, explicit grid of strategy variants compared
 * side by side. Heavy work runs in a Web Worker (see workers/newsBacktest.worker.ts)
 * with progress and cancellation; a synchronous fallback exists for tests/node.
 */

import type { CandleSeries } from '../data/series.ts';
import type { EnrichedEvent } from '../econ/study.ts';
import { compactSeries, runNewsBacktest, seriesFromPayload, type NewsBacktestResult, type NewsStrategy, type SeriesPayload, describeStrategy } from './news.ts';
import type { SplitConfig } from './stats.ts';

export interface GridAxes {
  entryMinutes: number[];
  exitMinutes: (number | null)[];
  minAbsZ: (number | null)[];
  tpPips: (number | null)[];
  slPips: (number | null)[];
}

export const DEFAULT_GRID: GridAxes = {
  entryMinutes: [1, 5],
  exitMinutes: [30, 60],
  minAbsZ: [1, 2],
  tpPips: [null],
  slPips: [null],
};

export const MAX_GRID = 96;

export function buildGrid(base: NewsStrategy, axes: GridAxes): NewsStrategy[] {
  const out: NewsStrategy[] = [];
  for (const em of axes.entryMinutes)
    for (const xm of axes.exitMinutes)
      for (const z of axes.minAbsZ)
        for (const tp of axes.tpPips)
          for (const sl of axes.slPips) {
            if (xm === null && tp === null && sl === null) continue;
            const s: NewsStrategy = {
              ...base,
              entry: { kind: 'minutes', value: em },
              exit: { ...base.exit, timeMin: xm, tpPips: tp, slPips: sl },
              minAbsZ: z,
              requireZ: z !== null ? true : base.requireZ,
            };
            s.label = describeStrategy(s);
            out.push(s);
            if (out.length >= MAX_GRID) return out;
          }
  return out;
}

export interface OptimizeRequest {
  type: 'optimize';
  events: EnrichedEvent[];
  series: SeriesPayload;
  strategies: NewsStrategy[];
  split: SplitConfig | null;
}

export type OptimizeMessage =
  | { type: 'progress'; done: number; total: number; label: string }
  | { type: 'result'; index: number; result: NewsBacktestResult }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** Pure runner shared by the worker and the fallback. */
export function runGridSync(req: OptimizeRequest, onMessage: (m: OptimizeMessage) => void, shouldStop: () => boolean = () => false): void {
  const series = seriesFromPayload(req.series);
  const total = req.strategies.length;
  for (let i = 0; i < total; i++) {
    if (shouldStop()) return;
    const s = req.strategies[i];
    onMessage({ type: 'progress', done: i, total, label: s.label ?? describeStrategy(s) });
    const result = runNewsBacktest(req.events, series, s, req.split);
    // Trade lists for every variant are large; keep them for the top-level UI but strip equity arrays beyond a cap.
    onMessage({ type: 'result', index: i, result });
  }
  onMessage({ type: 'progress', done: total, total, label: 'finished' });
  onMessage({ type: 'done' });
}

export interface OptimizeHandle {
  cancel(): void;
  promise: Promise<NewsBacktestResult[]>;
}

/** Longest horizon any strategy may need after a release (ms). */
export function maxAfterMs(strategies: readonly NewsStrategy[]): number {
  let max = 0;
  for (const s of strategies) {
    const hold = s.exit.timeMin ?? 1440 * 5;
    const delay = s.entry.kind === 'minutes' ? s.entry.value : s.entry.kind === 'bars' ? s.entry.value * 60 : 0;
    max = Math.max(max, (hold + delay + 5) * 60_000);
  }
  return max;
}

export function optimize(
  events: readonly EnrichedEvent[],
  series: CandleSeries,
  strategies: NewsStrategy[],
  split: SplitConfig | null,
  onProgress: (done: number, total: number, label: string) => void,
): OptimizeHandle {
  const payload = compactSeries(series, events.map((e) => e.event.time), 2 * 86_400_000, maxAfterMs(strategies));
  const req: OptimizeRequest = { type: 'optimize', events: [...events], series: payload, strategies, split };
  const results: NewsBacktestResult[] = new Array(strategies.length);
  let cancelled = false;
  let worker: Worker | null = null;
  const promise = new Promise<NewsBacktestResult[]>((resolve, reject) => {
    const handle = (m: OptimizeMessage): void => {
      if (m.type === 'progress') onProgress(m.done, m.total, m.label);
      else if (m.type === 'result') results[m.index] = m.result;
      else if (m.type === 'done') resolve(results.filter(Boolean));
      else if (m.type === 'error') reject(new Error(m.message));
    };
    if (typeof Worker !== 'undefined' && typeof import.meta.url === 'string') {
      try {
        worker = new Worker(new URL('../../workers/newsBacktest.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (ev: MessageEvent<OptimizeMessage>) => handle(ev.data);
        worker.onerror = (ev) => reject(new Error(ev.message || 'worker failed'));
        worker.postMessage(req, [payload.t.buffer, payload.o.buffer, payload.h.buffer, payload.l.buffer, payload.c.buffer]);
        return;
      } catch (err) {
        console.warn('[optimize] worker unavailable, running inline', err);
      }
    }
    // Inline fallback: chunk across macrotasks so the UI stays responsive.
    let i = 0;
    const s = seriesFromPayload(req.series);
    const step = (): void => {
      if (cancelled) return resolve(results.filter(Boolean));
      const end = Math.min(strategies.length, i + 1);
      for (; i < end; i++) {
        onProgress(i, strategies.length, strategies[i].label ?? '');
        results[i] = runNewsBacktest(req.events, s, strategies[i], split);
      }
      if (i >= strategies.length) {
        onProgress(i, strategies.length, 'finished');
        resolve(results.filter(Boolean));
      } else setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
  return {
    cancel() {
      cancelled = true;
      worker?.terminate();
      worker = null;
    },
    promise,
  };
}
