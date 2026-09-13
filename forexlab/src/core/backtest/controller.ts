/**
 * Manual trading on the chart: arm a side, click the bar to trade, and the ledger
 * records the bar index — never a pixel position — so a trade stays attached to the
 * same moment across zoom, pan, timeframe and replay moves.
 */

import { createStore, useSlice } from '../store/state.ts';
import { overlayRegistry } from '../app/overlays.ts';
import type { ChartEngine, InteractionLayer } from '../chart/engine.ts';
import { allowedSeries } from '../replay/gate.ts';
import { pushDiagnostic } from '../app/state.ts';
import { formatDateTime } from '../time/tz.ts';
import { pipSizeFromDecimals } from '../util/pips.ts';
import { paintTrades, type TradeGhost } from './overlay.ts';
import { backtestStore, tradeLedger } from './store.ts';

export type TradeArm =
  | { mode: 'open'; side: 'buy' | 'sell'; kind: 'market' | 'limit' }
  | { mode: 'close' }
  | null;

export interface TradeUiState {
  arm: TradeArm;
  ghost: TradeGhost | null;
  selectedId: string | null;
  hiddenIds: string[];
  showFloating: boolean;
  /** Set after a click, cleared when the panel scrolls to it. */
  lastTradeId: string | null;
}

export const tradeStore = createStore<TradeUiState>({
  arm: null,
  ghost: null,
  selectedId: null,
  hiddenIds: [],
  showFloating: true,
  lastTradeId: null,
});

export function useTradeUi<K>(select: (s: TradeUiState) => K, isEqual?: (a: K, b: K) => boolean): K {
  return useSlice(tradeStore, select, isEqual);
}

class TradeController {
  /** Registered by app/modes so arming a tool here releases the other mode. */
  onArmChange: ((arm: TradeArm) => void) | null = null;

  private engine: ChartEngine | null = null;
  private overlayOff: (() => void) | null = null;
  private interactionOff: (() => void) | null = null;

  constructor() {
    // The ledger changes independently of the chart (panel edits, undo, session
    // loads), so painters are rebuilt from there too.
    tradeLedger.subscribe(() => overlayRegistry.scheduleSync());
    tradeStore.subscribe(() => this.engine?.requestRender());
  }

  attach(engine: ChartEngine): void {
    this.engine = engine;
    this.overlayOff?.();
    this.overlayOff = overlayRegistry.register('trades', () => this.painters());
    this.interactionOff?.();
    this.interactionOff = engine.addInteraction(this.layer());
  }

  detach(): void {
    this.overlayOff?.();
    this.overlayOff = null;
    this.interactionOff?.();
    this.interactionOff = null;
    this.engine = null;
    tradeStore.set({ ghost: null });
  }

  currentArm(): TradeArm {
    return tradeStore.get().arm;
  }

  currentGhost(): TradeGhost | null {
    return tradeStore.get().ghost;
  }

  isArmed(): boolean {
    return tradeStore.get().arm !== null;
  }

  arm(next: Exclude<TradeArm, null>): void {
    const current = tradeStore.get().arm;
    const same =
      current !== null &&
      current.mode === next.mode &&
      (next.mode === 'close' || (current.mode === 'open' && current.kind === next.kind && current.side === next.side));
    if (same) {
      this.setArm(null);
      return;
    }
    this.setArm(next);
  }

  setArm(next: TradeArm): void {
    tradeStore.set({ arm: next, ghost: next ? tradeStore.get().ghost : null });
    if (this.onArmChange) this.onArmChange(next);
    this.engine?.setToolCursor(next ? 'crosshair' : undefined);
    this.engine?.requestRender();
    overlayRegistry.scheduleSync();
  }

  cancel(): boolean {
    if (!this.isArmed()) return false;
    this.setArm(null);
    pushDiagnostic('info', 'Trade entry disarmed');
    return true;
  }

  select(id: string | null): void {
    tradeStore.set({ selectedId: id });
    this.engine?.requestRender();
  }

  toggleHidden(id: string): void {
    const set = new Set(tradeStore.get().hiddenIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    tradeStore.set({ hiddenIds: [...set] });
    this.engine?.requestRender();
  }

  setHidden(ids: string[]): void {
    tradeStore.set({ hiddenIds: ids });
    this.engine?.requestRender();
  }

  setShowFloating(v: boolean): void {
    tradeStore.set({ showFloating: v });
    this.engine?.requestRender();
  }

  /** Oldest still-open trade — what C and the CLOSE button act on. */
  firstOpen(): string | null {
    const open = tradeLedger.results().filter((r) => r.status === 'open');
    return open.length ? open[0].id : null;
  }

  closeOldest(): boolean {
    const id = this.firstOpen();
    if (!id) {
      pushDiagnostic('info', 'No open position to close');
      return false;
    }
    const ok = tradeLedger.close(id);
    if (ok) {
      const r = tradeLedger.results().find((x) => x.id === id);
      pushDiagnostic(
        'info',
        `Closed ${r?.trade.side.toUpperCase()} at bar ${(tradeLedger.find(id)?.manualExitBar ?? 0) + 1}${
          r && Number.isFinite(r.netPips) ? ` · ${r.netPips.toFixed(1)} pips` : ''
        }`,
      );
      overlayRegistry.scheduleSync();
    }
    return ok;
  }

  private place(side: 'buy' | 'sell', kind: 'market' | 'limit', index: number, price: number): void {
    const account = backtestStore.get().account;
    const pip = pipSizeFromDecimals(account.decimals);
    const ghost = tradeStore.get().ghost;
    const stop = ghost?.stop ?? null;
    const target = ghost?.target ?? null;
    const series = allowedSeries();
    if (!series) return;
    if (kind === 'market' && price !== series.candle(index)?.c) {
      // A market entry is defined by the bar close; the click only chooses the bar.
      price = series.candle(index)?.c ?? price;
    }
    if (stop !== null && target !== null) {
      const risk = side === 'buy' ? price - stop : target - price;
      const reward = side === 'buy' ? target - price : price - target;
      if (risk <= 0 || reward <= 0) {
        pushDiagnostic('error', 'Stop and target are on the wrong side of the entry price — trade not recorded');
        return;
      }
      if (reward / risk < 1) {
        pushDiagnostic(
          'warn',
          `Reward ${reward / pip >= 0 ? '' : '−'}${Math.abs(reward / pip).toFixed(1)} pips is below risk ${Math.abs(risk / pip).toFixed(1)} pips (R ${((reward / risk) * 1).toFixed(2)}) — recorded anyway`,
        );
      }
    }
    const trade = tradeLedger.open({
      side,
      bar: index,
      price,
      entryKind: kind,
      stop,
      target,
    });
    if (!trade) return;
    tradeStore.set({ lastTradeId: trade.id, selectedId: trade.id });
    const t = series.time(index);
    pushDiagnostic(
      'info',
      `${side.toUpperCase()} ${kind === 'limit' ? 'limit' : 'market'} recorded · ${trade.size.toLocaleString('en-US', { maximumFractionDigits: 0 })} units @ ${price.toFixed(account.decimals)} · ${t ? formatDateTime(t, 'UTC') : ''}`.trim(),
    );
    overlayRegistry.scheduleSync();
  }

  private layer(): InteractionLayer {
    const self = this;
    return {
      id: 'trades',
      cursor: () => (tradeStore.get().arm ? 'crosshair' : undefined),
      onPointerMove(info, engine) {
        const state = tradeStore.get();
        if (!state.arm || state.arm.mode === 'close') return false;
        const series = allowedSeries();
        if (!series || info.index === null) return false;
        const index = Math.max(0, Math.min(series.count - 1, info.index));
        const candle = series.candle(index);
        if (!candle) return false;
        const price = state.arm.kind === 'limit' ? info.price : candle.c;
        const prev = state.ghost;
        if (prev && prev.index === index && Math.abs(prev.price - price) < 1e-12) return false;
        tradeStore.set({
          ghost: {
            side: state.arm.side,
            kind: state.arm.kind,
            index,
            price,
            stop: prev?.stop ?? null,
            target: prev?.target ?? null,
          },
        });
        engine.requestRender();
        return false; // let the crosshair keep updating
      },
      onPointerDown(info, engine) {
        const state = tradeStore.get();
        if (!state.arm) return false;
        if (info.index === null) return true;
        const series = allowedSeries();
        if (!series) return true;
        const index = Math.max(0, Math.min(series.count - 1, info.index));
        if (state.arm.mode === 'close') {
          const id = self.firstOpen();
          if (id) {
            tradeLedger.closeAt(id, index);
            pushDiagnostic('info', `Position closed at bar ${index + 1}`);
            overlayRegistry.scheduleSync();
          } else {
            pushDiagnostic('info', 'No open position to close');
          }
          self.setArm(null);
          engine.requestRender();
          return true;
        }
        const candle = series.candle(index);
        if (!candle) return true;
        self.place(state.arm.side, state.arm.kind, index, state.arm.kind === 'limit' ? info.price : candle.c);
        self.setArm(null);
        engine.requestRender();
        return true;
      },
    };
  }

  /** Levels armed with the current tool state (typed in the trade toolbar). */
  setGhostLevels(stop: number | null, target: number | null): void {
    const ghost = tradeStore.get().ghost;
    tradeStore.set({
      ghost: ghost
        ? { ...ghost, stop, target }
        : { side: 'buy', kind: 'market', index: 0, price: 0, stop, target },
    });
    this.engine?.requestRender();
  }

  private painters(): { id: string; draw(rc: Parameters<typeof paintTrades>[0]): void }[] {
    const state = tradeStore.get();
    const results = tradeLedger.results();
    if (results.length === 0 && !state.ghost) return [];
    const decimals = backtestStore.get().account.decimals;
    const hidden = new Set(state.hiddenIds);
    const selectedId = state.selectedId;
    const showFloating = state.showFloating;
    const ghost = state.ghost;
    return [
      {
        id: 'positions',
        draw(rc) {
          paintTrades(rc, { results, decimals, selectedId, hiddenIds: hidden, showFloating, ghost });
        },
      },
    ];
  }
}

export const tradeController = new TradeController();
