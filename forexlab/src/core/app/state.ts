/**
 * Application state spine.
 *
 * One store, slice selectors, and a hard rule: nothing bulk goes in here.
 * Datasets, event tables and drawings live in registries (typed arrays / plain
 * maps) and are referenced by id from state.
 */

import { createStore, useSlice, type Store } from '../store/state.ts';
import * as idb from '../store/idb.ts';
import { DEFAULT_CHART_SETTINGS, type ChartSettings } from '../chart/style.ts';
import type { TimeframeId } from '../time/timeframes.ts';
import { uid } from '../util/format.ts';

export type PanelId =
  | 'watchlist'
  | 'import'
  | 'replay'
  | 'backtest'
  | 'news'
  | 'research'
  | 'objects'
  | 'settings';

export interface WatchItem {
  id: string;
  symbol: string;
  label: string;
  favorite: boolean;
  datasetId: string | null;
  tf: TimeframeId;
}

export interface Diagnostic {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  at: number;
}

export interface ReplayState {
  active: boolean;
  /** Cursor index into the active timeframe series (inclusive last visible bar). */
  cursor: number;
  /**
   * Authoritative boundary: every base bar with time <= knownUntil is known, and
   * nothing after it is. `cursor` is derived from this on every timeframe or
   * timezone change, so replay knowledge survives aggregation.
   */
  knownUntil: number | null;
  total: number;
  playing: boolean;
  speed: number;
  follow: boolean;
}

export interface AppState {
  ready: boolean;
  datasetId: string | null;
  datasetEpoch: number;
  symbol: string;
  tf: TimeframeId;
  tz: string;
  chart: ChartSettings;
  loading: string | null;
  diagnostics: Diagnostic[];
  watchlist: WatchItem[];
  panel: PanelId | null;
  leftOpen: boolean;
  rightOpen: boolean;
  fullscreen: boolean;
  tool: string | null;
  replay: ReplayState;
  statusHint: string;
  /** Data provenance: real user import vs deterministic test fixture. */
  fixtureMode: boolean;
}

export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;

export const initialAppState: AppState = {
  ready: false,
  datasetId: null,
  datasetEpoch: 0,
  symbol: 'EURUSD',
  tf: '15m',
  tz: 'UTC',
  chart: DEFAULT_CHART_SETTINGS,
  loading: null,
  diagnostics: [],
  watchlist: [],
  panel: 'watchlist',
  leftOpen: true,
  rightOpen: false,
  fullscreen: false,
  tool: null,
  replay: { active: false, cursor: 0, knownUntil: null, total: 0, playing: false, speed: 1, follow: true },
  statusHint: '',
  fixtureMode: false,
};

export const appStore: Store<AppState> = createStore<AppState>(initialAppState);

export function useApp<K>(select: (s: AppState) => K, isEqual?: (a: K, b: K) => boolean): K {
  return useSlice(appStore, select, isEqual);
}

export function pushDiagnostic(level: Diagnostic['level'], text: string): void {
  const list = appStore.get().diagnostics;
  const next = [...list, { id: uid('dx'), level, text, at: Date.now() }].slice(-40);
  appStore.set({ diagnostics: next });
  if (level !== 'info') console.warn(`[${level}] ${text}`);
}

export function clearDiagnostics(): void {
  appStore.set({ diagnostics: [] });
}

export function setLoading(text: string | null): void {
  appStore.set({ loading: text });
}

/** Watchlist persistence (settings + watchlist only; datasets live in their own store). */
const KV_KEY = 'ui-state-v1';

interface PersistedState {
  tf: TimeframeId;
  tz: string;
  chart: ChartSettings;
  watchlist: WatchItem[];
  leftOpen: boolean;
  rightOpen: boolean;
  symbol: string;
}

export async function persistUiState(): Promise<void> {
  const s = appStore.get();
  const payload: PersistedState = {
    tf: s.tf,
    tz: s.tz,
    chart: s.chart,
    watchlist: s.watchlist,
    leftOpen: s.leftOpen,
    rightOpen: s.rightOpen,
    symbol: s.symbol,
  };
  await idb.put('kv', payload, KV_KEY);
}

export async function restoreUiState(): Promise<void> {
  const saved = await idb.get<PersistedState>('kv', KV_KEY);
  if (!saved) return;
  appStore.set({
    tf: saved.tf ?? initialAppState.tf,
    tz: saved.tz ?? 'UTC',
    chart: { ...DEFAULT_CHART_SETTINGS, ...saved.chart },
    watchlist: saved.watchlist ?? [],
    leftOpen: saved.leftOpen ?? true,
    rightOpen: saved.rightOpen ?? false,
    symbol: saved.symbol ?? 'EURUSD',
    datasetId: saved.watchlist?.find((w) => w.datasetId)?.datasetId ?? null,
  });
}

export function defaultWatchItem(symbol: string, datasetId: string | null): WatchItem {
  const clean = symbol.toUpperCase();
  return {
    id: uid('w'),
    symbol: clean,
    label: clean,
    favorite: false,
    datasetId,
    tf: '15m',
  };
}
