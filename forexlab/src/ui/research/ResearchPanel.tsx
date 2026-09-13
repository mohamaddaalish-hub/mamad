/**
 * Research dashboard: cross-event statistics over the *filtered, gated* event set.
 * Every section shows its sample size. Compact/detailed view toggles the density.
 */

import { useMemo, useState } from 'react';
import { Btn, Chip, Empty, Section, Sel, Tabs } from '../kit.tsx';
import { appStore, useApp } from '../../core/app/state.ts';
import { openDialog } from '../../core/app/dialogs.ts';
import { useResearch, type ResearchSnapshot } from '../../core/econ/service.ts';
import { newsStore, useNews } from '../../core/econ/store.ts';
import {
  LOW_SAMPLE,
  bySession,
  byRegime,
  histogram,
  horizonStats,
  meanImpactDuration,
  quantiles,
  reactionCurve,
  surpriseMatrix,
  type EnrichedEvent,
  type HorizonStat,
} from '../../core/econ/study.ts';
import { POST_HORIZONS_MIN, SESSION_LABEL, SURPRISE_BAND_LABEL, horizonLabel, isOk, type Session, type VolRegime } from '../../core/econ/types.ts';
import { CurveChart, Histogram, LowSample, Warn, num, pct } from '../news/common.tsx';
import { EventHistory } from './EventHistory.tsx';
import { EventComparison } from './EventComparison.tsx';
import { NewsBacktester } from './NewsBacktester.tsx';
import { cx } from '../../core/util/format.ts';

type SectionId = 'overview' | 'reaction' | 'consistency' | 'distribution' | 'matrix' | 'session' | 'volatility' | 'history' | 'compare' | 'backtest';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'reaction', label: 'Reaction' },
  { id: 'consistency', label: 'Consistency' },
  { id: 'distribution', label: 'Distribution' },
  { id: 'matrix', label: 'Matrix' },
  { id: 'session', label: 'Sessions' },
  { id: 'volatility', label: 'Volatility' },
  { id: 'history', label: 'History' },
  { id: 'compare', label: 'Compare' },
  { id: 'backtest', label: 'Backtest' },
];

export function ResearchPanel(): React.ReactElement {
  const research = useResearch();
  const [section, setSection] = useState<SectionId>('overview');
  const [detailed, setDetailed] = useState(true);
  const historyKey = useNews((s) => s.historyKey);
  const replay = useApp((s) => s.replay);
  const events = research.filtered;
  return (
    <div className="research-panel">
      <div className="panel-section" style={{ paddingBottom: 4 }}>
        <div className="row between" style={{ marginBottom: 4 }}>
          <span className="row" style={{ gap: 6 }}>
            <Chip tone="accent">{events.length} events in scope</Chip>
            {replay.active ? <Chip tone="warn">replay-gated</Chip> : null}
            {!research.series ? <Chip tone="warn">no price data</Chip> : null}
          </span>
          <span className="row" style={{ gap: 2 }}>
            <Btn size="xs" active={!detailed} onClick={() => setDetailed(false)}>Compact</Btn>
            <Btn size="xs" active={detailed} onClick={() => setDetailed(true)}>Detailed</Btn>
            <Btn size="xs" onClick={() => appStore.set({ panel: 'news' })}>Filter…</Btn>
          </span>
        </div>
        <div className="scroll-x">
          <Tabs value={section} onChange={setSection} items={SECTIONS} />
        </div>
      </div>
      <div className="panel-body">
        {events.length === 0 && section !== 'backtest' && section !== 'history' ? (
          <Empty>
            No events in scope.
            <div className="note small" style={{ marginTop: 6 }}>Import a news CSV and a matching price dataset, then widen the filter.</div>
            <div style={{ marginTop: 8 }}><Btn size="xs" variant="primary" onClick={() => openDialog('newsImport')}>Import news</Btn></div>
          </Empty>
        ) : null}
        {section === 'overview' && events.length > 0 ? <Overview research={research} detailed={detailed} /> : null}
        {section === 'reaction' && events.length > 0 ? <Reaction events={events} detailed={detailed} /> : null}
        {section === 'consistency' && events.length > 0 ? <Consistency events={events} detailed={detailed} /> : null}
        {section === 'distribution' && events.length > 0 ? <Distribution events={events} /> : null}
        {section === 'matrix' && events.length > 0 ? <Matrix events={events} detailed={detailed} /> : null}
        {section === 'session' && events.length > 0 ? <Sessions events={events} /> : null}
        {section === 'volatility' && events.length > 0 ? <Volatility events={events} /> : null}
        {section === 'history' ? <EventHistory research={research} keyId={historyKey} onPick={(k) => newsStore.set({ historyKey: k })} /> : null}
        {section === 'compare' && events.length > 0 ? <EventComparison research={research} /> : null}
        {section === 'backtest' ? <NewsBacktester research={research} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function Overview({ research, detailed }: { research: ResearchSnapshot; detailed: boolean }): React.ReactElement {
  const events = research.filtered;
  const byType = useMemo(() => {
    const m = new Map<string, EnrichedEvent[]>();
    for (const e of events) {
      const k = `${e.event.currency} ${e.event.type}`;
      let a = m.get(k);
      if (!a) m.set(k, (a = []));
      a.push(e);
    }
    return [...m.entries()]
      .map(([k, list]) => ({ k, list, key: list[0].event.key, s15: horizonStats(list, 15, expectedDir), s60: horizonStats(list, 60, expectedDir) }))
      .sort((a, b) => b.list.length - a.list.length);
  }, [events]);
  const s15 = horizonStats(events, 15);
  const withZ = events.filter((e) => isOk(e.surprise.z)).length;
  const ambiguous = events.filter((e) => e.cluster.ambiguous).length;
  const dur = meanImpactDuration(events);
  return (
    <>
      <Section title="Event overview">
        <div className="stat-grid">
          <Stat k="Events" v={String(events.length)} />
          <Stat k="With standardized surprise" v={`${withZ} (${pct(events.length ? withZ / events.length : null)})`} />
          <Stat k="With +15m reaction" v={String(s15.n)} />
          <Stat k="Mean |15m| move" v={`${num(meanAbs(events, 15))} pips`} />
          <Stat k="Median 15m move" v={`${num(s15.median, 1, true)} pips`} />
          <Stat k="Mean impact duration" v={dur === null ? '—' : `${num(dur, 0)} min`} />
          <Stat k="Ambiguous attribution" v={`${ambiguous} (${pct(events.length ? ambiguous / events.length : null)})`} />
          <Stat k="Indicators" v={String(new Set(events.map((e) => e.event.key)).size)} />
        </div>
        {events.length < LOW_SAMPLE ? <Warn>Fewer than {LOW_SAMPLE} events in scope — statistics are anecdotal.</Warn> : null}
      </Section>
      <Section title="By indicator">
        <table className="table compact">
          <thead>
            <tr>
              <th>Indicator</th>
              <th className="n">n</th>
              <th className="n">mean 15m</th>
              <th className="n">|15m|</th>
              <th className="n">cons. 15m</th>
              {detailed ? <th className="n">mean 1H</th> : null}
              {detailed ? <th className="n">cons. 1H</th> : null}
              <th />
            </tr>
          </thead>
          <tbody>
            {byType.slice(0, detailed ? 80 : 20).map((r) => (
              <tr key={r.k} className="clickable" onClick={() => newsStore.set({ historyKey: r.key })}>
                <td>{r.k}</td>
                <td className="n num">{r.list.length}</td>
                <td className={cx('n num', tone(r.s15.mean))}>{num(r.s15.mean, 1, true)}</td>
                <td className="n num">{num(meanAbs(r.list, 15))}</td>
                <td className="n num">{pct(r.s15.consistency)}{r.s15.lowSample ? ' *' : ''}</td>
                {detailed ? <td className={cx('n num', tone(r.s60.mean))}>{num(r.s60.mean, 1, true)}</td> : null}
                {detailed ? <td className="n num">{pct(r.s60.consistency)}</td> : null}
                <td><Btn size="xs" onClick={(e) => { e.stopPropagation(); newsStore.set({ historyKey: r.key }); }}>history</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="note small dim">* low sample (n &lt; {LOW_SAMPLE}). Consistency = share of releases where the pair moved in the direction implied by the surprise sign (positive surprise → base currency up).</div>
      </Section>
    </>
  );
}

/** Expected pair direction from the surprise sign: base up on positive base-currency surprise. */
export function expectedDir(e: EnrichedEvent): 1 | -1 | 0 {
  if (!isOk(e.surprise.direction) || e.surprise.direction.value === 0) return 0;
  const symbol = appStore.get().symbol.toUpperCase();
  const base = symbol.slice(0, 3);
  const quote = symbol.slice(3, 6);
  const c = e.event.currency.toUpperCase();
  const sign = e.surprise.direction.value;
  if (c === base) return sign;
  if (c === quote) return (-sign) as 1 | -1;
  return 0;
}

function meanAbs(events: readonly EnrichedEvent[], m: number): number | null {
  const v = events.map((e) => e.reaction.post.find((h) => h.minutes === m)?.pips).filter((p): p is { status: 'ok'; value: number } => !!p && isOk(p)).map((p) => Math.abs(p.value));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function tone(v: number | null): string | false {
  return v === null ? false : v > 0 ? 'pos' : v < 0 ? 'neg' : false;
}

function Stat({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className="stat-v num">{v}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ reaction */

function Reaction({ events, detailed }: { events: EnrichedEvent[]; detailed: boolean }): React.ReactElement {
  const [signed, setSigned] = useState(true);
  const oriented = useMemo(() => (signed ? orient(events) : events), [events, signed]);
  const curve = useMemo(() => reactionCurve(oriented), [oriented]);
  const labels = curve.horizons.map(horizonLabel);
  return (
    <Section
      title="Reaction curve"
      right={
        <span className="row" style={{ gap: 2 }}>
          <Btn size="xs" active={signed} onClick={() => setSigned(true)} tip="Flip each event so a positive value = move in the direction implied by the surprise">surprise-aligned</Btn>
          <Btn size="xs" active={!signed} onClick={() => setSigned(false)} tip="Raw pair move">raw</Btn>
        </span>
      }
    >
      <CurveChart
        labels={labels}
        markerIndex={curve.horizons.indexOf(0)}
        series={[
          { name: 'Average', values: curve.mean, color: 'var(--accent)' },
          { name: 'Median', values: curve.median, color: 'var(--warn)', dashed: true },
        ]}
        height={detailed ? 190 : 130}
      />
      <table className="table compact" style={{ marginTop: 6 }}>
        <thead>
          <tr>
            <th>Horizon</th>
            {labels.map((l) => <th key={l} className="n">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr><td>Average</td>{curve.mean.map((v, i) => <td key={i} className={cx('n num', tone(v))}>{num(v, 1, true)}</td>)}</tr>
          <tr><td>Median</td>{curve.median.map((v, i) => <td key={i} className={cx('n num', tone(v))}>{num(v, 1, true)}</td>)}</tr>
          <tr><td>Sample</td>{curve.n.map((v, i) => <td key={i} className="n num dim">{v}</td>)}</tr>
        </tbody>
      </table>
      {signed ? <div className="note small dim">Surprise-aligned: events whose surprise implies a downward pair move are sign-flipped, so the curve reads as "move in the implied direction". Events without a surprise sign are dropped ({events.length - oriented.length}).</div> : null}
    </Section>
  );
}

/** Flip reaction sign so +ve = in the direction implied by the surprise. */
export function orient(events: readonly EnrichedEvent[]): EnrichedEvent[] {
  const out: EnrichedEvent[] = [];
  for (const e of events) {
    const d = expectedDir(e);
    if (d === 0) continue;
    if (d === 1) {
      out.push(e);
      continue;
    }
    const flip = (m: { status: 'ok'; value: number } | { status: 'unavailable'; reason: string }) => (isOk(m) ? { status: 'ok' as const, value: -m.value } : m);
    out.push({
      ...e,
      reaction: {
        ...e.reaction,
        pre: e.reaction.pre.map((h) => ({ ...h, pips: flip(h.pips), pct: flip(h.pct) })),
        post: e.reaction.post.map((h) => ({ ...h, pips: flip(h.pips), pct: flip(h.pct), mfeUp: h.mfeDown, mfeDown: h.mfeUp })),
        curve: e.reaction.curve.map((v) => (v === null ? null : -v)),
        peakMove: flip(e.reaction.peakMove),
        initialMove: flip(e.reaction.initialMove),
      },
    });
  }
  return out;
}

/* --------------------------------------------------------------- consistency */

function Consistency({ events, detailed }: { events: EnrichedEvent[]; detailed: boolean }): React.ReactElement {
  const stats = useMemo(() => POST_HORIZONS_MIN.map((m) => horizonStats(events, m, expectedDir)), [events]);
  const judged = events.filter((e) => expectedDir(e) !== 0).length;
  return (
    <Section title="Directional consistency">
      <div className="note small" style={{ marginBottom: 6 }}>
        Share of releases where {appStore.get().symbol} moved in the direction implied by the surprise sign. {judged} of {events.length} events have a usable sign.
      </div>
      <table className="table compact">
        <thead>
          <tr>
            <th>Horizon</th>
            <th className="n">n</th>
            <th className="n">consistent</th>
            <th className="n">against</th>
            <th className="n">consistency</th>
            {detailed ? <th className="n">mean</th> : null}
            {detailed ? <th className="n">median</th> : null}
            <th />
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => {
            const agree = s.consistency !== null ? Math.round(s.consistency * (s.up + s.down)) : null;
            return (
              <tr key={s.minutes}>
                <td>{horizonLabel(s.minutes)}</td>
                <td className="n num">{s.n}</td>
                <td className="n num">{agree ?? '—'}</td>
                <td className="n num">{agree !== null ? s.up + s.down - agree : '—'}</td>
                <td className="n num"><Bar v={s.consistency} /> {pct(s.consistency)}</td>
                {detailed ? <td className={cx('n num', tone(s.mean))}>{num(s.mean, 1, true)}</td> : null}
                {detailed ? <td className={cx('n num', tone(s.median))}>{num(s.median, 1, true)}</td> : null}
                <td><LowSample n={s.n} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

function Bar({ v }: { v: number | null }): React.ReactElement | null {
  if (v === null) return null;
  return <span className="mini-bar"><span style={{ width: `${Math.round(v * 100)}%` }} /></span>;
}

/* -------------------------------------------------------------- distribution */

function Distribution({ events }: { events: EnrichedEvent[] }): React.ReactElement {
  const [h, setH] = useState<number>(15);
  const [aligned, setAligned] = useState(true);
  const vals = useMemo(() => {
    const src = aligned ? orient(events) : events;
    return src.map((e) => e.reaction.post.find((p) => p.minutes === h)?.pips).filter((p): p is { status: 'ok'; value: number } => !!p && isOk(p)).map((p) => p.value);
  }, [events, h, aligned]);
  const q = quantiles(vals);
  const hist = histogram(vals, Math.min(30, Math.max(8, Math.round(Math.sqrt(vals.length) * 1.5))));
  return (
    <Section
      title="Distribution"
      right={
        <span className="row" style={{ gap: 4 }}>
          <Btn size="xs" active={aligned} onClick={() => setAligned((v) => !v)}>surprise-aligned</Btn>
          <Sel value={h} onChange={(v) => setH(Number(v))} options={POST_HORIZONS_MIN.map((m) => ({ value: m, label: horizonLabel(m) }))} />
        </span>
      }
    >
      <Histogram edges={hist.edges} counts={hist.counts} marks={q ? [{ label: 'P10', value: q.p10 }, { label: 'P50', value: q.median }, { label: 'P90', value: q.p90 }] : []} height={150} />
      {q ? (
        <div className="stat-grid" style={{ marginTop: 6 }}>
          <Stat k="Sample" v={String(q.n)} />
          <Stat k="Mean" v={num(q.mean, 2, true)} />
          <Stat k="Median" v={num(q.median, 2, true)} />
          <Stat k="Std dev" v={num(q.std, 2)} />
          <Stat k="P10" v={num(q.p10, 1, true)} />
          <Stat k="P25" v={num(q.p25, 1, true)} />
          <Stat k="P75" v={num(q.p75, 1, true)} />
          <Stat k="P90" v={num(q.p90, 1, true)} />
        </div>
      ) : (
        <Warn>No reactions are known for this horizon.</Warn>
      )}
      <LowSample n={vals.length} />
    </Section>
  );
}

/* -------------------------------------------------------------------- matrix */

type Metric = 'mean' | 'median' | 'consistency' | 'n';

function Matrix({ events, detailed }: { events: EnrichedEvent[]; detailed: boolean }): React.ReactElement {
  const [metric, setMetric] = useState<Metric>('mean');
  const oriented = useMemo(() => events, [events]);
  const m = useMemo(() => surpriseMatrix(oriented), [oriented]);
  const cell = (s: HorizonStat): string => {
    if (s.n === 0) return '—';
    switch (metric) {
      case 'mean':
        return num(s.mean, 1, true);
      case 'median':
        return num(s.median, 1, true);
      case 'consistency':
        return pct(s.consistency);
      case 'n':
        return String(s.n);
    }
  };
  return (
    <Section
      title="Surprise × reaction matrix"
      right={<Sel value={metric} onChange={setMetric} options={[{ value: 'mean', label: 'Average reaction' }, { value: 'median', label: 'Median reaction' }, { value: 'consistency', label: 'Directional consistency' }, { value: 'n', label: 'Sample size' }]} />}
    >
      <div className="note small" style={{ marginBottom: 6 }}>Raw pair move in pips per surprise band; consistency here = share agreeing with the band's majority direction.</div>
      <table className="table compact matrix">
        <thead>
          <tr>
            <th>Band</th>
            {m.horizons.map((h) => <th key={h} className="n">{horizonLabel(h)}</th>)}
          </tr>
        </thead>
        <tbody>
          {m.bands.map((b, bi) => (
            <tr key={b}>
              <td>{SURPRISE_BAND_LABEL[b]}</td>
              {m.cells[bi].map((s, hi) => (
                <td key={hi} className={cx('n num', metric !== 'n' && metric !== 'consistency' && tone(metric === 'mean' ? s.mean : s.median), s.lowSample && s.n > 0 && 'low')} title={`n=${s.n} · mean ${num(s.mean, 1, true)} · median ${num(s.median, 1, true)} · consistency ${pct(s.consistency)}`}>
                  {cell(s)}
                  {detailed && s.n > 0 && metric !== 'n' ? <span className="dim tiny"> n{s.n}</span> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="note small dim">Faded cells have fewer than {LOW_SAMPLE} observations.</div>
    </Section>
  );
}

/* ------------------------------------------------------------------ sessions */

function Sessions({ events }: { events: EnrichedEvent[] }): React.ReactElement {
  const groups = useMemo(() => bySession(events), [events]);
  const order: Session[] = ['asia', 'london', 'overlap', 'newYork', 'off'];
  return (
    <Section title="Session analysis">
      <BreakdownTable rows={order.filter((s) => groups.has(s)).map((s) => ({ label: SESSION_LABEL[s], list: groups.get(s)! }))} />
    </Section>
  );
}

function Volatility({ events }: { events: EnrichedEvent[] }): React.ReactElement {
  const groups = useMemo(() => byRegime(events), [events]);
  const order: VolRegime[] = ['low', 'normal', 'high'];
  const unknown = events.filter((e) => !isOk(e.context.regime)).length;
  const atr = quantiles(events.map((e) => (isOk(e.context.atrPips) ? e.context.atrPips.value : NaN)));
  return (
    <Section title="Volatility regime analysis">
      <div className="note small" style={{ marginBottom: 6 }}>
        Regime is classified from pre-release ATR only (percentile of the trailing ATR distribution, or fixed pip thresholds — see Settings → Research). Pre-news ATR across scope: median {num(atr?.median)} pips (P10 {num(atr?.p10)} · P90 {num(atr?.p90)}).
        {unknown ? ` ${unknown} events have no regime (insufficient history).` : ''}
      </div>
      <BreakdownTable rows={order.filter((r) => groups.has(r)).map((r) => ({ label: r, list: groups.get(r)! }))} showVol />
    </Section>
  );
}

function BreakdownTable({ rows, showVol }: { rows: { label: string; list: EnrichedEvent[] }[]; showVol?: boolean }): React.ReactElement {
  return (
    <table className="table compact">
      <thead>
        <tr>
          <th>Group</th>
          <th className="n">n</th>
          <th className="n">avg 15m</th>
          <th className="n">median 15m</th>
          <th className="n">cons. 15m</th>
          <th className="n">avg 1H</th>
          <th className="n">MFE</th>
          <th className="n">MAE</th>
          <th className="n">{showVol ? 'vol ×' : 'duration'}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const s15 = horizonStats(orient(r.list), 15);
          const s60 = horizonStats(orient(r.list), 60);
          const dur = meanImpactDuration(r.list);
          return (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className="n num">{r.list.length}</td>
              <td className={cx('n num', tone(s15.mean))}>{num(s15.mean, 1, true)}</td>
              <td className={cx('n num', tone(s15.median))}>{num(s15.median, 1, true)}</td>
              <td className="n num">{pct(s15.consistency)}</td>
              <td className={cx('n num', tone(s60.mean))}>{num(s60.mean, 1, true)}</td>
              <td className="n num">{num(s15.avgMfe)}</td>
              <td className="n num">{num(s15.avgMae)}</td>
              <td className="n num">{showVol ? `${num(s15.avgVolRatio, 2)}×` : dur === null ? '—' : `${num(dur, 0)}m`}</td>
              <td><LowSample n={s15.n} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
