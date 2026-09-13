/** Event History: every known release of one indicator with reactions, sortable. */

import { useMemo, useState } from 'react';
import { Btn, Chip, Empty, Section, Sel } from '../kit.tsx';
import { appStore, useApp } from '../../core/app/state.ts';
import { formatDate } from '../../core/time/tz.ts';
import { goToTimestamp } from '../../core/app/actions.ts';
import { startReplayAtTime } from '../../core/replay/engine.ts';
import { closeDialog } from '../../core/app/dialogs.ts';
import type { ResearchSnapshot } from '../../core/econ/service.ts';
import { newsStore } from '../../core/econ/store.ts';
import { horizonStats, type EnrichedEvent } from '../../core/econ/study.ts';
import { IMPACT_LABEL, PATTERN_LABEL, POST_HORIZONS_MIN, REVISION_LABEL, SESSION_LABEL, horizonLabel, isOk } from '../../core/econ/types.ts';
import { openEventDetail } from '../../core/econ/markers.ts';
import { MaybeNum, Pips, VirtualList, num, pct } from '../news/common.tsx';
import { cx } from '../../core/util/format.ts';

const H = [1, 5, 15, 30, 60, 240, 1440];

export function EventHistory({ research, keyId, onPick }: { research: ResearchSnapshot; keyId: string | null; onPick: (k: string) => void }): React.ReactElement {
  const tz = useApp((s) => s.tz);
  const [sortKey, setSortKey] = useState<'time' | 'z' | 'r15' | 'r60'>('time');
  const [dir, setDir] = useState<1 | -1>(-1);
  const indicators = useMemo(() => {
    const m = new Map<string, { key: string; label: string; n: number }>();
    for (const e of research.visible) {
      const hit = m.get(e.key);
      if (hit) hit.n++;
      else m.set(e.key, { key: e.key, label: `${e.currency} · ${e.event}`, n: 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [research]);
  const list = keyId ? research.history(keyId) : [];
  const rows = useMemo(() => {
    const v = (x: EnrichedEvent): number => {
      if (sortKey === 'time') return x.event.time;
      if (sortKey === 'z') return isOk(x.surprise.z) ? x.surprise.z.value : -Infinity;
      const h = x.reaction.post.find((p) => p.minutes === (sortKey === 'r15' ? 15 : 60))?.pips;
      return h && isOk(h) ? h.value : -Infinity;
    };
    return [...list].sort((a, b) => (v(a) - v(b)) * dir);
  }, [list, sortKey, dir]);
  const stats = useMemo(() => POST_HORIZONS_MIN.map((m) => horizonStats(list, m)), [list]);
  const selected = new Set(newsStore.get().compareIds);
  if (indicators.length === 0) return <Empty>No known events. Import news or advance the replay.</Empty>;
  return (
    <>
      <Section title="Event history">
        <div className="row" style={{ gap: 4 }}>
          <Sel value={keyId ?? ''} onChange={onPick} options={[{ value: '', label: '— choose an indicator —' }, ...indicators.map((i) => ({ value: i.key, label: `${i.label} (${i.n})` }))]} className="grow" />
        </div>
        {keyId && list.length > 0 ? (
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            <Chip>{list.length} releases</Chip>
            <Chip>mean 15m {num(stats[2].mean, 1, true)} · median {num(stats[2].median, 1, true)}</Chip>
            <Chip>consistency 15m {pct(stats[2].consistency)}</Chip>
            <Btn size="xs" onClick={() => { newsStore.set({ compareIds: list.slice(-12).map((x) => x.event.id) }); }} tip="Send the latest 12 releases to Event Comparison">compare latest 12</Btn>
          </div>
        ) : null}
      </Section>
      {keyId && list.length > 0 ? (
        <div className="history-table">
          <VirtualList
            items={rows}
            rowHeight={24}
            height={Math.min(520, 26 + rows.length * 24 + 8)}
            header={
              <div className="vrow-inner head" style={{ width: HIST_W }}>
                {HIST_COLS.map((c) => (
                  <button key={c.key} type="button" className={cx('vcell', c.n && 'n')} style={{ width: c.w }} onClick={() => {
                    if (c.key === 'time' || c.key === 'z' || c.key === 'r15' || c.key === 'r60') {
                      if (sortKey === c.key) setDir((d) => (-d) as 1 | -1);
                      else setSortKey(c.key);
                    }
                  }}>
                    {c.label}{sortKey === c.key ? (dir > 0 ? ' ▲' : ' ▼') : ''}
                  </button>
                ))}
              </div>
            }
            render={(x) => <HistRow x={x} tz={tz} selected={selected.has(x.event.id)} />}
          />
        </div>
      ) : keyId ? (
        <Empty>No known releases for this indicator at the current replay position.</Empty>
      ) : null}
    </>
  );
}

const HIST_COLS: { key: string; label: string; w: number; n?: boolean }[] = [
  { key: 'time', label: 'Date', w: 78 },
  { key: 'actual', label: 'Actual', w: 52, n: true },
  { key: 'forecast', label: 'Fcst', w: 52, n: true },
  { key: 'previous', label: 'Prev', w: 52, n: true },
  { key: 'rev', label: 'Revision', w: 70 },
  { key: 'raw', label: 'Surprise', w: 58, n: true },
  { key: 'z', label: 'z', w: 46, n: true },
  { key: 'impact', label: 'Impact', w: 56 },
  { key: 'session', label: 'Session', w: 90 },
  { key: 'regime', label: 'Regime', w: 52 },
  { key: 'iso', label: 'Isolation', w: 70 },
  ...H.map((h) => ({ key: `r${h}`, label: horizonLabel(h), w: 46, n: true })),
  { key: 'mfe', label: 'MFE', w: 46, n: true },
  { key: 'mae', label: 'MAE', w: 46, n: true },
  { key: 'pattern', label: 'Pattern', w: 96 },
  { key: 'actions', label: '', w: 150 },
];
const HIST_W = HIST_COLS.reduce((s, c) => s + c.w, 0);

function HistRow({ x, tz, selected }: { x: EnrichedEvent; tz: string; selected: boolean }): React.ReactElement {
  const e = x.event;
  const u = e.unit ?? '';
  const h60 = x.reaction.post.find((p) => p.minutes === 60);
  const v = (n: number | null) => (n === null ? <span className="dim">—</span> : `${n}${u}`);
  let i = 0;
  const w = () => HIST_COLS[i++].w;
  return (
    <div className={cx('vrow-inner', selected && 'selected')} style={{ width: HIST_W }} onClick={() => openEventDetail(e.id)} role="button" tabIndex={0}>
      <span className="vcell mono" style={{ width: w() }}>{formatDate(e.time, tz)}</span>
      <span className="vcell n mono" style={{ width: w() }}>{v(e.actual)}</span>
      <span className="vcell n mono" style={{ width: w() }}>{v(e.forecast)}</span>
      <span className="vcell n mono" style={{ width: w() }}>{v(e.previous)}</span>
      <span className="vcell ellipsis" style={{ width: w() }}>{isOk(x.revision.kind) ? REVISION_LABEL[x.revision.kind.value].replace(' Revision', '') : <span className="dim">—</span>}</span>
      <span className="vcell n mono" style={{ width: w() }}><MaybeNum v={x.surprise.raw} decimals={2} signed /></span>
      <span className="vcell n mono" style={{ width: w() }}><MaybeNum v={x.surprise.z} decimals={2} signed /></span>
      <span className="vcell" style={{ width: w() }}>{e.impact ? IMPACT_LABEL[e.impact] : '—'}</span>
      <span className="vcell ellipsis" style={{ width: w() }}>{SESSION_LABEL[x.session]}</span>
      <span className="vcell" style={{ width: w() }}>{isOk(x.context.regime) ? x.context.regime.value : <span className="dim">—</span>}</span>
      <span className="vcell" style={{ width: w() }}>{x.cluster.isolation}</span>
      {H.map((h) => {
        const p = x.reaction.post.find((q) => q.minutes === h)?.pips;
        return <span key={h} className="vcell n" style={{ width: w() }}><Pips v={p} /></span>;
      })}
      <span className="vcell n mono" style={{ width: w() }}><MaybeNum v={h60?.mfeUp} tone={false} /></span>
      <span className="vcell n mono" style={{ width: w() }}><MaybeNum v={h60?.mfeDown} tone={false} /></span>
      <span className="vcell ellipsis" style={{ width: w() }}>{PATTERN_LABEL[x.reaction.pattern]}</span>
      <span className="vcell row" style={{ width: w(), gap: 2 }} onClick={(ev) => ev.stopPropagation()}>
        <Btn size="xs" onClick={() => goToTimestamp(e.time, 'center')} tip="Open on chart">chart</Btn>
        <Btn size="xs" onClick={() => { if (startReplayAtTime(e.time, -30 * 60_000)) { closeDialog(); appStore.set({ panel: 'replay' }); } }} tip="Start replay 30 minutes before this release">replay</Btn>
        <Btn size="xs" active={selected} onClick={() => newsStore.set((s) => ({ compareIds: s.compareIds.includes(e.id) ? s.compareIds.filter((id) => id !== e.id) : [...s.compareIds, e.id].slice(-24) }))} tip="Toggle in Event Comparison">cmp</Btn>
      </span>
    </div>
  );
}
