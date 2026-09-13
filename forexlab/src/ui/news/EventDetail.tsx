/**
 * Event Detail: everything known about one release *as of the replay boundary*.
 * Opened from the table, a chart marker, or Event History.
 */

import { Btn, Chip, Modal, Section } from '../kit.tsx';
import { closeDialog, useDialog } from '../../core/app/dialogs.ts';
import { appStore, useApp } from '../../core/app/state.ts';
import { formatDateTime, formatDate } from '../../core/time/tz.ts';
import { goToTimestamp } from '../../core/app/actions.ts';
import { startReplayAtTime } from '../../core/replay/engine.ts';
import { overlayRegistry } from '../../core/app/overlays.ts';
import { useResearch } from '../../core/econ/service.ts';
import { newsStore, visibleEvent } from '../../core/econ/store.ts';
import { impactScore, marketImportance, type EnrichedEvent } from '../../core/econ/study.ts';
import { IMPACT_LABEL, PATTERN_LABEL, REVISION_LABEL, SESSION_LABEL, SIGMA_BUCKET_LABEL, SURPRISE_BAND_LABEL, horizonLabel, isOk, type Maybe } from '../../core/econ/types.ts';
import { ImpactDot, KV, MaybeNum, Pips, Warn, num } from './common.tsx';
import { cx } from '../../core/util/format.ts';

export function EventDetailDialog(): React.ReactElement | null {
  const id = useDialog((s) => (s.open === 'eventDetail' ? (s.payload as string) : null));
  const research = useResearch();
  const tz = useApp((s) => s.tz);
  if (!id) return null;
  const ev = visibleEvent(id, research.knownUntil);
  const close = () => {
    newsStore.set({ detailId: null });
    closeDialog();
    overlayRegistry.scheduleSync();
  };
  if (!ev) {
    return (
      <Modal title="Event not available" onClose={close} narrow>
        <Warn>This event is not part of known history at the current replay position. Advance the replay to its release time to open it.</Warn>
      </Modal>
    );
  }
  const x = research.enrich(ev);
  const history = research.history(ev.key).filter((h) => h.event.time < ev.time);
  const allAvg15 = allIndicatorAverages(research);
  const mi = marketImportance(history, allAvg15);
  const score = impactScore(x, history);
  const replayFrom = (min: number) => {
    const ok = startReplayAtTime(ev.time, -min * 60_000);
    if (ok) {
      close();
      appStore.set({ panel: 'replay', rightOpen: true });
    }
  };
  return (
    <Modal
      title={
        <span className="row" style={{ gap: 8 }}>
          <ImpactDot impact={ev.impact} />
          {ev.currency} {ev.event}
        </span>
      }
      subtitle={`${formatDateTime(ev.time, tz)} ${tz}`}
      onClose={close}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>Historical analysis only — not a trading signal.</span>
          <span style={{ flex: 1 }} />
          <Btn
            onClick={() => newsStore.set((s) => ({ hiddenIds: s.hiddenIds.includes(ev.id) ? s.hiddenIds.filter((h) => h !== ev.id) : [...s.hiddenIds, ev.id] }))}
            tip="Toggle this event's marker on the chart (Objects manager restores hidden markers)"
          >
            {newsStore.get().hiddenIds.includes(ev.id) ? 'Show marker' : 'Hide marker'}
          </Btn>
          <Btn onClick={() => { goToTimestamp(ev.time, 'center'); close(); }}>Open on chart</Btn>
          <Btn onClick={() => replayFrom(30)}>Replay 30 min before</Btn>
          <Btn variant="primary" onClick={() => replayFrom(15)}>Replay 15 min before</Btn>
        </>
      }
    >
      <EventDetailBody x={x} history={history} mi={mi} score={score} tz={tz} />
    </Modal>
  );
}

export function allIndicatorAverages(research: ReturnType<typeof useResearch>): number[] {
  const byKey = new Map<string, number[]>();
  for (const e of research.filtered) {
    const h = e.reaction.post.find((p) => p.minutes === 15);
    if (!h || !isOk(h.pips)) continue;
    let arr = byKey.get(e.event.key);
    if (!arr) byKey.set(e.event.key, (arr = []));
    arr.push(Math.abs(h.pips.value));
  }
  return [...byKey.values()].filter((a) => a.length >= 3).map((a) => a.reduce((s, v) => s + v, 0) / a.length);
}

export function EventDetailBody({ x, history, mi, score, tz }: { x: EnrichedEvent; history: EnrichedEvent[]; mi: ReturnType<typeof marketImportance>; score: ReturnType<typeof impactScore>; tz: string }): React.ReactElement {
  const e = x.event;
  const s = x.surprise;
  const r = x.revision;
  const c = x.context;
  const rx = x.reaction;
  const unit = e.unit ?? '';
  const fmt = (v: number | null) => (v === null ? <span className="dim">—</span> : <span className="num">{v}{unit}</span>);
  return (
    <div className="detail-grid">
      <Section title="Release">
        <KV k="Actual" v={fmt(e.actual)} />
        <KV k="Forecast" v={fmt(e.forecast)} />
        <KV k="Previous (original)" v={fmt(r.originalPrevious ?? e.previous)} />
        <KV k="Revised previous" v={r.revisedPrevious !== null ? fmt(r.revisedPrevious) : <span className="dim">none stated</span>} />
        <KV k="Revision" v={isOk(r.kind) ? <span>{REVISION_LABEL[r.kind.value]} <MaybeNum v={r.amount} decimals={2} signed suffix={unit} /> <span className="chip">{r.source === 'derived' ? 'Derived Revision' : 'Stated Revision'}</span></span> : <span className="dim" title={r.kind.reason}>— {r.kind.reason}</span>} />
        {r.source === 'derived' && r.observableAt ? <div className="note small">Derived from the next release ({formatDate(r.observableAt, tz)}); not knowable before then.</div> : null}
        <div className="divider" />
        <KV k="Raw surprise" v={<MaybeNum v={s.raw} decimals={2} signed suffix={unit} />} hint="Actual − Forecast" />
        <KV k="Direction" v={isOk(s.direction) ? (s.direction.value > 0 ? 'Positive' : s.direction.value < 0 ? 'Negative' : 'In line') : <span className="dim">—</span>} />
        <KV k="Actual vs previous" v={<MaybeNum v={s.vsPrevious} decimals={2} signed suffix={unit} />} />
        <KV k="Standardized surprise" v={<MaybeNum v={s.z} decimals={2} signed suffix="σ" />} hint="z-score against prior forecast errors of this indicator only" />
        <KV k="Surprise band" v={isOk(s.band) ? SURPRISE_BAND_LABEL[s.band.value] : <span className="dim" title={s.band.reason}>Unavailable · {s.band.reason}</span>} />
        <KV k="Sigma bucket" v={isOk(s.sigma) ? SIGMA_BUCKET_LABEL[s.sigma.value] : <span className="dim">—</span>} />
        <KV k="Sample size" v={<span className="num">{s.sample} prior release{s.sample === 1 ? '' : 's'}</span>} />
        {s.errorStd !== null ? <KV k="Prior error μ / σ" v={<span className="num">{num(s.errorMean, 3)} / {num(s.errorStd, 3)}</span>} /> : null}
      </Section>

      <Section title="Importance & context">
        <KV k="Calendar importance" v={e.impact ? IMPACT_LABEL[e.impact] : <span className="dim">unknown</span>} hint="metadata from the calendar file" />
        <KV k="Historical market importance" v={<span>{mi.label} <span className="dim">· mean |15m| {num(mi.avgAbs15m)} pips, n={mi.n}</span></span>} hint="observed from prior reactions of this indicator" />
        <KV k="News impact score" v={isOk(score.score) ? <span className="num">{score.score.value} / 100</span> : <span className="dim">Unavailable · {score.score.reason}</span>} hint="Historical Analytical Score — descriptive, not predictive" />
        <details className="small">
          <summary className="dim">score components</summary>
          {score.components.map((cmp) => (
            <KV key={cmp.name} k={`${cmp.name} (w ${cmp.weight})`} v={<span className="num">{cmp.value === null ? '—' : cmp.value.toFixed(2)} <span className="dim">{cmp.note}</span></span>} />
          ))}
        </details>
        <div className="divider" />
        <KV k="Session" v={SESSION_LABEL[x.session]} />
        <KV k="Pre-news trend" v={<span className={cx(c.trend === 'bullish' && 'pos', c.trend === 'bearish' && 'neg')}>{c.trend}</span>} />
        <KV k="Pre-news ATR" v={<MaybeNum v={c.atrPips} tone={false} suffix=" pips" />} />
        <KV k="Pre-news volatility" v={<MaybeNum v={c.preVolPips} tone={false} decimals={2} suffix=" pips/bar" />} />
        <KV k="Volatility regime" v={isOk(c.regime) ? <span>{c.regime.value}{c.regimePercentile !== null ? <span className="dim"> · p{Math.round(c.regimePercentile * 100)}</span> : null}</span> : <span className="dim" title={c.regime.reason}>—</span>} />
        <KV k="Pre-news change 30m / 1H / 4H" v={<span><Pips v={c.change30m} /> / <Pips v={c.change1h} /> / <Pips v={c.change4h} /></span>} />
        <KV k="Distance to day high / low" v={<span><MaybeNum v={c.distDayHigh} tone={false} /> / <MaybeNum v={c.distDayLow} tone={false} /></span>} />
        <KV k="Distance to prev-day high / low" v={<span><MaybeNum v={c.distPrevDayHigh} tone={false} /> / <MaybeNum v={c.distPrevDayLow} tone={false} /></span>} />
        <div className="divider" />
        <KV k="Event isolation" v={<span>{x.cluster.isolation} <span className="dim">(±{x.cluster.windowMin}m)</span></span>} />
        <KV k="Cluster" v={x.cluster.neighbours.length === 0 ? <span className="dim">none</span> : <span className="num">{x.cluster.neighbours.length} nearby · {x.cluster.simultaneous.length} simultaneous</span>} />
        {x.cluster.ambiguous ? <Warn>Attribution is ambiguous: other high-impact releases occur within ±{x.cluster.windowMin} minutes. The reaction below cannot be attributed to this event alone.</Warn> : null}
      </Section>

      <Section title="Reaction" className="span-2">
        <table className="table compact">
          <thead>
            <tr>
              <th>Horizon</th>
              <th className="n">Δ price</th>
              <th className="n">Pips</th>
              <th className="n">%</th>
              <th className="n">MFE↑</th>
              <th className="n">MAE↓</th>
              <th className="n">Vol ×</th>
            </tr>
          </thead>
          <tbody>
            {rx.pre.map((h) => (
              <tr key={h.minutes} className="dim">
                <td>{horizonLabel(h.minutes)}</td>
                <td className="n"><MaybeNum v={h.price} decimals={rx.decimals} tone={false} /></td>
                <td className="n"><Pips v={negate(h.pips)} /></td>
                <td className="n"><MaybeNum v={negate(h.pct)} decimals={3} signed suffix="%" /></td>
                <td className="n">—</td>
                <td className="n">—</td>
                <td className="n">—</td>
              </tr>
            ))}
            <tr>
              <td><b>0 (release)</b></td>
              <td className="n"><MaybeNum v={rx.refPrice} decimals={rx.decimals} tone={false} /></td>
              <td className="n">0</td>
              <td className="n">0</td>
              <td className="n">—</td>
              <td className="n">—</td>
              <td className="n">—</td>
            </tr>
            {rx.post.map((h) => (
              <tr key={h.minutes}>
                <td>{horizonLabel(h.minutes)}</td>
                <td className="n"><MaybeNum v={h.price} decimals={rx.decimals} tone={false} /></td>
                <td className="n"><Pips v={h.pips} /></td>
                <td className="n"><MaybeNum v={h.pct} decimals={3} signed suffix="%" /></td>
                <td className="n"><MaybeNum v={h.mfeUp} tone={false} /></td>
                <td className="n"><MaybeNum v={h.mfeDown} tone={false} /></td>
                <td className="n"><MaybeNum v={h.volRatio} decimals={2} tone={false} suffix="×" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="kv-row">
          <KV k="Initial move (+1m)" v={<Pips v={rx.initialMove} />} />
          <KV k="Peak move" v={<Pips v={rx.peakMove} />} />
          <KV k="Peak time" v={rx.peakTime ? <span className="num">{formatDateTime(rx.peakTime, tz)}</span> : <span className="dim">—</span>} />
          <KV k="Time to peak" v={rx.timeToPeakMin !== null ? <span className="num">{rx.timeToPeakMin} min</span> : <span className="dim">—</span>} />
          <KV k="Impact duration" v={<MaybeNum v={rx.impactDurationMin} decimals={0} tone={false} suffix=" min" />} />
          <KV k="Return to pre-news" v={<MaybeNum v={rx.returnToPreMin} decimals={0} tone={false} suffix=" min" />} />
          <KV k="Pattern" v={<Chip>{PATTERN_LABEL[rx.pattern]}</Chip>} />
          <KV k="Prior releases known" v={<span className="num">{history.length}</span>} hint="Releases of this indicator before this one, at the current replay position" />
        </div>
        {rx.post.some((h) => h.pips.status === 'unavailable' && /not yet known/.test(h.pips.reason)) ? (
          <Warn>Some horizons lie beyond the current replay position and are withheld until that time is reached.</Warn>
        ) : null}
      </Section>
    </div>
  );
}

function negate(m: Maybe<number>): Maybe<number> {
  return isOk(m) ? { status: 'ok', value: -m.value } : m;
}
