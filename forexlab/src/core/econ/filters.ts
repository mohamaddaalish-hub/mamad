/**
 * News filter model + evaluation. Filters are plain serialisable objects so
 * presets persist in IndexedDB and the backtester can reuse the exact same
 * predicate the explorer shows.
 */

import * as idb from '../store/idb.ts';
import { createStore, useSlice } from '../store/state.ts';
import type { EnrichedEvent } from './study.ts';
import {
  CATEGORIES,
  CURRENCIES,
  IMPACTS,
  ISOLATIONS,
  REVISION_KINDS,
  SESSIONS,
  SIGMA_BUCKETS,
  SURPRISE_BANDS,
  TRENDS,
  VOL_REGIMES,
  type Category,
  type Impact,
  type Isolation,
  type RevisionKind,
  type Session,
  type SigmaBucket,
  type SurpriseBand,
  type Trend,
  type VolRegime,
  isOk,
} from './types.ts';

export interface NewsFilter {
  currencies: string[];
  impacts: Impact[];
  /** Include events with no impact metadata. */
  includeUnknownImpact: boolean;
  categories: Category[];
  /** Event-type tags; empty = all. */
  types: string[];
  bands: SurpriseBand[];
  /** Include events whose standardized surprise is UNAVAILABLE. */
  includeNoSurprise: boolean;
  sigma: SigmaBucket[];
  revisions: RevisionKind[];
  includeNoRevision: boolean;
  sessions: Session[];
  regimes: VolRegime[];
  includeNoRegime: boolean;
  isolation: Isolation[];
  trends: Trend[];
  /** Text search over title. */
  query: string;
  /** Optional [from, to] instants. */
  from: number | null;
  to: number | null;
}

export const ALL_FILTER: NewsFilter = {
  currencies: [...CURRENCIES],
  impacts: [...IMPACTS],
  includeUnknownImpact: true,
  categories: [...CATEGORIES],
  types: [],
  bands: [...SURPRISE_BANDS],
  includeNoSurprise: true,
  sigma: [...SIGMA_BUCKETS],
  revisions: [...REVISION_KINDS],
  includeNoRevision: true,
  sessions: [...SESSIONS],
  regimes: [...VOL_REGIMES],
  includeNoRegime: true,
  isolation: [...ISOLATIONS],
  trends: [...TRENDS],
  query: '',
  from: null,
  to: null,
};

export const EMPTY_FILTER: NewsFilter = {
  ...ALL_FILTER,
  currencies: [],
  impacts: [],
  includeUnknownImpact: false,
  categories: [],
  bands: [],
  includeNoSurprise: false,
  sigma: [],
  revisions: [],
  includeNoRevision: false,
  sessions: [],
  regimes: [],
  includeNoRegime: false,
  isolation: [],
  trends: [],
};

export function invertFilter(f: NewsFilter): NewsFilter {
  const inv = <T>(all: readonly T[], sel: readonly T[]): T[] => all.filter((x) => !sel.includes(x));
  return {
    ...f,
    currencies: inv(CURRENCIES, f.currencies),
    impacts: inv(IMPACTS, f.impacts),
    includeUnknownImpact: !f.includeUnknownImpact,
    categories: inv(CATEGORIES, f.categories),
    bands: inv(SURPRISE_BANDS, f.bands),
    includeNoSurprise: !f.includeNoSurprise,
    sigma: inv(SIGMA_BUCKETS, f.sigma),
    revisions: inv(REVISION_KINDS, f.revisions),
    includeNoRevision: !f.includeNoRevision,
    sessions: inv(SESSIONS, f.sessions),
    regimes: inv(VOL_REGIMES, f.regimes),
    includeNoRegime: !f.includeNoRegime,
    isolation: inv(ISOLATIONS, f.isolation),
    trends: inv(TRENDS, f.trends),
  };
}

/** Cheap pre-enrichment predicate (metadata only). Use before computing reactions. */
export function matchesMeta(e: EnrichedEvent['event'], f: NewsFilter): boolean {
  if (f.currencies.length && !f.currencies.includes(e.currency)) return false;
  if (e.impact === null ? !f.includeUnknownImpact : !f.impacts.includes(e.impact)) return false;
  if (f.categories.length && !f.categories.includes(e.category)) return false;
  if (f.types.length && !f.types.includes(e.type)) return false;
  if (f.from !== null && e.time < f.from) return false;
  if (f.to !== null && e.time > f.to) return false;
  if (f.query) {
    const q = f.query.toLowerCase();
    if (!e.event.toLowerCase().includes(q) && !e.type.toLowerCase().includes(q) && !e.currency.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** Full predicate (needs enrichment). */
export function matchesFilter(x: EnrichedEvent, f: NewsFilter): boolean {
  if (!matchesMeta(x.event, f)) return false;
  if (isOk(x.surprise.band)) {
    if (!f.bands.includes(x.surprise.band.value)) return false;
    if (isOk(x.surprise.sigma) && !f.sigma.includes(x.surprise.sigma.value)) return false;
  } else if (!f.includeNoSurprise) return false;
  if (isOk(x.revision.kind)) {
    if (!f.revisions.includes(x.revision.kind.value)) return false;
  } else if (!f.includeNoRevision) return false;
  if (!f.sessions.includes(x.session)) return false;
  if (isOk(x.context.regime)) {
    if (!f.regimes.includes(x.context.regime.value)) return false;
  } else if (!f.includeNoRegime) return false;
  if (!f.isolation.includes(x.cluster.isolation)) return false;
  if (!f.trends.includes(x.context.trend)) return false;
  return true;
}

/** True when the filter needs enrichment to decide (anything beyond metadata narrowed). */
export function needsEnrichment(f: NewsFilter): boolean {
  return (
    f.bands.length !== SURPRISE_BANDS.length ||
    !f.includeNoSurprise ||
    f.sigma.length !== SIGMA_BUCKETS.length ||
    f.revisions.length !== REVISION_KINDS.length ||
    !f.includeNoRevision ||
    f.sessions.length !== SESSIONS.length ||
    f.regimes.length !== VOL_REGIMES.length ||
    !f.includeNoRegime ||
    f.isolation.length !== ISOLATIONS.length ||
    f.trends.length !== TRENDS.length
  );
}

/* ------------------------------------------------------------ filter store */

export interface FilterPreset {
  id: string;
  name: string;
  filter: NewsFilter;
  createdAt: number;
}

export interface FilterState {
  filter: NewsFilter;
  presets: FilterPreset[];
  drawerOpen: boolean;
}

export const filterStore = createStore<FilterState>({ filter: ALL_FILTER, presets: [], drawerOpen: false });

export function useFilter<K>(select: (s: FilterState) => K): K {
  return useSlice(filterStore, select);
}

export function setFilter(patch: Partial<NewsFilter> | ((f: NewsFilter) => Partial<NewsFilter>)): void {
  const cur = filterStore.get().filter;
  const p = typeof patch === 'function' ? patch(cur) : patch;
  filterStore.set({ filter: { ...cur, ...p } });
  void persistFilters();
}

export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

const KEY = 'news-filter-v1';

export async function persistFilters(): Promise<void> {
  const s = filterStore.get();
  try {
    await idb.put('kv', { filter: s.filter, presets: s.presets }, KEY);
  } catch {
    /* storage is best-effort */
  }
}

export async function restoreFilters(): Promise<void> {
  try {
    const saved = await idb.get<{ filter: NewsFilter; presets: FilterPreset[] }>('kv', KEY);
    if (!saved) return;
    filterStore.set({ filter: sanitise(saved.filter), presets: Array.isArray(saved.presets) ? saved.presets.map((p) => ({ ...p, filter: sanitise(p.filter) })) : [] });
  } catch {
    /* ignore */
  }
}

/** Untrusted storage → valid filter. */
export function sanitise(raw: unknown): NewsFilter {
  const r = (raw ?? {}) as Partial<NewsFilter>;
  const pick = <T>(all: readonly T[], v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => all.includes(x as T)) as T[]) : [...all]);
  return {
    currencies: Array.isArray(r.currencies) ? r.currencies.filter((x) => typeof x === 'string').slice(0, 50) : [...CURRENCIES],
    impacts: pick(IMPACTS, r.impacts),
    includeUnknownImpact: r.includeUnknownImpact ?? true,
    categories: pick(CATEGORIES, r.categories),
    types: Array.isArray(r.types) ? r.types.filter((x) => typeof x === 'string').slice(0, 200) : [],
    bands: pick(SURPRISE_BANDS, r.bands),
    includeNoSurprise: r.includeNoSurprise ?? true,
    sigma: pick(SIGMA_BUCKETS, r.sigma),
    revisions: pick(REVISION_KINDS, r.revisions),
    includeNoRevision: r.includeNoRevision ?? true,
    sessions: pick(SESSIONS, r.sessions),
    regimes: pick(VOL_REGIMES, r.regimes),
    includeNoRegime: r.includeNoRegime ?? true,
    isolation: pick(ISOLATIONS, r.isolation),
    trends: pick(TRENDS, r.trends),
    query: typeof r.query === 'string' ? r.query.slice(0, 100) : '',
    from: typeof r.from === 'number' ? r.from : null,
    to: typeof r.to === 'number' ? r.to : null,
  };
}

export function savePreset(name: string): void {
  const s = filterStore.get();
  const preset: FilterPreset = { id: `fp_${Date.now().toString(36)}`, name: name.slice(0, 60), filter: s.filter, createdAt: Date.now() };
  filterStore.set({ presets: [...s.presets, preset] });
  void persistFilters();
}

export function loadPreset(id: string): void {
  const p = filterStore.get().presets.find((x) => x.id === id);
  if (p) setFilter(p.filter);
}

export function deletePreset(id: string): void {
  filterStore.set({ presets: filterStore.get().presets.filter((p) => p.id !== id) });
  void persistFilters();
}
