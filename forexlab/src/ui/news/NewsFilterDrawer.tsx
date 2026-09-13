/** News filter drawer: every facet as checkbox groups, presets, and quick actions. */

import { useMemo, useState } from 'react';
import { Btn, Check, Section } from '../kit.tsx';
import {
  ALL_FILTER,
  EMPTY_FILTER,
  deletePreset,
  filterStore,
  invertFilter,
  loadPreset,
  savePreset,
  setFilter,
  toggleIn,
  useFilter,
} from '../../core/econ/filters.ts';
import { newsRegistry, newsStore, useNews } from '../../core/econ/store.ts';
import {
  CATEGORIES,
  CURRENCIES,
  IMPACTS,
  IMPACT_LABEL,
  ISOLATIONS,
  REVISION_KINDS,
  REVISION_LABEL,
  SESSIONS,
  SESSION_LABEL,
  SIGMA_BUCKETS,
  SIGMA_BUCKET_LABEL,
  SURPRISE_BANDS,
  SURPRISE_BAND_LABEL,
  TRENDS,
  VOL_REGIMES,
} from '../../core/econ/types.ts';
import { overlayRegistry } from '../../core/app/overlays.ts';

function Group<T extends string>({
  title,
  all,
  selected,
  label,
  onToggle,
  onSet,
  extra,
  counts,
}: {
  title: string;
  all: readonly T[];
  selected: readonly T[];
  label: (v: T) => string;
  onToggle: (v: T) => void;
  onSet: (v: T[]) => void;
  extra?: React.ReactNode;
  counts?: Map<string, number>;
}): React.ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <div className="fgroup">
      <div className="fgroup-head">
        <button type="button" className="fgroup-title" onClick={() => setOpen((v) => !v)}>
          {open ? '▾' : '▸'} {title} <span className="dim">{selected.length}/{all.length}</span>
        </button>
        <span className="row" style={{ gap: 2 }}>
          <Btn size="xs" variant="ghost" onClick={() => onSet([...all])}>all</Btn>
          <Btn size="xs" variant="ghost" onClick={() => onSet([])}>none</Btn>
        </span>
      </div>
      {open ? (
        <div className="fgroup-body">
          {all.map((v) => (
            <Check key={v} checked={selected.includes(v)} onChange={() => onToggle(v)} label={label(v)} count={counts?.get(v)} />
          ))}
          {extra}
        </div>
      ) : null}
    </div>
  );
}

export function NewsFilterDrawer({ onClose }: { onClose?: () => void }): React.ReactElement {
  const f = useFilter((s) => s.filter);
  const presets = useFilter((s) => s.presets);
  const version = useNews((s) => s.version);
  const showOnChart = useNews((s) => s.showOnChart);
  const [presetName, setPresetName] = useState('');
  const { types, currencyCounts } = useMemo(() => {
    const t = new Map<string, number>();
    const c = new Map<string, number>();
    for (const e of newsRegistry.allUngated()) {
      t.set(e.type, (t.get(e.type) ?? 0) + 1);
      c.set(e.currency, (c.get(e.currency) ?? 0) + 1);
    }
    return { types: [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60), currencyCounts: c };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const extraCurrencies = [...currencyCounts.keys()].filter((c) => !(CURRENCIES as readonly string[]).includes(c));
  const allCurrencies = [...CURRENCIES, ...extraCurrencies];
  return (
    <div className="filter-drawer">
      <div className="panel-header">
        <span className="panel-title">News filter</span>
        <span className="right row" style={{ gap: 2 }}>
          <Btn size="xs" onClick={() => setFilter(ALL_FILTER)} tip="Select every option">Select all</Btn>
          <Btn size="xs" onClick={() => setFilter(EMPTY_FILTER)} tip="Clear every option">Clear all</Btn>
          <Btn size="xs" onClick={() => setFilter(invertFilter(filterStore.get().filter))} tip="Invert every selection">Invert</Btn>
          <Btn size="xs" onClick={() => setFilter({ ...ALL_FILTER })} tip="Reset to defaults">Reset</Btn>
          {onClose ? <Btn size="xs" icon="close" onClick={onClose} /> : null}
        </span>
      </div>
      <div className="panel-body">
        <Section title="Chart">
          <div className="row" style={{ gap: 4 }}>
            <Btn size="xs" variant={showOnChart ? 'primary' : 'default'} onClick={() => { newsStore.set({ showOnChart: true, hiddenIds: [] }); overlayRegistry.scheduleSync(); }}>Show on chart</Btn>
            <Btn size="xs" onClick={() => { newsStore.set({ showOnChart: false }); overlayRegistry.scheduleSync(); }}>Hide all</Btn>
          </div>
        </Section>
        <Section title="Presets">
          <div className="row" style={{ gap: 4 }}>
            <input className="input" placeholder="Preset name" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
            <Btn size="xs" disabled={!presetName.trim()} onClick={() => { savePreset(presetName.trim()); setPresetName(''); }}>Save</Btn>
          </div>
          {presets.length ? (
            <div className="list" style={{ marginTop: 6 }}>
              {presets.map((p) => (
                <div key={p.id} className="list-row" onClick={() => loadPreset(p.id)} role="button" tabIndex={0}>
                  <span className="title">{p.name}</span>
                  <Btn size="xs" icon="trash" onClick={(e) => { e.stopPropagation(); deletePreset(p.id); }} />
                </div>
              ))}
            </div>
          ) : (
            <div className="note small dim" style={{ marginTop: 4 }}>No saved presets.</div>
          )}
        </Section>
        <Section title="Search">
          <input className="input" placeholder="Event title, type, currency" value={f.query} onChange={(e) => setFilter({ query: e.target.value })} />
        </Section>
        <Group title="Currency" all={allCurrencies} selected={f.currencies} label={(v) => v} counts={currencyCounts} onToggle={(v) => setFilter((s) => ({ currencies: toggleIn(s.currencies, v) }))} onSet={(v) => setFilter({ currencies: v })} />
        <Group
          title="Impact"
          all={IMPACTS}
          selected={f.impacts}
          label={(v) => IMPACT_LABEL[v]}
          onToggle={(v) => setFilter((s) => ({ impacts: toggleIn(s.impacts, v) }))}
          onSet={(v) => setFilter({ impacts: v })}
          extra={<Check checked={f.includeUnknownImpact} onChange={(v) => setFilter({ includeUnknownImpact: v })} label="Unknown impact" />}
        />
        <Group title="Category" all={CATEGORIES} selected={f.categories} label={(v) => v} onToggle={(v) => setFilter((s) => ({ categories: toggleIn(s.categories, v) }))} onSet={(v) => setFilter({ categories: v })} />
        <div className="fgroup">
          <div className="fgroup-head">
            <span className="fgroup-title">Event type <span className="dim">{f.types.length === 0 ? 'all' : f.types.length}</span></span>
            <Btn size="xs" variant="ghost" onClick={() => setFilter({ types: [] })}>all</Btn>
          </div>
          <div className="fgroup-body cols-2">
            {types.map(([t, n]) => (
              <Check key={t} checked={f.types.length === 0 || f.types.includes(t)} indeterminate={f.types.length === 0} onChange={() => setFilter((s) => ({ types: s.types.length === 0 ? [t] : toggleIn(s.types, t) }))} label={t} count={n} />
            ))}
            {types.length === 0 ? <div className="note small dim">Import news to see event types.</div> : null}
          </div>
        </div>
        <Group
          title="Surprise band"
          all={SURPRISE_BANDS}
          selected={f.bands}
          label={(v) => SURPRISE_BAND_LABEL[v]}
          onToggle={(v) => setFilter((s) => ({ bands: toggleIn(s.bands, v) }))}
          onSet={(v) => setFilter({ bands: v })}
          extra={<Check checked={f.includeNoSurprise} onChange={(v) => setFilter({ includeNoSurprise: v })} label="Surprise unavailable" />}
        />
        <Group title="Standardized surprise" all={SIGMA_BUCKETS} selected={f.sigma} label={(v) => SIGMA_BUCKET_LABEL[v]} onToggle={(v) => setFilter((s) => ({ sigma: toggleIn(s.sigma, v) }))} onSet={(v) => setFilter({ sigma: v })} />
        <Group
          title="Revision"
          all={REVISION_KINDS}
          selected={f.revisions}
          label={(v) => REVISION_LABEL[v]}
          onToggle={(v) => setFilter((s) => ({ revisions: toggleIn(s.revisions, v) }))}
          onSet={(v) => setFilter({ revisions: v })}
          extra={<Check checked={f.includeNoRevision} onChange={(v) => setFilter({ includeNoRevision: v })} label="Revision unknown" />}
        />
        <Group title="Session" all={SESSIONS} selected={f.sessions} label={(v) => SESSION_LABEL[v]} onToggle={(v) => setFilter((s) => ({ sessions: toggleIn(s.sessions, v) }))} onSet={(v) => setFilter({ sessions: v })} />
        <Group
          title="Volatility regime"
          all={VOL_REGIMES}
          selected={f.regimes}
          label={(v) => v}
          onToggle={(v) => setFilter((s) => ({ regimes: toggleIn(s.regimes, v) }))}
          onSet={(v) => setFilter({ regimes: v })}
          extra={<Check checked={f.includeNoRegime} onChange={(v) => setFilter({ includeNoRegime: v })} label="Regime unavailable" />}
        />
        <Group title="Event isolation" all={ISOLATIONS} selected={f.isolation} label={(v) => v} onToggle={(v) => setFilter((s) => ({ isolation: toggleIn(s.isolation, v) }))} onSet={(v) => setFilter({ isolation: v })} />
        <Group title="Pre-news trend" all={TRENDS} selected={f.trends} label={(v) => v} onToggle={(v) => setFilter((s) => ({ trends: toggleIn(s.trends, v) }))} onSet={(v) => setFilter({ trends: v })} />
      </div>
    </div>
  );
}
