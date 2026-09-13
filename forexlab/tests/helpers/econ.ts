/** Synthetic fixtures for the economic-news tests. No real data. */

import { CandleSeries } from '../../src/core/data/series.ts';
import { emptyColumns } from '../../src/core/data/types.ts';
import type { EconEvent } from '../../src/core/econ/types.ts';

export const MIN = 60_000;

/**
 * Deterministic 1-minute series: flat-ish random walk, with an optional scripted
 * jump at `jumps` (time → pips) so reactions are known exactly.
 */
export function minuteSeries(start: number, bars: number, opts: { seed?: number; jumps?: Record<number, number>; price?: number; drift?: number } = {}): CandleSeries {
  let s = (opts.seed ?? 7) >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const cols = emptyColumns(bars);
  let price = opts.price ?? 1.1;
  const jumps = opts.jumps ?? {};
  for (let i = 0; i < bars; i++) {
    const t = start + i * MIN;
    const jump = (jumps[t] ?? 0) * 0.0001;
    const noise = (rnd() - 0.5) * 0.00004 + (opts.drift ?? 0) * 0.0001;
    const o = price;
    const c = +(o + jump + noise).toFixed(5);
    const h = +(Math.max(o, c) + rnd() * 0.00002).toFixed(5);
    const l = +(Math.min(o, c) - rnd() * 0.00002).toFixed(5);
    cols.t[i] = t;
    cols.o[i] = o;
    cols.h[i] = h;
    cols.l[i] = l;
    cols.c[i] = c;
    cols.v[i] = 100;
    cols.n[i] = 1;
    price = c;
  }
  return new CandleSeries({ symbol: 'EURUSD', tf: '1m', tz: 'UTC', cols, hasVolume: true });
}

let n = 0;
export function ev(time: number, patch: Partial<EconEvent> = {}): EconEvent {
  n++;
  const currency = patch.currency ?? 'USD';
  const title = patch.event ?? 'Consumer Price Index (YoY)';
  return {
    id: patch.id ?? `e${n}`,
    time,
    currency,
    country: null,
    impact: 'high',
    event: title,
    key: patch.key ?? `${currency}|${title.toLowerCase()}`,
    type: 'CPI',
    category: 'Inflation',
    subcategory: null,
    actual: 3.1,
    forecast: 3.0,
    previous: 3.2,
    revisedPrevious: null,
    row: n,
    unit: '%',
    batchId: 'test',
    ...patch,
  };
}

/** Monthly releases of one indicator with scripted actual/forecast pairs. */
export function releases(start: number, pairs: [number, number][], patch: Partial<EconEvent> = {}): EconEvent[] {
  return pairs.map(([actual, forecast], i) => ev(start + i * 30 * 86_400_000, { actual, forecast, id: `r${i}`, ...patch }));
}
