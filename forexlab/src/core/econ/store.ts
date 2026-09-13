/**
 * News store: the single owner of imported economic events.
 *
 * Events live in a module-level registry (never in React state); IndexedDB holds
 * the payload per import batch under `news` (metadata) and `blobs` (`news:<id>`
 * JSON). A small external store carries ids, versions and the filter/selection
 * view state so panels can subscribe cheaply.
 *
 * Replay gating is enforced here: `visibleEvents()` returns only events whose
 * release instant is ≤ the replay boundary. Every consumer — table, markers,
 * detail, statistics, backtests — reads through it (or through `knownUntil()`),
 * which is what makes "the 16:30 event does not exist at 16:20" a property of the
 * data layer rather than a UI convention.
 */

import * as idb from '../store/idb.ts';
import { createStore, useSlice } from '../store/state.ts';
import { appStore, pushDiagnostic } from '../app/state.ts';
import { chartHost } from '../chart/host.ts';
import { ALL_KNOWN, isAllKnown } from '../replay/boundary.ts';
import { overlayRegistry } from '../app/overlays.ts';
import type { EconEvent } from './types.ts';
import type { NewsImportSummary } from './csv.ts';
import { EventIndex } from './surprise.ts';
import { datasetRegistry } from '../data/datasets.ts';

export interface NewsBatchRecord {
  id: string;
  fileName: string;
  createdAt: number;
  count: number;
  firstTime: number | null;
  lastTime: number | null;
  tz: string;
  summary: Omit<NewsImportSummary, 'rejectedRows'> & { rejectedRows: NewsImportSummary['rejectedRows'] };
}

export interface NewsViewState {
  /** Bumps whenever the event set changes (import, delete). */
  version: number;
  batches: NewsBatchRecord[];
  hydrated: boolean;
  /** Event opened in the detail view. */
  detailId: string | null;
  /** Event history / comparison focus (indicator key). */
  historyKey: string | null;
  compareIds: string[];
  showOnChart: boolean;
  hiddenIds: string[];
}

export const newsStore = createStore<NewsViewState>({
  version: 0,
  batches: [],
  hydrated: false,
  detailId: null,
  historyKey: null,
  compareIds: [],
  showOnChart: true,
  hiddenIds: [],
});

export function useNews<K>(select: (s: NewsViewState) => K, isEqual?: (a: K, b: K) => boolean): K {
  return useSlice(newsStore, select, isEqual);
}

class NewsRegistry {
  private events: EconEvent[] = [];
  private index: EventIndex = new EventIndex([]);
  private hydrating: Promise<void> | null = null;

  /** Full event set — bypasses replay. Only for import summaries and the batch list. */
  allUngated(): readonly EconEvent[] {
    return this.events;
  }

  /** Index over the full set. Gated consumers must still pass `knownUntil` to the engines. */
  fullIndex(): EventIndex {
    return this.index;
  }

  count(): number {
    return this.events.length;
  }

  get(id: string): EconEvent | undefined {
    return this.index.byId.get(id);
  }

  async hydrate(): Promise<void> {
    if (newsStore.get().hydrated) return;
    if (this.hydrating) return this.hydrating;
    this.hydrating = (async () => {
      try {
        const batches = await idb.all<NewsBatchRecord>('news');
        const all: EconEvent[] = [];
        for (const b of batches) {
          const payload = await idb.get<EconEvent[]>('blobs', `news:${b.id}`);
          if (Array.isArray(payload)) all.push(...payload);
        }
        this.replace(all);
        newsStore.set({ batches: batches.sort((a, b) => a.createdAt - b.createdAt), hydrated: true });
      } catch (err) {
        console.warn('[news] hydrate failed', err);
        newsStore.set({ hydrated: true });
      }
    })();
    return this.hydrating;
  }

  private replace(events: EconEvent[]): void {
    this.events = events;
    this.index = new EventIndex(events);
    newsStore.set({ version: newsStore.get().version + 1 });
    overlayRegistry.scheduleSync();
  }

  async addBatch(record: NewsBatchRecord, events: EconEvent[]): Promise<void> {
    await idb.put('blobs', events, `news:${record.id}`);
    await idb.put('news', record, record.id);
    // Cross-batch duplicates: keep the earlier import's row.
    const existing = new Set(this.events.map((e) => `${e.key}@${e.time}`));
    const fresh = events.filter((e) => !existing.has(`${e.key}@${e.time}`));
    const dropped = events.length - fresh.length;
    if (dropped > 0) pushDiagnostic('info', `${dropped} events already existed in the library and were not duplicated`);
    this.replace([...this.events, ...fresh]);
    newsStore.set({ batches: [...newsStore.get().batches, record] });
  }

  async deleteBatch(id: string): Promise<void> {
    await idb.del('news', id);
    await idb.del('blobs', `news:${id}`);
    this.replace(this.events.filter((e) => e.batchId !== id));
    newsStore.set({ batches: newsStore.get().batches.filter((b) => b.id !== id) });
  }

  async clear(): Promise<void> {
    for (const b of newsStore.get().batches) await this.deleteBatch(b.id);
  }
}

export const newsRegistry = new NewsRegistry();

/* ------------------------------------------------------------------- gating */

/**
 * The instant up to which history is known. Outside replay everything is known
 * (ALL_KNOWN). During replay this is the app's authoritative replay boundary.
 */
export function knownUntil(): number {
  const r = appStore.get().replay;
  if (!r.active) return ALL_KNOWN;
  if (isAllKnown(r.knownUntil)) {
    // Replay active but boundary says everything known — only when at dataset end.
    return ALL_KNOWN;
  }
  return r.knownUntil as number;
}

export function isEventKnown(e: Pick<EconEvent, 'time'>, until = knownUntil()): boolean {
  return e.time <= until;
}

/** Events the user is allowed to know about right now. */
export function visibleEvents(until = knownUntil()): EconEvent[] {
  const all = newsRegistry.allUngated();
  if (until >= ALL_KNOWN - 1) return all as EconEvent[];
  // sorted by time → binary search
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (all[mid].time <= until) lo = mid + 1;
    else hi = mid;
  }
  return all.slice(0, lo) as EconEvent[];
}

/** Gated lookup: a future event is not found. */
export function visibleEvent(id: string, until = knownUntil()): EconEvent | null {
  const e = newsRegistry.get(id);
  if (!e || !isEventKnown(e, until)) return null;
  return e;
}

/**
 * The candle series consumers may analyse right now (gate-clipped). Prefers the
 * dataset's native resolution so reactions are measured on the finest bars the
 * user imported, independent of the timeframe currently displayed.
 */
export function analysisSeries() {
  const engine = chartHost.engine;
  if (!engine) return null;
  const id = appStore.get().datasetId;
  const base = (id ? datasetRegistry.cachedBase(id) : null) ?? engine.getBaseSeries();
  if (!base) return null;
  const r = appStore.get().replay;
  if (!r.active || isAllKnown(r.knownUntil)) return base;
  // Base series limited to bars fully known.
  const until = r.knownUntil as number;
  const step = base.stepMs ?? 0;
  const n = base.upper(until - step + 1);
  return base.withLimit(Math.max(0, Math.min(base.total, n)));
}

export function newNewsBatchId(): string {
  return `nb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
