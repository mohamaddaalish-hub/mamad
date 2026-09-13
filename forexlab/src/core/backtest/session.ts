/**
 * Backtest sessions.
 *
 * A session is the unit of work: a dataset at a timeframe and timezone, a replay
 * position, the drawings, the trade ledger, the account and cost model, and the
 * chart settings. Saving a session snapshots all of it into IndexedDB under the
 * `sessions` store (the same layer the datasets already use — no second storage
 * architecture), and the trades keep their own key so the ledger can flush
 * independently while you work.
 */

import * as idb from '../store/idb.ts';
import { chartHost } from '../chart/host.ts';
import { appStore, pushDiagnostic, type ReplayState } from '../app/state.ts';
import { updateChartSettings } from '../app/actions.ts';
import { drawingStore } from '../draw/store.ts';
import { overlayRegistry } from '../app/overlays.ts';
import type { ChartSettings } from '../chart/style.ts';
import type { TimeframeId } from '../time/timeframes.ts';
import { DEFAULT_ACCOUNT, type AccountSettings } from './account.ts';
import { backtestStore, setAccount, tradeLedger } from './store.ts';
import { barReplay } from '../replay/engine.ts';
import type { Trade } from './trade.ts';
import { deserializeTrade } from './trade.ts';

export interface BacktestSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  datasetId: string | null;
  symbol: string;
  tf: TimeframeId;
  tz: string;
  replay: ReplayState;
  account: AccountSettings;
  chart: ChartSettings;
  trades: Trade[];
  drawings: unknown[];
  notes: string;
  /** Snapshot of the outcome *as saved* — the list is a library, not a live view. */
  summary: { closedTrades: number; netMoney: number | null; moneyCcy: string };
}

export interface SessionSummary {
  id: string;
  name: string;
  updatedAt: number;
  symbol: string;
  tf: TimeframeId;
  datasetId: string | null;
  closedTrades: number;
  netMoney: number | null;
  hasReplay: boolean;
  drawings: number;
}

const KEY = (id: string): string => id;

function newId(): string {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export async function listSessions(): Promise<SessionSummary[]> {
  try {
    const all = await idb.all<BacktestSession>('sessions');
    return all
      .filter((s) => s && typeof s.id === 'string')
      .map((s) => ({
        id: s.id,
        name: s.name || 'untitled session',
        updatedAt: s.updatedAt ?? s.createdAt ?? 0,
        symbol: s.symbol ?? '',
        tf: s.tf ?? '1m',
        datasetId: s.datasetId ?? null,
        closedTrades: s.summary?.closedTrades ?? s.trades?.length ?? 0,
        netMoney: s.summary?.netMoney ?? null,
        hasReplay: !!s.replay?.active,
        drawings: Array.isArray(s.drawings) ? s.drawings.length : 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    pushDiagnostic('error', `Sessions could not be listed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function currentSummary(): BacktestSession['summary'] {
  const results = tradeLedger.results();
  const closed = results.filter((r) => r.status === 'closed' && r.computable);
  const net = closed.length ? closed.reduce((acc, r) => acc + r.netMoney, 0) : null;
  return { closedTrades: closed.length, netMoney: net, moneyCcy: closed[0]?.moneyCcy ?? backtestStore.get().account.currency };
}

/** Snapshot the live work into the active session (creating one when needed). */
export async function saveSession(name?: string): Promise<string | null> {
  const state = appStore.get();
  const bt = backtestStore.get();
  const id = bt.sessionId ?? newId();
  const previous = await idb.get<BacktestSession>('sessions', KEY(id)).catch(() => undefined);
  const session: BacktestSession = {
    id,
    name: name ?? bt.sessionName ?? previous?.name ?? `${state.symbol} ${state.tf} session`,
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    datasetId: state.datasetId,
    symbol: state.symbol,
    tf: state.tf,
    tz: state.tz,
    replay: { ...state.replay },
    account: { ...bt.account },
    chart: { ...state.chart },
    trades: tradeLedger.exportTrades(),
    drawings: drawingStore.all().slice(),
    notes: backtestStore.get().sessionNotes || previous?.notes || '',
    summary: currentSummary(),
  };
  try {
    await tradeLedger.flush();
    await idb.put('sessions', session, KEY(id));
    backtestStore.set({ sessionId: id, sessionName: session.name });
    pushDiagnostic(
      'info',
      `Session "${session.name}" saved · ${session.trades.length} trade${session.trades.length === 1 ? '' : 's'} · ${session.drawings.length} drawing${session.drawings.length === 1 ? '' : 's'}`,
    );
    return id;
  } catch (err) {
    pushDiagnostic('error', `Session could not be saved locally: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function newSession(name: string): Promise<string> {
  const id = newId();
  backtestStore.set({ sessionId: id, sessionName: name, sessionNotes: '' });
  tradeLedger.forget();
  try {
    await idb.put('kv', [], `trades:${id}`);
  } catch {
    /* the first save will report a real failure */
  }
  pushDiagnostic('info', `New session "${name}" — trades and drawings are recorded under it`);
  return id;
}

/** Apply a stored session to the app. Returns false when the data is gone. */
export async function loadSession(id: string): Promise<boolean> {
  let session: BacktestSession | undefined;
  try {
    session = await idb.get<BacktestSession>('sessions', KEY(id));
  } catch (err) {
    pushDiagnostic('error', `Session could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!session) {
    pushDiagnostic('error', 'That session is no longer in local storage');
    return false;
  }
  backtestStore.set({ sessionId: session.id, sessionName: session.name, sessionNotes: session.notes ?? '' });
  setAccount({ ...DEFAULT_ACCOUNT, ...session.account });
  if (session.chart) updateChartSettings(session.chart);
  await tradeLedger.load(session.id);
  if (session.trades && tradeLedger.count() === 0) {
    const restored = session.trades
      .map((t) => deserializeTrade(t))
      .filter((t): t is Trade => t !== null);
    if (restored.length) tradeLedger.importTrades(restored);
    if (restored.length !== session.trades.length) {
      pushDiagnostic('warn', `${session.trades.length - restored.length} trade records in this session were unreadable`);
    }
  }
  const datasetGone = session.datasetId === null || !(await hasDataset(session.datasetId));
  if (session.datasetId && !datasetGone) {
    const { openDataset } = await import('../app/actions.ts');
    await openDataset(session.datasetId, { tf: session.tf, tz: session.tz });
    // The session's own drawings override the per-dataset store for this session.
    if (Array.isArray(session.drawings)) {
      const wanted = session.drawings.length;
      const read = await drawingStore.importJson(JSON.stringify({ kind: 'drawings', drawings: wanted ? session.drawings : [] }), { replace: true });
      if (read < wanted) {
        pushDiagnostic('warn', `${wanted - read} drawing record${wanted - read === 1 ? ' was' : 's were'} unreadable and were skipped`);
      }
    }
    if (session.replay?.active) {
      const seriesCount = chartHost.engine?.getBaseSeries()?.count ?? 0;
      if (seriesCount > 0) {
        const cursor = Math.max(0, Math.min(seriesCount - 1, session.replay.cursor));
        barReplay.setStartIndex(cursor);
        barReplay.start(cursor);
        appStore.set({ replay: { ...appStore.get().replay, knownUntil: session.replay.knownUntil ?? appStore.get().replay.knownUntil } });
        pushDiagnostic('info', `Replay restored at bar ${cursor + 1} of ${seriesCount}`);
      }
    } else {
      barReplay.stop();
    }
  } else {
    pushDiagnostic(
      'error',
      datasetGone
        ? `The dataset "${session.symbol}" this session was built on is no longer imported — trades and settings were loaded, the chart was not`
        : 'This session has no dataset attached',
    );
  }
  overlayRegistry.scheduleSync();
  return true;
}

async function hasDataset(id: string): Promise<boolean> {
  const { datasetRegistry } = await import('../data/datasets.ts');
  await datasetRegistry.hydrate();
  return !!datasetRegistry.get(id);
}

export async function duplicateSession(id: string, name: string): Promise<string | null> {
  const src = await idb.get<BacktestSession>('sessions', KEY(id)).catch(() => undefined);
  if (!src) {
    pushDiagnostic('error', 'Nothing to duplicate — the source session is missing');
    return null;
  }
  const copy: BacktestSession = {
    ...src,
    id: newId(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    await idb.put('sessions', copy, KEY(copy.id));
    await idb.put('kv', copy.trades, `trades:${copy.id}`);
    pushDiagnostic('info', `Session "${src.name}" duplicated as "${name}"`);
    return copy.id;
  } catch (err) {
    pushDiagnostic('error', `Duplicate failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function renameSession(id: string, name: string): Promise<void> {
  const src = await idb.get<BacktestSession>('sessions', KEY(id)).catch(() => undefined);
  if (!src) return;
  await idb.put('sessions', { ...src, name, updatedAt: Date.now() }, KEY(id));
  if (backtestStore.get().sessionId === id) backtestStore.set({ sessionName: name });
}

export async function setSessionNotes(id: string, notes: string): Promise<void> {
  const src = await idb.get<BacktestSession>('sessions', KEY(id)).catch(() => undefined);
  if (!src) return;
  await idb.put('sessions', { ...src, notes, updatedAt: Date.now() }, KEY(id));
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await idb.del('sessions', KEY(id));
    await idb.del('kv', `trades:${id}`);
    if (backtestStore.get().sessionId === id) {
      backtestStore.set({ sessionId: null, sessionName: '', sessionNotes: '' });
      tradeLedger.forget();
    }
    pushDiagnostic('info', 'Session deleted from local storage');
  } catch (err) {
    pushDiagnostic('error', `Session delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function exportSessionJson(id: string): Promise<string | null> {
  const src = await idb.get<BacktestSession>('sessions', KEY(id)).catch(() => undefined);
  if (!src) return null;
  return JSON.stringify({ app: 'forexlab', kind: 'backtest-session', v: 1, session: src }, null, 2);
}

export async function importSessionJson(text: string): Promise<string | null> {
  let parsed: { kind?: string; session?: BacktestSession } | null = null;
  try {
    parsed = JSON.parse(text) as { kind?: string; session?: BacktestSession };
  } catch (err) {
    pushDiagnostic('error', `Session file could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const session = parsed?.session;
  if (!parsed || parsed.kind !== 'backtest-session' || !session || typeof session.id !== 'string') {
    pushDiagnostic('error', 'That file is not a ForexLab session export');
    return null;
  }
  const id = newId();
  const restored: BacktestSession = {
    ...session,
    id,
    name: `${session.name || 'imported session'} (imported)`,
    updatedAt: Date.now(),
    trades: Array.isArray(session.trades) ? session.trades.map((t) => deserializeTrade(t)).filter((t): t is Trade => t !== null) : [],
    drawings: Array.isArray(session.drawings) ? session.drawings : [],
  };
  await idb.put('sessions', restored, KEY(id));
  await idb.put('kv', restored.trades, `trades:${id}`);
  pushDiagnostic('info', `Session imported: ${restored.name} · ${restored.trades.length} trades · ${restored.drawings.length} drawings`);
  return id;
}
