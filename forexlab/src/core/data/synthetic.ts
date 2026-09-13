/**
 * Deterministic synthetic OHLCV generator.
 *
 * This exists for two reasons only: automated tests, and an unmistakably labelled
 * "fixture" mode so the workstation can be exercised without a real file. It is
 * never presented as market data, never auto-loaded, and the UI always tags it.
 *
 * Model: random walk with intraday volatility smile (Asia quiet, London/NY busy),
 * weekends closed, and a realistic tick-volume proxy.
 */

import type { CandleColumns } from '../data/types.ts';
import { timeframe, type TimeframeId } from '../time/timeframes.ts';

export interface SyntheticOptions {
  symbol?: string;
  tf?: TimeframeId;
  start: number;
  bars: number;
  seed?: number;
  /** Starting mid price. */
  price?: number;
  /** Volatility per bar as a fraction of price (1e-4 ≈ 1 pip on EURUSD). */
  vol?: number;
  /** Skip Saturday/Sunday for intraday timeframes. */
  skipWeekends?: boolean;
  /** Inject gaps (missing bars) to exercise import diagnostics. */
  gaps?: { at: number; length: number }[];
  trend?: number;
}

/** xorshift32 — small, fast, reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Hour-of-day (UTC) volatility multiplier: quiet Asia, busy London/NY. */
function sessionFactor(t: number): number {
  const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
  if (hour >= 7 && hour < 12) return 1.7; // London
  if (hour >= 12 && hour < 17) return 2.2; // London/NY overlap
  if (hour >= 17 && hour < 21) return 1.3; // NY afternoon
  if (hour >= 22 || hour < 2) return 1.05; // Asia
  return 0.6; // late NY / Sydney quiet
}

export function syntheticCandles(opts: SyntheticOptions): { cols: CandleColumns; tf: TimeframeId } {
  const tf = opts.tf ?? '1m';
  const step = timeframe(tf).ms ?? 86_400_000;
  const want = Math.max(1, Math.floor(opts.bars));
  const rand = rng(opts.seed ?? 12345);
  const vol = opts.vol ?? 2.2e-4;
  const skipWeekends = opts.skipWeekends !== false && timeframe(tf).kind === 'intraday';
  const gapSet = new Set<number>();
  for (const g of opts.gaps ?? []) {
    for (let k = 0; k < g.length; k++) gapSet.add(g.at + k);
  }
  const tv: number[] = [];
  const ov: number[] = [];
  const hv: number[] = [];
  const lv: number[] = [];
  const cv: number[] = [];
  const vv: number[] = [];
  let price = opts.price ?? 1.085;
  const trend = opts.trend ?? 0;
  let cursor = Math.floor(opts.start / step) * step;
  let slot = 0;
  let guard = 0;
  while (tv.length < want && guard++ < want * 4 + 5000) {
    if (skipWeekends) {
      const d = new Date(cursor);
      const wd = d.getUTCDay();
      // FX closes Friday 21:00 UTC and reopens Sunday 21:00 UTC.
      if (wd === 6 || wd === 0 || (wd === 5 && d.getUTCHours() >= 21)) {
        cursor += step;
        slot++;
        continue;
      }
    }
    if (gapSet.has(slot)) {
      cursor += step;
      slot++;
      continue;
    }
    const i = tv.length;
    const sigma = vol * sessionFactor(cursor) * (1 + 0.5 * Math.sin(i / 480));
    const open = price;
    const drift = trend * sigma;
    let close = open + gaussian(rand) * open * sigma + drift * open;
    // Keep the walk sane so tests never see a runaway price.
    if (!Number.isFinite(close) || close <= 0.2 || close > 5) close = open * (1 + sigma * 0.5);
    const wickUp = Math.abs(gaussian(rand)) * open * sigma * 0.65;
    const wickDown = Math.abs(gaussian(rand)) * open * sigma * 0.65;
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;
    tv.push(cursor);
    ov.push(round6(open));
    hv.push(round6(high));
    lv.push(round6(low));
    cv.push(round6(close));
    vv.push(Math.round(120 + Math.abs(gaussian(rand)) * 90 + sessionFactor(cursor) * 260));
    price = close;
    cursor += step;
    slot++;
  }
  const len = tv.length;
  const t = Float64Array.from(tv);
  const o = Float64Array.from(ov);
  const h = Float64Array.from(hv);
  const l = Float64Array.from(lv);
  const c = Float64Array.from(cv);
  const v = Float64Array.from(vv);
  const n = new Uint32Array(len).fill(1);
  return { cols: { t, o, h, l, c, v, n, len }, tf };
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Compact CSV text for the same series — used to exercise the importer end-to-end. */
export function syntheticCsv(opts: SyntheticOptions & { bars?: number }): string {
  const { cols } = syntheticCandles(opts);
  const lines: string[] = ['Date,Time,Open,High,Low,Close,Volume'];
  for (let i = 0; i < cols.len; i++) {
    const d = new Date(cols.t[i]);
    const date = d.toISOString().slice(0, 10);
    const time = d.toISOString().slice(11, 16);
    lines.push(
      `${date},${time},${cols.o[i].toFixed(5)},${cols.h[i].toFixed(5)},${cols.l[i].toFixed(5)},${cols.c[i].toFixed(5)},${cols.v[i]}`,
    );
  }
  return lines.join('\n');
}
