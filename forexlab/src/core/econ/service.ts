/**
 * Research service: one memoised pipeline from (gated events, gated series,
 * filter, config) to enriched events. Panels call `useResearch()` and get the
 * same object until one of the inputs changes, so the table, the chart markers,
 * the dashboard and the backtester never disagree about which events exist.
 *
 * Every input is read through the replay gate (`knownUntil`, `analysisSeries`),
 * so a future event or bar cannot enter the pipeline.
 */

import { useEffect, useMemo, useState } from 'react';
import { appStore, useApp } from '../app/state.ts';
import { createStore, useSlice } from '../store/state.ts';
import * as idb from '../store/idb.ts';
import type { CandleSeries } from '../data/series.ts';
import { filterStore, matchesFilter, matchesMeta, useFilter, type NewsFilter } from './filters.ts';
import { analysisSeries, knownUntil, newsRegistry, newsStore, useNews, visibleEvents } from './store.ts';
import { DEFAULT_STUDY_CONFIG, eventStudy, type EnrichedEvent, type StudyConfig } from './study.ts';
import type { EconEvent } from './types.ts';

export interface ResearchSnapshot {
  knownUntil: number;
  series: CandleSeries | null;
  /** All events known right now (unfiltered, enriched lazily via `enrich`). */
  visible: EconEvent[];
  /** Filter-matching events, enriched. */
  filtered: EnrichedEvent[];
  /** Enrich any visible event (cached). */
  enrich(e: EconEvent): EnrichedEvent;
  /** Enriched history for one indicator key (all visible releases). */
  history(key: string): EnrichedEvent[];
  filter: NewsFilter;
  config: StudyConfig;
  version: number;
}

interface ConfigState {
  config: StudyConfig;
}

export const studyConfigStore = createStore<ConfigState>({ config: DEFAULT_STUDY_CONFIG });

export function useStudyConfig(): StudyConfig {
  return useSlice(studyConfigStore, (s) => s.config);
}

export function setStudyConfig(patch: Partial<StudyConfig>): void {
  const next = { ...studyConfigStore.get().config, ...patch };
  studyConfigStore.set({ config: next });
  eventStudy.setConfig(next);
  bump();
  void idb.put('kv', next, 'study-config-v1').catch(() => undefined);
}

export async function restoreStudyConfig(): Promise<void> {
  try {
    const saved = await idb.get<StudyConfig>('kv', 'study-config-v1');
    if (saved && typeof saved === 'object') {
      const next: StudyConfig = {
        ...DEFAULT_STUDY_CONFIG,
        ...saved,
        surprise: { ...DEFAULT_STUDY_CONFIG.surprise, ...saved.surprise },
        context: { ...DEFAULT_STUDY_CONFIG.context, ...saved.context },
        reaction: { ...DEFAULT_STUDY_CONFIG.reaction, ...saved.reaction },
      };
      studyConfigStore.set({ config: next });
      eventStudy.setConfig(next);
    }
  } catch {
    /* ignore */
  }
}

/** Manual invalidation counter (dataset reload, config change). */
const tick = createStore<{ n: number }>({ n: 0 });
export function bump(): void {
  tick.set({ n: tick.get().n + 1 });
}

let last: { key: string; snap: ResearchSnapshot } | null = null;

export function computeResearch(): ResearchSnapshot {
  const until = knownUntil();
  const series = analysisSeries();
  const filter = filterStore.get().filter;
  const config = studyConfigStore.get().config;
  const version = newsStore.get().version;
  const key = [until, series ? `${series.datasetId ?? series.symbol}:${series.count}:${series.tf}` : 'none', version, JSON.stringify(filter), tick.get().n, appStore.get().tz].join('|');
  if (last && last.key === key) return last.snap;
  if (config.tz !== appStore.get().tz) {
    const next = { ...config, tz: appStore.get().tz };
    studyConfigStore.set({ config: next });
    eventStudy.setConfig(next);
  }
  const index = newsRegistry.fullIndex();
  const visible = visibleEvents(until);
  const enrich = (e: EconEvent): EnrichedEvent => eventStudy.enrich(e, index, series, until);
  const meta = visible.filter((e) => matchesMeta(e, filter));
  const filtered = meta.map(enrich).filter((x) => matchesFilter(x, filter));
  const histCache = new Map<string, EnrichedEvent[]>();
  const snap: ResearchSnapshot = {
    knownUntil: until,
    series,
    visible,
    filtered,
    enrich,
    history(k: string) {
      const hit = histCache.get(k);
      if (hit) return hit;
      const arr = (index.byKey.get(k) ?? []).filter((e) => e.time <= until).map(enrich);
      histCache.set(k, arr);
      return arr;
    },
    filter,
    config: studyConfigStore.get().config,
    version,
  };
  last = { key, snap };
  return snap;
}

/** Hook: recomputes only when a gate/filter/data input changes. */
export function useResearch(): ResearchSnapshot {
  const replay = useApp((s) => s.replay);
  const epoch = useApp((s) => s.datasetEpoch);
  const tz = useApp((s) => s.tz);
  const version = useNews((s) => s.version);
  const filter = useFilter((s) => s.filter);
  const n = useSlice(tick, (s) => s.n);
  const [, force] = useState(0);
  // Series may attach slightly after datasetEpoch bumps; poll once via microtask.
  useEffect(() => {
    const id = setTimeout(() => force((v) => v + 1), 0);
    return () => clearTimeout(id);
  }, [epoch]);
  return useMemo(() => computeResearch(), [replay.active, replay.knownUntil, replay.cursor, epoch, tz, version, filter, n]);
}
