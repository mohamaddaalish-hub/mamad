/**
 * Manual backtest ledger: fill rules, costs, excursion measurement, the ambiguity
 * policy, statistics from the ledger only, and the session round trip.
 */

import { describe, expect, it } from 'vitest';
import { seriesFromArrays } from '../src/core/data/series.ts';
import type { CandleSeries } from '../src/core/data/series.ts';
import { evaluateTrade, makeTrade, serializeTrade, deserializeTrade, type Trade } from '../src/core/backtest/trade.ts';
import { computeStats, equityCurve, tradesToCsv } from '../src/core/backtest/stats.ts';
import { DEFAULT_ACCOUNT, quoteCurrency, needsConversion, sizeFor, validateAccount, type AccountSettings } from '../src/core/backtest/account.ts';

const T0 = Date.UTC(2024, 3, 1, 8, 0);
const MIN = 60_000;
const PIP = 0.0001;

/** Candles from literal numbers so every assertion is about a known path. */
function mk(rows: Array<[o: number, h: number, l: number, c: number]>): CandleSeries {
  const t = rows.map((_, i) => T0 + i * MIN);
  const o = rows.map((r) => r[0]);
  const h = rows.map((r) => r[1]);
  const l = rows.map((r) => r[2]);
  const c = rows.map((r) => r[3]);
  return seriesFromArrays(t, o, h, l, c, undefined, { symbol: 'EURUSD', tf: '1m', tz: 'UTC' });
}

function account(patch: Partial<AccountSettings> = {}): AccountSettings {
  return { ...DEFAULT_ACCOUNT, sizing: 'fixed', fixedSize: 10_000, spreadPips: 0, slippagePips: 0, commissionPerSide: 0, ...patch };
}

function trade(
  series: CandleSeries,
  patch: Partial<Trade> & { side?: 'buy' | 'sell'; entryBar?: number },
  acc: AccountSettings,
): Trade {
  return makeTrade(
    {
      symbol: 'EURUSD',
      tf: '1m',
      side: patch.side ?? 'buy',
      size: 10_000,
      entryKind: 'market',
      entryBar: patch.entryBar ?? 0,
      entryPrice: series.candle(patch.entryBar ?? 0)!.c,
      stop: null,
      target: null,
      manualExitBar: null,
      note: '',
      ...patch,
    } as never,
    acc,
  );
}

function evaluate(series: CandleSeries, t: Trade, acc: AccountSettings, equity = acc.startingBalance) {
  return evaluateTrade(t, { series, account: acc, quoteCcy: quoteCurrency('EURUSD') }, equity);
}

const flat = (price: number, n: number): Array<[number, number, number, number]> =>
  Array.from({ length: n }, () => [price, price + 0.0002, price - 0.0002, price] as [number, number, number, number]);

describe('fills and measured results', () => {
  it('a market entry fills at the bar close the user clicked', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.1015, 1.1005, 1.101],
    ]);
    const acc = account();
    const r = evaluate(series, trade(series, { entryBar: 0 }, acc), acc);
    expect(r.entry?.price).toBe(1.1);
    expect(r.entry?.index).toBe(0);
    expect(r.status).toBe('open');
  });

  it('a limit order that no revealed bar reached is an order, not a trade', () => {
    const series = mk(flat(1.1, 4));
    const acc = account();
    const t = trade(
      series,
      {
        entryKind: 'limit',
        entryPrice: 1.09,
      },
      acc,
    );
    const r = evaluate(series, t, acc);
    expect(r.status).toBe('pending');
    expect(r.entry).toBeNull();
    expect(r.unavailableReason).toMatch(/never reached/);
  });

  it('a limit order fills on the first bar whose range reaches it', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.1005, 1.0995, 1.1],
      [1.0995, 1.1005, 1.095, 1.099], // low 1.0950 crosses the 1.0970 buy limit
      [1.099, 1.101, 1.0985, 1.1005],
    ]);
    const acc = account();
    const r = evaluate(series, trade(series, { entryKind: 'limit', entryPrice: 1.097 }, acc), acc);
    expect(r.status).toBe('open');
    expect(r.entry?.index).toBe(2);
    expect(r.entry?.price).toBeCloseTo(1.097, 5);
    // MFE from the bar after the fill only: 1.1010 - 1.0970 = 40 pips.
    expect(r.mfePips).toBeCloseTo(40, 6);
  });

  it('targets are filled at the level with the bar time', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.1015, 1.1005, 1.101],
      [1.101, 1.103, 1.1015, 1.1025],
    ]);
    const acc = account();
    const r = evaluate(series, trade(series, { target: 1.102, stop: 1.098 }, acc), acc);
    expect(r.status).toBe('closed');
    expect(r.exit?.reason).toBe('take-profit');
    expect(r.exit?.index).toBe(2);
    expect(r.exit?.price).toBe(1.102);
    expect(r.grossPips).toBeCloseTo(20, 6);
    expect(r.netPips).toBeCloseTo(20, 6);
    expect(r.grossMoney).toBeCloseTo(20 * PIP * 10_000, 6);
    expect(r.durationMs).toBe(2 * MIN);
    expect(r.barsHeld).toBe(2);
    expect(r.intrabar).toBe(true);
  });

  it('a manual close is taken at that bar close, not at a later high', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.11, 1.09, 1.1005],
    ]);
    const acc = account();
    const r = evaluate(series, trade(series, { manualExitBar: 1 }, acc), acc);
    expect(r.exit?.reason).toBe('manual');
    expect(r.grossPips).toBeCloseTo(5, 6);
    // The exit bar's 1.1100 spike is beyond the close, so MFE stays at the close.
    expect(r.mfePips).toBeCloseTo(5, 6);
    expect(r.maePips).toBeCloseTo(0, 6);
  });

  it('stops are filled at the stop level', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.1002, 1.0975, 1.098],
    ]);
    const acc = account();
    const r = evaluate(series, trade(series, { stop: 1.099 }, acc), acc);
    expect(r.exit?.reason).toBe('stop-loss');
    expect(r.exit?.price).toBe(1.099);
    expect(r.netPips).toBeCloseTo(-10, 6);
    expect(r.netMoney).toBeCloseTo(-10 * PIP * 10_000, 6);
    expect(r.rMultiple).toBeCloseTo(-1, 6);
  });

  it('a short profits when price falls and the signs stay consistent', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.1002, 1.0945, 1.095],
    ]);
    const acc = account();
    const long = evaluate(series, trade(series, { side: 'sell', target: 1.095 }, acc), acc);
    expect(long.netPips).toBeCloseTo(50, 6);
    // A buy whose "target" sits below the entry is nonsense: the level is reported
    // and ignored instead of fabricating a fill at a price that never traded.
    const sameBar = evaluate(series, trade(series, { side: 'buy', target: 1.095 }, acc), acc);
    expect(sameBar.status).toBe('open');
    expect(sameBar.levelProblem).toMatch(/wrong side of the entry price/);
  });
});

describe('costs', () => {
  it('charges the round-trip spread and both commissions', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.103, 1.1015, 1.1025],
    ]);
    const acc = account({ spreadPips: 1, commissionPerSide: 2 });
    const r = evaluate(series, trade(series, { target: 1.102 }, acc), acc);
    expect(r.grossPips).toBeCloseTo(20, 6);
    expect(r.netPips).toBeCloseTo(19, 6);
    const grossMoney = 20 * PIP * 10_000;
    const netMoney = 19 * PIP * 10_000 - 4;
    expect(r.grossMoney).toBeCloseTo(grossMoney, 6);
    expect(r.netMoney).toBeCloseTo(netMoney, 6);
    expect(r.costMoney).toBeCloseTo(1 * PIP * 10_000 + 4, 6);
  });

  it('slippage moves both fills against the trader', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.103, 1.1015, 1.1025],
    ]);
    const acc = account({ slippagePips: 1 });
    const r = evaluate(series, trade(series, { target: 1.102 }, acc), acc);
    // Entry 1.1000 + 1 pip, exit 1.1020 - 1 pip → 18 pips instead of 20.
    expect(r.entry?.price).toBeCloseTo(1.1001, 6);
    expect(r.exit?.price).toBeCloseTo(1.1019, 6);
    expect(r.grossPips).toBeCloseTo(18, 6);
  });

  it('an open position is marked at the newest revealed close minus the spread', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.1015, 1.1005, 1.101],
    ]);
    const acc = account({ spreadPips: 1 });
    const r = evaluate(series, trade(series, {}, acc), acc);
    expect(r.status).toBe('open');
    expect(r.unrealizedPips).toBeCloseTo(9, 6);
    expect(r.markedAt?.index).toBe(1);
  });
});

describe('ambiguity policy (never the favourable assumption by default)', () => {
  const series = mk([
    [1.1, 1.1005, 1.0995, 1.1],
    [1.1, 1.103, 1.098, 1.1005], // one bar covers both 1.099 and 1.102
  ]);

  for (const policy of ['adverse', 'favorable', 'first-touch-close'] as const) {
    it(`resolves a both-levels bar as ${policy}`, () => {
      const acc = account({ ambiguityPolicy: policy });
      const r = evaluate(series, trade(series, { stop: 1.099, target: 1.102 }, acc), acc);
      expect(r.ambiguous).toBe(true);
      expect(r.intrabar).toBe(true);
      expect(r.ambiguityPolicy).toBe(policy);
      if (policy === 'adverse') {
        expect(r.exit?.reason).toBe('stop-loss');
        expect(r.netPips).toBeCloseTo(-10, 6);
      } else if (policy === 'favorable') {
        expect(r.exit?.reason).toBe('take-profit');
        expect(r.netPips).toBeCloseTo(20, 6);
      } else {
        expect(r.exit?.reason).toBe('close-only');
        expect(r.exit?.price).toBe(1.1005);
        expect(r.netPips).toBeCloseTo(5, 6);
      }
    });
  }

  it('the three readings really differ, so the policy is not cosmetic', () => {
    const pips = (['adverse', 'favorable', 'first-touch-close'] as const).map((policy) =>
      evaluate(series, trade(series, { stop: 1.099, target: 1.102 }, account({ ambiguityPolicy: policy })), account({ ambiguityPolicy: policy })).netPips,
    );
    expect(new Set(pips.map((v) => v.toFixed(2))).size).toBe(3);
  });

  it('defaults to the adverse reading', () => {
    expect(DEFAULT_ACCOUNT.ambiguityPolicy).toBe('adverse');
  });
});

describe('excursions and the data limit', () => {
  it('ignores the entry bar range', () => {
    const series = mk([
      [1.1, 1.5, 1.0, 1.1], // the bar clicked: an enormous range that must not count
      [1.1, 1.102, 1.099, 1.1005],
    ]);
    const acc = account();
    const r = evaluate(series, trade(series, {}, acc), acc);
    expect(r.mfePips).toBeCloseTo(20, 6);
    expect(r.maePips).toBeCloseTo(10, 6);
  });

  it('stops at the newest revealed bar when a trade is still open', () => {
    const all = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.102, 1.099, 1.1005],
      [1.1005, 1.11, 1.09, 1.105], // beyond a barrier of 2 bars
    ]);
    const acc = account();
    const t = trade(all, {}, acc);
    const revealed = evaluate(all.withLimit(2), t, acc);
    const full = evaluate(all, t, acc);
    expect(revealed.mfePips).toBeCloseTo(20, 6);
    expect(full.mfePips).toBeCloseTo(100, 6);
    expect(revealed.markedAt?.index).toBe(1);
    expect(full.markedAt?.index).toBe(2);
  });
});

describe('statistics from the ledger', () => {
  it('reports UNAVAILABLE rather than zero when nothing has closed', () => {
    const series = mk(flat(1.1, 3));
    const acc = account();
    const stats = computeStats([], acc.startingBalance);
    expect(stats.netPnl).toBeNull();
    expect(stats.winRate).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.expectancy).toBeNull();
    expect(stats.avgDurationMs).toBeNull();
    expect(stats.finalEquity).toBeNull();
    const curve = equityCurve([], acc.startingBalance);
    expect(curve.equity).toHaveLength(0);
    expect(curve.maxDrawdown).toBe(0);
    void series;
  });

  it('computes the ledger numbers from closed trades only', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.103, 1.1015, 1.1025], // win +20 pips
      [1.1025, 1.103, 1.102, 1.1025],
      [1.1025, 1.103, 1.102, 1.1025],
    ]);
    const acc = account();
    const win = evaluate(series, trade(series, { entryBar: 0, target: 1.102 }, acc), acc);
    // A loser: enter at bar 2 close, stop below.
    const loss = evaluate(series, trade(series, { entryBar: 2, stop: 1.102 }, acc), acc);
    const pending = evaluate(series, trade(series, { entryBar: 2, entryKind: 'limit', entryPrice: 1.09 }, acc), acc);
    expect(win.status).toBe('closed');
    const openResult = evaluate(series, trade(series, { entryBar: 3 }, acc), acc);
    const results = [win, loss, pending, openResult];
    const stats = computeStats(results, 10_000);
    expect(stats.closedCount).toBe(2);
    expect(stats.winCount).toBe(1);
    expect(stats.lossCount).toBe(1);
    expect(stats.pendingCount).toBe(1);
    expect(stats.openCount).toBe(1);
    expect(stats.winRate).toBeCloseTo(50, 6);
    const winMoney = win.netMoney;
    const lossMoney = loss.netMoney;
    expect(stats.netPnl).toBeCloseTo(winMoney + lossMoney, 6);
    expect(stats.expectancy).toBeCloseTo((winMoney + lossMoney) / 2, 6);
    expect(stats.profitFactor).toBeCloseTo(winMoney / Math.abs(lossMoney), 6);
    expect(stats.bestTrade).toBeCloseTo(Math.max(winMoney, lossMoney), 6);
    expect(stats.worstTrade).toBeCloseTo(Math.min(winMoney, lossMoney), 6);
    expect(stats.maxConsecWins).toBe(1);
    expect(stats.maxConsecLosses).toBe(1);
    // Return % is measured against equity before each trade, so the second trade
    // is judged on the balance the first one left behind.
    const curve = equityCurve(results, 10_000);
    expect(curve.equity).toHaveLength(3); // seed point + two closed steps
    expect(curve.equity[2].value).toBeCloseTo(10_000 + winMoney + lossMoney, 6);
    // A single `evaluateTrade` call does not know the run-up; only the ledger's
    // result chain applies it (covered by the live-chart test).
    const lossResult = results.find((r) => r.id === loss.id)!;
    expect(lossResult.equityBefore).toBe(10_000);
  });

  it('drawdown follows the curve, not the individual losses', () => {
    const acc = account();
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.1025, 1.102, 1.1022], // +20 pips win
      [1.1022, 1.1025, 1.102, 1.1022],
      [1.1022, 1.1025, 1.102, 1.1022],
    ]);
    const win = evaluate(series, trade(series, { entryBar: 0, target: 1.102 }, acc), acc);
    const loss = evaluate(series, trade(series, { entryBar: 2, stop: 1.102 }, acc), acc);
    const curves = equityCurve([win, loss], 10_000);
    const winMoney = win.netMoney;
    const lossMoney = loss.netMoney;
    expect(curves.maxDrawdown).toBeCloseTo(Math.abs(lossMoney), 6);
    expect(curves.peak).toBeCloseTo(10_000 + winMoney, 6);
    // The curve starts at the seed balance, so the trough includes it.
    expect(curves.trough).toBe(10_000);
    expect(curves.equity[curves.equity.length - 1].value).toBeCloseTo(10_000 + winMoney + lossMoney, 6);
  });

  it('open positions never move the equity curve', () => {
    const acc = account();
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.2, 1.09, 1.19],
    ]);
    const open = evaluate(series, trade(series, {}, acc), acc);
    expect(open.status).toBe('open');
    const curves = equityCurve([open], 10_000);
    expect(curves.equity).toHaveLength(0);
  });
});

describe('sizing, currency and validation', () => {
  it('derives units from risk and the stop distance', () => {
    const acc = account({ sizing: 'risk', riskPerTradePct: 1, startingBalance: 10_000 });
    const s = sizeFor(1.1, 1.099, acc, 10_000);
    // 100 risk / 0.001 per unit = 100 000 units.
    expect(s.size).toBeCloseTo(100_000, 6);
    expect(s.derived).toBe(true);
    expect(s.problem).toBeNull();
  });

  it('falls back to the fixed size when there is no stop, and says so', () => {
    const acc = account({ sizing: 'risk', fixedSize: 5_000 });
    const s = sizeFor(1.1, null, acc, 10_000);
    expect(s.size).toBe(5_000);
    expect(s.derived).toBe(false);
    expect(s.problem).toMatch(/No stop loss/);
  });

  it('flags a currency that would need a rate the app does not have', () => {
    expect(quoteCurrency('EURUSD')).toBe('USD');
    expect(needsConversion('USD', 'USD')).toBe(false);
    expect(needsConversion('USD', 'CHF')).toBe(true);
    expect(needsConversion('JPY', 'USD')).toBe(true);
    expect(needsConversion('', 'USD')).toBe(false);
  });

  it('rejects impossible account settings with readable problems', () => {
    expect(validateAccount(account()).ok).toBe(true);
    const bad = validateAccount(account({ startingBalance: 0, riskPerTradePct: 150, spreadPips: -1, fixedSize: -5 }));
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe('trade records are serialisable', () => {
  it('round-trips through the persisted shape', () => {
    const series = mk(flat(1.1, 3));
    const acc = account({ spreadPips: 1.2 });
    const t = trade(series, { stop: 1.09, target: 1.11, note: 'held over news, "quoted"' }, acc);
    const back = deserializeTrade(JSON.parse(JSON.stringify(serializeTrade(t))));
    expect(back).not.toBeNull();
    expect(back!.id).toBe(t.id);
    expect(back!.costs.spreadPips).toBeCloseTo(1.2, 6);
    expect(back!.stop).toBe(1.09);
    expect(back!.note).toBe('held over news, "quoted"');
    expect(deserializeTrade({ id: 'x' })).toBeNull();
    expect(deserializeTrade({ ...serializeTrade(t), side: 'hold' })).toBeNull();
  });
});

describe('trade export', () => {
  it('writes a header, one row per trade and quotes free text', () => {
    const series = mk([
      [1.1, 1.1005, 1.0995, 1.1],
      [1.1, 1.103, 1.1015, 1.1025],
    ]);
    const acc = account();
    const t = trade(series, { target: 1.102, note: 'a,b "c"' }, acc);
    const csv = tradesToCsv([evaluate(series, t, acc)], 'UTC');
    const lines = csv.trim().split('\r\n');
    expect(lines[0].split(',')).toHaveLength(28);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"a,b ""c"""');
    expect(lines[1]).toContain('take-profit');
    expect(lines[1]).toContain('2024-04-01');
  });

  it('leaves exit columns empty for an open trade', () => {
    const series = mk(flat(1.1, 3));
    const acc = account();
    const csv = tradesToCsv([evaluate(series, trade(series, {}, acc), acc)], 'UTC');
    const cells = csv.trim().split('\r\n')[1].split(',');
    expect(cells[5]).toBe('open');
    expect(cells[8]).toBe(''); // exit time
    expect(cells[9]).toBe(''); // exit price
    expect(cells[10]).toBe(''); // exit reason
  });
});
