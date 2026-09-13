import { describe, expect, it } from 'vitest';
import { simulateTrade, isFailure, type ExitRule } from '../src/core/backtest/newsTrade.ts';
import { computeStats, groupByPeriod, periodKey, splitIssues, splitOf, yearRange, DEFAULT_SPLIT } from '../src/core/backtest/newsStats.ts';
import { compactSeries, defaultSide, entryIndexFor, runNewsBacktest, seriesFromPayload, sideFor, DEFAULT_STRATEGY, type NewsStrategy } from '../src/core/backtest/news.ts';
import { buildGrid, runGridSync, DEFAULT_GRID, type OptimizeRequest } from '../src/core/backtest/optimize.ts';
import { EventIndex } from '../src/core/econ/surprise.ts';
import { enrichEvent } from '../src/core/econ/study.ts';
import { CandleSeries } from '../src/core/data/series.ts';
import { emptyColumns } from '../src/core/data/types.ts';
import { MIN, ev, minuteSeries, releases } from './helpers/econ.ts';

const T0 = Date.UTC(2023, 0, 2, 0, 0);

function bars(rows: [number, number, number, number][], start = T0): CandleSeries {
  const cols = emptyColumns(rows.length);
  rows.forEach(([o, h, l, c], i) => {
    cols.t[i] = start + i * MIN;
    cols.o[i] = o;
    cols.h[i] = h;
    cols.l[i] = l;
    cols.c[i] = c;
    cols.n[i] = 1;
  });
  return new CandleSeries({ symbol: 'EURUSD', tf: '1m', tz: 'UTC', cols, hasVolume: false });
}

const noCost = { spreadPips: 0, slippagePips: 0, commissionPips: 0 };

describe('trade simulation', () => {
  it('applies spread, slippage and commission', () => {
    const s = bars([
      [1.1, 1.1, 1.1, 1.1],
      [1.1, 1.101, 1.1, 1.101],
    ]);
    const rule: ExitRule = { timeMin: 2, tpPips: null, slPips: null, ambiguity: 'worst' };
    const t = simulateTrade(s, 0, 1, rule, { spreadPips: 1, slippagePips: 0.5, commissionPips: 0.4 }, 5);
    if (isFailure(t)) throw new Error(t.detail);
    // entry 1.1 + 0.5 pip half spread + 0.5 slip = 1.10010; exit 1.101 − 0.5 slip = 1.10095 → gross 8.5 pips, net 8.1
    expect(t.entryPrice).toBeCloseTo(1.1001, 6);
    expect(t.grossPips).toBeCloseTo(8.5, 5);
    expect(t.netPips).toBeCloseTo(8.1, 5);
    expect(t.exitReason).toBe('time');
    expect(t.holdingMin).toBe(2);
  });

  it('hits TP and SL and computes R multiple, MFE and MAE', () => {
    const s = bars([
      [1.1, 1.1002, 1.0998, 1.1001],
      [1.1001, 1.1004, 1.0999, 1.1003],
      [1.1003, 1.1012, 1.1002, 1.1011], // TP 10 pips at 1.1010
    ]);
    const long = simulateTrade(s, 0, 1, { timeMin: null, tpPips: 10, slPips: 5, ambiguity: 'worst' }, noCost, 5);
    if (isFailure(long)) throw new Error(long.detail);
    expect(long.exitReason).toBe('tp');
    expect(long.netPips).toBeCloseTo(10, 5);
    expect(long.rMultiple).toBeCloseTo(2, 5);
    expect(long.maePips).toBeCloseTo(2, 5);
    const short = simulateTrade(s, 0, -1, { timeMin: null, tpPips: 10, slPips: 5, ambiguity: 'worst' }, noCost, 5);
    if (isFailure(short)) throw new Error(short.detail);
    expect(short.exitReason).toBe('sl');
    expect(short.netPips).toBeCloseTo(-5, 5);
  });

  it('requires an explicit policy when TP and SL fall in one bar', () => {
    const s = bars([[1.1, 1.102, 1.098, 1.1]]);
    const worst = simulateTrade(s, 0, 1, { timeMin: null, tpPips: 10, slPips: 10, ambiguity: 'worst' }, noCost, 5);
    const best = simulateTrade(s, 0, 1, { timeMin: null, tpPips: 10, slPips: 10, ambiguity: 'best' }, noCost, 5);
    const skip = simulateTrade(s, 0, 1, { timeMin: null, tpPips: 10, slPips: 10, ambiguity: 'skip' }, noCost, 5);
    expect(!isFailure(worst) && worst.exitReason).toBe('sl');
    expect(!isFailure(worst) && worst.ambiguousBar).toBe(true);
    expect(!isFailure(best) && best.exitReason).toBe('tp');
    expect(isFailure(skip) && skip.reason).toBe('ambiguous-skip');
  });

  it('refuses to close a trade when known bars run out', () => {
    const s = bars([[1.1, 1.1, 1.1, 1.1], [1.1, 1.1, 1.1, 1.1]]);
    const t = simulateTrade(s, 0, 1, { timeMin: 30, tpPips: null, slPips: null, ambiguity: 'worst' }, noCost, 5);
    expect(isFailure(t) && t.reason).toBe('insufficient-bars');
    const beyond = simulateTrade(s.withLimit(1), 1, 1, { timeMin: 1, tpPips: null, slPips: null, ambiguity: 'worst' }, noCost, 5);
    expect(isFailure(beyond) && beyond.reason).toBe('no-entry-bar');
  });
});

describe('statistics', () => {
  const tr = (net: number, t: number) => ({ entryTime: t, exitTime: t + MIN, netPips: net, grossPips: net, mfePips: Math.abs(net), maePips: 1, holdingMin: 1, rMultiple: null });
  it('win rate, profit factor, expectancy, drawdown', () => {
    const s = computeStats([tr(10, 1), tr(-5, 2), tr(-5, 3), tr(20, 4)]);
    expect(s.trades).toBe(4);
    expect(s.winRate).toBe(0.5);
    expect(s.netPips).toBe(20);
    expect(s.profitFactor).toBe(3);
    expect(s.expectancy).toBeCloseTo(5);
    expect(s.maxDrawdown).toBe(10);
    expect(s.maxLossStreak).toBe(2);
    expect(s.equity).toEqual([0, 10, 5, 0, 20]);
  });
  it('period keys and splits', () => {
    expect(periodKey(Date.UTC(2024, 6, 1), 'half')).toBe('2024 H2');
    expect(periodKey(Date.UTC(2024, 1, 1), 'month')).toBe('2024-02');
    expect(periodKey(Date.UTC(2024, 1, 1), 'year')).toBe('2024');
    const g = groupByPeriod([{ entryTime: Date.UTC(2024, 0, 1) }, { entryTime: Date.UTC(2024, 7, 1) }], 'half');
    expect([...g.keys()]).toEqual(['2024 H1', '2024 H2']);
    expect(splitOf(Date.UTC(2022, 5, 1), DEFAULT_SPLIT)).toBe('training');
    expect(splitOf(Date.UTC(2024, 5, 1), DEFAULT_SPLIT)).toBe('validation');
    expect(splitOf(Date.UTC(2025, 5, 1), DEFAULT_SPLIT)).toBe('oos');
    expect(splitOf(Date.UTC(2019, 5, 1), DEFAULT_SPLIT)).toBe('unassigned');
    expect(splitIssues(DEFAULT_SPLIT)).toEqual([]);
    const bad = { ...DEFAULT_SPLIT, oosFrom: yearRange(2023, 2023)[0] };
    expect(splitIssues(bad).some((x) => /overlap/.test(x))).toBe(true);
  });
});

describe('news backtester', () => {
  // 20 monthly USD releases at 12:30Z; positive surprise → EURUSD drops 10 pips over 5 minutes.
  const first = T0 + 750 * MIN;
  const pairs: [number, number][] = Array.from({ length: 20 }, (_, i) => [3 + (i % 2 ? 0.3 : -0.3) + (i % 5 === 0 ? 0.1 : 0), 3]);
  const list = releases(first, pairs);
  const jumps: Record<number, number> = {};
  for (const e of list) {
    const sign = e.actual! - e.forecast! > 0 ? -1 : 1;
    jumps[e.time] = 4 * sign;
    jumps[e.time + MIN] = 3 * sign;
    jumps[e.time + 2 * MIN] = 3 * sign;
  }
  const series = minuteSeries(T0, 20 * 30 * 1440 + 3000, { jumps });
  const idx = new EventIndex(list);
  const enriched = list.map((e) => enrichEvent(e, idx, series, Number.POSITIVE_INFINITY));

  it('default direction mapping follows base/quote', () => {
    expect(defaultSide('USD', 'EURUSD')).toBe(-1);
    expect(defaultSide('EUR', 'EURUSD')).toBe(1);
    expect(defaultSide('GBP', 'EURUSD')).toBeNull();
    const e = enriched[19];
    expect(sideFor(e, { mode: 'custom', rules: [], pair: 'EURUSD' })).toBe(e.surprise.raw.status === 'ok' && e.surprise.raw.value > 0 ? -1 : 1);
    expect(sideFor(e, { mode: 'opposite', rules: [], pair: 'EURUSD' })).toBe(e.surprise.raw.status === 'ok' && e.surprise.raw.value > 0 ? 1 : -1);
    expect(sideFor(e, { mode: 'buy', rules: [], pair: 'EURUSD' })).toBe(e.surprise.raw.status === 'ok' && e.surprise.raw.value > 0 ? 1 : -1);
    expect(sideFor(e, { mode: 'custom', rules: [{ currency: 'USD', onPositive: 1 }], pair: 'EURUSD' })).toBe(e.surprise.raw.status === 'ok' && e.surprise.raw.value > 0 ? 1 : -1);
  });

  it('entry rules never open before the release', () => {
    const rel = list[0].time;
    const at = entryIndexFor(series, rel, { kind: 'release', value: 0 });
    expect(series.time(at)).toBe(rel);
    const m1 = entryIndexFor(series, rel, { kind: 'minutes', value: 1 });
    expect(series.time(m1)).toBe(rel + MIN);
    const b3 = entryIndexFor(series, rel, { kind: 'bars', value: 3 });
    expect(series.time(b3)).toBe(rel + 2 * MIN);
  });

  it('runs the strategy and produces trades, skips and breakdowns', () => {
    const strategy: NewsStrategy = { ...DEFAULT_STRATEGY, entry: { kind: 'minutes', value: 1 }, exit: { timeMin: 30, tpPips: null, slPips: null, ambiguity: 'worst' }, costs: noCost, minAbsZ: null, requireZ: false };
    const r = runNewsBacktest(enriched, series, strategy, DEFAULT_SPLIT);
    expect(r.totalEvents).toBe(20);
    expect(r.trades.length).toBe(20);
    expect(r.stats.winRate).toBeGreaterThan(0.8);
    expect(r.stats.netPips).toBeGreaterThan(50);
    expect(r.monthly.length).toBeGreaterThan(10);
    expect(r.yearly.length).toBeGreaterThanOrEqual(2);
    expect(r.halves.every((h) => h.events > 0)).toBe(true);
    expect(r.splits!.training.stats.trades + r.splits!.validation.stats.trades + r.splits!.oos.stats.trades + r.splits!.unassigned.stats.trades).toBe(20);
    const t = r.trades[0];
    expect(t.entryTime).toBe(t.releaseTime + MIN);
    expect(t.eventId).toBe(list[0].id);
    // z-gated variant: early releases have no history → skipped with a reason
    const gated = runNewsBacktest(enriched, series, { ...strategy, requireZ: true, minAbsZ: 0.5 });
    expect(gated.skipped.length).toBeGreaterThan(0);
    expect(gated.skipped[0].reason).toMatch(/standardized surprise unavailable/);
    expect(gated.trades.length + gated.skipped.length).toBe(20);
  });

  it('cluster policy and surprise sign filters skip with reasons', () => {
    const strategy: NewsStrategy = { ...DEFAULT_STRATEGY, costs: noCost, minAbsZ: null, requireZ: false, surpriseSign: 'positive' };
    const r = runNewsBacktest(enriched, series, strategy);
    expect(r.skipped.every((s) => /negative surprise excluded/.test(s.reason))).toBe(true);
    expect(r.trades.every((t) => (t.rawSurprise ?? 0) > 0)).toBe(true);
  });

  it('compact series round-trips and grid runs synchronously with progress', () => {
    const payload = compactSeries(series, list.map((e) => e.time), 60 * MIN, 120 * MIN);
    expect(payload.t.length).toBeLessThan(series.count);
    expect(payload.t.length).toBeGreaterThanOrEqual(20 * 180 - 20);
    const small = seriesFromPayload(payload);
    const strategies = buildGrid({ ...DEFAULT_STRATEGY, costs: noCost, requireZ: false }, { ...DEFAULT_GRID, minAbsZ: [null] });
    expect(strategies.length).toBe(4);
    const msgs: string[] = [];
    let results = 0;
    const req: OptimizeRequest = { type: 'optimize', events: enriched, series: payload, strategies, split: null };
    runGridSync(req, (m) => {
      msgs.push(m.type);
      if (m.type === 'result') {
        results++;
        expect(m.result.trades.length).toBe(20);
      }
    });
    expect(results).toBe(4);
    expect(msgs[msgs.length - 1]).toBe('done');
    void small;
  });
});

describe('period labels for six-month analysis', () => {
  it('produces only periods with data', () => {
    const strategy: NewsStrategy = { ...DEFAULT_STRATEGY, costs: noCost, minAbsZ: null, requireZ: false };
    const e = ev(T0 + 600 * MIN);
    const s = minuteSeries(T0, 3000, { jumps: { [e.time]: -5 } });
    const en = enrichEvent(e, new EventIndex([e]), s, Number.POSITIVE_INFINITY);
    const r = runNewsBacktest([en], s, strategy);
    expect(r.halves.map((h) => h.period)).toEqual(['2023 H1']);
    expect(r.yearly.map((h) => h.period)).toEqual(['2023']);
  });
});
