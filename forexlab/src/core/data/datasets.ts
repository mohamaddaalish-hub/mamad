/**
 * Dataset registry: the only place that holds candle payloads.
 *
 * Metadata lives in IndexedDB (cheap, always loaded); the heavy typed arrays are
 * loaded on demand, kept in a module-level registry, and never passed through
 * React state. Aggregated timeframes and their level-of-detail pyramids are
 * memoised per (dataset, timeframe, timezone).
 */

import { aggregateSeries, CandleSeries } from './series.ts';
import { Pyramid } from './pyramid.ts';
import type { CandleColumns } from './types.ts';
import type { ImportReport } from '../csv/market.ts';
import { timeframe, type TimeframeId } from '../time/timeframes.ts';
import * as idb from '../store/idb.ts';

export interface DatasetRecord {
  id: string;
  symbol: string;
  label: string;
  fileName: string;
  bytes: number;
  tf: TimeframeId;
  tz: string;
  firstTime: number;
  lastTime: number;
  count: number;
  hasVolume: boolean;
  createdAt: number;
  report: ImportReport;
}

interface Loaded {
  series: CandleSeries;
  pyramid: Pyramid;
}

const COLS: (keyof CandleColumns)[] = ['t', 'o', 'h', 'l', 'c', 'v', 'n'];

export async function persistColumns(id: string, cols: CandleColumns): Promise<void> {
  const arrays = [cols.t, cols.o, cols.h, cols.l, cols.c, cols.v, cols.n];
  const names = COLS;
  await Promise.all(
    names.map((name, i) => idb.put('blobs', arrays[i].buffer, `${id}:${name}`)),
  );
}

export function columnsFromBuffers(buffers: Record<string, ArrayBuffer | undefined>, len: number): CandleColumns {
  const get = (name: string, ctor: 'f64' | 'u32'): Float64Array | Uint32Array => {
    const buf = buffers[name];
    if (!buf) return ctor === 'f64' ? new Float64Array(len) : new Uint32Array(len);
    return ctor === 'f64' ? new Float64Array(buf) : new Uint32Array(buf);
  };
  return {
    t: get('t', 'f64') as Float64Array,
    o: get('o', 'f64') as Float64Array,
    h: get('h', 'f64') as Float64Array,
    l: get('l', 'f64') as Float64Array,
    c: get('c', 'f64') as Float64Array,
    v: get('v', 'f64') as Float64Array,
    n: get('n', 'u32') as Uint32Array,
    len,
  };
}

class DatasetRegistry {
  private meta = new Map<string, DatasetRecord>();
  private loaded = new Map<string, Loaded>();
  private agg = new Map<string, Loaded>();
  private loading = new Map<string, Promise<Loaded>>();
  private listeners = new Set<() => void>();
  private hydrated = false;
  /** Cap on simultaneously held base series; older ones are evicted (re-loadable). */
  maxLoadedInMemory = 3;
  private order: string[] = [];

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  list(): DatasetRecord[] {
    return [...this.meta.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): DatasetRecord | undefined {
    return this.meta.get(id);
  }

  bySymbol(symbol: string): DatasetRecord[] {
    const s = symbol.toUpperCase();
    return this.list().filter((d) => d.symbol === s);
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const records = await idb.all<DatasetRecord>('datasets');
      for (const rec of records) this.meta.set(rec.id, rec);
      if (records.length > 0) this.emit();
    } catch (err) {
      // A missing/blocked IDB is not fatal: imported data stays for the session.
      console.warn('[datasets] hydrate failed', err);
    }
  }

  async register(record: DatasetRecord, cols: CandleColumns): Promise<void> {
    await persistColumns(record.id, cols);
    await idb.put('datasets', record, record.id);
    this.meta.set(record.id, record);
    this.retain(record.id, {
      series: new CandleSeries({
        symbol: record.symbol,
        tf: record.tf,
        tz: record.tz,
        cols,
        hasVolume: record.hasVolume,
        datasetId: record.id,
      }),
      pyramid: new Pyramid(cols),
    });
    this.emit();
  }

  private retain(id: string, loaded: Loaded): void {
    this.loaded.set(id, loaded);
    this.order = [id, ...this.order.filter((x) => x !== id)];
    while (this.order.length > this.maxLoadedInMemory) {
      const victim = this.order.pop();
      if (!victim || victim === id) continue;
      this.loaded.delete(victim);
      this.evictDerived(victim);
    }
  }

  private evictDerived(id: string): void {
    for (const key of [...this.agg.keys()]) {
      if (key.startsWith(`${id}|`)) this.agg.delete(key);
    }
  }

  /** Base series for a dataset, loading from IndexedDB on first use. */
  async base(id: string): Promise<CandleSeries | null> {
    const hit = this.loaded.get(id);
    if (hit) return hit.series;
    const inflight = this.loading.get(id);
    if (inflight) return (await inflight).series;
    const task = this.loadBase(id).finally(() => this.loading.delete(id));
    this.loading.set(id, task);
    return (await task).series;
  }

  private async loadBase(id: string): Promise<Loaded> {
    const rec = this.meta.get(id);
    if (!rec) throw new Error(`unknown dataset ${id}`);
    const names = ['t', 'o', 'h', 'l', 'c', 'v', 'n'];
    const buffers: Record<string, ArrayBuffer | undefined> = {};
    await Promise.all(
      names.map(async (name) => {
        buffers[name] = await idb.get<ArrayBuffer>('blobs', `${id}:${name}`);
      }),
    );
    const count = Math.min(rec.count, (buffers.t?.byteLength ?? 0) / 8);
    const cols = columnsFromBuffers(buffers, count);
    const loaded: Loaded = {
      series: new CandleSeries({
        symbol: rec.symbol,
        tf: rec.tf,
        tz: rec.tz,
        cols,
        hasVolume: rec.hasVolume,
        datasetId: id,
      }),
      pyramid: new Pyramid(cols),
    };
    this.retain(id, loaded);
    this.emit();
    return loaded;
  }

  /**
   * Series at the requested timeframe, aggregated from the base series when the
   * dataset is finer. Memoised: switching timeframes back and forth is free.
   */
  async view(id: string, tf: TimeframeId, tz: string): Promise<Loaded> {
    const rec = this.meta.get(id);
    if (!rec) throw new Error(`unknown dataset ${id}`);
    const key = `${id}|${tf}|${tz}`;
    const hit = this.agg.get(key);
    if (hit) return hit;
    const base = await this.base(id);
    if (!base) throw new Error(`dataset ${id} unavailable`);
    let loaded: Loaded;
    const reuseBase =
      rec.tf === tf && (timeframe(tf).kind === 'intraday' || rec.tz === tz);
    if (reuseBase) {
      const cached = this.loaded.get(id);
      loaded = { series: base, pyramid: cached?.pyramid ?? new Pyramid(base.cols) };
    } else {
      const series = aggregateSeries(base, tf, tz);
      loaded = { series, pyramid: new Pyramid(series.cols) };
    }
    this.agg.set(key, loaded);
    this.emit();
    return loaded;
  }

  /** Synchronous probe for the native-resolution series (already in memory once opened). */
  cachedBase(id: string): CandleSeries | null {
    return this.loaded.get(id)?.series ?? null;
  }

  /** Synchronous cache probe: never triggers IndexedDB reads or aggregation. */
  cachedView(id: string, tf: TimeframeId, tz: string): Loaded | null {
    const hit = this.agg.get(`${id}|${tf}|${tz}`);
    if (hit) return hit;
    const rec = this.meta.get(id);
    const base = this.loaded.get(id);
    if (base && rec && rec.tf === tf && (timeframe(tf).kind === 'intraday' || rec.tz === tz)) return base;
    return null;
  }

  estimatedBytes(id: string): number {
    const rec = this.meta.get(id);
    if (!rec) return 0;
    return rec.count * (6 * 8 + 4);
  }

  async remove(id: string): Promise<void> {
    const rec = this.meta.get(id);
    if (!rec) return;
    for (const name of ['t', 'o', 'h', 'l', 'c', 'v', 'n']) {
      await idb.del('blobs', `${id}:${name}`);
    }
    await idb.del('datasets', id);
    this.meta.delete(id);
    this.loaded.delete(id);
    this.evictDerived(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit();
  }

  inMemoryBytes(): number {
    let total = 0;
    for (const loaded of this.loaded.values()) total += loaded.series.cols.t.byteLength * 6;
    for (const [, loaded] of this.agg) total += loaded.series.cols.t.byteLength * 6;
    return total;
  }

  debugClearMemory(): void {
    this.loaded.clear();
    this.agg.clear();
    this.order = [];
  }
}

export const datasetRegistry = new DatasetRegistry();

export function newDatasetId(): string {
  return `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
