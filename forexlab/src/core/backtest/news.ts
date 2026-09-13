/**
 * Automated news backtester — pure engine.
 *
 * Input: candidate events (already filtered + enriched on the gated event set),
 * a gated candle series, and a `NewsStrategy`. Output: one simulated trade per
 * eligible event plus explicit skip reasons. The engine is synchronous and
 * allocation-light so it can run inside a Web Worker for optimisation grids.
 *
 * Entry never uses information after the entry bar's open: the entry bar is the
 * first bar whose *open time* is ≥ release + delay (or the k-th bar after the
 * release bar), and the fill is that bar's open plus costs.
 */

import { CandleSeries } from '../data/series.ts';
import { emptyColumns } from '../data/types.ts';
import { quoteDecimals } from '../econ/context.ts';
import type { EnrichedEvent } from '../econ/study.ts';
import { isOk } from '../econ/types.ts';
import { computeStats, groupByPeriod, splitOf, type SplitConfig, type SplitName, type Stats } from './newsStats.ts';
import { DEFAULT_COSTS, isFailure, simulateTrade, type AmbiguityPolicy, type Costs, type Side, type SimTrade } from './newsTrade.ts';

/** How a currency's positive surprise maps to a trade on the pair. */
export type DirectionMode = 'buy' | 'sell' | 'opposite' | 'custom';

export interface DirectionRule {
  /** Currency the rule applies to (e.g. USD). */
  currency: string;
  /** Pair side when the surprise is positive: +1 buy pair, −1 sell pair. */
  onPositive: Side;
}

export interface DirectionMapping {
  mode: DirectionMode;
  /** Used when mode === 'custom' */
  rules: DirectionRule[];
  /** Pair symbol e.g. EURUSD — base/quote determine the default mapping. */
  pair: string;
}

/**
 * Default economic mapping: a positive surprise is bullish for its currency;
 * the pair goes up when the base currency strengthens and down when the quote
 * currency strengthens. This is only a *default* the user can override.
 */
export function defaultSide(currency: string, pair: string): Side | null {
  const base = pair.slice(0, 3).toUpperCase();
  const quote = pair.slice(3, 6).toUpperCase();
  const c = currency.toUpperCase();
  if (c === base) return 1;
  if (c === quote) return -1;
  return null;
}

export function sideFor(e: EnrichedEvent, mapping: DirectionMapping): Side | null {
  const dir = isOk(e.surprise.direction) ? e.surprise.direction.value : 0;
  if (dir === 0) return null;
  let onPositive: Side | null;
  switch (mapping.mode) {
    case 'buy':
      onPositive = 1;
      break;
    case 'sell':
      onPositive = -1;
      break;
    case 'custom': {
      const r = mapping.rules.find((x) => x.currency.toUpperCase() === e.event.currency.toUpperCase());
      onPositive = r ? r.onPositive : defaultSide(e.event.currency, mapping.pair);
      break;
    }
    case 'opposite':
    default: {
      const d = defaultSide(e.event.currency, mapping.pair);
      onPositive = d === null ? null : mapping.mode === 'opposite' ? ((-d) as Side) : d;
    }
  }
  if (onPositive === null) return null;
  return (dir > 0 ? onPositive : -onPositive) as Side;
}

export interface EntryRule {
  kind: 'release' | 'bars' | 'minutes';
  /** Bars after the release bar, or minutes after the release. */
  value: number;
}

export interface NewsStrategy {
  entry: EntryRule;
  exit: { timeMin: number | null; tpPips: number | null; slPips: number | null; ambiguity: AmbiguityPolicy };
  costs: Costs;
  direction: DirectionMapping;
  /** Skip events whose cluster has other high-impact releases nearby. */
  clusterPolicy: 'any' | 'isolatedOnly' | 'noAmbiguous';
  /** Minimum |z| required (null = no requirement). */
  minAbsZ: number | null;
  /** Require standardized surprise to be available. */
  requireZ: boolean;
  /** Minimum |raw surprise| in indicator units (null = none). */
  minAbsRaw: number | null;
  /** Only trade when surprise sign is in this set. */
  surpriseSign: 'any' | 'positive' | 'negative';
  label?: string;
}

export const DEFAULT_STRATEGY: NewsStrategy = {
  entry: { kind: 'minutes', value: 1 },
  exit: { timeMin: 30, tpPips: null, slPips: null, ambiguity: 'worst' },
  costs: DEFAULT_COSTS,
  direction: { mode: 'custom', rules: [], pair: 'EURUSD' },
  clusterPolicy: 'any',
  minAbsZ: 1,
  requireZ: true,
  minAbsRaw: null,
  surpriseSign: 'any',
};

export interface NewsTrade extends SimTrade {
  eventId: string;
  eventKey: string;
  eventTitle: string;
  eventType: string;
  currency: string;
  releaseTime: number;
  rawSurprise: number | null;
  z: number | null;
  session: string;
  regime: string | null;
  isolation: string;
  ambiguousAttribution: boolean;
}

export interface SkippedEvent {
  eventId: string;
  reason: string;
}

export interface NewsBacktestResult {
  strategyLabel: string;
  totalEvents: number;
  validEvents: number;
  skipped: SkippedEvent[];
  trades: NewsTrade[];
  stats: Stats;
  ambiguousBars: number;
  /** Per-period breakdowns. */
  monthly: { period: string; stats: Stats; events: number }[];
  halves: { period: string; stats: Stats; events: number }[];
  yearly: { period: string; stats: Stats; events: number }[];
  splits: Record<SplitName, { stats: Stats; events: number }> | null;
}

export function entryIndexFor(series: CandleSeries, releaseTime: number, entry: EntryRule): number {
  const step = series.stepMs ?? 60_000;
  // Release bar: the bar whose bucket contains the release instant.
  const releaseIdx = series.lower(releaseTime - step + 1);
  if (releaseIdx >= series.count) return -1;
  if (entry.kind === 'release') {
    // Entering "at release" means the first bar that *opens* at or after release
    // (the release bar's open is before the news and would be look-ahead).
    return series.lower(releaseTime);
  }
  if (entry.kind === 'bars') {
    const first = series.lower(releaseTime);
    const i = first + Math.max(0, entry.value - 1);
    return i < series.count ? i : -1;
  }
  const i = series.lower(releaseTime + entry.value * 60_000);
  return i < series.count ? i : -1;
}

export function runNewsBacktest(
  candidates: readonly EnrichedEvent[],
  series: CandleSeries | null,
  strategy: NewsStrategy,
  split: SplitConfig | null = null,
): NewsBacktestResult {
  const skipped: SkippedEvent[] = [];
  const trades: NewsTrade[] = [];
  let ambiguousBars = 0;
  const decimals = series ? quoteDecimals(series) : 5;
  const eventCountBy = (kind: 'month' | 'half' | 'year') => groupByPeriod(candidates.map((e) => ({ entryTime: e.event.time })), kind);
  for (const e of candidates) {
    if (!series || series.count === 0) {
      skipped.push({ eventId: e.event.id, reason: 'no price data' });
      continue;
    }
    if (strategy.requireZ && !isOk(e.surprise.z)) {
      skipped.push({ eventId: e.event.id, reason: `standardized surprise unavailable: ${e.surprise.z.reason}` });
      continue;
    }
    if (!isOk(e.surprise.raw)) {
      skipped.push({ eventId: e.event.id, reason: `raw surprise unavailable: ${e.surprise.raw.reason}` });
      continue;
    }
    if (strategy.minAbsZ !== null && (!isOk(e.surprise.z) || Math.abs(e.surprise.z.value) < strategy.minAbsZ)) {
      skipped.push({ eventId: e.event.id, reason: `|z| below ${strategy.minAbsZ}` });
      continue;
    }
    if (strategy.minAbsRaw !== null && Math.abs(e.surprise.raw.value) < strategy.minAbsRaw) {
      skipped.push({ eventId: e.event.id, reason: `|surprise| below ${strategy.minAbsRaw}` });
      continue;
    }
    const sign = Math.sign(e.surprise.raw.value);
    if (sign === 0) {
      skipped.push({ eventId: e.event.id, reason: 'zero surprise' });
      continue;
    }
    if (strategy.surpriseSign === 'positive' && sign < 0) {
      skipped.push({ eventId: e.event.id, reason: 'negative surprise excluded' });
      continue;
    }
    if (strategy.surpriseSign === 'negative' && sign > 0) {
      skipped.push({ eventId: e.event.id, reason: 'positive surprise excluded' });
      continue;
    }
    if (strategy.clusterPolicy === 'isolatedOnly' && e.cluster.isolation !== 'isolated') {
      skipped.push({ eventId: e.event.id, reason: `not isolated (${e.cluster.neighbours.length} events within ±${e.cluster.windowMin}m)` });
      continue;
    }
    if (strategy.clusterPolicy === 'noAmbiguous' && e.cluster.ambiguous) {
      skipped.push({ eventId: e.event.id, reason: 'attribution ambiguous (high-impact neighbour)' });
      continue;
    }
    const side = sideFor(e, strategy.direction);
    if (side === null) {
      skipped.push({ eventId: e.event.id, reason: `no direction rule for ${e.event.currency} on ${strategy.direction.pair}` });
      continue;
    }
    const entryIdx = entryIndexFor(series, e.event.time, strategy.entry);
    if (entryIdx < 0) {
      skipped.push({ eventId: e.event.id, reason: 'entry bar not in known price history' });
      continue;
    }
    // Entry must not precede the release (guards a mis-specified rule).
    if (series.time(entryIdx) < e.event.time) {
      skipped.push({ eventId: e.event.id, reason: 'entry bar opens before release (rejected to avoid look-ahead)' });
      continue;
    }
    // Entry more than a day after release means data is missing around the event.
    if (series.time(entryIdx) - e.event.time > 86_400_000) {
      skipped.push({ eventId: e.event.id, reason: 'no price bars within a day after release' });
      continue;
    }
    const sim = simulateTrade(series, entryIdx, side, strategy.exit, strategy.costs, decimals);
    if (isFailure(sim)) {
      skipped.push({ eventId: e.event.id, reason: sim.reason === 'ambiguous-skip' ? `TP and SL in the same bar (policy: skip)` : sim.detail });
      if (sim.reason === 'ambiguous-skip') ambiguousBars++;
      continue;
    }
    if (sim.ambiguousBar) ambiguousBars++;
    trades.push({
      ...sim,
      eventId: e.event.id,
      eventKey: e.event.key,
      eventTitle: e.event.event,
      eventType: e.event.type,
      currency: e.event.currency,
      releaseTime: e.event.time,
      rawSurprise: e.surprise.raw.value,
      z: isOk(e.surprise.z) ? e.surprise.z.value : null,
      session: e.session,
      regime: isOk(e.context.regime) ? e.context.regime.value : null,
      isolation: e.cluster.isolation,
      ambiguousAttribution: e.cluster.ambiguous,
    });
  }
  const per = (kind: 'month' | 'half' | 'year') => {
    const ev = eventCountBy(kind);
    const tr = groupByPeriod(trades, kind);
    const keys = new Set([...ev.keys(), ...tr.keys()]);
    return [...keys].sort().map((period) => ({ period, stats: computeStats(tr.get(period) ?? []), events: ev.get(period)?.length ?? 0 }));
  };
  let splits: NewsBacktestResult['splits'] = null;
  if (split) {
    const names: SplitName[] = ['training', 'validation', 'oos', 'unassigned'];
    splits = Object.fromEntries(
      names.map((n) => [n, { stats: computeStats(trades.filter((t) => splitOf(t.releaseTime, split) === n)), events: candidates.filter((e) => splitOf(e.event.time, split) === n).length }]),
    ) as NewsBacktestResult['splits'];
  }
  return {
    strategyLabel: strategy.label ?? describeStrategy(strategy),
    totalEvents: candidates.length,
    validEvents: trades.length + skipped.filter((s) => s.reason.startsWith('TP and SL')).length,
    skipped,
    trades,
    stats: computeStats(trades),
    ambiguousBars,
    monthly: per('month'),
    halves: per('half'),
    yearly: per('year'),
    splits,
  };
}

export function describeStrategy(s: NewsStrategy): string {
  const entry = s.entry.kind === 'release' ? 'at release' : s.entry.kind === 'bars' ? `+${s.entry.value} bar${s.entry.value === 1 ? '' : 's'}` : `+${s.entry.value}m`;
  const exits: string[] = [];
  if (s.exit.timeMin !== null) exits.push(s.exit.timeMin >= 1440 ? `${s.exit.timeMin / 1440}D` : s.exit.timeMin >= 60 ? `${s.exit.timeMin / 60}H` : `${s.exit.timeMin}m`);
  if (s.exit.tpPips !== null) exits.push(`TP ${s.exit.tpPips}`);
  if (s.exit.slPips !== null) exits.push(`SL ${s.exit.slPips}`);
  const z = s.minAbsZ !== null ? ` · |z| ≥ ${s.minAbsZ}` : '';
  return `${entry} / ${exits.join(' ') || 'no exit'}${z}`;
}

/* --------------------------------------------------- compact series transfer */

/** Minimal serialisable candle payload (for workers). */
export interface SeriesPayload {
  symbol: string;
  tf: string;
  tz: string;
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
}

/**
 * Copy only the bars the backtest can touch: [release − 1D, release + maxHoldMs]
 * per candidate, merged. The copy is made from the *gated* series so a worker
 * cannot see anything the main thread may not.
 */
export function compactSeries(series: CandleSeries, times: readonly number[], beforeMs: number, afterMs: number): SeriesPayload {
  const sorted = [...times].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const t of sorted) {
    const a = series.lower(t - beforeMs);
    const b = Math.min(series.count, series.upper(t + afterMs));
    if (b <= a) continue;
    const last = ranges[ranges.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
  }
  const total = ranges.reduce((s, [a, b]) => s + (b - a), 0);
  const out = emptyColumns(total);
  let w = 0;
  const src = series.cols;
  for (const [a, b] of ranges) {
    out.t.set(src.t.subarray(a, b), w);
    out.o.set(src.o.subarray(a, b), w);
    out.h.set(src.h.subarray(a, b), w);
    out.l.set(src.l.subarray(a, b), w);
    out.c.set(src.c.subarray(a, b), w);
    w += b - a;
  }
  return { symbol: series.symbol, tf: series.tf, tz: series.tz, t: out.t, o: out.o, h: out.h, l: out.l, c: out.c };
}

export function seriesFromPayload(p: SeriesPayload): CandleSeries {
  const len = p.t.length;
  const cols = emptyColumns(len);
  cols.t.set(p.t);
  cols.o.set(p.o);
  cols.h.set(p.h);
  cols.l.set(p.l);
  cols.c.set(p.c);
  cols.n.fill(1);
  return new CandleSeries({ symbol: p.symbol, tf: p.tf as CandleSeries['tf'], tz: p.tz, cols, hasVolume: false });
}
