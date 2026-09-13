/**
 * The trade model and its evaluation.
 *
 * A trade stores only what the user actually decided (side, size, entry, stop,
 * target, when it was closed) plus the bar it was taken on. Everything derived —
 * pips, money, R, MFE/MAE, duration — is computed on demand from the candle data,
 * so a result can never be stale and can never reference a bar the replay has not
 * revealed. The evaluator is a pure function of (trades, gated series, account).
 */

import type { CandleSeries } from '../data/series.ts';
import type { TimeframeId } from '../time/timeframes.ts';
import { pipSizeFromDecimals } from '../util/pips.ts';
import type { AccountSettings, AmbiguityPolicy } from './account.ts';

export type Side = 'buy' | 'sell';
export type EntryKind = 'market' | 'limit';
export type ExitReason = 'manual' | 'take-profit' | 'stop-loss' | 'ambiguous' | 'close-only';

export interface BarRef {
  /** Index into the series the trade was evaluated against. */
  index: number;
  time: number;
  price: number;
}

export interface Trade {
  id: string;
  symbol: string;
  tf: TimeframeId;
  side: Side;
  /** Base-currency units. */
  size: number;
  entryKind: EntryKind;
  /** Bar the order was placed on; the fill is resolved from it. */
  entryBar: number;
  /** Requested entry price: close of `entryBar` for market, the limit level otherwise. */
  entryPrice: number;
  stop: number | null;
  target: number | null;
  /** Set when the position was closed manually, at the close of that bar. */
  manualExitBar: number | null;
  note: string;
  createdWallClock: number;
  /** Account snapshot the trade was recorded under (costs are part of the record). */
  costs: Pick<AccountSettings, 'spreadPips' | 'commissionPerSide' | 'slippagePips' | 'ambiguityPolicy' | 'decimals'>;
}

export interface TradeResult {
  id: string;
  trade: Trade;
  status: 'pending' | 'open' | 'closed';
  entry: BarRef | null;
  exit: (BarRef & { reason: ExitReason }) | null;
  /** True when the exit came from a bar whose intra-bar path is unknown. */
  intrabar: boolean;
  /** True when the same bar covered stop and target and the policy decided it. */
  ambiguous: boolean;
  ambiguityPolicy: AmbiguityPolicy;
  /** Price distance in pips, before costs. */
  grossPips: number;
  /** After spread and slippage. */
  netPips: number;
  grossMoney: number;
  costMoney: number;
  netMoney: number;
  /** Equity the trade started from, and the percentage the net result moved it. */
  equityBefore: number;
  returnPct: number;
  /** Money at risk from the stop; R is undefined without one. */
  riskMoney: number;
  rMultiple: number | null;
  durationMs: number | null;
  barsHeld: number | null;
  mfePips: number | null;
  maePips: number | null;
  mfePrice: number | null;
  maePrice: number | null;
  /** Open trades carry the mark at the newest *revealed* bar. */
  markedAt: BarRef | null;
  unrealizedMoney: number;
  unrealizedPips: number;
  /** Quote currency the money figures are expressed in. */
  moneyCcy: string;
  /** Internal: state needed to continue this scan when the cursor advances. */
  scanState: ScanState | null;
  /** False when there is not enough data to state a result at all. */
  computable: boolean;
  unavailableReason: string | null;
  /** Set when a recorded level could not be honoured, so the UI can say why. */
  levelProblem: string | null;
}

/**
 * Continuation state for incremental evaluation. Advancing the replay cursor by one
 * bar must not re-scan every bar since the entry for every open trade, so the scan
 * can resume where it stopped — valid only when the trade object and the fills are
 * unchanged and the window only ever grew.
 */
export interface ScanState {
  /** First index not looked at yet. */
  from: number;
  entryPrice: number;
  filledEntry: number;
  mfe: number;
  mae: number;
  mfePrice: number;
  maePrice: number;
  sawAnyBar: boolean;
}

export interface EvaluateContext {
  /** The gated series: never pass the full dataset here. */
  series: CandleSeries;
  account: AccountSettings;
  quoteCcy: string;
  /** Resume a previous scan of the same open trade (see `ScanState`). */
  resume?: ScanState | null;
}

let seq = 0;
export function newTradeId(): string {
  seq += 1;
  return `t${Date.now().toString(36)}${seq.toString(36)}`;
}

export function makeTrade(
  partial: Omit<Trade, 'id' | 'createdWallClock' | 'costs'> & { id?: string; costs?: Trade['costs'] },
  account: AccountSettings,
): Trade {
  return {
    ...partial,
    id: partial.id ?? newTradeId(),
    createdWallClock: Date.now(),
    costs: partial.costs ?? {
      spreadPips: account.spreadPips,
      commissionPerSide: account.commissionPerSide,
      slippagePips: account.slippagePips,
      ambiguityPolicy: account.ambiguityPolicy,
      decimals: account.decimals,
    },
  };
}

function touched(bar: { h: number; l: number }, side: Side, stop: number | null, target: number | null) {
  const hitStop = stop !== null && (side === 'buy' ? bar.l <= stop : bar.h >= stop);
  const hitTarget = target !== null && (side === 'buy' ? bar.h >= target : bar.l <= target);
  return { hitStop, hitTarget };
}

/** Signed price distance converted to pips for a side (positive = profit). */
function pipsOf(deltaPrice: number, side: Side, decimals: number): number {
  const pip = pipSizeFromDecimals(decimals);
  if (!(pip > 0)) return NaN;
  return ((side === 'buy' ? deltaPrice : -deltaPrice) / pip);
}

/**
 * Evaluate one trade against the revealed data. `series` must already be clipped
 * by the replay gate: bars beyond it simply do not exist for this function, which
 * is exactly why an open trade's MFE/MAE and mark never leak the future.
 */
export function evaluateTrade(trade: Trade, ctx: EvaluateContext, equityBefore: number): TradeResult {
  const resume = ctx.resume ?? null;
  const { series } = ctx;
  const pip = pipSizeFromDecimals(trade.costs.decimals);
  // The clipped length is the whole world for this function: bars the replay has
  // not revealed are not merely skipped, they are not addressed at all.
  const total = series.count;
  const base: TradeResult = {
    id: trade.id,
    trade,
    status: 'pending',
    entry: null,
    exit: null,
    intrabar: false,
    ambiguous: false,
    ambiguityPolicy: trade.costs.ambiguityPolicy,
    grossPips: NaN,
    netPips: NaN,
    grossMoney: NaN,
    costMoney: NaN,
    netMoney: NaN,
    equityBefore,
    returnPct: NaN,
    riskMoney: 0,
    rMultiple: null,
    durationMs: null,
    barsHeld: null,
    mfePips: null,
    maePips: null,
    mfePrice: null,
    maePrice: null,
    markedAt: null,
    unrealizedMoney: NaN,
    unrealizedPips: NaN,
    moneyCcy: ctx.quoteCcy,
    computable: false,
    unavailableReason: null,
    levelProblem: null,
    scanState: null,
  };
  if (total === 0) return { ...base, unavailableReason: 'no data' };
  if (trade.entryBar < 0 || trade.entryBar >= total) {
    return { ...base, unavailableReason: 'the entry bar is outside the revealed data' };
  }
  if (!(pip > 0)) return { ...base, unavailableReason: 'the pip size could not be determined from the source decimals' };

  const entryBarTime = series.time(trade.entryBar);
  if (Number.isNaN(entryBarTime)) return { ...base, unavailableReason: 'the entry bar has no timestamp' };

  // ------------------------------------------------------------------- the fill
  let entryPrice: number;
  let entryIndex = trade.entryBar;
  if (trade.entryKind === 'market') {
    const c = series.candle(trade.entryBar);
    if (!c) return { ...base, unavailableReason: 'the entry bar could not be read' };
    entryPrice = c.c;
  } else {
    // A limit order fills on the first bar at or after placement whose range
    // reaches the level; until then it is an order, not a trade.
    const c0 = series.candle(trade.entryBar);
    if (!c0) return { ...base, unavailableReason: 'the entry bar could not be read' };
    let filled = false;
    entryPrice = NaN;
    for (let i = trade.entryBar; i < total; i++) {
      const c = series.candle(i);
      if (!c) break;
      const reachable = trade.side === 'buy' ? c.l <= trade.entryPrice : c.h >= trade.entryPrice;
      if (reachable) {
        entryPrice = trade.entryPrice;
        entryIndex = i;
        filled = true;
        break;
      }
    }
    if (!filled) {
      return { ...base, status: 'pending', unavailableReason: 'limit price was never reached in the revealed data' };
    }
  }

  // Slippage is always adverse to the trader: an entry moves away from the
  // requested price, an exit moves against the position.
  // A level on the wrong side of the entry price cannot be honoured: treating it as
  // a live level would fabricate a fill, so it is reported and ignored.
  const levelProblem =
    [
      trade.stop !== null && (trade.side === 'buy' ? trade.stop >= entryPrice : trade.stop <= entryPrice) ? 'stop loss is on the wrong side of the entry price' : null,
      trade.target !== null && (trade.side === 'buy' ? trade.target <= entryPrice : trade.target >= entryPrice) ? 'take profit is on the wrong side of the entry price' : null,
    ]
      .filter(Boolean)
      .join(' and ') || null;
  const stop = levelProblem && trade.stop !== null && (trade.side === 'buy' ? trade.stop >= entryPrice : trade.stop <= entryPrice) ? null : trade.stop;
  const target = levelProblem && trade.target !== null && (trade.side === 'buy' ? trade.target <= entryPrice : trade.target >= entryPrice) ? null : trade.target;
  const slip = trade.costs.slippagePips * pip;
  const entrySlip = trade.side === 'buy' ? slip : -slip;
  const exitSlip = trade.side === 'buy' ? -slip : slip;
  const filledEntry = entryPrice + entrySlip;
  const entry: BarRef = { index: entryIndex, time: series.time(entryIndex), price: filledEntry };

  // ------------------------------------------------- excursion + level resolution
  const scanFrom = entryIndex + 1; // the entry bar's internal path is unknown
  const hardEnd = trade.manualExitBar !== null ? Math.min(trade.manualExitBar, total - 1) : total - 1;
  let activeResume =
    resume && resume.entryPrice === entryPrice && trade.manualExitBar === null && hardEnd >= resume.from - 1 ? resume : null;
  let exit: TradeResult['exit'] = null;
  let ambiguous = false;
  let intrabar = false;
  let mfe = activeResume ? activeResume.mfe : 0;
  let mae = activeResume ? activeResume.mae : 0;
  let mfePrice = activeResume ? activeResume.mfePrice : filledEntry;
  let maePrice = activeResume ? activeResume.maePrice : filledEntry;
  let sawAnyBar = activeResume ? activeResume.sawAnyBar : false;
  const startAt = activeResume ? Math.max(scanFrom, activeResume.from) : scanFrom;

  for (let i = startAt; i <= hardEnd; i++) {
    const c = series.candle(i);
    if (!c) break;
    const isManualEnd = trade.manualExitBar !== null && i === trade.manualExitBar;
    const { hitStop, hitTarget } = touched(c, trade.side, stop, target);
    if (hitStop || hitTarget) {
      // The bar that resolves a level: only the excursion up to the fill price is
      // provable, because the path inside the bar is not part of OHLC data.
      intrabar = true;
      sawAnyBar = true;
      let level: number;
      let reason: ExitReason;
      if (hitStop && hitTarget) {
        ambiguous = true;
        if (trade.costs.ambiguityPolicy === 'adverse') {
          level = stop as number;
          reason = 'stop-loss';
        } else if (trade.costs.ambiguityPolicy === 'favorable') {
          level = target as number;
          reason = 'take-profit';
        } else {
          level = c.c;
          reason = 'close-only';
        }
      } else if (hitStop) {
        level = stop as number;
        reason = 'stop-loss';
      } else {
        level = target as number;
        reason = 'take-profit';
      }
      exit = { index: i, time: c.t, price: level + exitSlip, reason };
      const favourable = trade.side === 'buy' ? exit.price - filledEntry : filledEntry - exit.price;
      if (favourable > 0 && favourable > mfe) {
        mfe = favourable;
        mfePrice = exit.price;
      }
      if (favourable < 0 && -favourable > mae) {
        mae = -favourable;
        maePrice = exit.price;
      }
      break;
    }
    if (isManualEnd) {
      // A manual close is defined at that bar's close; excursions beyond the close
      // inside the same bar are not attributed to the trade.
      sawAnyBar = true;
      exit = { index: i, time: c.t, price: c.c + exitSlip, reason: 'manual' };
      const favourable = trade.side === 'buy' ? exit.price - filledEntry : filledEntry - exit.price;
      if (favourable > 0 && favourable > mfe) {
        mfe = favourable;
        mfePrice = exit.price;
      }
      if (favourable < 0 && -favourable > mae) {
        mae = -favourable;
        maePrice = exit.price;
      }
      break;
    }
    sawAnyBar = true;
    const favourable = trade.side === 'buy' ? c.h - filledEntry : filledEntry - c.l;
    const adverse = trade.side === 'buy' ? filledEntry - c.l : c.h - filledEntry;
    if (favourable > mfe) {
      mfe = favourable;
      mfePrice = trade.side === 'buy' ? c.h : c.l;
    }
    if (adverse > mae) {
      mae = adverse;
      maePrice = trade.side === 'buy' ? c.l : c.h;
    }
  }

  if (trade.manualExitBar !== null && !exit) {
    // Closed on the same bar it was opened (or before the scan began): the only
    // price that can be stated honestly is that bar's close.
    const c = series.candle(trade.manualExitBar);
    if (c && trade.manualExitBar >= entryIndex) {
      exit = { index: trade.manualExitBar, time: c.t, price: c.c + exitSlip, reason: 'manual' };
      if (trade.manualExitBar === entryIndex) sawAnyBar = false;
    }
  }

  const markIndex = Math.min(total - 1, exit ? exit.index : hardEnd);
  const markCandle = series.candle(markIndex);
  const mark: BarRef | null = markCandle ? { index: markIndex, time: markCandle.t, price: markCandle.c } : null;

  // --------------------------------------------------------------------- the maths
  const gross = (deltaPrice: number): number => pipsOf(deltaPrice, trade.side, trade.costs.decimals);
  const spreadCostPips = trade.costs.spreadPips;

  const money = (pips: number, size: number): number => (Number.isFinite(pips) ? pips * pip * size : NaN);

  // An open trade reports the state needed to continue the scan from here.
  const scanState: ScanState | null = exit
    ? null
    : { from: hardEnd + 1, entryPrice, filledEntry, mfe, mae, mfePrice, maePrice, sawAnyBar };

  let result: TradeResult = {
    ...base,
    scanState,
    entry,
    exit,
    intrabar,
    ambiguous,
    status: exit ? 'closed' : 'open',
    levelProblem,
    mfePips: sawAnyBar ? gross(mfe) : null,
    maePips: sawAnyBar ? gross(mae) : null,
    mfePrice: sawAnyBar ? mfePrice : null,
    maePrice: sawAnyBar ? maePrice : null,
    markedAt: mark,
    barsHeld: exit && sawAnyBar ? Math.max(0, exit.index - entryIndex) : sawAnyBar ? Math.max(0, hardEnd - entryIndex) : null,
  };

  if (exit) {
    // Both fills are the slipped prices, so the spread is the only remaining cost.
    const grossPips = gross(exit.price - filledEntry);
    const netPips = grossPips - spreadCostPips;
    const commission = trade.costs.commissionPerSide * 2;
    const costMoney = money(spreadCostPips, trade.size) + commission;
    const riskMoney = stop !== null ? Math.abs(filledEntry - stop) * trade.size : 0;
    const netMoney = money(netPips, trade.size) - commission;
    result = {
      ...result,
      computable: true,
      unavailableReason: exit ? null : result.unavailableReason,
      grossPips,
      netPips,
      grossMoney: money(grossPips, trade.size),
      costMoney,
      netMoney,
      returnPct: equityBefore > 0 ? (netMoney / equityBefore) * 100 : NaN,
      riskMoney,
      rMultiple: riskMoney > 0 ? netMoney / riskMoney : null,
      durationMs: exit ? exit.time - entry.time : null,
    };
  } else {
    if (mark) {
      const markPips = gross(mark.price + exitSlip - filledEntry) - spreadCostPips;
      result = {
        ...result,
        computable: true,
        unavailableReason: sawAnyBar ? null : 'no bar has closed since the entry yet',
        unrealizedPips: markPips,
        unrealizedMoney: money(markPips, trade.size),
        grossMoney: money(gross(mark.price + exitSlip - filledEntry), trade.size),
        netMoney: money(markPips, trade.size),
        netPips: markPips,
        grossPips: gross(mark.price - filledEntry),
        riskMoney: stop !== null ? Math.abs(filledEntry - stop) * trade.size : 0,
      };
    }
    if (!sawAnyBar) {
      result = { ...result, computable: false, unavailableReason: 'the entry bar is the newest revealed bar' };
    }
  }
  return result;
}

export function tradeSortKey(t: Trade): number {
  return t.entryBar * 1000 + (t.manualExitBar ?? 999);
}

export function serializeTrade(t: Trade): Record<string, unknown> {
  return { ...t };
}

export function deserializeTrade(raw: unknown): Trade | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Trade>;
  if (
    typeof r.id !== 'string' ||
    typeof r.side !== 'string' ||
    typeof r.entryBar !== 'number' ||
    typeof r.entryPrice !== 'number' ||
    typeof r.size !== 'number' ||
    !r.costs
  ) {
    return null;
  }
  if (r.side !== 'buy' && r.side !== 'sell') return null;
  return {
    id: r.id,
    symbol: typeof r.symbol === 'string' ? r.symbol : '',
    tf: (typeof r.tf === 'string' ? r.tf : '1m') as TimeframeId,
    side: r.side,
    size: r.size,
    entryKind: r.entryKind === 'limit' ? 'limit' : 'market',
    entryBar: Math.max(0, Math.round(r.entryBar)),
    entryPrice: r.entryPrice,
    stop: typeof r.stop === 'number' ? r.stop : null,
    target: typeof r.target === 'number' ? r.target : null,
    manualExitBar: typeof r.manualExitBar === 'number' ? Math.max(0, Math.round(r.manualExitBar)) : null,
    note: typeof r.note === 'string' ? r.note : '',
    createdWallClock: typeof r.createdWallClock === 'number' ? r.createdWallClock : 0,
    costs: {
      spreadPips: Number(r.costs.spreadPips) || 0,
      commissionPerSide: Number(r.costs.commissionPerSide) || 0,
      slippagePips: Number(r.costs.slippagePips) || 0,
      ambiguityPolicy: r.costs.ambiguityPolicy === 'favorable' ? 'favorable' : r.costs.ambiguityPolicy === 'first-touch-close' ? 'first-touch-close' : 'adverse',
      decimals: Number.isFinite(r.costs.decimals) ? r.costs.decimals : 5,
    },
  };
}
