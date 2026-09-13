/**
 * News Explorer panel: library of imported batches, filter access, and the
 * virtualized event table. Rows open Event Detail; the "history" action focuses
 * an indicator in the Research tab.
 */

import { useMemo, useState } from 'react';
import { Btn, Chip, Empty, Section } from '../kit.tsx';
import { openDialog } from '../../core/app/dialogs.ts';
import { appStore, useApp } from '../../core/app/state.ts';
import { formatDate, formatTime } from '../../core/time/tz.ts';
import { formatInt } from '../../core/util/format.ts';
import { useResearch } from '../../core/econ/service.ts';
import { newsRegistry, useNews } from '../../core/econ/store.ts';
import { filterStore, useFilter } from '../../core/econ/filters.ts';
import type { EnrichedEvent } from '../../core/econ/study.ts';
import { IMPACT_LABEL, SESSION_LABEL, SURPRISE_BAND_LABEL, isOk } from '../../core/econ/types.ts';
import { openEventDetail } from '../../core/econ/markers.ts';
import { ImpactDot, MaybeNum, Pips, VirtualList } from './common.tsx';
import { NewsFilterDrawer } from './NewsFilterDrawer.tsx';
import { cx } from '../../core/util/format.ts';

type SortKey = 'time' | 'currency' | 'event' | 'impact' | 'actual' | 'z' | 'r15' | 'session';

const COLS: { key: SortKey | string; label: string; w: number; n?: boolean }[] = [
  { key: 'time', label: 'Date', w: 76 },
  { key: 'clock', label: 'Time', w: 44 },
  { key: 'currency', label: 'Ccy', w: 36 },
  { key: 'event', label: 'Event', w: 200 },
  { key: 'impact', label: 'Impact', w: 56 },
  { key: 'category', label: 'Category', w: 84 },
  { key: 'actual', label: 'Actual', w: 54, n: true },
  { key: 'forecast', label: 'Fcst', w: 54, n: true },
  { key: 'previous', label: 'Prev', w: 54, n: true },
  { key: 'revision', label: 'Rev', w: 54, n: true },
  { key: 'raw', label: 'Surprise', w: 60, n: true },
  { key: 'z', label: 'z', w: 50, n: true },
  { key: 'band', label: 'Band', w: 110 },
  { key: 'session', label: 'Session', w: 96 },
  { key: 'r15', label: '+15m', w: 54, n: true },
  { key: 'isolation', label: 'Isolation', w: 72 },
  { key: 'cluster', label: 'Cluster', w: 50, n: true },
];
const ROW_W = COLS.reduce((s, c) => s + c.w, 0);

export function NewsPanel(): React.ReactElement {
  const research = useResearch();
  const tz = useApp((s) => s.tz);
  const replay = useApp((s) => s.replay);
  const batches = useNews((s) => s.batches);
  const drawer = useFilter((s) => s.drawerOpen);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'time', dir: -1 });
  const rows = useMemo(() => sortRows(research.filtered, sort), [research, sort]);
  const total = newsRegistry.count();
  const hidden = total - research.visible.length;

  const header = (
    <div className="vrow-inner head" style={{ width: ROW_W }}>
      {COLS.map((c) => (
        <button
          key={c.key}
          type="button"
          className={cx('vcell', c.n && 'n', sort.key === c.key && 'sorted')}
          style={{ width: c.w }}
          onClick={() => {
            const k = (['time', 'currency', 'event', 'impact', 'actual', 'z', 'r15', 'session'] as string[]).includes(c.key) ? (c.key as SortKey) : null;
            if (k) setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : -1 }));
          }}
        >
          {c.label}
          {sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
        </button>
      ))}
    </div>
  );

  return (
    <div className="news-panel">
      <div className="panel-section" style={{ paddingBottom: 6 }}>
        <div className="row between">
          <span className="row" style={{ gap: 6 }}>
            <Chip tone={total ? 'accent' : undefined}>{formatInt(research.filtered.length)} / {formatInt(research.visible.length)} events</Chip>
            {replay.active && hidden > 0 ? <Chip tone="warn" title="Events after the replay boundary do not exist yet">{formatInt(hidden)} future hidden</Chip> : null}
          </span>
          <span className="row" style={{ gap: 2 }}>
            <Btn size="xs" icon="import" onClick={() => openDialog('newsImport')} tip="Import an economic calendar CSV">Import</Btn>
            <Btn size="xs" active={drawer} onClick={() => filterStore.set({ drawerOpen: !drawer })} tip="Open the filter drawer">Filter</Btn>
            <Btn size="xs" onClick={() => appStore.set({ panel: 'research' })} tip="Open the Research dashboard">Research</Btn>
          </span>
        </div>
      </div>
      {drawer ? <NewsFilterDrawer onClose={() => filterStore.set({ drawerOpen: false })} /> : null}
      {total === 0 ? (
        <Empty>
          No economic events imported yet.
          <div style={{ marginTop: 8 }}>
            <Btn size="xs" variant="primary" icon="import" onClick={() => openDialog('newsImport')}>Import news CSV</Btn>
          </div>
        </Empty>
      ) : (
        <div className="news-table-wrap">
          <VirtualList
            items={rows}
            rowHeight={24}
            header={header}
            className="news-table"
            emptyText={research.visible.length === 0 ? 'No events are known at this replay position.' : 'No events match the current filter.'}
            render={(x) => <Row x={x} tz={tz} />}
          />
        </div>
      )}
      {batches.length ? (
        <Section title="Imported files">
          <div className="list">
            {batches.map((b) => (
              <div key={b.id} className="list-row">
                <div style={{ minWidth: 0 }}>
                  <div className="title">{b.fileName}</div>
                  <div className="sub">
                    {formatInt(b.count)} events · {b.firstTime !== null ? formatDate(b.firstTime, tz) : '—'} → {b.lastTime !== null ? formatDate(b.lastTime, tz) : '—'} · {b.tz}
                    {b.summary.rejected ? ` · ${formatInt(b.summary.rejected)} rejected` : ''}
                  </div>
                </div>
                <Btn size="xs" icon="trash" tip="Remove this import" onClick={() => { if (window.confirm(`Remove ${b.fileName} from the local library?`)) void newsRegistry.deleteBatch(b.id); }} />
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function Row({ x, tz }: { x: EnrichedEvent; tz: string }): React.ReactElement {
  const e = x.event;
  const r15 = x.reaction.post.find((h) => h.minutes === 15)?.pips;
  const unit = e.unit ?? '';
  const detail = useNews((s) => s.detailId) === e.id;
  const v = (n: number | null) => (n === null ? <span className="dim">—</span> : `${n}${unit}`);
  return (
    <div
      className={cx('vrow-inner', detail && 'selected', x.cluster.ambiguous && 'ambiguous')}
      style={{ width: ROW_W }}
      onClick={() => openEventDetail(e.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(ev) => ev.key === 'Enter' && openEventDetail(e.id)}
      title={x.cluster.ambiguous ? 'Attribution ambiguous: high-impact events nearby' : undefined}
    >
      <span className="vcell mono" style={{ width: COLS[0].w }}>{formatDate(e.time, tz)}</span>
      <span className="vcell mono" style={{ width: COLS[1].w }}>{formatTime(e.time, tz)}</span>
      <span className="vcell" style={{ width: COLS[2].w }}>{e.currency}</span>
      <span className="vcell ellipsis" style={{ width: COLS[3].w }} title={e.event}>{e.event}</span>
      <span className="vcell" style={{ width: COLS[4].w }}><ImpactDot impact={e.impact} /> {e.impact ? IMPACT_LABEL[e.impact] : <span className="dim">—</span>}</span>
      <span className="vcell ellipsis" style={{ width: COLS[5].w }}>{e.category}</span>
      <span className="vcell n mono" style={{ width: COLS[6].w }}>{v(e.actual)}</span>
      <span className="vcell n mono" style={{ width: COLS[7].w }}>{v(e.forecast)}</span>
      <span className="vcell n mono" style={{ width: COLS[8].w }}>{v(e.previous)}</span>
      <span className="vcell n mono" style={{ width: COLS[9].w }}><MaybeNum v={x.revision.amount} decimals={2} signed /></span>
      <span className="vcell n mono" style={{ width: COLS[10].w }}><MaybeNum v={x.surprise.raw} decimals={2} signed /></span>
      <span className="vcell n mono" style={{ width: COLS[11].w }}><MaybeNum v={x.surprise.z} decimals={2} signed /></span>
      <span className="vcell ellipsis" style={{ width: COLS[12].w }}>{isOk(x.surprise.band) ? SURPRISE_BAND_LABEL[x.surprise.band.value] : <span className="dim" title={x.surprise.band.reason}>Unavailable</span>}</span>
      <span className="vcell ellipsis" style={{ width: COLS[13].w }}>{SESSION_LABEL[x.session]}</span>
      <span className="vcell n" style={{ width: COLS[14].w }}><Pips v={r15} /></span>
      <span className="vcell" style={{ width: COLS[15].w }}>{x.cluster.isolation}</span>
      <span className="vcell n mono" style={{ width: COLS[16].w }}>{x.cluster.neighbours.length || <span className="dim">—</span>}</span>
    </div>
  );
}

function sortRows(rows: EnrichedEvent[], sort: { key: SortKey; dir: 1 | -1 }): EnrichedEvent[] {
  const val = (x: EnrichedEvent): number | string => {
    switch (sort.key) {
      case 'time':
        return x.event.time;
      case 'currency':
        return x.event.currency;
      case 'event':
        return x.event.event;
      case 'impact':
        return x.event.impact ?? 'zzz';
      case 'actual':
        return x.event.actual ?? Number.NEGATIVE_INFINITY;
      case 'z':
        return isOk(x.surprise.z) ? x.surprise.z.value : Number.NEGATIVE_INFINITY;
      case 'r15': {
        const h = x.reaction.post.find((p) => p.minutes === 15)?.pips;
        return h && isOk(h) ? h.value : Number.NEGATIVE_INFINITY;
      }
      case 'session':
        return x.session;
    }
  };
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return c * sort.dir || a.event.time - b.event.time;
  });
}
