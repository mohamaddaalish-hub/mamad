/**
 * Level-of-detail pyramid ("mipmap chain") for candle rendering.
 *
 * Why: 5 years of 1-minute EUR/USD is ~2.6M rows. Painting every row when the
 * whole span is on screen would drop the frame rate to single digits. The
 * pyramid folds groups of PYR_FACTOR rows into one OHLC envelope, so a frame
 * paints ~O(plot width) primitives at whatever level matches the visible span.
 *
 * Replay safety: a level-L bucket may only be used when its whole base extent
 * lies below the replay barrier. Buckets straddling the barrier are dropped and
 * their rows are painted from level 0 instead, so an aggregated frame can never
 * smuggle in a future high/low/close.
 */

import { emptyColumns, foldRange, sliceColumns, type CandleColumns } from './types.ts';

export const PYR_FACTOR = 16;
export const PYR_MAX_LEVELS = 6;

export interface PyramidLevel {
  depth: number;
  factor: number;
  cols: CandleColumns;
}

/** A run of rows at one level of detail. `from`/`to` index that level's arrays. */
export interface RenderSegment {
  depth: number;
  /** Base rows per bucket at this depth. */
  factor: number;
  from: number;
  to: number;
}

export interface RenderPlan {
  segments: RenderSegment[];
  /** Paintable primitive count for the frame. */
  primitives: number;
  /** Base-row span actually covered (already clamped to the barrier). */
  baseFrom: number;
  baseTo: number;
  /** Level used for the main body (0 = exact candles). */
  depth: number;
}

const EMPTY_PLAN: RenderPlan = { segments: [], primitives: 0, baseFrom: 0, baseTo: 0, depth: 0 };

export class Pyramid {
  readonly base: CandleColumns;
  private levels: (PyramidLevel | null)[];
  /** Barrier the pyramid was built for; only used for cache invalidation by callers. */
  limit = Infinity;

  constructor(base: CandleColumns) {
    this.base = base;
    this.levels = new Array<PyramidLevel | null>(PYR_MAX_LEVELS).fill(null);
    this.levels[0] = { depth: 0, factor: 1, cols: base };
  }

  get rowCount(): number {
    return this.base.len;
  }

  level(depth: number): PyramidLevel {
    const d = Math.max(0, Math.min(PYR_MAX_LEVELS - 1, depth));
    const cached = this.levels[d];
    if (cached) return cached;
    const parent = this.level(d - 1);
    const built = foldLevel(parent.cols, d);
    this.levels[d] = built;
    return built;
  }

  /** Finest level whose bucket count still fits the paint budget. */
  private depthFor(span: number, maxPrimitives: number): number {
    let depth = 0;
    let factor = 1;
    while (depth + 1 < PYR_MAX_LEVELS && span / factor > maxPrimitives) {
      depth++;
      factor *= PYR_FACTOR;
    }
    return depth;
  }

  /**
   * Paint plan for base rows [i0,i1) with the replay barrier at `limit`.
   *
   * `maxPrimitives` is about one primitive per horizontal pixel: the coarsest
   * acceptable level is chosen, then a level-0 tail covers rows whose bucket
   * straddles the barrier.
   */
  plan(i0: number, i1: number, limit: number, maxPrimitives: number): RenderPlan {
    const from = Math.max(0, Math.min(i0, Math.min(limit, this.base.len)));
    const to = Math.max(from, Math.min(i1, Math.min(limit, this.base.len)));
    const span = to - from;
    if (span <= 0) return EMPTY_PLAN;
    const budget = Math.max(8, Math.floor(maxPrimitives));
    const depth = this.depthFor(span, budget);
    const factor = Math.pow(PYR_FACTOR, depth);
    const segments: RenderSegment[] = [];
    let primitives = 0;
    let cursor = from;
    if (factor > 1) {
      // Complete buckets of this level that end at or before the barrier.
      const safeBaseEnd = Math.min(to, Math.floor(limit / factor) * factor);
      if (safeBaseEnd > cursor) {
        const b0 = Math.floor(cursor / factor);
        const b1 = Math.ceil(safeBaseEnd / factor);
        const lvl = this.level(depth);
        const to2 = Math.min(b1, lvl.cols.len);
        segments.push({ depth, factor, from: b0, to: to2 });
        primitives += Math.max(0, to2 - b0);
        cursor = safeBaseEnd;
      }
    }
    if (to > cursor) {
      segments.push({ depth: 0, factor: 1, from: cursor, to });
      primitives += to - cursor;
    }
    return { segments, primitives, baseFrom: from, baseTo: to, depth };
  }

  /**
   * Price envelope of a plan, used for auto-scaling so the vertical scale lines
   * up with what is really painted. Edge buckets that stick out of the clipped
   * span are re-folded from level 0, which keeps the bounds exact.
   */
  boundsFor(plan: RenderPlan): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    const grow = (lo: number, hi: number) => {
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    };
    for (const seg of plan.segments) {
      if (seg.depth === 0) {
        const cols = this.base;
        for (let i = seg.from; i < seg.to; i++) {
          grow(cols.l[i], cols.h[i]);
        }
        continue;
      }
      const cols = this.level(seg.depth).cols;
      for (let i = seg.from; i < seg.to; i++) {
        const s = i * seg.factor;
        const e = s + seg.factor;
        if (s >= plan.baseFrom && e <= plan.baseTo) {
          grow(cols.l[i], cols.h[i]);
        } else {
          const fold = foldRange(this.base, Math.max(s, plan.baseFrom), Math.min(e, plan.baseTo));
          if (fold) grow(fold.l, fold.h);
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    return { min, max };
  }

  /** Drop lazily built coarse levels (used when the base series is replaced). */
  reset(): void {
    for (let d = 1; d < PYR_MAX_LEVELS; d++) this.levels[d] = null;
  }
}

function foldLevel(src: CandleColumns, depth: number): PyramidLevel {
  const factor = Math.pow(PYR_FACTOR, depth);
  const buckets = Math.ceil(src.len / factor);
  const out = emptyColumns(Math.max(buckets, 1));
  const { t, o, h, l, c, v, n } = src;
  for (let b = 0; b < buckets; b++) {
    const s = b * factor;
    const e = Math.min(s + factor, src.len);
    let hi = -Infinity;
    let lo = Infinity;
    let vol = 0;
    let cnt = 0;
    for (let i = s; i < e; i++) {
      if (h[i] > hi) hi = h[i];
      if (l[i] < lo) lo = l[i];
      vol += v[i];
      cnt += n[i] || 1;
    }
    out.t[b] = t[s];
    out.o[b] = o[s];
    out.h[b] = hi;
    out.l[b] = lo;
    out.c[b] = c[e - 1];
    out.v[b] = vol;
    out.n[b] = cnt;
  }
  return {
    depth,
    factor,
    cols: out.len === buckets ? out : sliceColumns(out, 0, buckets),
  };
}
