/** Performance statistics over a list of closed trades (pips-based). */

export interface TradeLike {
  entryTime: number;
  exitTime: number;
  netPips: number;
  grossPips: number;
  mfePips: number;
  maePips: number;
  holdingMin: number;
  rMultiple: number | null;
}

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  netPips: number;
  grossPips: number;
  avgTrade: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  avgMfe: number | null;
  avgMae: number | null;
  avgHoldingMin: number | null;
  avgR: number | null;
  equity: number[];
  drawdown: number[];
  /** Largest consecutive loss streak. */
  maxLossStreak: number;
}

export function computeStats(trades: readonly TradeLike[], startingEquityPips = 0): Stats {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const equity: number[] = [startingEquityPips];
  const drawdown: number[] = [0];
  let eq = startingEquityPips;
  let peak = startingEquityPips;
  let maxDd = 0;
  let maxDdPct: number | null = null;
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let net = 0;
  let gross = 0;
  let mfe = 0;
  let mae = 0;
  let hold = 0;
  let rSum = 0;
  let rN = 0;
  let streak = 0;
  let maxStreak = 0;
  for (const t of sorted) {
    net += t.netPips;
    gross += t.grossPips;
    mfe += t.mfePips;
    mae += t.maePips;
    hold += t.holdingMin;
    if (t.rMultiple !== null) {
      rSum += t.rMultiple;
      rN++;
    }
    if (t.netPips > 0) {
      wins++;
      grossWin += t.netPips;
      streak = 0;
    } else if (t.netPips < 0) {
      losses++;
      grossLoss += -t.netPips;
      streak++;
      if (streak > maxStreak) maxStreak = streak;
    } else flats++;
    eq += t.netPips;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak !== 0 ? (dd / Math.abs(peak)) * 100 : null;
    }
    equity.push(eq);
    drawdown.push(-dd);
  }
  const n = sorted.length;
  const winRate = n ? wins / n : null;
  const avgWin = wins ? grossWin / wins : null;
  const avgLoss = losses ? -grossLoss / losses : null;
  return {
    trades: n,
    wins,
    losses,
    flats,
    winRate,
    netPips: net,
    grossPips: gross,
    avgTrade: n ? net / n : null,
    avgWin,
    avgLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : null,
    expectancy: n && winRate !== null ? winRate * (avgWin ?? 0) + (1 - winRate) * (avgLoss ?? 0) : null,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    avgMfe: n ? mfe / n : null,
    avgMae: n ? mae / n : null,
    avgHoldingMin: n ? hold / n : null,
    avgR: rN ? rSum / rN : null,
    equity,
    drawdown,
    maxLossStreak: maxStreak,
  };
}

/* ------------------------------------------------------------- period splits */

export type PeriodKind = 'month' | 'half' | 'year';

export function periodKey(t: number, kind: PeriodKind): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (kind === 'year') return String(y);
  if (kind === 'half') return `${y} H${m < 6 ? 1 : 2}`;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function groupByPeriod<T extends { entryTime: number }>(items: readonly T[], kind: PeriodKind): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = periodKey(it.entryTime, kind);
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(it);
  }
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/* ------------------------------------------------------------ research splits */

export interface SplitConfig {
  /** Inclusive year-based boundaries expressed as instants. */
  trainingFrom: number | null;
  trainingTo: number | null;
  validationFrom: number | null;
  validationTo: number | null;
  oosFrom: number | null;
  oosTo: number | null;
}

export type SplitName = 'training' | 'validation' | 'oos' | 'unassigned';

export function splitOf(t: number, s: SplitConfig): SplitName {
  const inR = (a: number | null, b: number | null) => (a === null || t >= a) && (b === null || t <= b) && !(a === null && b === null);
  if (inR(s.trainingFrom, s.trainingTo)) return 'training';
  if (inR(s.validationFrom, s.validationTo)) return 'validation';
  if (inR(s.oosFrom, s.oosTo)) return 'oos';
  return 'unassigned';
}

export function splitIssues(s: SplitConfig): string[] {
  const issues: string[] = [];
  const ranges: [SplitName, number | null, number | null][] = [
    ['training', s.trainingFrom, s.trainingTo],
    ['validation', s.validationFrom, s.validationTo],
    ['oos', s.oosFrom, s.oosTo],
  ];
  for (const [name, a, b] of ranges) {
    if (a !== null && b !== null && a > b) issues.push(`${name}: start is after end`);
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const [na, a0, a1] = ranges[i];
      const [nb, b0, b1] = ranges[j];
      if (a0 === null && a1 === null) continue;
      if (b0 === null && b1 === null) continue;
      const lo = Math.max(a0 ?? -Infinity, b0 ?? -Infinity);
      const hi = Math.min(a1 ?? Infinity, b1 ?? Infinity);
      if (lo <= hi) issues.push(`${na} and ${nb} periods overlap — results would mix in-sample and out-of-sample data`);
    }
  }
  if (s.oosFrom !== null && s.trainingTo !== null && s.oosFrom <= s.trainingTo) issues.push('out-of-sample begins before training ends');
  return issues;
}

export function yearRange(fromYear: number, toYear: number): [number, number] {
  return [Date.UTC(fromYear, 0, 1), Date.UTC(toYear, 11, 31, 23, 59, 59, 999)];
}

export const DEFAULT_SPLIT: SplitConfig = {
  trainingFrom: yearRange(2020, 2023)[0],
  trainingTo: yearRange(2020, 2023)[1],
  validationFrom: yearRange(2024, 2024)[0],
  validationTo: yearRange(2024, 2024)[1],
  oosFrom: yearRange(2025, 2026)[0],
  oosTo: yearRange(2025, 2026)[1],
};
