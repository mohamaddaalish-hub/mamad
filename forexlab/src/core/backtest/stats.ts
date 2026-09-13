/**
 * Statistics derived from the manual ledger — nothing here is simulated. A figure
 * that cannot be computed from the recorded trades is returned as `null` and the
 * UI renders UNAVAILABLE, so an empty or partial ledger never produces a confident
 * zero.
 */

import { formatDateTime } from '../time/tz.ts';
import type { TradeResult } from './trade.ts';

export type Metric = number | null;

export interface Point {
  time: number;
  value: number;
}

export interface CurveSet {
  equity: Point[];
  drawdown: Point[];
  peak: number;
  trough: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
}

export interface LedgerStats {
  netPnl: Metric;
  grossPnl: Metric;
  costTotal: Metric;
  netPips: Metric;
  closedCount: number;
  openCount: number;
  pendingCount: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  winRate: Metric;
  profitFactor: Metric;
  expectancy: Metric;
  avgWin: Metric;
  avgLoss: Metric;
  bestTrade: Metric;
  worstTrade: Metric;
  avgR: Metric;
  totalR: Metric;
  avgDurationMs: Metric;
  maxConsecWins: number;
  maxConsecLosses: number;
  avgMfePips: Metric;
  avgMaePips: Metric;
  ambiguousCount: number;
  favorableAmbiguousCount: number;
  intrabarCount: number;
  flaggedCount: number;
  totalReturnPct: Metric;
  finalEquity: Metric;
}

function sum(values: number[]): number {
  let acc = 0;
  for (const v of values) acc += v;
  return acc;
}

function mean(values: number[]): Metric {
  if (values.length === 0) return null;
  return sum(values) / values.length;
}

/** Trades with a decided outcome — pending orders and open positions are excluded. */
export function closedResults(results: TradeResult[]): TradeResult[] {
  return results.filter((r) => r.status === 'closed' && r.computable);
}

export function computeStats(results: TradeResult[], startingBalance: number): LedgerStats {
  const closed = closedResults(results).sort(
    (a, b) => (a.exit?.time ?? 0) - (b.exit?.time ?? 0) || (a.entry?.time ?? 0) - (b.entry?.time ?? 0),
  );
  const netList = closed.map((r) => r.netMoney);
  const grossList = closed.map((r) => r.grossMoney);
  const costList = closed.map((r) => r.costMoney);
  const pipList = closed.map((r) => r.netPips);
  const wins = closed.filter((r) => r.netMoney > 0);
  const losses = closed.filter((r) => r.netMoney < 0);
  const flats = closed.filter((r) => r.netMoney === 0);
  const grossProfit = sum(wins.map((r) => r.netMoney));
  const grossLoss = Math.abs(sum(losses.map((r) => r.netMoney)));
  const rList = closed.map((r) => r.rMultiple).filter((v): v is number => v !== null && Number.isFinite(v));
  const durations = closed.map((r) => r.durationMs).filter((v): v is number => v !== null && Number.isFinite(v));
  const mfes = closed.map((r) => r.mfePips).filter((v): v is number => v !== null && Number.isFinite(v));
  const maes = closed.map((r) => r.maePips).filter((v): v is number => v !== null && Number.isFinite(v));

  let runWin = 0;
  let runLoss = 0;
  let maxWin = 0;
  let maxLoss = 0;
  for (const r of closed) {
    if (r.netMoney > 0) {
      runWin += 1;
      runLoss = 0;
    } else if (r.netMoney < 0) {
      runLoss += 1;
      runWin = 0;
    } else {
      runWin = 0;
      runLoss = 0;
    }
    maxWin = Math.max(maxWin, runWin);
    maxLoss = Math.max(maxLoss, runLoss);
  }

  const equity = equityCurve(results, startingBalance);
  return {
    netPnl: closed.length ? sum(netList) : null,
    grossPnl: closed.length ? sum(grossList) : null,
    costTotal: closed.length ? sum(costList) : null,
    netPips: closed.length ? sum(pipList) : null,
    closedCount: closed.length,
    openCount: results.filter((r) => r.status === 'open').length,
    pendingCount: results.filter((r) => r.status === 'pending').length,
    winCount: wins.length,
    lossCount: losses.length,
    breakevenCount: flats.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    expectancy: mean(netList),
    avgWin: mean(wins.map((r) => r.netMoney)),
    avgLoss: mean(losses.map((r) => r.netMoney)),
    bestTrade: netList.length ? Math.max(...netList) : null,
    worstTrade: netList.length ? Math.min(...netList) : null,
    avgR: mean(rList),
    totalR: rList.length ? sum(rList) : null,
    avgDurationMs: mean(durations),
    maxConsecWins: maxWin,
    maxConsecLosses: maxLoss,
    avgMfePips: mean(mfes),
    avgMaePips: mean(maes),
    ambiguousCount: closed.filter((r) => r.ambiguous).length,
    favorableAmbiguousCount: closed.filter((r) => r.ambiguous && r.ambiguityPolicy === 'favorable').length,
    intrabarCount: closed.filter((r) => r.intrabar).length,
    flaggedCount: results.filter((r) => !r.computable && r.status !== 'pending').length,
    totalReturnPct: closed.length && startingBalance > 0 ? (sum(netList) / startingBalance) * 100 : null,
    finalEquity: closed.length ? equity.equity[equity.equity.length - 1]?.value ?? startingBalance : null,
  };
}

/**
 * Equity is stepped only by *closed* trades, in exit order, because an open
 * position's unrealised figure changes with every revealed bar and would make the
 * curve a function of the cursor rather than of the decisions. The newest mark of
 * open trades is reported separately by the UI as "including floating".
 */
export function equityCurve(results: TradeResult[], startingBalance: number): CurveSet {
  const closed = closedResults(results).sort(
    (a, b) => (a.exit?.time ?? 0) - (b.exit?.time ?? 0) || (a.entry?.time ?? 0) - (b.entry?.time ?? 0),
  );
  const equity: Point[] = [];
  const drawdown: Point[] = [];
  let acc = startingBalance;
  let peak = startingBalance;
  let maxDd = 0;
  let maxDdPct = 0;
  if (closed.length > 0) {
    equity.push({ time: (closed[0].entry?.time ?? 0) - 1, value: startingBalance });
    drawdown.push({ time: (closed[0].entry?.time ?? 0) - 1, value: 0 });
  }
  for (const r of closed) {
    acc += r.netMoney;
    peak = Math.max(peak, acc);
    const dd = peak - acc;
    maxDd = Math.max(maxDd, dd);
    maxDdPct = peak > 0 ? Math.max(maxDdPct, dd / peak) * 100 : maxDdPct;
    const t = r.exit?.time ?? 0;
    equity.push({ time: t, value: acc });
    drawdown.push({ time: t, value: -dd });
  }
  return {
    equity,
    drawdown,
    peak: equity.length ? Math.max(...equity.map((p) => p.value)) : startingBalance,
    trough: equity.length ? Math.min(...equity.map((p) => p.value)) : startingBalance,
    maxDrawdown: closed.length ? maxDd : 0,
    maxDrawdownPct: closed.length ? maxDdPct : 0,
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return `${h}h${rem ? ` ${rem}m` : ''}`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

export function formatMoney(v: Metric, ccy = ''): string {
  if (v === null || !Number.isFinite(v)) return 'UNAVAILABLE';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
  return `${sign}${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${ccy ? ` ${ccy}` : ''}`;
}

export function formatMetric(v: Metric, unit = '', digits = 2): string {
  if (v === null) return 'UNAVAILABLE';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '—';
  return `${v.toFixed(digits)}${unit}`;
}

const CSV_HEADER = [
  'id',
  'symbol',
  'tf',
  'side',
  'size',
  'status',
  'entry_time',
  'entry_price',
  'exit_time',
  'exit_price',
  'exit_reason',
  'stop',
  'target',
  'gross_pips',
  'net_pips',
  'gross_money',
  'cost_money',
  'net_money',
  'currency',
  'return_pct',
  'r_multiple',
  'duration_ms',
  'bars_held',
  'mfe_pips',
  'mae_pips',
  'ambiguous',
  'ambiguity_policy',
  'note',
];

/** Comma-separated, CRLF, RFC-4180 quoting. Times use the chart's timezone. */
export function tradesToCsv(results: TradeResult[], tz: string): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_HEADER.join(',')];
  for (const r of results) {
    const t = r.trade;
    lines.push(
      [
        esc(t.id),
        esc(t.symbol),
        esc(t.tf),
        esc(t.side),
        esc(t.size),
        esc(r.status),
        esc(r.entry ? formatDateTime(r.entry.time, tz) : ''),
        esc(r.entry?.price ?? t.entryPrice),
        esc(r.exit ? formatDateTime(r.exit.time, tz) : ''),
        esc(r.exit?.price ?? ''),
        esc(r.exit?.reason ?? ''),
        esc(t.stop),
        esc(t.target),
        esc(r.grossPips),
        esc(r.netPips),
        esc(r.grossMoney),
        esc(r.costMoney),
        esc(r.netMoney),
        esc(r.moneyCcy),
        esc(r.returnPct),
        esc(r.rMultiple),
        esc(r.durationMs),
        esc(r.barsHeld),
        esc(r.mfePips),
        esc(r.maePips),
        esc(r.ambiguous ? 'yes' : 'no'),
        esc(r.ambiguityPolicy),
        esc(t.note),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
