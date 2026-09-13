/**
 * Trade ledger store: the reactive list of recorded trades, its account settings,
 * undo/redo, and local persistence. Like the drawing store, the heavy data lives
 * outside React (module singleton + subscription) and writes are debounced into
 * IndexedDB under the active session's key.
 */

import { createStore, useSlice } from '../store/state.ts';
import * as idb from '../store/idb.ts';
import { appStore, pushDiagnostic } from '../app/state.ts';
import { allowedSeries } from '../replay/gate.ts';
import { DEFAULT_ACCOUNT, quoteCurrency, sizeFor, type AccountSettings } from './account.ts';
import {
  deserializeTrade,
  evaluateTrade,
  makeTrade,
  newTradeId,
  serializeTrade,
  type Side,
  type Trade,
  type TradeResult,
} from './trade.ts';

const ACCOUNT_KEY = 'backtest:account';
const tradesKey = (sessionId: string): string => `trades:${sessionId}`;

export interface BacktestState {
  /** Active session id, or null while working unsaved. */
  sessionId: string | null;
  sessionName: string;
  sessionNotes: string;
  account: AccountSettings;
}

export const backtestStore = createStore<BacktestState>({
  sessionId: null,
  sessionName: '',
  sessionNotes: '',
  account: { ...DEFAULT_ACCOUNT },
});

export function useBacktest<K>(select: (s: BacktestState) => K, isEqual?: (a: K, b: K) => boolean): K {
  return useSlice(backtestStore, select, isEqual);
}

export interface OpenTradeInput {
  side: Side;
  /** Index into the currently displayed (gated) series. */
  bar: number;
  /** Requested price: bar close for market entries, the limit level otherwise. */
  price: number;
  entryKind?: 'market' | 'limit';
  stop?: number | null;
  target?: number | null;
  size?: number | null;
  note?: string;
}

class TradeLedger {
  private trades: Trade[] = [];
  private listeners = new Set<() => void>();
  private undoStack: Trade[][] = [];
  private redoStack: Trade[][] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedFor: string | null = null;
  /** Bumped on every mutation so React consumers see a new snapshot object. */
  private version = 0;
  private cachedResults: { key: string; list: TradeResult[] } | null = null;
  /** Per-trade continuation of the excursion scan (see `ScanState`). */
  private scanCache = new Map<string, { trade: Trade; seriesId: string; cursor: number; resume: NonNullable<TradeResult['scanState']> }>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version += 1;
    this.cachedResults = null;
    // Trade objects are replaced on every edit, so cached scans no longer match by
    // identity; drop them to keep the map from growing across a long session.
    for (const [id, hit] of this.scanCache) if (!this.trades.some((t) => t === hit.trade)) this.scanCache.delete(id);
    for (const fn of this.listeners) fn();
  }

  all(): Trade[] {
    return this.trades;
  }

  count(): number {
    return this.trades.length;
  }

  snapshotKey(): string {
    return `${this.trades.length}:${this.version}`;
  }

  find(id: string): Trade | undefined {
    return this.trades.find((t) => t.id === id);
  }

  /** Newest revealed bar index, or -1 with no data. */
  lastKnownIndex(): number {
    const series = allowedSeries();
    return series ? series.count - 1 : -1;
  }

  private historyPush(): void {
    this.undoStack.push(this.trades.map((t) => ({ ...t })));
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  open(input: OpenTradeInput): Trade | null {
    const series = allowedSeries();
    if (!series || series.count === 0) {
      pushDiagnostic('error', 'No revealed bars to trade against');
      return null;
    }
    const account = backtestStore.get().account;
    const bar = Math.max(0, Math.min(series.count - 1, Math.round(input.bar)));
    const time = series.time(bar);
    if (Number.isNaN(time)) {
      pushDiagnostic('error', 'That bar has no timestamp — the trade was not recorded');
      return null;
    }
    const price = Number.isFinite(input.price) ? input.price : series.candle(bar)!.c;
    if (input.entryKind !== 'limit' && Math.abs(price - series.candle(bar)!.c) > (price || 1) * 1e-6) {
      // A "market" entry is defined as the bar close; anything else is a limit.
      pushDiagnostic('info', 'Market entries fill at the bar close — the requested price was recorded as a limit instead');
    }
    const entryKind = input.entryKind === 'limit' ? 'limit' : 'market';
    const equity = this.equityNow();
    const sizing =
      input.size && input.size > 0
        ? { size: input.size, derived: false, problem: null as string | null, riskAmount: 0 }
        : sizeFor(price, input.stop ?? null, account, equity);
    if (sizing.problem) pushDiagnostic('warn', sizing.problem);
    const trade = makeTrade(
      {
        id: newTradeId(),
        symbol: appStore.get().symbol,
        tf: appStore.get().tf,
        side: input.side,
        size: sizing.size,
        entryKind,
        entryBar: bar,
        entryPrice: price,
        stop: input.stop ?? null,
        target: input.target ?? null,
        manualExitBar: null,
        note: input.note ?? '',
      },
      account,
    );
    this.historyPush();
    this.trades = [...this.trades, trade].sort((a, b) => a.entryBar - b.entryBar || a.createdWallClock - b.createdWallClock);
    this.emit();
    this.scheduleFlush();
    return trade;
  }

  /** Close at the newest revealed bar's close (a manual market exit). */
  close(id: string): boolean {
    const last = this.lastKnownIndex();
    if (last < 0) {
      pushDiagnostic('error', 'No revealed bars — nothing to close against');
      return false;
    }
    return this.closeAt(id, last);
  }

  closeAt(id: string, bar: number): boolean {
    const trade = this.find(id);
    if (!trade) return false;
    const series = allowedSeries();
    if (!series) return false;
    const index = Math.max(0, Math.min(series.count - 1, Math.round(bar)));
    if (index < trade.entryBar) {
      pushDiagnostic('warn', 'An exit cannot be recorded before the entry bar');
      return false;
    }
    if (trade.manualExitBar === index) return false;
    this.historyPush();
    this.trades = this.trades.map((t) => (t.id === id ? { ...t, manualExitBar: index } : t));
    this.emit();
    this.scheduleFlush();
    return true;
  }

  reopen(id: string): boolean {
    const trade = this.find(id);
    if (!trade) return false;
    this.historyPush();
    this.trades = this.trades.map((t) => (t.id === id ? { ...t, manualExitBar: null } : t));
    this.emit();
    this.scheduleFlush();
    return true;
  }

  update(id: string, patch: Partial<Pick<Trade, 'stop' | 'target' | 'note' | 'size' | 'entryPrice' | 'entryBar'>>): boolean {
    const trade = this.find(id);
    if (!trade) return false;
    this.historyPush();
    this.trades = this.trades
      .map((t) => (t.id === id ? { ...t, ...patch, costs: { ...t.costs } } : t))
      .sort((a, b) => a.entryBar - b.entryBar || a.createdWallClock - b.createdWallClock);
    this.emit();
    this.scheduleFlush();
    return true;
  }

  remove(id: string): boolean {
    const trade = this.find(id);
    if (!trade) return false;
    this.historyPush();
    this.trades = this.trades.filter((t) => t.id !== id);
    this.emit();
    this.scheduleFlush();
    return true;
  }

  removeMany(ids: Set<string>): number {
    const kept = this.trades.filter((t) => !ids.has(t.id));
    if (kept.length === this.trades.length) return 0;
    this.historyPush();
    const removed = this.trades.length - kept.length;
    this.trades = kept;
    this.emit();
    this.scheduleFlush();
    return removed;
  }

  clear(): void {
    if (this.trades.length === 0) return;
    this.historyPush();
    this.trades = [];
    this.emit();
    this.scheduleFlush();
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.trades.map((t) => ({ ...t })));
    this.trades = prev;
    this.emit();
    this.scheduleFlush();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.trades.map((t) => ({ ...t })));
    this.trades = next;
    this.emit();
    this.scheduleFlush();
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Equity after all closed trades, used for risk sizing and the return figure. */
  equityNow(): number {
    const account = backtestStore.get().account;
    let equity = account.startingBalance;
    for (const r of this.results()) {
      if (r.status === 'closed') equity += r.netMoney;
    }
    return equity;
  }

  /**
   * Results for the current state, memoised on (dataset epoch, cursor, ledger
   * version, account) so a repaint or a hover never re-walks the whole ledger.
   */
  results(): TradeResult[] {
    const series = allowedSeries();
    const account = backtestStore.get().account;
    const replay = appStore.get().replay;
    const key = `${appStore.get().datasetId}|${appStore.get().tf}|${series?.count ?? 0}|${replay.cursor}|${this.snapshotKey()}|${JSON.stringify(account)}`;
    if (this.cachedResults && this.cachedResults.key === key) return this.cachedResults.list;
    if (!series || series.count === 0) {
      const list: TradeResult[] = [];
      this.cachedResults = { key, list };
      return list;
    }
    const quote = quoteCurrency(appStore.get().symbol);
    const seriesId = `${series.datasetId ?? ''}|${series.tf}|${series.tz}`;
    const ordered = [...this.trades].sort((a, b) => a.entryBar - b.entryBar || a.createdWallClock - b.createdWallClock);
    let equity = account.startingBalance;
    // Equity before a trade needs the trades that closed before it, so results are
    // computed in entry order and the equity ledger is applied in exit order.
    const cursor = series.count - 1;
    const prelim = ordered.map((t) => {
      const cached = this.scanCache.get(t.id);
      const resume =
        cached && cached.trade === t && cached.seriesId === seriesId && cached.cursor < cursor && t.manualExitBar === null
          ? cached.resume
          : null;
      const out = evaluateTrade(t, { series, account, quoteCcy: quote, resume }, equity);
      if (out.scanState && out.entry) this.scanCache.set(t.id, { trade: t, seriesId, cursor, resume: out.scanState });
      else this.scanCache.delete(t.id);
      return out;
    });
    const closedByTime = prelim
      .filter((r) => r.status === 'closed')
      .sort((a, b) => (a.exit?.time ?? 0) - (b.exit?.time ?? 0));
    const equityBeforeById = new Map<string, number>();
    let run = account.startingBalance;
    for (const r of closedByTime) {
      equityBeforeById.set(r.id, run);
      run += r.netMoney;
    }
    const list = prelim.map((r) => {
      const before = equityBeforeById.get(r.id);
      if (before === undefined || before === r.equityBefore) return r;
      // Only the equity-relative fields depend on the run-up; patch them instead of
      // re-walking the candles for every trade.
      return {
        ...r,
        equityBefore: before,
        returnPct: before > 0 && Number.isFinite(r.netMoney) ? (r.netMoney / before) * 100 : NaN,
      };
    });
    this.cachedResults = { key, list };
    return list;
  }

  /** Trades whose entry is at or before the replay cursor — the only ones legal to show. */
  visibleIds(): Set<string> {
    const out = new Set<string>();
    for (const r of this.results()) if (r.entry !== null) out.add(r.id);
    return out;
  }

  // ------------------------------------------------------------------ persistence
  private scheduleFlush(): void {
    const sessionId = backtestStore.get().sessionId;
    if (!sessionId) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 400);
  }

  async flush(): Promise<void> {
    const sessionId = backtestStore.get().sessionId;
    if (!sessionId) return;
    try {
      await idb.put('kv', this.trades.map(serializeTrade), tradesKey(sessionId));
    } catch (err) {
      pushDiagnostic('error', `Trades could not be stored locally: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async load(sessionId: string): Promise<void> {
    this.loadedFor = sessionId;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    try {
      const raw = (await idb.get<unknown[]>('kv', tradesKey(sessionId))) ?? [];
      const trades = raw.map(deserializeTrade).filter((t): t is Trade => t !== null);
      if (trades.length !== raw.length && raw.length > 0) {
        pushDiagnostic('warn', `${raw.length - trades.length} stored trade records were unreadable and were skipped`);
      }
      this.trades = trades.sort((a, b) => a.entryBar - b.entryBar || a.createdWallClock - b.createdWallClock);
      this.emit();
    } catch (err) {
      pushDiagnostic('error', `Trades could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
      this.trades = [];
      this.emit();
    }
  }

  /** Used when a session is duplicated or deleted. */
  forget(): void {
    this.scanCache.clear();
    this.loadedFor = null;
    this.trades = [];
    this.cachedResults = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }

  get loadedSessionId(): string | null {
    return this.loadedFor;
  }

  exportTrades(): Trade[] {
    return [...this.trades];
  }

  importTrades(raw: unknown): number {
    if (!Array.isArray(raw)) return 0;
    const trades = raw.map(deserializeTrade).filter((t): t is Trade => t !== null);
    this.historyPush();
    this.trades = [...this.trades, ...trades].sort((a, b) => a.entryBar - b.entryBar);
    this.emit();
    this.scheduleFlush();
    return trades.length;
  }
}

export const tradeLedger = new TradeLedger();

export function setAccount(patch: Partial<AccountSettings>): void {
  const account = { ...backtestStore.get().account, ...patch };
  backtestStore.set({ account });
  void persistAccount();
}

export async function persistAccount(): Promise<void> {
  try {
    await idb.put('kv', backtestStore.get().account, ACCOUNT_KEY);
  } catch {
    // A blocked IDB must not break the session; the values stay for this load.
  }
}

export async function hydrateBacktest(): Promise<void> {
  try {
    const stored = await idb.get<Partial<AccountSettings>>('kv', ACCOUNT_KEY);
    if (stored) backtestStore.set({ account: { ...DEFAULT_ACCOUNT, ...stored } });
  } catch {
    /* first run */
  }
}

/**
 * Adopt the pip size implied by an imported file (5 decimals → 0.0001). Trades
 * already recorded keep the decimals they were entered with, so historical results
 * do not shift when a second dataset with different precision is opened.
 */
export function adoptPricePrecision(decimals: number | undefined, symbol: string): void {
  if (!decimals || decimals < 0 || decimals > 8) return;
  const account = backtestStore.get().account;
  if (account.decimals === decimals) return;
  setAccount({ decimals });
  pushDiagnostic('info', `Pip size for ${symbol} set from the imported file (${decimals} decimals)`);
}
