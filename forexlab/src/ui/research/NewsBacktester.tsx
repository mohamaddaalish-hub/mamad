/**
 * Automated News Backtester UI: strategy configuration, report, breakdowns
 * (monthly / six-month / yearly), research splits and controlled optimisation.
 * The engine only ever sees the gated, filtered event set and the gated series.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Btn, Check, Chip, Field, NumInput, ProgressBar, Section, Sel, Sparkline, Tabs } from '../kit.tsx';
import { pushDiagnostic, useApp } from '../../core/app/state.ts';
import * as idb from '../../core/store/idb.ts';
import { formatDateTime } from '../../core/time/tz.ts';
import { formatDuration } from '../../core/util/format.ts';
import type { ResearchSnapshot } from '../../core/econ/service.ts';
import { DEFAULT_STRATEGY, describeStrategy, runNewsBacktest, type DirectionRule, type NewsBacktestResult, type NewsStrategy } from '../../core/backtest/news.ts';
import { DEFAULT_SPLIT, splitIssues, yearRange, type SplitConfig, type SplitName, type Stats } from '../../core/backtest/newsStats.ts';
import { buildGrid, optimize, DEFAULT_GRID, type GridAxes, type OptimizeHandle } from '../../core/backtest/optimize.ts';
import { CURRENCIES } from '../../core/econ/types.ts';
import { horizonStats, reactionCurve } from '../../core/econ/study.ts';
import { horizonLabel } from '../../core/econ/types.ts';
import { CurveChart, Histogram, LowSample, VirtualList, Warn, num, pct } from '../news/common.tsx';
import { histogram } from '../../core/econ/study.ts';
import { openEventDetail } from '../../core/econ/markers.ts';
import { cx } from '../../core/util/format.ts';

const TIME_EXITS: (number | null)[] = [1, 5, 15, 30, 60, 240, 1440, null];
const PIP_LEVELS: (number | null)[] = [null, 5, 10, 20, 30, 50, 100];
const CFG_KEY = 'news-backtest-config-v1';

interface Persisted {
  strategy: NewsStrategy;
  split: SplitConfig;
  grid: GridAxes;
}

function yearOf(t: number | null): number {
  return t === null ? 2020 : new Date(t).getUTCFullYear();
}

export function NewsBacktester({ research }: { research: ResearchSnapshot }): React.ReactElement {
  const symbol = useApp((s) => s.symbol);
  const tz = useApp((s) => s.tz);
  const [strategy, setStrategy] = useState<NewsStrategy>({ ...DEFAULT_STRATEGY, direction: { ...DEFAULT_STRATEGY.direction, pair: symbol } });
  const [split, setSplit] = useState<SplitConfig>(DEFAULT_SPLIT);
  const [useSplit, setUseSplit] = useState(true);
  const [grid, setGrid] = useState<GridAxes>(DEFAULT_GRID);
  const [result, setResult] = useState<NewsBacktestResult | null>(null);
  const [tab, setTab] = useState<'report' | 'trades' | 'periods' | 'splits' | 'optimize'>('report');
  const [gridResults, setGridResults] = useState<NewsBacktestResult[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const handle = useRef<OptimizeHandle | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    void idb.get<Persisted>('kv', CFG_KEY).then((p) => {
      if (!p) return;
      if (p.strategy) setStrategy({ ...DEFAULT_STRATEGY, ...p.strategy, direction: { ...DEFAULT_STRATEGY.direction, ...p.strategy.direction, pair: symbol } });
      if (p.split) setSplit(p.split);
      if (p.grid) setGrid({ ...DEFAULT_GRID, ...p.grid });
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const id = setTimeout(() => void idb.put('kv', { strategy, split, grid } satisfies Persisted, CFG_KEY).catch(() => undefined), 400);
    return () => clearTimeout(id);
  }, [strategy, split, grid]);
  useEffect(() => setStrategy((s) => ({ ...s, direction: { ...s.direction, pair: symbol } })), [symbol]);

  const issues = useMemo(() => (useSplit ? splitIssues(split) : []), [split, useSplit]);
  const candidates = research.filtered;
  const series = research.series;

  const run = (): void => {
    if (!series) {
      pushDiagnostic('warn', 'Load a price dataset before running the news backtester');
      return;
    }
    setRunning(true);
    setTimeout(() => {
      try {
        const r = runNewsBacktest(candidates, series, { ...strategy, label: describeStrategy(strategy) }, useSplit ? split : null);
        setResult(r);
        setTab('report');
      } catch (err) {
        pushDiagnostic('error', `Backtest failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRunning(false);
      }
    }, 10);
  };

  const runGrid = (): void => {
    if (!series) return;
    const strategies = buildGrid(strategy, grid);
    if (strategies.length === 0) {
      pushDiagnostic('warn', 'The grid is empty — enable at least one exit');
      return;
    }
    setGridResults(null);
    setProgress({ done: 0, total: strategies.length, label: 'starting' });
    handle.current = optimize(candidates, series, strategies, useSplit ? split : null, (done, total, label) => setProgress({ done, total, label }));
    handle.current.promise
      .then((rs) => setGridResults(rs))
      .catch((err) => pushDiagnostic('error', `Optimisation failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        setProgress(null);
        handle.current = null;
      });
  };
  useEffect(() => () => handle.current?.cancel(), []);

  const set = (patch: Partial<NewsStrategy>) => setStrategy((s) => ({ ...s, ...patch }));
  const dirRules = strategy.direction.rules;
  const rule = (c: string): DirectionRule | undefined => dirRules.find((r) => r.currency === c);

  return (
    <>
      <Section title="Strategy" right={<Chip>{describeStrategy(strategy)}</Chip>}>
        <div className="grid-3">
          <Field label="Entry">
            <Sel
              value={`${strategy.entry.kind}:${strategy.entry.value}`}
              onChange={(v) => {
                const [kind, val] = String(v).split(':');
                set({ entry: { kind: kind as NewsStrategy['entry']['kind'], value: Number(val) } });
              }}
              options={[
                { value: 'release:0', label: 'At release (first bar opening at/after release)' },
                ...[1, 2, 3, 5, 10].map((n) => ({ value: `bars:${n}`, label: `+${n} candle${n === 1 ? '' : 's'}` })),
                ...[1, 5, 15, 30].map((n) => ({ value: `minutes:${n}`, label: `+${n} min` })),
              ]}
            />
          </Field>
          <Field label="Time exit">
            <Sel value={strategy.exit.timeMin === null ? 'none' : strategy.exit.timeMin} onChange={(v) => set({ exit: { ...strategy.exit, timeMin: v === 'none' ? null : Number(v) } })} options={TIME_EXITS.map((m) => ({ value: m === null ? 'none' : m, label: m === null ? 'none (TP/SL only)' : horizonLabel(m).replace('+', '') }))} />
          </Field>
          <Field label="Ambiguous bar policy" hint="TP and SL inside one candle">
            <Sel value={strategy.exit.ambiguity} onChange={(v) => set({ exit: { ...strategy.exit, ambiguity: v } })} options={[{ value: 'worst', label: 'Worst case (SL first)' }, { value: 'best', label: 'Best case (TP first)' }, { value: 'skip', label: 'Skip trade' }]} />
          </Field>
          <Field label="Take profit (pips)">
            <Sel value={strategy.exit.tpPips === null ? 'none' : strategy.exit.tpPips} onChange={(v) => set({ exit: { ...strategy.exit, tpPips: v === 'none' ? null : Number(v) } })} options={PIP_LEVELS.map((p) => ({ value: p === null ? 'none' : p, label: p === null ? 'none' : `${p}` }))} />
          </Field>
          <Field label="Stop loss (pips)">
            <Sel value={strategy.exit.slPips === null ? 'none' : strategy.exit.slPips} onChange={(v) => set({ exit: { ...strategy.exit, slPips: v === 'none' ? null : Number(v) } })} options={PIP_LEVELS.map((p) => ({ value: p === null ? 'none' : p, label: p === null ? 'none' : `${p}` }))} />
          </Field>
          <Field label="Cluster policy">
            <Sel value={strategy.clusterPolicy} onChange={(v) => set({ clusterPolicy: v })} options={[{ value: 'any', label: 'Any' }, { value: 'isolatedOnly', label: 'Isolated only' }, { value: 'noAmbiguous', label: 'Exclude ambiguous attribution' }]} />
          </Field>
          <Field label="Surprise sign">
            <Sel value={strategy.surpriseSign} onChange={(v) => set({ surpriseSign: v })} options={[{ value: 'any', label: 'Any' }, { value: 'positive', label: 'Positive only' }, { value: 'negative', label: 'Negative only' }]} />
          </Field>
          <Field label="Min |standardized surprise| (σ)">
            <div className="row" style={{ gap: 4 }}>
              <Sel value={strategy.minAbsZ === null ? 'none' : strategy.minAbsZ} onChange={(v) => set({ minAbsZ: v === 'none' ? null : Number(v), requireZ: v !== 'none' || strategy.requireZ })} options={[{ value: 'none', label: 'none' }, ...[0.5, 1, 1.5, 2, 3].map((z) => ({ value: z, label: `≥ ${z}σ` }))]} />
            </div>
            <Check checked={strategy.requireZ} onChange={(v) => set({ requireZ: v })} label="Require standardized surprise" />
          </Field>
          <Field label="Min |raw surprise| (indicator units)">
            <NumInput value={strategy.minAbsRaw ?? 0} onChange={(v) => set({ minAbsRaw: v > 0 ? v : null })} step={0.1} min={0} decimals={2} />
          </Field>
          <Field label="Spread (pips)"><NumInput value={strategy.costs.spreadPips} onChange={(v) => set({ costs: { ...strategy.costs, spreadPips: v } })} step={0.1} min={0} decimals={1} /></Field>
          <Field label="Slippage / side (pips)"><NumInput value={strategy.costs.slippagePips} onChange={(v) => set({ costs: { ...strategy.costs, slippagePips: v } })} step={0.1} min={0} decimals={1} /></Field>
          <Field label="Commission / round trip (pips)"><NumInput value={strategy.costs.commissionPips} onChange={(v) => set({ costs: { ...strategy.costs, commissionPips: v } })} step={0.1} min={0} decimals={1} /></Field>
        </div>
        <div className="divider" />
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Field label="Direction mapping" hint={`pair ${symbol}`}>
            <Sel value={strategy.direction.mode} onChange={(v) => set({ direction: { ...strategy.direction, mode: v } })} options={[{ value: 'custom', label: 'Economic default (positive → currency bullish)' }, { value: 'opposite', label: 'Opposite of default' }, { value: 'buy', label: 'Always BUY on positive surprise' }, { value: 'sell', label: 'Always SELL on positive surprise' }]} />
          </Field>
          {strategy.direction.mode === 'custom' ? (
            <div className="row wrap" style={{ gap: 4 }}>
              {CURRENCIES.map((c) => {
                const r = rule(c);
                const base = symbol.slice(0, 3);
                const quote = symbol.slice(3, 6);
                const def = c === base ? 1 : c === quote ? -1 : null;
                const cur = r ? r.onPositive : def;
                return (
                  <Sel
                    key={c}
                    value={cur === null ? 'skip' : cur === 1 ? 'buy' : 'sell'}
                    onChange={(v) => {
                      const next = dirRules.filter((x) => x.currency !== c);
                      if (v !== 'skip') next.push({ currency: c, onPositive: v === 'buy' ? 1 : -1 });
                      set({ direction: { ...strategy.direction, rules: next } });
                    }}
                    options={[{ value: 'buy', label: `${c}+ → BUY ${symbol}` }, { value: 'sell', label: `${c}+ → SELL ${symbol}` }, { value: 'skip', label: `${c}: skip` }]}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="divider" />
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Check checked={useSplit} onChange={setUseSplit} label="Research splits (training / validation / out-of-sample)" />
          {useSplit ? (
            <>
              <YearRange label="Training" from={yearOf(split.trainingFrom)} to={yearOf(split.trainingTo)} onChange={(a, b) => setSplit((s) => ({ ...s, trainingFrom: yearRange(a, b)[0], trainingTo: yearRange(a, b)[1] }))} />
              <YearRange label="Validation" from={yearOf(split.validationFrom)} to={yearOf(split.validationTo)} onChange={(a, b) => setSplit((s) => ({ ...s, validationFrom: yearRange(a, b)[0], validationTo: yearRange(a, b)[1] }))} />
              <YearRange label="Out-of-sample" from={yearOf(split.oosFrom)} to={yearOf(split.oosTo)} onChange={(a, b) => setSplit((s) => ({ ...s, oosFrom: yearRange(a, b)[0], oosTo: yearRange(a, b)[1] }))} />
            </>
          ) : null}
        </div>
        {issues.map((i) => <Warn key={i}>{i}</Warn>)}
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <Btn variant="primary" onClick={run} disabled={running || !series || candidates.length === 0}>Run backtest on {candidates.length} events</Btn>
          <span className="dim small">Uses the current News filter and replay position. {series ? '' : 'No price data loaded.'}</span>
        </div>
      </Section>

      {result ? (
        <>
          <div className="panel-section" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <Tabs value={tab} onChange={setTab} items={[{ id: 'report', label: 'Report' }, { id: 'trades', label: `Trades (${result.trades.length})` }, { id: 'periods', label: 'Periods' }, { id: 'splits', label: 'Splits' }, { id: 'optimize', label: 'Optimize' }]} />
          </div>
          {tab === 'report' ? <Report r={result} candidates={candidates} /> : null}
          {tab === 'trades' ? <Trades r={result} tz={tz} /> : null}
          {tab === 'periods' ? <Periods r={result} /> : null}
          {tab === 'splits' ? <Splits r={result} useSplit={useSplit} issues={issues} /> : null}
          {tab === 'optimize' ? (
            <Optimize grid={grid} setGrid={setGrid} run={runGrid} cancel={() => handle.current?.cancel()} progress={progress} results={gridResults} baseline={result} />
          ) : null}
        </>
      ) : (
        <div className="panel-section">
          <div className="note small dim">Run a backtest to see the report, trades, six-month / yearly breakdowns, research splits and controlled optimisation. Results describe history; they are not forecasts.</div>
        </div>
      )}
    </>
  );
}

function YearRange({ label, from, to, onChange }: { label: string; from: number; to: number; onChange: (a: number, b: number) => void }): React.ReactElement {
  return (
    <Field label={label}>
      <div className="row" style={{ gap: 3 }}>
        <NumInput value={from} onChange={(v) => onChange(v, Math.max(v, to))} min={1990} max={2100} step={1} decimals={0} />
        <span className="dim">–</span>
        <NumInput value={to} onChange={(v) => onChange(Math.min(from, v), v)} min={1990} max={2100} step={1} decimals={0} />
      </div>
    </Field>
  );
}

/* -------------------------------------------------------------------- report */

function StatsGrid({ s, events, skipped }: { s: Stats; events?: number; skipped?: number }): React.ReactElement {
  const items: [string, string, string?][] = [
    ...(events !== undefined ? ([['Total events', String(events)], ['Skipped', String(skipped ?? 0)]] as [string, string][]) : []),
    ['Trades', String(s.trades)],
    ['Wins / losses', `${s.wins} / ${s.losses}`],
    ['Win rate', pct(s.winRate, 1)],
    ['Net pips', num(s.netPips, 1, true), tone(s.netPips)],
    ['Average trade', num(s.avgTrade, 2, true), tone(s.avgTrade)],
    ['Average win', num(s.avgWin, 2, true)],
    ['Average loss', num(s.avgLoss, 2, true)],
    ['Profit factor', num(s.profitFactor, 2)],
    ['Expectancy', num(s.expectancy, 2, true), tone(s.expectancy)],
    ['Max drawdown', `${num(s.maxDrawdown, 1)} pips`],
    ['Max drawdown %', s.maxDrawdownPct === null ? '—' : `${num(s.maxDrawdownPct, 1)}%`],
    ['Average MFE', num(s.avgMfe, 1)],
    ['Average MAE', num(s.avgMae, 1)],
    ['Average holding', s.avgHoldingMin === null ? '—' : formatDuration(s.avgHoldingMin * 60_000)],
    ['Average R', num(s.avgR, 2)],
    ['Max loss streak', String(s.maxLossStreak)],
  ];
  return (
    <div className="stat-grid">
      {items.map(([k, v, t]) => (
        <div key={k} className="stat">
          <div className="stat-k">{k}</div>
          <div className={cx('stat-v num', t)}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function tone(v: number | null | undefined): string | undefined {
  return v === null || v === undefined ? undefined : v > 0 ? 'pos' : v < 0 ? 'neg' : undefined;
}

function Report({ r, candidates }: { r: NewsBacktestResult; candidates: ResearchSnapshot['filtered'] }): React.ReactElement {
  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of r.skipped) {
      const k = s.reason.replace(/\d+(\.\d+)?/g, '#');
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [r]);
  const traded = useMemo(() => {
    const ids = new Set(r.trades.map((t) => t.eventId));
    return candidates.filter((e) => ids.has(e.event.id));
  }, [r, candidates]);
  const curve = reactionCurve(traded);
  const dist = histogram(r.trades.map((t) => t.netPips), 20);
  const s15 = horizonStats(traded, 15);
  return (
    <>
      <Section title={`Backtest report · ${r.strategyLabel}`}>
        <StatsGrid s={r.stats} events={r.totalEvents} skipped={r.skipped.length} />
        {r.ambiguousBars > 0 ? <Warn>{r.ambiguousBars} trade{r.ambiguousBars === 1 ? '' : 's'} had TP and SL inside one candle — resolved by the "{r.trades[0]?.ambiguousBar !== undefined ? 'configured' : ''}" ambiguity policy, never by guessing intrabar order.</Warn> : null}
        <LowSample n={r.trades.length} min={30} />
        <div className="grid-2" style={{ marginTop: 8 }}>
          <div>
            <div className="dim small">Equity (pips)</div>
            <Sparkline points={r.stats.equity} zeroLine height={110} />
          </div>
          <div>
            <div className="dim small">Drawdown (pips)</div>
            <Sparkline points={r.stats.drawdown} color="var(--bear)" height={110} />
          </div>
          <div>
            <div className="dim small">Reaction curve of traded events (raw pair move, n={s15.n})</div>
            <CurveChart labels={curve.horizons.map(horizonLabel)} markerIndex={curve.horizons.indexOf(0)} height={140} series={[{ name: 'Average', values: curve.mean, color: 'var(--accent)' }, { name: 'Median', values: curve.median, color: 'var(--warn)', dashed: true }]} />
          </div>
          <div>
            <div className="dim small">Net pips per trade</div>
            <Histogram edges={dist.edges} counts={dist.counts} height={140} />
          </div>
        </div>
      </Section>
      {reasons.length ? (
        <Section title={`Skipped events · ${r.skipped.length}`}>
          <table className="table compact">
            <tbody>
              {reasons.map(([k, n]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="n num">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------- trades */

const TCOLS: { label: string; w: number; n?: boolean }[] = [
  { label: 'Entry time', w: 118 },
  { label: 'Event', w: 170 },
  { label: 'Side', w: 44 },
  { label: 'Entry', w: 62, n: true },
  { label: 'Exit', w: 62, n: true },
  { label: 'Exit time', w: 118 },
  { label: 'Reason', w: 54 },
  { label: 'Gross', w: 54, n: true },
  { label: 'Net', w: 54, n: true },
  { label: 'Ret %', w: 58, n: true },
  { label: 'R', w: 44, n: true },
  { label: 'MFE', w: 46, n: true },
  { label: 'MAE', w: 46, n: true },
  { label: 'Hold', w: 50, n: true },
  { label: 'z', w: 46, n: true },
  { label: 'Session', w: 90 },
  { label: 'Regime', w: 52 },
  { label: 'Isolation', w: 72 },
];
const TW = TCOLS.reduce((s, c) => s + c.w, 0);

function Trades({ r, tz }: { r: NewsBacktestResult; tz: string }): React.ReactElement {
  return (
    <div className="history-table">
      <VirtualList
        items={r.trades}
        rowHeight={24}
        height={Math.min(520, 26 + r.trades.length * 24 + 8)}
        header={<div className="vrow-inner head" style={{ width: TW }}>{TCOLS.map((c) => <span key={c.label} className={cx('vcell', c.n && 'n')} style={{ width: c.w }}>{c.label}</span>)}</div>}
        render={(t) => {
          let i = 0;
          const w = () => TCOLS[i++].w;
          return (
            <div className="vrow-inner" style={{ width: TW }} onClick={() => openEventDetail(t.eventId)} role="button" tabIndex={0}>
              <span className="vcell mono" style={{ width: w() }}>{formatDateTime(t.entryTime, tz)}</span>
              <span className="vcell ellipsis" style={{ width: w() }} title={t.eventTitle}>{t.currency} {t.eventTitle}</span>
              <span className={cx('vcell', t.side > 0 ? 'pos' : 'neg')} style={{ width: w() }}>{t.side > 0 ? 'BUY' : 'SELL'}</span>
              <span className="vcell n mono" style={{ width: w() }}>{t.entryPrice.toFixed(5)}</span>
              <span className="vcell n mono" style={{ width: w() }}>{t.exitPrice.toFixed(5)}</span>
              <span className="vcell mono" style={{ width: w() }}>{formatDateTime(t.exitTime, tz)}</span>
              <span className="vcell" style={{ width: w() }}>{t.exitReason}{t.ambiguousBar ? ' ⚠' : ''}</span>
              <span className={cx('vcell n mono', tone(t.grossPips))} style={{ width: w() }}>{num(t.grossPips, 1, true)}</span>
              <span className={cx('vcell n mono', tone(t.netPips))} style={{ width: w() }}>{num(t.netPips, 1, true)}</span>
              <span className={cx('vcell n mono', tone(t.returnPct))} style={{ width: w() }}>{num(t.returnPct, 3, true)}</span>
              <span className="vcell n mono" style={{ width: w() }}>{num(t.rMultiple, 2)}</span>
              <span className="vcell n mono" style={{ width: w() }}>{num(t.mfePips, 1)}</span>
              <span className="vcell n mono" style={{ width: w() }}>{num(t.maePips, 1)}</span>
              <span className="vcell n mono" style={{ width: w() }}>{t.holdingMin}m</span>
              <span className="vcell n mono" style={{ width: w() }}>{num(t.z, 2, true)}</span>
              <span className="vcell" style={{ width: w() }}>{t.session}</span>
              <span className="vcell" style={{ width: w() }}>{t.regime ?? '—'}</span>
              <span className="vcell" style={{ width: w() }}>{t.isolation}{t.ambiguousAttribution ? ' ⚠' : ''}</span>
            </div>
          );
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- periods */

function PeriodTable({ rows, title }: { rows: { period: string; stats: Stats; events: number }[]; title: string }): React.ReactElement {
  return (
    <Section title={title}>
      <table className="table compact">
        <thead>
          <tr>
            <th>Period</th>
            <th className="n">Events</th>
            <th className="n">Trades</th>
            <th className="n">Win rate</th>
            <th className="n">Net pips</th>
            <th className="n">PF</th>
            <th className="n">Max DD</th>
            <th className="n">Expectancy</th>
            <th className="n">Avg MFE</th>
            <th className="n">Avg MAE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period}>
              <td>{r.period}</td>
              <td className="n num">{r.events}</td>
              <td className="n num">{r.stats.trades}</td>
              <td className="n num">{pct(r.stats.winRate)}</td>
              <td className={cx('n num', tone(r.stats.netPips))}>{num(r.stats.netPips, 1, true)}</td>
              <td className="n num">{num(r.stats.profitFactor, 2)}</td>
              <td className="n num">{num(r.stats.maxDrawdown, 1)}</td>
              <td className={cx('n num', tone(r.stats.expectancy))}>{num(r.stats.expectancy, 2, true)}</td>
              <td className="n num">{num(r.stats.avgMfe, 1)}</td>
              <td className="n num">{num(r.stats.avgMae, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <div className="note small dim">No periods with data.</div> : null}
    </Section>
  );
}

function Periods({ r }: { r: NewsBacktestResult }): React.ReactElement {
  return (
    <>
      <PeriodTable title="Six-month analysis" rows={r.halves} />
      <PeriodTable title="Yearly analysis" rows={r.yearly} />
      <PeriodTable title="Monthly analysis" rows={r.monthly} />
    </>
  );
}

/* -------------------------------------------------------------------- splits */

function Splits({ r, useSplit, issues }: { r: NewsBacktestResult; useSplit: boolean; issues: string[] }): React.ReactElement {
  if (!useSplit || !r.splits) return <div className="panel-section"><div className="note small dim">Enable research splits in the strategy section and re-run.</div></div>;
  const names: SplitName[] = ['training', 'validation', 'oos', 'unassigned'];
  const label: Record<SplitName, string> = { training: 'Training', validation: 'Validation', oos: 'Out-of-sample', unassigned: 'Unassigned' };
  return (
    <>
      {issues.map((i) => <Warn key={i}>{i}</Warn>)}
      <Section title="Training / Validation / Out-of-sample">
        <div className="note small" style={{ marginBottom: 6 }}>Periods are evaluated separately and never mixed. Configure parameters on training, confirm on validation, and treat out-of-sample as a single, untouched check.</div>
        <table className="table compact">
          <thead>
            <tr>
              <th>Split</th>
              <th className="n">Events</th>
              <th className="n">Trades</th>
              <th className="n">Win rate</th>
              <th className="n">Net pips</th>
              <th className="n">PF</th>
              <th className="n">Max DD</th>
              <th className="n">Expectancy</th>
              <th className="n">Avg MFE</th>
              <th className="n">Avg MAE</th>
            </tr>
          </thead>
          <tbody>
            {names.map((n) => {
              const s = r.splits![n];
              if (n === 'unassigned' && s.events === 0) return null;
              return (
                <tr key={n}>
                  <td>{label[n]}</td>
                  <td className="n num">{s.events}</td>
                  <td className="n num">{s.stats.trades}</td>
                  <td className="n num">{pct(s.stats.winRate)}</td>
                  <td className={cx('n num', tone(s.stats.netPips))}>{num(s.stats.netPips, 1, true)}</td>
                  <td className="n num">{num(s.stats.profitFactor, 2)}</td>
                  <td className="n num">{num(s.stats.maxDrawdown, 1)}</td>
                  <td className={cx('n num', tone(s.stats.expectancy))}>{num(s.stats.expectancy, 2, true)}</td>
                  <td className="n num">{num(s.stats.avgMfe, 1)}</td>
                  <td className="n num">{num(s.stats.avgMae, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="grid-3" style={{ marginTop: 8 }}>
          {(['training', 'validation', 'oos'] as SplitName[]).map((n) => (
            <div key={n}>
              <div className="dim small">{label[n]} equity</div>
              <Sparkline points={r.splits![n].stats.equity} zeroLine height={80} />
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ optimize */

function ListEdit({ label, values, options, onChange, fmt }: { label: string; values: (number | null)[]; options: (number | null)[]; onChange: (v: (number | null)[]) => void; fmt: (v: number | null) => string }): React.ReactElement {
  return (
    <Field label={label}>
      <div className="row wrap" style={{ gap: 3 }}>
        {options.map((o) => {
          const on = values.includes(o);
          return (
            <Btn key={String(o)} size="xs" active={on} onClick={() => onChange(on ? values.filter((v) => v !== o) : [...values, o])}>
              {fmt(o)}
            </Btn>
          );
        })}
      </div>
    </Field>
  );
}

function Optimize({ grid, setGrid, run, cancel, progress, results, baseline }: { grid: GridAxes; setGrid: (g: GridAxes) => void; run: () => void; cancel: () => void; progress: { done: number; total: number; label: string } | null; results: NewsBacktestResult[] | null; baseline: NewsBacktestResult }): React.ReactElement {
  const count = grid.entryMinutes.length * grid.exitMinutes.length * grid.minAbsZ.length * grid.tpPips.length * grid.slPips.length;
  const [sortBy, setSortBy] = useState<'netPips' | 'profitFactor' | 'expectancy' | 'winRate' | 'maxDrawdown'>('netPips');
  const sorted = useMemo(() => (results ? [...results].sort((a, b) => {
    const va = a.stats[sortBy] ?? -Infinity;
    const vb = b.stats[sortBy] ?? -Infinity;
    return sortBy === 'maxDrawdown' ? (va as number) - (vb as number) : (vb as number) - (va as number);
  }) : null), [results, sortBy]);
  return (
    <>
      <Section title="Controlled optimisation">
        <div className="note small" style={{ marginBottom: 6 }}>
          A small, explicit grid of variants of the current strategy is compared side by side (max 96 combinations). Runs in a Web Worker with progress and cancellation. Comparing many variants on the same data inflates the best result — judge on validation / out-of-sample.
        </div>
        <div className="grid-2">
          <ListEdit label="Entry delay" values={grid.entryMinutes} options={[0, 1, 5, 15, 30]} onChange={(v) => setGrid({ ...grid, entryMinutes: v.filter((x): x is number => x !== null).sort((a, b) => a - b) })} fmt={(v) => (v === 0 ? 'release' : `+${v}m`)} />
          <ListEdit label="Time exit" values={grid.exitMinutes} options={[5, 15, 30, 60, 240, 1440, null]} onChange={(v) => setGrid({ ...grid, exitMinutes: v })} fmt={(v) => (v === null ? 'none' : horizonLabel(v).replace('+', ''))} />
          <ListEdit label="Min |z|" values={grid.minAbsZ} options={[null, 0.5, 1, 1.5, 2, 3]} onChange={(v) => setGrid({ ...grid, minAbsZ: v })} fmt={(v) => (v === null ? 'any' : `≥${v}σ`)} />
          <ListEdit label="Take profit" values={grid.tpPips} options={PIP_LEVELS} onChange={(v) => setGrid({ ...grid, tpPips: v })} fmt={(v) => (v === null ? 'none' : `${v}`)} />
          <ListEdit label="Stop loss" values={grid.slPips} options={PIP_LEVELS} onChange={(v) => setGrid({ ...grid, slPips: v })} fmt={(v) => (v === null ? 'none' : `${v}`)} />
        </div>
        <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
          {progress ? (
            <>
              <div style={{ flex: 1 }}><ProgressBar ratio={progress.total ? progress.done / progress.total : 0} label={`${progress.done}/${progress.total} · ${progress.label}`} /></div>
              <Btn onClick={cancel}>Cancel</Btn>
            </>
          ) : (
            <Btn variant="primary" onClick={run} disabled={count === 0 || count > 96}>Run {Math.min(96, count)} variants</Btn>
          )}
          {count > 96 ? <span className="dim small">grid too large — reduce axes</span> : null}
        </div>
      </Section>
      {sorted ? (
        <Section title="Comparison" right={<Sel value={sortBy} onChange={setSortBy} options={[{ value: 'netPips', label: 'Net pips' }, { value: 'profitFactor', label: 'Profit factor' }, { value: 'expectancy', label: 'Expectancy' }, { value: 'winRate', label: 'Win rate' }, { value: 'maxDrawdown', label: 'Drawdown' }]} />}>
          <table className="table compact">
            <thead>
              <tr>
                <th>Variant</th>
                <th className="n">Trades</th>
                <th className="n">Win rate</th>
                <th className="n">Net pips</th>
                <th className="n">PF</th>
                <th className="n">Max DD</th>
                <th className="n">Expectancy</th>
                <th className="n">Avg MFE</th>
                <th className="n">Avg MAE</th>
                {baseline.splits ? <th className="n">Train</th> : null}
                {baseline.splits ? <th className="n">Valid</th> : null}
                {baseline.splits ? <th className="n">OOS</th> : null}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.strategyLabel}>
                  <td>{r.strategyLabel}</td>
                  <td className="n num">{r.stats.trades}</td>
                  <td className="n num">{pct(r.stats.winRate)}</td>
                  <td className={cx('n num', tone(r.stats.netPips))}>{num(r.stats.netPips, 1, true)}</td>
                  <td className="n num">{num(r.stats.profitFactor, 2)}</td>
                  <td className="n num">{num(r.stats.maxDrawdown, 1)}</td>
                  <td className={cx('n num', tone(r.stats.expectancy))}>{num(r.stats.expectancy, 2, true)}</td>
                  <td className="n num">{num(r.stats.avgMfe, 1)}</td>
                  <td className="n num">{num(r.stats.avgMae, 1)}</td>
                  {r.splits ? <td className={cx('n num', tone(r.splits.training.stats.netPips))}>{num(r.splits.training.stats.netPips, 0, true)}</td> : null}
                  {r.splits ? <td className={cx('n num', tone(r.splits.validation.stats.netPips))}>{num(r.splits.validation.stats.netPips, 0, true)}</td> : null}
                  {r.splits ? <td className={cx('n num', tone(r.splits.oos.stats.netPips))}>{num(r.splits.oos.stats.netPips, 0, true)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
    </>
  );
}

