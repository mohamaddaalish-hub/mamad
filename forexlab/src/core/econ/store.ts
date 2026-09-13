/**
 * News feed store (stage 8, persistence reused from stage 1).
 *
 * Feeds live in IndexedDB like everything else — one record per feed in the
 * `sessions` object store under `news:<feedId>`, the index plus the filter state
 * in `kv`. React never receives the raw event array from a store write; consumers
 * subscribe and pull, so importing 5 000 rows does not re-render the tree 5 000
 * times, and the merged view is memoized by a version counter.
 */

import { useSyncExternalStore } from 'react';
import * as idb from '../store/idb.ts';
import type { EconEvent, ImpactLabel, NewsFeed } from './types.ts';
import { BAND_ORDER, buildSurpriseContext, scoreEvent, type Surprise, type SurpriseBand, type SurpriseContext } from './surprise.ts';

export interface NewsFilterState {
  currencies: string[];
  impacts: ImpactLabel[];
  categories: string[];
  /** Event-type keys (`EUR:Nfp Nonfarm Payrolls` style) — empty means all. */
  eventKeys: string[];
  bands: SurpriseBand[];
  /** Only events whose surprise could be standardized honestly. */
  requireStandardized: boolean;
  /** Only events carrying a revision (stated or derived). */
  revisionOnly: boolean;
  /** Only rows that have an actual value (i.e. the release already happened). */
  onlyWithActual: boolean;
  search: string;
  from: number | null;
  to: number | null;
}

export const DEFAULT_NEWS_FILTER: NewsFilterState = {
  currencies: [],
  impacts: [],
  categories: [],
  eventKeys: [],
  bands: [],
  requireStandardized: false,
  revisionOnly: false,
  onlyWithActual: false,
  search: '',
  from: null,
  to: null,
};

export interface NewsPreset {
  id: string;
  name: string;
  filter: NewsFilterState;
  createdAt: number;
}

const FEED_INDEX_KEY = 'news-feeds-v1';
const FILTER_KEY = 'news-filter-v1';
const PRESET_KEY = 'news-presets-v1';
const feedKey = (id: string): string => `news:${id}`;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

class NewsStore {
  private feedMap = new Map<string, NewsFeed>();
  private order: string[] = [];
  private selectedId: string | null = null;
  private filter: NewsFilterState = { ...DEFAULT_NEWS_FILTER };
  private presets: NewsPreset[] = [];
  private listeners = new Set<() => void>();
  private version = 0;
  private merged: { version: number; events: EconEvent[]; ctx: SurpriseContext } | null = null;
  private view: { version: number; filterKey: string; events: EconEvent[] } | null = null;
  private surprises: { version: number; map: Map<string, Surprise> } | null = null;
  hydrated = false;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const index = await idb.get<{ ids: string[]; activeId: string | null }>('kv', FEED_INDEX_KEY);
      if (index) {
        for (const id of index.ids) {
          const feed = await idb.get<NewsFeed>('news', feedKey(id));
          if (feed) {
            this.feedMap.set(feed.id, feed);
            this.order.push(feed.id);
          }
        }
        this.selectedId = index.activeId && this.feedMap.has(index.activeId) ? index.activeId : this.order[0] ?? null;
      }
      const savedFilter = await idb.get<NewsFilterState>('kv', FILTER_KEY);
      if (savedFilter) this.filter = { ...DEFAULT_NEWS_FILTER, ...savedFilter };
      const savedPresets = await idb.get<NewsPreset[]>('kv', PRESET_KEY);
      if (savedPresets) this.presets = savedPresets;
      if (this.order.length) this.emit();
    } catch (err) {
      console.warn('[news] hydrate failed', err);
    }
  }

  private async persistIndex(): Promise<void> {
    await idb.put('kv', { ids: this.order, activeId: this.selectedId }, FEED_INDEX_KEY);
  }

  async addFeed(feed: NewsFeed, opts: { activate?: boolean } = {}): Promise<void> {
    await idb.put('news', feed, feedKey(feed.id));
    this.feedMap.set(feed.id, feed);
    this.order = [feed.id, ...this.order.filter((x) => x !== feed.id)];
    if (opts.activate !== false) this.selectedId = feed.id;
    await this.persistIndex();
    this.emit();
  }

  async removeFeed(id: string): Promise<void> {
    await idb.del('news', feedKey(id));
    this.feedMap.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.selectedId === id) this.selectedId = this.order[0] ?? null;
    await this.persistIndex();
    this.emit();
  }

  async renameFeed(id: string, label: string): Promise<void> {
    const feed = this.feedMap.get(id);
    if (!feed) return;
    const next = { ...feed, label };
    this.feedMap.set(id, next);
    await idb.put('news', next, feedKey(id));
    this.emit();
  }

  async setActive(id: string | null): Promise<void> {
    this.selectedId = id;
    await this.persistIndex();
    this.emit();
  }

  get feeds(): NewsFeed[] {
    return this.order.map((id) => this.feedMap.get(id)).filter((f): f is NewsFeed => !!f);
  }

  get activeId(): string | null {
    return this.selectedId;
  }

  get activeFeed(): NewsFeed | null {
    return this.activeId ? this.feedMap.get(this.activeId) ?? null : null;
  }

  get feedCount(): number {
    return this.feedMap.size;
  }

  /**
   * Every event from every feed, chronological, with rows that carry the same
   * instant + currency + indicator collapsed so an overlapping import does not
   * double-count a release. The feed imported later wins, on the assumption that
   * a re-import is a correction.
   */
  allEvents(): EconEvent[] {
    if (this.merged && this.merged.version === this.version) return this.merged.events;
    const byKey = new Map<string, EconEvent>();
    const all: EconEvent[] = [];
    for (const feed of this.feedMap.values()) all.push(...feed.events);
    all.sort((a, b) => a.instant - b.instant || (a.line ?? 0) - (b.line ?? 0));
    for (const e of all) {
      const key = `${e.instant}|${e.currency}|${e.eventKey}`;
      const hit = byKey.get(key);
      if (hit && hit.id !== e.id) {
        // Same release in two feeds: keep the one that carries more information.
        const score = (x: EconEvent): number => (x.actual !== null ? 2 : 0) + (x.forecast !== null ? 1 : 0);
        if (score(e) <= score(hit)) continue;
      }
      byKey.set(key, e);
    }
    const events = [...byKey.values()].sort((a, b) => a.instant - b.instant);
    this.merged = { version: this.version, events, ctx: buildSurpriseContext(events) };
    return events;
  }

  surpriseOf(event: EconEvent): Surprise {
    this.allEvents();
    if (!this.surprises || this.surprises.version !== this.version) {
      this.surprises = { version: this.version, map: new Map<string, Surprise>() };
    }
    const hit = this.surprises.map.get(event.id);
    if (hit) return hit;
    const ctx: SurpriseContext = this.merged!.ctx;
    const s = scoreEvent(event, ctx);
    this.surprises.map.set(event.id, s);
    return s;
  }

  surpriseByEventKey(key: string): Surprise[] {
    return this.allEvents()
      .filter((e) => e.eventKey === key)
      .map((e) => this.surpriseOf(e));
  }

  get filterState(): NewsFilterState {
    return this.filter;
  }

  setFilter(patch: Partial<NewsFilterState>): void {
    this.filter = { ...this.filter, ...patch };
    void idb.put('kv', this.filter, FILTER_KEY);
    this.emit();
  }

  resetFilter(): void {
    this.filter = { ...DEFAULT_NEWS_FILTER };
    void idb.put('kv', this.filter, FILTER_KEY);
    this.emit();
  }

  get presetList(): NewsPreset[] {
    return this.presets;
  }

  async savePreset(name: string): Promise<NewsPreset> {
    const preset: NewsPreset = { id: newId('np'), name: name.trim() || 'Untitled preset', filter: { ...this.filter }, createdAt: Date.now() };
    this.presets = [preset, ...this.presets].slice(0, 40);
    await idb.put('kv', this.presets, PRESET_KEY);
    this.emit();
    return preset;
  }

  async applyPreset(id: string): Promise<void> {
    const hit = this.presets.find((p) => p.id === id);
    if (!hit) return;
    this.filter = { ...DEFAULT_NEWS_FILTER, ...hit.filter };
    await idb.put('kv', this.filter, FILTER_KEY);
    this.emit();
  }

  async deletePreset(id: string): Promise<void> {
    this.presets = this.presets.filter((p) => p.id !== id);
    await idb.put('kv', this.presets, PRESET_KEY);
    this.emit();
  }

  /** Facets offered by the explorer, derived from what is actually imported. */
  facets(): { currencies: string[]; impacts: ImpactLabel[]; categories: string[]; eventKeys: string[]; bands: SurpriseBand[] } {
    const events = this.allEvents();
    const currencies = new Set<string>();
    const impacts = new Set<ImpactLabel>();
    const categories = new Set<string>();
    const eventKeys = new Set<string>();
    const bands = new Set<SurpriseBand>();
    for (const e of events) {
      currencies.add(e.currency);
      impacts.add(e.impact);
      if (e.category) categories.add(e.category);
      eventKeys.add(e.eventKey);
      const s = this.surpriseOf(e);
      if (s.band) bands.add(s.band);
    }
    return {
      currencies: [...currencies].sort(),
      impacts: (['high', 'medium', 'low', 'none', 'unknown'] as ImpactLabel[]).filter((i) => impacts.has(i)),
      categories: [...categories].sort(),
      eventKeys: [...eventKeys].sort(),
      bands: BAND_ORDER.filter((b) => bands.has(b)),
    };
  }

  /** Filter application. Cheap enough to run per keystroke at calendar sizes. */
  filteredEvents(): EconEvent[] {
    const events = this.allEvents();
    const f = this.filter;
    const key = JSON.stringify(f);
    if (this.view && this.view.version === this.version && this.view.filterKey === key) return this.view.events;
    const needle = f.search.trim().toLowerCase();
    const cur = new Set(f.currencies);
    const imp = new Set(f.impacts);
    const cat = new Set(f.categories);
    const evk = new Set(f.eventKeys);
    const bands = new Set(f.bands);
    const out = events.filter((e) => {
      if (cur.size && !cur.has(e.currency)) return false;
      if (imp.size && !imp.has(e.impact)) return false;
      if (cat.size && !(e.category && cat.has(e.category))) return false;
      if (evk.size && !evk.has(e.eventKey)) return false;
      if (f.onlyWithActual && e.actual === null) return false;
      if (f.from !== null && e.instant < f.from) return false;
      if (f.to !== null && e.instant > f.to) return false;
      if (needle && !`${e.event} ${e.currency} ${e.category ?? ''}`.toLowerCase().includes(needle)) return false;
      if (f.requireStandardized || f.revisionOnly || bands.size) {
        const s = this.surpriseOf(e);
        if (f.requireStandardized && s.standardized === null) return false;
        if (f.revisionOnly && s.revision.stated === null && s.revision.derived === null) return false;
        if (bands.size && !(s.band && bands.has(s.band))) return false;
      }
      return true;
    });
    this.view = { version: this.version, filterKey: key, events: out };
    return out;
  }

  /** Total accepted rows across feeds (for status readouts). */
  get totalRows(): number {
    let n = 0;
    for (const f of this.feeds.values()) n += f.events.length;
    return n;
  }
}

export const newsStore = new NewsStore();

export interface NewsSnapshot {
  version: number;
  feeds: NewsFeed[];
  activeId: string | null;
  filter: NewsFilterState;
  presets: NewsPreset[];
  events: EconEvent[];
  filtered: EconEvent[];
  totalRows: number;
}

export function newsSnapshot(): NewsSnapshot {
  return {
    version: newsStore.getSnapshot(),
    feeds: newsStore.feeds,
    activeId: newsStore.activeId,
    filter: newsStore.filterState,
    presets: newsStore.presetList,
    events: newsStore.allEvents(),
    filtered: newsStore.filteredEvents(),
    totalRows: newsStore.totalRows,
  };
}

/** Snapshot-per-render access: the component re-renders on `version`, arrays are memoized. */
export function useNews(): NewsSnapshot {
  useSyncExternalStore(newsStore.subscribe, newsSnapshot, newsSnapshot);
  return newsSnapshot();
}

/** Currency legs of a symbol, so EURUSD shows both EUR and USD releases. */
export function currenciesForSymbol(symbol: string): string[] {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (s.length !== 6) return [s.slice(0, 3)];
  return [s.slice(0, 3), s.slice(3, 6)];
}
