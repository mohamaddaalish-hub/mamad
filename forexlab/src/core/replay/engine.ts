/**
 * Historical Bar Replay.
 *
 * Replay moves a knowledge boundary. The boundary is a *timestamp* (`knownUntil`)
 * held in app state; the visible bar cursor for the current timeframe is derived
 * from it, which is what makes replay correct across timeframe and timezone
 * changes and inside every aggregation (see `replay/boundary.ts` and
 * `replay/gate.ts`). The transport is deterministic: which bars appear depends only
 * on the start point and the step commands, never on wall-clock timing — speed
 * changes how fast the same sequence is delivered. `checksum()` fingerprints the
 * visible state so a test can prove two runs agree.
 */

import { appStore, pushDiagnostic, REPLAY_SPEEDS, type ReplayState } from '../app/state.ts';
import { chartHost } from '../chart/host.ts';
import { overlayRegistry } from '../app/overlays.ts';
import { formatDateTime } from '../time/tz.ts';
import type { CandleSeries } from '../data/series.ts';
import { cursorForKnownUntil, isAllKnown, knownUntilForCursor } from './boundary.ts';
import { fullSeries } from './gate.ts';

/** Bars delivered per second at 1×. Chosen for readable candle-by-candle review. */
export const BARS_PER_SECOND_AT_1X = 8;
/** Upper bound on bars advanced in one animation frame (keeps a fast tab responsive). */
export const MAX_BARS_PER_FRAME = 400;

class BarReplay {
  private raf = 0;
  private lastTs = 0;
  private acc = 0;
  private delivered = 0;

  /** Bar index the replay (re)starts from, in the current timeframe's index space. */
  startIndex: number | null = null;
  /** Timestamp of that start bar — preferred over the index across timeframe switches. */
  startTime: number | null = null;

  get state(): ReplayState {
    return appStore.get().replay;
  }

  /** Bars in the displayed series (dataset's range at the active timeframe). */
  total(): number {
    return this.displayed()?.count ?? 0;
  }

  cursor(): number {
    return this.state.cursor;
  }

  isActive(): boolean {
    return this.state.active;
  }

  private displayed(): CandleSeries | null {
    return chartHost.engine?.getBaseSeries() ?? fullSeries();
  }

  /** Enter replay at `index` of the active timeframe's series. */
  start(index?: number, opts: { play?: boolean } = {}): boolean {
    const series = this.displayed();
    if (!series || series.count === 0) {
      pushDiagnostic('error', 'Nothing to replay — import a CSV first');
      return false;
    }
    const engine = chartHost.engine;
    const requested = index ?? this.startIndex ?? (engine ? Math.floor(engine.view.rightIndex) : series.count - 1);
    let cursor = Math.max(0, Math.min(series.count - 1, Math.round(requested)));
    if (index === undefined && this.startTime !== null) {
      const byTime = series.indexAtOrBefore(this.startTime);
      if (byTime >= 0) cursor = Math.min(series.count - 1, byTime);
    }
    if (cursor >= series.count - 1) {
      pushDiagnostic('warn', 'Replay starts on the newest bar — there is nothing left to reveal');
    }
    const prev = this.state;
    const knownUntil = knownUntilForCursor(series, cursor);
    appStore.set({
      replay: {
        active: true,
        cursor,
        knownUntil,
        total: series.count,
        playing: false,
        speed: prev.speed,
        follow: prev.follow,
      },
    });
    this.startTime = timeAt(cursor, series);
    engine?.setReplayBarrier(cursor, prev.follow);
    syncLegend();
    overlayRegistry.scheduleSync();
    pushDiagnostic(
      'info',
      `Replay armed at ${formatDateTime(this.startTime ?? 0, appStore.get().tz)} · bar ${cursor + 1} of ${series.count} (${series.tf}) · ${(series.count - cursor - 1).toLocaleString()} future bars hidden`,
    );
    if (opts.play) this.play();
    return true;
  }

  /** Leave replay, keeping the chart on the same moment in time. */
  stop(opts: { keepPosition?: boolean } = {}): void {
    const prev = this.state;
    if (!prev.active) return;
    const known = prev.knownUntil ?? timeAt(prev.cursor, this.displayed());
    const to = isAllKnown(known) ? null : known;
    this.pause();
    appStore.set({ replay: { ...prev, active: false, playing: false, knownUntil: null } });
    const engine = chartHost.engine;
    engine?.setReplayBarrier(null);
    if (opts.keepPosition !== false && to !== null && to !== undefined) {
      engine?.goToTime(to, 'right');
    }
    syncLegend();
    overlayRegistry.scheduleSync();
    pushDiagnostic('info', 'Replay ended — the full imported range is visible again');
  }

  exit(): void {
    this.stop();
  }

  toggle(): void {
    if (this.state.active) this.stop();
    else this.start();
  }

  play(): void {
    const s = this.state;
    if (!s.active) {
      this.start(undefined, { play: true });
      return;
    }
    if (s.playing) return;
    if (s.cursor >= s.total - 1) {
      pushDiagnostic('info', 'Replay is already at the newest bar — restart (R) to play again');
      return;
    }
    appStore.set({ replay: { ...s, playing: true } });
    this.acc = 0;
    this.lastTs = 0;
    this.schedule();
  }

  pause(): void {
    const s = this.state;
    if (s.playing) appStore.set({ replay: { ...s, playing: false } });
    this.unschedule();
  }

  playPause(): void {
    if (this.state.active && this.state.playing) this.pause();
    else if (this.state.active) this.play();
    else this.start(undefined, { play: true });
  }

  isPlaying(): boolean {
    return this.state.playing;
  }

  /** Advance (or rewind, with a negative count) by whole bars of the active timeframe. */
  step(bars = 1): number {
    const series = this.displayed();
    if (!series || series.count === 0) return 0;
    const s = this.state;
    const from = s.active ? s.cursor : this.edgeCursor(series);
    const target = Math.max(0, Math.min(series.count - 1, from + bars));
    if (target === from) {
      if (bars > 0 && s.active) {
        this.pause();
        pushDiagnostic('info', 'Replay reached the newest imported bar');
      } else if (!s.active) {
        pushDiagnostic('info', 'Nothing before the first bar to reveal');
      }
      return 0;
    }
    const knownUntil = knownUntilForCursor(series, target);
    const atEnd = target >= series.count - 1;
    const next: ReplayState = {
      ...s,
      active: true,
      total: series.count,
      cursor: target,
      knownUntil,
      playing: atEnd ? false : s.active ? s.playing : false,
    };
    appStore.set({ replay: next });
    chartHost.engine?.setReplayBarrier(next.cursor, next.follow);
    if (atEnd) this.unschedule();
    this.delivered += Math.abs(target - from);
    syncLegend();
    overlayRegistry.scheduleSync();
    return target - from;
  }

  private edgeCursor(series: CandleSeries): number {
    const engine = chartHost.engine;
    if (!engine) return 0;
    return Math.max(0, Math.min(series.count - 1, Math.floor(engine.view.rightIndex)));
  }

  /** Batched jump: one state update and one repaint, however many bars. */
  stepMany(count: number): void {
    this.step(count);
  }

  restart(): void {
    const s = this.state;
    const wasPlaying = s.playing;
    this.pause();
    const index =
      this.startTime !== null && this.displayed()
        ? (this.displayed() as CandleSeries).indexAtOrBefore(this.startTime)
        : (this.startIndex ?? 0);
    this.start(Math.max(0, index), { play: wasPlaying });
  }

  /** Choose the (re)start bar. Recorded as a time so a timeframe switch keeps it. */
  setStartIndex(index: number | null): void {
    const series = this.displayed();
    if (index === null || !series || series.count === 0) {
      this.startIndex = null;
      this.startTime = null;
      chartHost.engine?.setLegendNote('');
      return;
    }
    const clamped = Math.max(0, Math.min(series.count - 1, Math.round(index)));
    this.startIndex = clamped;
    this.startTime = timeAt(clamped, series);
    if (!this.state.active) {
      chartHost.engine?.setLegendNote(
        this.startTime !== null ? `replay will start at ${formatDateTime(this.startTime, appStore.get().tz)}` : '',
      );
    }
  }

  /** Re-derive the armed start after a timeframe switch (same moment, new index). */
  reanchor(): void {
    const series = this.displayed();
    if (!series || series.count === 0) return;
    if (this.startTime !== null) {
      const i = series.indexAtOrBefore(this.startTime);
      if (i >= 0) this.startIndex = Math.min(series.count - 1, i);
    }
    const s = this.state;
    if (!s.active) return;
    const cursor = Math.max(0, cursorForKnownUntil(series, s.knownUntil));
    if (cursor === s.cursor && s.total === series.count) return;
    appStore.set({ replay: { ...s, cursor, total: series.count } });
    chartHost.engine?.setReplayBarrier(cursor, s.follow);
    syncLegend();
  }

  setSpeed(speed: number): void {
    const s = this.state;
    const clamped = REPLAY_SPEEDS.includes(speed as (typeof REPLAY_SPEEDS)[number]) ? speed : nearestSpeed(speed);
    appStore.set({ replay: { ...s, speed: clamped } });
    this.acc = 0;
  }

  cycleSpeed(dir: 1 | -1 = 1): void {
    const i = REPLAY_SPEEDS.indexOf(this.state.speed as (typeof REPLAY_SPEEDS)[number]);
    const next = REPLAY_SPEEDS[Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, (i < 0 ? 2 : i) + dir))];
    this.setSpeed(next);
  }

  setFollow(follow: boolean): void {
    const s = this.state;
    appStore.set({ replay: { ...s, follow } });
    if (follow) chartHost.engine?.setReplayBarrier(s.cursor, true);
  }

  /** Frame loop: converts elapsed time into a *count* of whole bars. */
  private schedule(): void {
    if (this.raf || typeof requestAnimationFrame !== 'function') return;
    const tick = (ts: number): void => {
      const s = appStore.get().replay;
      if (!s.active || !s.playing) {
        this.raf = 0;
        return;
      }
      if (!this.lastTs) this.lastTs = ts;
      const dt = Math.min(250, ts - this.lastTs); // a throttled tab must not dump the whole dataset
      this.lastTs = ts;
      const interval = 1000 / (BARS_PER_SECOND_AT_1X * Math.max(0.01, s.speed));
      this.acc += dt;
      const bars = Math.min(MAX_BARS_PER_FRAME, Math.floor(this.acc / interval));
      if (bars > 0) {
        this.acc -= bars * interval;
        this.step(bars);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private unschedule(): void {
    this.lastTs = 0;
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Bars delivered since load — exposed for tests and the status strip. */
  deliveredCount(): number {
    return this.delivered;
  }

  resetCounter(): void {
    this.delivered = 0;
  }

  /**
   * Fingerprint of what is currently visible: timeframe, bar count, first/last time
   * and a rolling sum over closes. Two runs of the same step script must match.
   */
  checksum(): string {
    const series = chartHost.engine?.getSeries();
    if (!series || series.count === 0) return 'empty';
    const cols = series.cols;
    const n = series.count;
    let acc = 0;
    for (let i = 0; i < n; i++) acc = (acc + Math.round(cols.c[i] * 1e5) + i) % 2147483647;
    return `${series.tf}:${n}:${series.time(0)}:${series.time(n - 1)}:${acc}`;
  }

  destroy(): void {
    this.unschedule();
  }
}

function nearestSpeed(v: number): number {
  let best: number = REPLAY_SPEEDS[0];
  let dist = Infinity;
  for (const s of REPLAY_SPEEDS) {
    const d = Math.abs(Math.log(s) - Math.log(v));
    if (d < dist) {
      dist = d;
      best = s;
    }
  }
  return best;
}

/** Timestamp of a bar index in a given series (the dataset, not the clipped view). */
export function timeAt(index: number, series: CandleSeries | null = fullSeries()): number | null {
  if (!series || index < 0 || index >= series.total) return null;
  const t = series.cols.t[index];
  return Number.isFinite(t) ? t : null;
}

function syncLegend(): void {
  const s = appStore.get().replay;
  const engine = chartHost.engine;
  if (!engine) return;
  if (!s.active) {
    engine.setLegendNote(
      barReplay.startIndex !== null && barReplay.startTime !== null
        ? `replay will start at ${formatDateTime(barReplay.startTime, appStore.get().tz)}`
        : '',
    );
    return;
  }
  const hidden = Math.max(0, s.total - s.cursor - 1);
  engine.setLegendNote(`REPLAY ${s.playing ? 'playing' : 'paused'} · ${hidden.toLocaleString()} future bars hidden`);
}

export const barReplay = new BarReplay();

/** Progress 0..1 through the dataset for the current cursor. */
export function replayProgress(): number {
  const s = appStore.get().replay;
  if (!s.active || s.total <= 1) return 0;
  return Math.max(0, Math.min(1, s.cursor / (s.total - 1)));
}

/** Enter replay from an exact instant (used by news "replay from before event"). */
export function startReplayAtTime(instant: number, offsetMs = 0): boolean {
  const series = chartHost.engine?.getBaseSeries() ?? fullSeries();
  if (!series) return false;
  const i = series.indexAtOrBefore(instant + offsetMs);
  if (i < 0) {
    pushDiagnostic('warn', 'That moment is before the imported data — nothing to replay from');
    return false;
  }
  return barReplay.start(i);
}

/** Move an already-running replay to another instant without changing its settings. */
export function seekReplayToTime(instant: number, offsetMs = 0): boolean {
  const series = chartHost.engine?.getBaseSeries() ?? fullSeries();
  if (!series || series.count === 0) return false;
  const i = series.indexAtOrBefore(instant + offsetMs);
  if (i < 0) return false;
  if (!barReplay.isActive()) return barReplay.start(i);
  const knownUntil = knownUntilForCursor(series, i);
  appStore.set({ replay: { ...barReplay.state, cursor: i, knownUntil, total: series.count } });
  barReplay.startTime = timeAt(i, series);
  chartHost.engine?.setReplayBarrier(i, barReplay.state.follow);
  syncLegend();
  overlayRegistry.scheduleSync();
  return true;
}
