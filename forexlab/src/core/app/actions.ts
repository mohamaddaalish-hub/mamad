/**
 * Imperative application actions.
 *
 * The chart is an imperative canvas object, so view commands (go to date, zoom,
 * timeframe switch, replay follow) are functions here rather than reducers. State
 * keeps only what the UI needs to render.
 */

import { appStore, pushDiagnostic, persistUiState, type AppState } from './state.ts';
import { datasetRegistry, newDatasetId, type DatasetRecord } from '../data/datasets.ts';
import type { ChartEngine } from '../chart/engine.ts';
import { chartHost } from '../chart/host.ts';
import { cursorForKnownUntil, knownUntilForCursor } from '../replay/boundary.ts';
import { barReplay } from '../replay/engine.ts';
import { CandleSeries } from '../data/series.ts';
import { Pyramid } from '../data/pyramid.ts';
import { drawingStore } from '../draw/store.ts';
import { overlayRegistry } from './overlays.ts';
import { adoptPricePrecision } from '../backtest/store.ts';
import type { CandleColumns } from '../data/types.ts';
import { syntheticCandles } from '../data/synthetic.ts';
import type { ImportReport } from '../csv/market.ts';
import { isTimeframeId, timeframe, type TimeframeId } from '../time/timeframes.ts';
import { formatDate, formatTime, zonedToInstant } from '../time/tz.ts';

// Re-exported so existing UI call sites keep working; the object lives in
// chart/host.ts so core layers can reach it without importing this module.
export { chartHost };

export function bindEngine(engine: ChartEngine | null): void {
  chartHost.engine = engine;
  if (engine) void refreshSeries({ keepAnchor: false });
}

export interface OpenDatasetOptions {
  tf?: TimeframeId;
  tz?: string;
  /** Jump to this time instead of the newest bar. */
  at?: number;
}

/** Make a stored dataset the chart's data source. */
export async function openDataset(datasetId: string | null, opts: OpenDatasetOptions = {}): Promise<void> {
  if (!datasetId) {
    const replay = appStore.get().replay;
    appStore.set({
      datasetId: null,
      replay: { ...replay, active: false, playing: false, total: 0, cursor: 0, knownUntil: null },
    });
    chartHost.engine?.attachSeries(null, null);
    void drawingStore.useDataset(null);
    return;
  }
  await datasetRegistry.hydrate();
  const rec = datasetRegistry.get(datasetId);
  if (!rec) {
    pushDiagnostic('error', `Dataset ${datasetId} is not in the local library`);
    return;
  }
  const patch: Partial<AppState> = {
    datasetId,
    symbol: rec.symbol,
    datasetEpoch: appStore.get().datasetEpoch + 1,
    fixtureMode: rec.fileName === FIXTURE_FILE_NAME,
  };
  if (opts.tf) patch.tf = opts.tf;
  if (opts.tz) patch.tz = opts.tz;
  appStore.set(patch);
  void persistUiState();
  await refreshSeries({ keepAnchor: false });
  adoptPricePrecision(rec.report.priceDecimals, rec.symbol);
  await drawingStore.useDataset(datasetId);
  overlayRegistry.sync();
  if (opts.at !== undefined) chartHost.engine?.goToTime(opts.at, 'right');
  pushDiagnostic(
    'info',
    `${rec.symbol} ${rec.tf} · ${rec.count.toLocaleString()} bars · ${formatDate(rec.firstTime, rec.tz)} → ${formatDate(rec.lastTime, rec.tz)}`,
  );
}

/** (Re)load the series for the current (dataset, timeframe, timezone) triple. */
export async function refreshSeries(opts: { keepAnchor?: boolean } = {}): Promise<void> {
  const engine = chartHost.engine;
  if (!engine) return;
  const state = appStore.get();
  if (!state.datasetId) {
    engine.attachSeries(null, null, { tz: state.tz });
    syncReplayTotals(null, false);
    return;
  }
  const label = `aggregating ${state.tf}…`;
  appStore.set({ loading: label });
  // Yield a frame so the busy indicator paints before a synchronous aggregation.
  await new Promise((r) => setTimeout(r, 0));
  try {
    const { series, pyramid } = await datasetRegistry.view(state.datasetId, state.tf, state.tz);
    const now = appStore.get();
    if (now.datasetId !== state.datasetId || now.tf !== state.tf || now.tz !== state.tz) return;
    engine.attachSeries(series, pyramid, { tz: state.tz, keepTimeAnchor: opts.keepAnchor ?? true });
    syncReplayTotals(series, now.replay.active);
  } catch (err) {
    pushDiagnostic('error', `Could not load series: ${err instanceof Error ? err.message : String(err)}`);
    engine.attachSeries(null, null, { tz: state.tz });
  } finally {
    if (appStore.get().loading === label) appStore.set({ loading: null });
  }
}

export function syncReplayTotals(series: CandleSeries | null, keepActive: boolean): void {
  const replay = appStore.get().replay;
  const total = series?.count ?? 0;
  if (keepActive && series && total > 0) {
    // Re-derive the cursor from the knowledge boundary: a coarser timeframe has a
    // different index space, and the bar under construction must stay withheld.
    const known = replay.knownUntil ?? knownUntilForCursor(series, Math.min(replay.cursor, total - 1));
    const cursor = Math.max(0, cursorForKnownUntil(series, known));
    appStore.set({ replay: { ...replay, total, cursor, knownUntil: known } });
    chartHost.engine?.setReplayBarrier(cursor, replay.follow);
    return;
  }
  appStore.set({
    replay: { ...replay, total, cursor: Math.max(0, total - 1), knownUntil: null, active: false, playing: false },
  });
  chartHost.engine?.setReplayBarrier(null);
}

export async function setTimeframe(tf: TimeframeId): Promise<void> {
  if (!isTimeframeId(tf) || appStore.get().tf === tf) return;
  appStore.set({ tf });
  void persistUiState();
  await refreshSeries({ keepAnchor: true });
  // Replay keeps its *time* boundary; the armed index and cursor are re-derived.
  barReplay.reanchor();
}

export async function setTimezone(tz: string): Promise<void> {
  if (!tz || appStore.get().tz === tz) return;
  appStore.set({ tz });
  void persistUiState();
  await refreshSeries({ keepAnchor: true });
  barReplay.reanchor();
}

export function updateChartSettings(patch: Partial<AppState['chart']>): void {
  const chart = { ...appStore.get().chart, ...patch };
  appStore.set({ chart });
  chartHost.engine?.setSettings(chart);
  void persistUiState();
}

// ------------------------------------------------------------------ view moves
export function zoomIn(): void {
  chartHost.engine?.zoomBy(1.35);
}

export function zoomOut(): void {
  chartHost.engine?.zoomBy(1 / 1.35);
}

export function fitAll(): void {
  chartHost.engine?.fitAll();
}

export function autoscale(): void {
  chartHost.engine?.autoscale();
}

export function resetView(): void {
  chartHost.engine?.resetView();
}

/** Parse `2024-03-15 16:00` (or ISO) in the chart timezone and jump there. */
export function goToDateTime(input: string): boolean {
  const tz = appStore.get().tz;
  const instant = zonedToInstant(input, tz);
  if (instant === null) {
    pushDiagnostic('error', `Could not parse "${input}" — expected YYYY-MM-DD[ HH:mm[:ss]]`);
    return false;
  }
  return goToTimestamp(instant);
}

export function goToTimestamp(instant: number, align: 'right' | 'center' = 'right'): boolean {
  const engine = chartHost.engine;
  if (!engine) return false;
  const ok = engine.goToTime(instant, align);
  if (!ok) {
    const bounds = datasetBounds();
    pushDiagnostic(
      'warn',
      bounds
        ? `${formatDate(instant, appStore.get().tz)} is outside the imported range ${formatDate(bounds[0], appStore.get().tz)} → ${formatDate(bounds[1], appStore.get().tz)}`
        : 'No dataset loaded',
    );
  }
  return ok;
}

/** Range of the underlying dataset (all bars, ignoring the replay barrier). */
export function datasetBounds(): [number, number] | null {
  const series = chartHost.engine?.getSeries();
  if (!series || series.total === 0) return null;
  const cols = series.underlying();
  return [cols.t[0], cols.t[series.total - 1]];
}

/** Range the user is currently allowed to see (respects the replay barrier). */
export function visibleBounds(): [number, number] | null {
  const series = chartHost.engine?.getSeries();
  if (!series || series.count === 0) return null;
  return [series.time(0), series.time(series.count - 1)];
}

/** Move by whole periods of the active timeframe (prev/next date buttons). */
export function stepPeriod(direction: 1 | -1, count = 1): void {
  const engine = chartHost.engine;
  if (!engine) return;
  const series = engine.getSeries();
  if (!series || series.count === 0) return;
  const stepMs = timeframe(appStore.get().tf).ms ?? 86_400_000;
  const idx = Math.max(0, Math.min(series.count - 1, Math.floor(engine.view.rightIndex)));
  const current = series.time(idx);
  engine.goToTime(current + direction * stepMs * count, 'right');
}

export function jumpToFirst(): void {
  chartHost.engine?.goToIndex(0, 'right');
}

export function jumpToLast(): void {
  const series = chartHost.engine?.getSeries();
  if (series) chartHost.engine?.goToIndex(series.count - 1, 'right');
}

// ------------------------------------------------------------------- datasets
export async function deleteDataset(id: string): Promise<void> {
  await datasetRegistry.remove(id);
  if (appStore.get().datasetId === id) await openDataset(null);
  pushDiagnostic('info', 'Dataset removed from the local library');
}

export function datasetRecordFromReport(
  report: ImportReport,
  bytes: number,
  fileName: string,
): Omit<DatasetRecord, 'id' | 'createdAt'> {
  return {
    symbol: report.symbol,
    label: `${report.symbol} ${report.timeframe} ${formatDate(report.firstTime ?? 0, report.timezone)}–${formatDate(report.lastTime ?? 0, report.timezone)}`,
    fileName,
    bytes,
    tf: report.timeframe,
    tz: report.timezone,
    firstTime: report.firstTime ?? 0,
    lastTime: report.lastTime ?? 0,
    count: report.accepted,
    hasVolume: report.volumeSeen,
    report,
  };
}

/** Register freshly imported columnar data as a dataset and open it. */
export async function registerImportedDataset(
  cols: CandleColumns,
  meta: Omit<DatasetRecord, 'id' | 'createdAt'>,
  opts: { open?: boolean } = {},
): Promise<DatasetRecord> {
  const id = newDatasetId();
  const record: DatasetRecord = { ...meta, id, createdAt: Date.now() };
  await datasetRegistry.register(record, cols);
  if (opts.open !== false) await openDataset(id, { tf: record.tf === appStore.get().tf ? record.tf : appStore.get().tf });
  return record;
}

// --------------------------------------------------------------------- fixture
export const FIXTURE_FILE_NAME = 'synthetic-fixture';

/**
 * Load the deterministic synthetic fixture used for interface verification.
 * Flagged in state (`fixtureMode`) so the UI never presents it as market data.
 */
export async function loadFixture(bars = 12_000): Promise<void> {
  const { cols, tf } = syntheticCandles({
    bars,
    tf: '5m',
    start: Date.UTC(2024, 0, 2, 0, 0),
    seed: 20240102,
  });
  const report: ImportReport = {
    fileName: FIXTURE_FILE_NAME,
    symbol: 'EURUSD',
    timeframe: tf,
    nativeTimeframe: tf,
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
    minLow: Infinity,
    maxHigh: -Infinity,
    volumeSeen: true,
    priceDecimals: 5,
    invalid: [],
    notes: ['SYNTHETIC deterministic fixture — not market data, never a trading input.'],
    durationMs: 0,
    dateFormat: 'ISO-8601',
    timeFormat: 'HH:mm',
    columnMap: {},
    header: [],
  };
  for (let i = 0; i < cols.len; i++) {
    if (cols.l[i] < report.minLow) report.minLow = cols.l[i];
    if (cols.h[i] > report.maxHigh) report.maxHigh = cols.h[i];
  }
  const record: DatasetRecord = {
    id: newDatasetId(),
    createdAt: Date.now(),
    symbol: 'EURUSD',
    label: 'SYNTHETIC fixture (verification only)',
    fileName: FIXTURE_FILE_NAME,
    bytes: cols.len * 52,
    tf,
    tz: 'UTC',
    firstTime: cols.t[0],
    lastTime: cols.t[cols.len - 1],
    count: cols.len,
    hasVolume: true,
    report,
  };
  await datasetRegistry.register(record, cols);
  await openDataset(record.id, { tf: '30m' });
  pushDiagnostic('warn', 'Loaded a deterministic synthetic fixture for interface verification — this is NOT market data.');
}

// ------------------------------------------------------------------ series access
export function currentSeries(): CandleSeries | null {
  return chartHost.engine?.getSeries() ?? null;
}

export function currentView(): { series: CandleSeries; pyramid: Pyramid } | null {
  const state = appStore.get();
  if (!state.datasetId) return null;
  const cached = datasetRegistry.cachedView(state.datasetId, state.tf, state.tz);
  if (cached) return cached;
  const series = chartHost.engine?.getSeries();
  if (!series) return null;
  return { series, pyramid: new Pyramid(series.cols) };
}

export function timeLabel(t: number): string {
  const tz = appStore.get().tz;
  return `${formatDate(t, tz)} ${formatTime(t, tz)}`;
}
