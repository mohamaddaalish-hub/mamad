/**
 * Manual backtest panel: sessions, the account and cost model, the trade list, and
 * the statistics that fall out of the ledger. Every figure is computed from recorded
 * trades against the revealed candles — an empty ledger shows UNAVAILABLE, never a
 * confident zero.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Btn, Chip, Empty, Field, InlineEdit, NumInput, Section, Sel, Sparkline, Stat, VirtualList } from '../kit.tsx';
import { useApp, pushDiagnostic } from '../../core/app/state.ts';
import { allowedSeries } from '../../core/replay/gate.ts';
import { formatDateTime } from '../../core/time/tz.ts';
import { formatPips } from '../../core/util/pips.ts';
import { formatInt } from '../../core/util/format.ts';
import { AMBIGUITY_POLICIES, describeCosts, needsConversion, quoteCurrency, sizeFor, validateAccount } from '../../core/backtest/account.ts';
import { backtestStore, setAccount, tradeLedger, useBacktest } from '../../core/backtest/store.ts';
import { tradeController, useTradeUi } from '../../core/backtest/controller.ts';
import { useTradeResults } from '../../core/backtest/hooks.ts';
import { computeStats, equityCurve, formatDuration, formatMetric, formatMoney, tradesToCsv } from '../../core/backtest/stats.ts';
import {
  deleteSession,
  duplicateSession,
  exportSessionJson,
  listSessions,
  loadSession,
  newSession,
  renameSession,
  saveSession,
  setSessionNotes,
  type SessionSummary,
} from '../../core/backtest/session.ts';
import { downloadText, readTextFile } from '../util/download.ts';
import type { TradeResult } from '../../core/backtest/trade.ts';

export function BacktestPanel(): React.ReactElement {
  const tz = useApp((s) => s.tz);
  const symbol = useApp((s) => s.symbol);
  const datasetId = useApp((s) => s.datasetId);
  const fixtureMode = useApp((s) => s.fixtureMode);
  const replay = useApp((s) => s.replay);
  const account = useBacktest((s) => s.account);
  const sessionId = useBacktest((s) => s.sessionId);
  const sessionName = useBacktest((s) => s.sessionName);
  const sessionNotes = useBacktest((s) => s.sessionNotes);
  const results = useTradeResults();
  const ui = useTradeUi((s) => s);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refreshSessions = (): void => {
    void listSessions().then(setSessions);
  };
  useEffect(refreshSessions, [sessionId, results.length]);

  const stats = useMemo(() => computeStats(results, account.startingBalance), [results, account.startingBalance]);
  const curves = useMemo(() => equityCurve(results, account.startingBalance), [results]);
  const problems = validateAccount(account);
  const quote = quoteCurrency(symbol);
  const ccyMismatch = needsConversion(quote, account.currency);
  const openList = results.filter((r) => r.status === 'open');
  const pendingList = results.filter((r) => r.status === 'pending');
  const lastKnownBar = allowedSeries()?.count ? (allowedSeries()!.count - 1) : 0;

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = [...results].sort((a, b) => (a.entry?.index ?? 0) - (b.entry?.index ?? 0));
    if (!q) return list;
    return list.filter((r) =>
      [r.trade.side, r.trade.tf, r.status, r.exit?.reason ?? '', r.trade.note, r.ambiguous ? 'ambiguous' : '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [results, filter]);

  const closeAll = (): void => {
    let n = 0;
    for (const r of openList) if (tradeLedger.close(r.id)) n++;
    pushDiagnostic('info', n > 0 ? `${n} open position${n === 1 ? '' : 's'} closed at the newest revealed bar` : 'No open position to close');
  };

  return (
    <div className="panel-body">
      <Section
        title="Session"
        right={
          sessionId ? (
            <Chip tone="accent" title="Trades and drawings are stored under this session">
              saved
            </Chip>
          ) : (
            <Chip tone="warn" title="Work is in memory until you save a session">
              unsaved
            </Chip>
          )
        }
      >
        <div className="row" style={{ gap: 4, marginBottom: 6 }}>
          {sessionId ? (
            <InlineEdit value={sessionName || 'untitled'} onSave={(v) => void renameSession(sessionId, v).then(refreshSessions)} />
          ) : (
            <input
              className="input"
              placeholder="new session name"
              value={sessionName}
              onChange={(e) => backtestStore.set({ sessionName: e.target.value })}
            />
          )}
          <Btn
            size="xs"
            icon="save"
            tip="Save the dataset, timeframe, replay position, drawings, trades, account and chart settings"
            onClick={() => void saveSession().then(refreshSessions)}
          >
            Save
          </Btn>
          <Btn
            size="xs"
            icon="plus"
            tip="Start an empty session; the current trades stay where they are"
            onClick={() => {
              const name = (sessionName || `${symbol} session`).trim();
              void newSession(name).then(() => refreshSessions());
            }}
          >
            New
          </Btn>
        </div>
        {sessions.length === 0 ? (
          <div className="dim small">No saved sessions yet.</div>
        ) : (
          <div className="list">
            {sessions.map((s) => (
              <div key={s.id} className={`list-row${s.id === sessionId ? ' selected' : ''}`}>
                <div className="cell">
                  <div className="title">
                    {s.name}
                    {s.hasReplay ? <span className="dim"> · replay</span> : null}
                  </div>
                  <div className="sub">
                    {s.symbol} {s.tf} · {formatInt(s.closedTrades)} closed · {formatInt(s.drawings)} drawings ·{' '}
                    {s.netMoney === null ? 'no result yet' : formatMoney(s.netMoney)}
                  </div>
                </div>
                <div className="row-actions">
                  <Btn size="xs" tip="Load this session" onClick={() => void loadSession(s.id).then(refreshSessions)}>
                    Load
                  </Btn>
                  <Btn
                    size="xs"
                    icon="duplicate"
                    tip="Duplicate"
                    onClick={() => void duplicateSession(s.id, `${s.name} copy`).then(refreshSessions)}
                  />
                  <Btn
                    size="xs"
                    icon="save"
                    tip="Export the session as JSON (trades, drawings, settings)"
                    onClick={() => {
                      void exportSessionJson(s.id).then((text) => {
                        if (!text) {
                          pushDiagnostic('error', 'Session could not be exported');
                          return;
                        }
                        downloadText(`forexlab-session-${s.name.replace(/[^\w.-]+/g, '_')}.json`, text, 'application/json');
                      });
                    }}
                  />
                  <Btn
                    size="xs"
                    icon="trash"
                    tip="Delete this session from local storage"
                    onClick={() => {
                      if (!window.confirm(`Delete session "${s.name}"? Its trades and drawings go with it.`)) return;
                      void deleteSession(s.id).then(refreshSessions);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <textarea
          className="input"
          rows={2}
          placeholder="Session notes: the hypothesis, the rules you traded by, what to check next"
          value={sessionNotes}
          onChange={(e) => backtestStore.set({ sessionNotes: e.target.value })}
          onBlur={() => {
            if (sessionId) void setSessionNotes(sessionId, sessionNotes).then(refreshSessions);
          }}
          disabled={!sessionId}
          style={{ marginTop: 6, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <div className="row" style={{ gap: 4, marginTop: 6 }}>
          <Btn size="xs" tip="Import a session JSON file" onClick={() => fileRef.current?.click()}>
            Import session
          </Btn>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void readTextFile(f).then(async (text) => {
                if (text === null) {
                  pushDiagnostic('error', 'That file was empty or unreadable');
                  return;
                }
                const { importSessionJson } = await import('../../core/backtest/session.ts');
                const id = await importSessionJson(text);
                if (id) {
                  refreshSessions();
                  void loadSession(id);
                }
              });
              e.target.value = '';
            }}
          />
        </div>
      </Section>

      <Section title="Account and costs">
        <div className="grid2">
          <Field label="Balance">
            <NumInput value={account.startingBalance} onChange={(v) => setAccount({ startingBalance: v })} min={0} step={100} />
          </Field>
          <Field label="Currency">
            <input className="input mono" value={account.currency} onChange={(e) => setAccount({ currency: e.target.value.toUpperCase().slice(0, 4) })} />
          </Field>
          <Field label="Sizing">
            <Sel
              value={account.sizing}
              onChange={(v) => setAccount({ sizing: v as 'fixed' | 'risk' })}
              options={[
                { value: 'risk', label: 'From risk %', title: 'Units derived from the stop distance and the current equity' },
                { value: 'fixed', label: 'Fixed size', title: 'Every trade uses the fixed size below' },
              ]}
              ariaLabel="Position sizing"
            />
          </Field>
          <Field label="Risk / trade">
            <NumInput value={account.riskPerTradePct} onChange={(v) => setAccount({ riskPerTradePct: v })} min={0} max={100} step={0.25} suffix="%" />
          </Field>
          <Field label="Fixed size">
            <NumInput value={account.fixedSize} onChange={(v) => setAccount({ fixedSize: v })} min={0} step={1000} />
          </Field>
          <Field label="Quote decimals">
            <NumInput value={account.decimals} onChange={(v) => setAccount({ decimals: Math.max(0, Math.min(8, Math.round(v))) })} min={0} max={8} step={1} />
          </Field>
          <Field label="Spread">
            <NumInput value={account.spreadPips} onChange={(v) => setAccount({ spreadPips: Math.max(0, v) })} min={0} step={0.1} suffix="pips" />
          </Field>
          <Field label="Slippage / side">
            <NumInput value={account.slippagePips} onChange={(v) => setAccount({ slippagePips: Math.max(0, v) })} min={0} step={0.1} suffix="pips" />
          </Field>
          <Field label="Commission / side">
            <NumInput value={account.commissionPerSide} onChange={(v) => setAccount({ commissionPerSide: Math.max(0, v) })} min={0} step={1} />
          </Field>
          <Field label="Pip size">
            <span className="mono small">{(account.decimals >= 5 ? 0.0001 : account.decimals === 4 ? 0.001 : account.decimals === 3 ? 0.01 : account.decimals === 2 ? 0.01 : 0.1).toFixed(6)}</span>
          </Field>
        </div>
        <div className="dim small" style={{ marginTop: 6 }}>{describeCosts(account)}</div>
        {ccyMismatch ? (
          <div className="note small warn-text" style={{ marginTop: 4 }}>
            P&amp;L is computed in {quote || 'the quote currency'} — converting to {account.currency} would need an FX rate this app does not have, so the
            figures stay in {quote || 'quote'} units.
          </div>
        ) : null}
        {problems.problems.map((p) => (
          <div key={p} className="note small warn-text">
            {p}
          </div>
        ))}
      </Section>

      <Section title="Ambiguous bar policy" right={<Chip tone={account.ambiguityPolicy === 'favorable' ? 'warn' : 'accent'}>{account.ambiguityPolicy}</Chip>}>
        <Sel
          value={account.ambiguityPolicy}
          onChange={(v) => setAccount({ ambiguityPolicy: v as (typeof AMBIGUITY_POLICIES)[number]['value'] })}
          options={AMBIGUITY_POLICIES.map((p) => ({ value: p.value, label: p.label, title: p.detail }))}
          ariaLabel="Ambiguous bar policy"
        />
        <div className="dim small" style={{ marginTop: 4 }}>
          {AMBIGUITY_POLICIES.find((p) => p.value === account.ambiguityPolicy)?.detail}{' '}
          {stats.ambiguousCount > 0 ? (
            <span>
              {formatInt(stats.ambiguousCount)} of {formatInt(stats.closedCount)} closed trades{ `were resolved by the ${account.ambiguityPolicy} policy`}
            </span>
          ) : (
            'No closed trade has needed this decision yet.'
          )}
        </div>
      </Section>

      <Section title="Entry" right={<span className="dim small">bar {formatInt(lastKnownBar + 1)}</span>}>
        <EntryRow account={account} lastKnownBar={lastKnownBar} />
      </Section>

      {openList.length + pendingList.length > 0 ? (
        <Section title="Open and pending" right={<Btn size="xs" onClick={closeAll} disabled={openList.length === 0}>Close all</Btn>}>
          <div className="list">
            {[...openList, ...pendingList].map((r) => (
              <ResultRow key={r.id} r={r} tz={tz} account={account} selected={ui.selectedId === r.id} onSelect={() => tradeController.select(ui.selectedId === r.id ? null : r.id)} />
            ))}
          </div>
        </Section>
      ) : null}

      {ui.selectedId ? <TradeDetail r={rows.find((x) => x.id === ui.selectedId)} tz={tz} account={account} /> : null}

      <Section title="Statistics" right={<Chip title="Computed from the ledger against the revealed candles only">{formatInt(stats.closedCount)} closed</Chip>}>
        <div className="stat-grid">
          <Stat label="Net P&L" value={formatMoney(stats.netPnl, account.currency)} tone={signTone(stats.netPnl)} hint="All closed trades, after spread, slippage and commission" />
          <Stat label="Gross P&L" value={formatMoney(stats.grossPnl, account.currency)} hint="Before costs" />
          <Stat label="Costs paid" value={formatMoney(stats.costTotal === null ? null : -Math.abs(stats.costTotal), account.currency)} tone="dim" hint="Spread and commission charged" />
          <Stat label="Net pips" value={stats.netPips === null ? 'UNAVAILABLE' : formatPips(stats.netPips, 1)} />
          <Stat label="Return" value={formatMetric(stats.totalReturnPct, '%', 2)} hint="Net P&L over the starting balance" />
          <Stat label="Win rate" value={formatMetric(stats.winRate, '%', 1)} hint={`${stats.winCount} wins / ${stats.lossCount} losses / ${stats.breakevenCount} flat`} />
          <Stat label="Profit factor" value={formatMetric(stats.profitFactor, '', 2)} hint="Gross profit over gross loss" />
          <Stat label="Expectancy" value={formatMoney(stats.expectancy, account.currency)} hint="Average net result per closed trade" />
          <Stat label="Average win" value={formatMoney(stats.avgWin, account.currency)} tone="pos" />
          <Stat label="Average loss" value={formatMoney(stats.avgLoss, account.currency)} tone="neg" />
          <Stat label="Best trade" value={formatMoney(stats.bestTrade, account.currency)} tone="pos" />
          <Stat label="Worst trade" value={formatMoney(stats.worstTrade, account.currency)} tone="neg" />
          <Stat label="Average R" value={formatMetric(stats.avgR, 'R', 2)} hint="Only trades recorded with a stop loss" />
          <Stat label="Total R" value={formatMetric(stats.totalR, 'R', 2)} />
          <Stat label="Average duration" value={formatDuration(stats.avgDurationMs)} />
          <Stat label="Max win streak" value={formatInt(stats.maxConsecWins)} />
          <Stat label="Max loss streak" value={formatInt(stats.maxConsecLosses)} />
          <Stat label="Average MFE" value={stats.avgMfePips === null ? 'UNAVAILABLE' : formatPips(stats.avgMfePips, 1)} hint="Best favourable excursion per trade, from candles after the entry bar" />
          <Stat label="Average MAE" value={stats.avgMaePips === null ? 'UNAVAILABLE' : formatPips(stats.avgMaePips, 1)} hint="Worst adverse excursion per trade" />
          <Stat label="Max drawdown" value={curves.equity.length > 1 ? formatMoney(-curves.maxDrawdown, account.currency) : 'UNAVAILABLE'} tone="neg" />
          <Stat label="Max drawdown %" value={curves.equity.length > 1 ? formatMetric(curves.maxDrawdownPct, '%', 2) : 'UNAVAILABLE'} />
          <Stat label="Equity (closed)" value={formatMoney(stats.finalEquity, account.currency)} hint="Starting balance plus every closed result" />
          <Stat label="Open positions" value={formatInt(stats.openCount)} />
          <Stat label="Unfilled orders" value={formatInt(stats.pendingCount)} tone="dim" />
          <Stat label="Ambiguous bars" value={formatInt(stats.ambiguousCount)} tone={stats.ambiguousCount ? 'neg' : 'dim'} hint="Closed by the policy above, because the intra-bar order is unknowable" />
        </div>
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <div style={{ flex: '1 1 0', minWidth: 0 }}>
            <div className="dim small" style={{ marginBottom: 2 }}>Equity (closed trades)</div>
            {curves.equity.length > 1 ? (
              <Sparkline points={curves.equity.map((p) => p.value)} color="var(--accent)" height={62} />
            ) : (
              <div className="dim small">Needs at least two closed trades.</div>
            )}
          </div>
          <div style={{ flex: '1 1 0', minWidth: 0 }}>
            <div className="dim small" style={{ marginBottom: 2 }}>Drawdown</div>
            {curves.drawdown.length > 1 ? (
              <Sparkline points={curves.drawdown.map((p) => p.value)} color="var(--danger)" height={62} />
            ) : (
              <div className="dim small">No drawdown yet.</div>
            )}
          </div>
        </div>
      </Section>

      <Section
        title={`Trades · ${rows.length}`}
        right={
          <div className="row" style={{ gap: 2 }}>
            <Btn
              size="xs"
              tip="Export every recorded trade with its measured result as CSV"
              onClick={() => {
                if (results.length === 0) {
                  pushDiagnostic('warn', 'Nothing to export yet');
                  return;
                }
                downloadText(`forexlab-trades-${symbol || 'chart'}-${datasetId ? datasetId.slice(-6) : 'local'}.csv`, tradesToCsv(results, tz), 'text/csv');
              }}
              disabled={results.length === 0}
            />
            <Btn size="xs" icon="eyeOff" tip="Hide every trade on the chart" onClick={() => tradeController.setHidden(results.map((r) => r.id))} disabled={results.length === 0} />
            <Btn
              size="xs"
              icon="trash"
              tip="Delete all trades in this session"
              onClick={() => {
                if (!window.confirm('Delete every trade in this session? This cannot be undone once saved.')) return;
                tradeLedger.clear();
                refreshSessions();
              }}
              disabled={results.length === 0}
            />
          </div>
        }
      >
        <div className="row" style={{ gap: 4, marginBottom: 6 }}>
          <input className="input" placeholder="Filter side, status, reason, note" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Btn size="xs" tip="Show all trades on the chart" onClick={() => tradeController.setHidden([])}>
            Show all
          </Btn>
        </div>
        {rows.length === 0 ? (
          <Empty>
            No trades recorded.
            <br />
            Arm Buy or Sell on the chart, click the bar you would have entered on, and press C (or Close) when you would have been out.
            {replay.active ? '' : ' Recording works without replay too — it simply uses the newest bar.'}
          </Empty>
        ) : (
          <VirtualList
            items={rows}
            rowHeight={74}
            maxHeight={420}
            render={(r) => (
              <ResultRow
                key={r.id}
                r={r}
                tz={tz}
                account={account}
                selected={ui.selectedId === r.id}
                hidden={ui.hiddenIds.includes(r.id)}
                onSelect={() => tradeController.select(ui.selectedId === r.id ? null : r.id)}
                onToggleHide={() => tradeController.toggleHidden(r.id)}
                onDelete={() => {
                  tradeLedger.remove(r.id);
                  refreshSessions();
                }}
                onReopen={() => tradeLedger.reopen(r.id)}
              />
            )}
          />
        )}
        <div className="dim small" style={{ marginTop: 6 }}>
          Undo / redo (Ctrl or ⌘ + Z) covers trades as well as drawings.{' '}
          {fixtureMode ? 'The open dataset is synthetic — results here verify the mechanics only.' : ''}
        </div>
      </Section>
    </div>
  );
}

function EntryRow({ account, lastKnownBar }: { account: ReturnType<typeof backtestStore.get>['account']; lastKnownBar: number }): React.ReactElement {
  const [stopPips, setStopPips] = useState(15);
  const [rewardRatio, setRewardRatio] = useState(2);
  const [note, setNote] = useState('');
  const series = allowedSeries();
  const price = series && series.count > 0 ? (series.candle(lastKnownBar)?.c ?? NaN) : NaN;
  const decimals = account.decimals;
  const pipSize = decimals >= 5 ? 0.0001 : decimals === 4 ? 0.001 : decimals === 3 ? 0.01 : decimals === 2 ? 0.01 : 0.1;
  const stop = Number.isFinite(price) ? price - stopPips * pipSize : null;
  const target = Number.isFinite(price) ? price + stopPips * pipSize * rewardRatio : null;
  const equity = tradeLedger.equityNow();
  const sizing = sizeFor(price, stop, account, equity);
  const place = (side: 'buy' | 'sell'): void => {
    if (!Number.isFinite(price)) {
      pushDiagnostic('error', 'No revealed bar to enter on');
      return;
    }
    const trade = tradeLedger.open({ side, bar: lastKnownBar, price, entryKind: 'market', stop, target, size: sizing.size, note });
    if (trade) {
      setNote('');
      pushDiagnostic('info', `${side.toUpperCase()} recorded at bar ${lastKnownBar + 1} (panel entry)`);
    }
  };
  return (
    <div>
      <div className="grid-2" style={{ marginBottom: 6 }}>
        <Field label="Stop (pips)">
          <NumInput value={stopPips} onChange={(v) => setStopPips(Math.max(0.5, v))} min={0.5} step={1} />
        </Field>
        <Field label="Reward : risk">
          <NumInput value={rewardRatio} onChange={(v) => setRewardRatio(Math.max(0.1, v))} min={0.1} step={0.1} />
        </Field>
      </div>
      <div className="dim small mono" style={{ marginBottom: 6 }}>
        {Number.isFinite(price)
          ? `entry ${price.toFixed(decimals)} · SL ${stop?.toFixed(decimals)} · TP ${target?.toFixed(decimals)} · ${formatInt(Math.round(sizing.size))} units${
              sizing.derived ? ` (risk ${account.riskPerTradePct}%)` : ' (fixed size)'
            }`
          : 'no revealed bar'}
      </div>
      <input className="input" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginBottom: 6 }} />
      <div className="row" style={{ gap: 4 }}>
        <Btn size="sm" variant="primary" onClick={() => place('buy')} disabled={!Number.isFinite(price)}>
          Record BUY at newest bar
        </Btn>
        <Btn size="sm" onClick={() => place('sell')} disabled={!Number.isFinite(price)}>
          Record SELL
        </Btn>
      </div>
      <div className="dim small" style={{ marginTop: 4 }}>
        Panel entries always use the newest revealed bar's close. To choose the bar, use Buy / Sell on the chart and click it.
      </div>
      {sizing.problem ? <div className="note small" style={{ color: 'var(--warn)' }}>{sizing.problem}</div> : null}
    </div>
  );
}

function ResultRow({
  r,
  tz,
  account,
  selected,
  hidden,
  onSelect,
  onToggleHide,
  onDelete,
  onReopen,
}: {
  r: TradeResult;
  tz: string;
  account: { decimals: number; currency: string };
  selected: boolean;
  hidden?: boolean;
  onSelect: () => void;
  onToggleHide?: () => void;
  onDelete?: () => void;
  onReopen?: () => void;
}): React.ReactElement {
  const money = r.status === 'closed' ? r.netMoney : r.unrealizedMoney;
  const pips = r.status === 'closed' ? r.netPips : r.unrealizedPips;
  return (
    <div className={`list-row${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="cell">
        <div className="title">
          <span className={r.trade.side === 'buy' ? 'pos' : 'neg'} style={{ fontWeight: 700 }}>
            {r.trade.side.toUpperCase()}
          </span>{' '}
          {r.status === 'closed' ? (money >= 0 ? '+' : '−') : ''}
          {Number.isFinite(money) ? `${Math.abs(money).toFixed(2)} ${r.moneyCcy || account.currency}` : 'UNAVAILABLE'}
          {r.status === 'open' ? <span className="dim"> floating</span> : null}
          {r.status === 'pending' ? <Chip tone="warn">limit unfilled</Chip> : null}
          {r.ambiguous ? <Chip tone="warn">{r.ambiguityPolicy}</Chip> : null}
        </div>
        <div className="sub mono">
          {r.entry ? `${formatDateTime(r.entry.time, tz)} @ ${r.entry.price.toFixed(account.decimals)}` : 'no fill'}
          {r.exit ? ` → ${formatDateTime(r.exit.time, tz)} @ ${r.exit.price.toFixed(account.decimals)} (${r.exit.reason})` : r.status === 'open' ? ' → open' : ''}
          {Number.isFinite(pips) && r.status !== 'pending' ? ` · ${formatPips(pips, 1)} pips` : ''}
          {r.rMultiple !== null ? ` · ${r.rMultiple.toFixed(2)}R` : ''}
          {r.barsHeld !== null ? ` · ${r.barsHeld} bars` : ''}
          {r.mfePips !== null ? ` · MFE ${formatPips(r.mfePips, 1)}` : ''}
          {r.maePips !== null ? ` · MAE ${formatPips(r.maePips, 1)}` : ''}
          {r.durationMs !== null ? ` · ${formatDuration(r.durationMs)}` : ''}
        </div>
        {r.unavailableReason ? <div className="sub" style={{ color: 'var(--warn)' }}>{r.unavailableReason}</div> : null}
        {r.trade.note ? <div className="sub dim">{r.trade.note}</div> : null}
      </div>
      <div className="row-actions">
        {onToggleHide ? (
          <Btn size="xs" icon={hidden ? 'eyeOff' : 'eye'} tip={hidden ? 'Show on chart' : 'Hide from chart'} onClick={(e) => { e.stopPropagation(); onToggleHide(); }} />
        ) : null}
        {r.status === 'open' ? (
          <Btn size="xs" tip="Close at the newest revealed bar" onClick={(e) => { e.stopPropagation(); tradeLedger.close(r.id); }}>
            Close
          </Btn>
        ) : null}
        {r.status === 'closed' && onReopen ? (
          <Btn size="xs" tip="Reopen this trade (removes the manual exit)" onClick={(e) => { e.stopPropagation(); onReopen(); }}>
            Reopen
          </Btn>
        ) : null}
        {onDelete ? <Btn size="xs" icon="trash" tip="Delete this trade" onClick={(e) => { e.stopPropagation(); onDelete(); }} /> : null}
      </div>
    </div>
  );
}

function TradeDetail({
  r,
  tz,
  account,
}: {
  r: TradeResult | undefined;
  tz: string;
  account: { decimals: number; currency: string };
}): React.ReactElement | null {
  if (!r) return null;
  const t = r.trade;
  const d = (v: number | null): string => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(account.decimals));
  const rows: Array<[string, string]> = [
    ['Recorded at', t.createdWallClock > 0 ? formatDateTime(t.createdWallClock, tz) : '\—'],
    ['Instrument', `${t.symbol} \· ${t.tf} \· ${t.entryKind === 'limit' ? 'limit' : 'market'} entry`],
    ['Entry bar', r.entry ? `#${r.entry.index + 1} \· ${formatDateTime(r.entry.time, tz)}` : 'not filled'],
    ['Entry price', r.entry ? d(r.entry.price) : d(t.entryPrice)],
    ['Exit bar', r.exit ? `#${r.exit.index + 1} \· ${formatDateTime(r.exit.time, tz)}` : 'still open'],
    ['Exit price', r.exit ? d(r.exit.price) : r.markedAt ? `mark ${d(r.markedAt.price)}` : '\—'],
    ['Exit reason', r.exit ? r.exit.reason.replace('-', ' ') : r.status === 'pending' ? 'order never reached' : '\—'],
    ['Stop / target', `${d(t.stop)} / ${d(t.target)}`],
    ['Size', `${t.size.toLocaleString('en-US', { maximumFractionDigits: 0 })} units`],
    ['Gross / net pips', `${formatPips(r.grossPips, 1)} / ${formatPips(r.netPips, 1)}`],
    ['Gross / net money', `${formatMoney(r.grossMoney, r.moneyCcy)} / ${formatMoney(r.netMoney, r.moneyCcy)}`],
    ['Costs charged', formatMoney(r.costMoney, r.moneyCcy)],
    ['R multiple', r.rMultiple === null ? 'needs a stop loss' : `${r.rMultiple.toFixed(2)}R`],
    ['Duration', r.durationMs === null ? 'still open' : formatDuration(r.durationMs)],
    ['Bars held', r.barsHeld === null ? '\—' : `${r.barsHeld}`],
    ['MFE / MAE', `${r.mfePips === null ? 'UNAVAILABLE' : formatPips(r.mfePips, 1)} / ${r.maePips === null ? 'UNAVAILABLE' : formatPips(r.maePips, 1)}`],
    ['Ambiguity', r.ambiguous ? `one bar covered both levels \— ${r.ambiguityPolicy} policy applied` : 'never ambiguous'],
    ['Intrabar path', r.intrabar ? 'fill price known, timing inside the bar is not' : 'resolved on bar boundaries'],
    ['Level warnings', r.levelProblem ?? 'none'],
    ['Data limits', r.unavailableReason ?? 'measured on every revealed bar up to the exit'],
  ];
  return (
    <Section title="Trade detail" right={<Chip tone={r.status === 'closed' ? 'accent' : 'warn'}>{r.status}</Chip>}>
      <div className="detail-grid">
        {rows.map(([k, v]) => (
          <div key={k} className="row between" style={{ gap: 8 }}>
            <span className="dim" style={{ fontSize: 11 }}>
              {k}
            </span>
            <span className="mono" style={{ fontSize: 11, textAlign: 'right' }}>
              {v}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function signTone(v: number | null): 'pos' | 'neg' | 'dim' {
  if (v === null || !Number.isFinite(v)) return 'dim';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim';
}

