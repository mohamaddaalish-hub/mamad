/**
 * The replay gate.
 *
 * One rule for the whole app: while a replay is running, every consumer — chart,
 * drawings, indicators later, the trade ledger, statistics, news markers and the
 * event study — must read bars through `allowedSeries()` / `allowedBounds()`.
 * The full dataset is reachable *only* through `fullSeries()` and is used solely
 * for the replay total and import diagnostics.
 *
 * This is what makes "no look-ahead" a structural property rather than a
 * convention: a module that wants a future bar has to deliberately bypass the
 * gate, and the test suite fails when it does.
 */

import type { CandleSeries } from '../data/series.ts';
import { chartHost } from '../chart/host.ts';
import { appStore } from '../app/state.ts';

export interface Gate {
  /** Index of the newest allowed bar, or null when no replay is active. */
  barrier: number | null;
  active: boolean;
}

export function currentGate(): Gate {
  const replay = appStore.get().replay;
  if (!replay.active) return { barrier: null, active: false };
  return { barrier: Math.max(0, replay.cursor), active: true };
}

/** Last index a consumer may touch, given a series of `count` bars. */
export function allowedLastIndex(count: number, gate: Gate = currentGate()): number {
  if (count <= 0) return -1;
  if (gate.barrier === null) return count - 1;
  return Math.max(0, Math.min(count - 1, gate.barrier));
}

/**
 * The series every visual/analytical consumer must use. During replay it is the
 * dataset clipped at the barrier (shares buffers, so this is O(1)).
 */
export function allowedSeries(): CandleSeries | null {
  const engine = chartHost.engine;
  if (!engine) return null;
  const gate = currentGate();
  const base = engine.getBaseSeries() ?? engine.getSeries();
  if (!base) return null;
  if (!gate.active) return engine.getSeries() ?? base;
  return base.withLimit(allowedLastIndex(base.count, gate) + 1);
}

/** Deliberate escape hatch: the complete dataset. Never use it for analytics. */
export function fullSeries(): CandleSeries | null {
  const engine = chartHost.engine;
  if (!engine) return null;
  return engine.getBaseSeries() ?? engine.getSeries();
}

/** [fromTime, toTime] the user is currently allowed to know about. */
export function allowedBounds(series = allowedSeries()): [number, number] | null {
  if (!series || series.count === 0) return null;
  return [series.time(0), series.time(series.count - 1)];
}

/** True when an instant is in the user's knowledge (bar or event timestamp). */
export function isKnown(instant: number, series = allowedSeries()): boolean {
  if (!series || series.count === 0) return false;
  return instant <= series.time(series.count - 1);
}

/** Index of the last allowed bar at or before `time`, or -1. */
export function allowedIndexAtOrBefore(time: number, series = allowedSeries()): number {
  if (!series || series.count === 0) return -1;
  return series.indexAtOrBefore(time);
}

/**
 * Fold the visible window into a coarser series while respecting the gate.
 * Used by the news reaction engine so aggregation can't sneak past the barrier.
 */
export function allowedRange(series: CandleSeries | null = allowedSeries()): { from: number; to: number } {
  if (!series) return { from: 0, to: 0 };
  const engine = chartHost.engine;
  const visible = engine?.getVisibleRange() ?? { from: 0, to: series.count };
  return {
    from: Math.max(0, Math.min(series.count - 1, visible.from)),
    to: Math.max(0, Math.min(series.count, visible.to)),
  };
}

export function hiddenBarCount(): number {
  const base = fullSeries();
  const allowed = allowedSeries();
  if (!base || !allowed) return 0;
  return Math.max(0, base.count - allowed.count);
}
