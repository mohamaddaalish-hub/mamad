/** Event Comparison: overlay individual reaction curves (release = 0) with mean/median. */

import { useMemo } from 'react';
import { Btn, Check, Chip, Empty, Section } from '../kit.tsx';
import { useApp } from '../../core/app/state.ts';
import { formatDate } from '../../core/time/tz.ts';
import type { ResearchSnapshot } from '../../core/econ/service.ts';
import { newsStore, useNews, visibleEvent } from '../../core/econ/store.ts';
import { reactionCurve, quantiles } from '../../core/econ/study.ts';
import { horizonLabel, isOk } from '../../core/econ/types.ts';
import { CurveChart, MaybeNum, num } from '../news/common.tsx';
import { openEventDetail } from '../../core/econ/markers.ts';

const PALETTE = ['#5b8ec9', '#c9a24b', '#3c9d78', '#cf6068', '#9a86c9', '#d0747c', '#76a9d6', '#b8a15b', '#5cb391', '#e08a90', '#af9fdc', '#8ea0b8'];

export function EventComparison({ research }: { research: ResearchSnapshot }): React.ReactElement {
  const tz = useApp((s) => s.tz);
  const ids = useNews((s) => s.compareIds);
  const hidden = useNews((s) => s.hiddenIds);
  const items = useMemo(() => ids.map((id) => visibleEvent(id, research.knownUntil)).filter((e): e is NonNullable<typeof e> => !!e).map((e) => research.enrich(e)), [ids, research]);
  const shown = items.filter((x) => !hidden.includes(`cmp:${x.event.id}`));
  const curve = reactionCurve(shown);
  const labels = curve.horizons.map(horizonLabel);
  if (items.length === 0) {
    return (
      <Empty>
        No events selected for comparison.
        <div className="note small" style={{ marginTop: 6 }}>Use "cmp" in Event History, or "compare latest 12" for an indicator.</div>
      </Empty>
    );
  }
  const m15 = quantiles(shown.map((x) => { const h = x.reaction.post.find((p) => p.minutes === 15)?.pips; return h && isOk(h) ? h.value : NaN; }));
  return (
    <>
      <Section title="Event comparison" right={<Btn size="xs" onClick={() => newsStore.set({ compareIds: [] })}>clear</Btn>}>
        <CurveChart
          labels={labels}
          markerIndex={curve.horizons.indexOf(0)}
          height={220}
          series={[
            ...shown.map((x, i) => ({ name: formatDate(x.event.time, tz), values: x.reaction.curve, color: PALETTE[i % PALETTE.length], faint: true })),
            { name: 'Average', values: curve.mean, color: 'var(--accent)', width: 2 },
            { name: 'Median', values: curve.median, color: 'var(--warn)', dashed: true, width: 2 },
          ]}
        />
        <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
          <Chip>{shown.length} of {items.length} shown</Chip>
          {m15 ? <Chip>15m mean {num(m15.mean, 1, true)} · median {num(m15.median, 1, true)} · σ {num(m15.std, 1)}</Chip> : null}
        </div>
      </Section>
      <Section title="Events">
        <table className="table compact">
          <thead>
            <tr>
              <th />
              <th>Date</th>
              <th>Event</th>
              <th className="n">Surprise</th>
              <th className="n">z</th>
              <th className="n">+15m</th>
              <th className="n">+1H</th>
              <th className="n">MFE 1H</th>
              <th className="n">MAE 1H</th>
              <th className="n">vol ×</th>
            </tr>
          </thead>
          <tbody>
            {items.map((x, i) => {
              const key = `cmp:${x.event.id}`;
              const h15 = x.reaction.post.find((p) => p.minutes === 15);
              const h60 = x.reaction.post.find((p) => p.minutes === 60);
              return (
                <tr key={x.event.id} className="clickable" onClick={() => openEventDetail(x.event.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Check checked={!hidden.includes(key)} onChange={(v) => newsStore.set((s) => ({ hiddenIds: v ? s.hiddenIds.filter((h) => h !== key) : [...s.hiddenIds, key] }))} label={<span className="legend-swatch" style={{ background: PALETTE[i % PALETTE.length] }} />} />
                  </td>
                  <td className="mono">{formatDate(x.event.time, tz)}</td>
                  <td>{x.event.currency} {x.event.event}</td>
                  <td className="n"><MaybeNum v={x.surprise.raw} decimals={2} signed /></td>
                  <td className="n"><MaybeNum v={x.surprise.z} decimals={2} signed /></td>
                  <td className="n"><MaybeNum v={h15?.pips} signed /></td>
                  <td className="n"><MaybeNum v={h60?.pips} signed /></td>
                  <td className="n"><MaybeNum v={h60?.mfeUp} tone={false} /></td>
                  <td className="n"><MaybeNum v={h60?.mfeDown} tone={false} /></td>
                  <td className="n"><MaybeNum v={h60?.volRatio} decimals={2} tone={false} suffix="×" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </>
  );
}
