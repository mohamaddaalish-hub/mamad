/**
 * Drawing model.
 *
 * A drawing is anchored to **(time, price)** — never to pixels — so it stays glued
 * to the market it was drawn on through zoom, pan, window resize, timeframe change,
 * fullscreen and navigation. Screen positions are derived on demand.
 *
 * Nothing here touches the DOM or React; the same code runs for hit-testing,
 * painting and (later) for the replay/backtest layers.
 */

import type { Viewport } from '../chart/viewport.ts';
import type { CandleSeries } from '../data/series.ts';
import { uid } from '../util/format.ts';

export type DrawingKind =
  | 'hline'
  | 'vline'
  | 'trend'
  | 'ray'
  | 'xline'
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'triangle'
  | 'arrow'
  | 'daterange'
  | 'pricerange'
  | 'pricedaterange'
  | 'brush'
  | 'text'
  | 'callout'
  | 'fib'
  | 'fibext';

export interface Anchor {
  /** Timestamp of the bar the anchor sits on (ms since epoch). */
  t: number;
  /** Price level. Ignored by time-only tools, derived for price-only tools. */
  p: number;
}

export type LineStyle = 'solid' | 'dash' | 'dot';

export interface DrawStyle {
  color: string;
  /** 0..1 — 0 is invisible, used for fills too. */
  opacity: number;
  width: number;
  style: LineStyle;
  /** null = no fill. */
  fill: string | null;
  fillOpacity: number;
  font: 'sm' | 'md' | 'lg';
  /** Draw the price/time label on the axis. */
  label: boolean;
}

export interface Drawing {
  id: string;
  kind: DrawingKind;
  /** Drawings belong to a dataset; they are not silently reused across symbols. */
  datasetId: string | null;
  symbol: string;
  anchors: Anchor[];
  style: DrawStyle;
  text: string;
  locked: boolean;
  hidden: boolean;
  /** Fib levels as fractions of the swing (0 = anchor A, 1 = anchor B). */
  levels: number[];
  createdAt: number;
  updatedAt: number;
  /** Manual z-order; higher paints later. */
  order: number;
  note?: string;
}

export const FIB_DEFAULT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2];
export const FIB_EXT_DEFAULT_LEVELS = [0, 0.5, 0.618, 1, 1.272, 1.618, 2, 2.618];

export const DRAWING_TOOLS: { kind: DrawingKind; label: string; icon: string; points: number; key?: string; hint: string }[] = [
  { kind: 'hline', label: 'Horizontal line', icon: 'hline', points: 1, key: 'H', hint: 'Click at a price level' },
  { kind: 'vline', label: 'Vertical line', icon: 'vline', points: 1, key: 'V', hint: 'Click at a time' },
  { kind: 'trend', label: 'Trend line', icon: 'trend', points: 2, key: 'T', hint: 'Drag from swing point to swing point' },
  { kind: 'ray', label: 'Ray', icon: 'ray', points: 2, hint: 'Starts at the anchor, extends right forever' },
  { kind: 'xline', label: 'Extended line', icon: 'xline', points: 2, hint: 'Extends through both anchors' },
  { kind: 'rect', label: 'Rectangle', icon: 'rect', points: 2, hint: 'Drag a box; both corners are anchored' },
  { kind: 'circle', label: 'Circle', icon: 'circle', points: 2, hint: 'Drag from centre to edge' },
  { kind: 'ellipse', label: 'Ellipse', icon: 'ellipse', points: 2, hint: 'Drag a bounding box' },
  { kind: 'triangle', label: 'Triangle', icon: 'triangle', points: 2, hint: 'Drag a bounding box' },
  { kind: 'arrow', label: 'Arrow', icon: 'arrow', points: 2, hint: 'Drag from tail to head' },
  { kind: 'daterange', label: 'Date range', icon: 'dateRange', points: 2, hint: 'Drag to measure time' },
  { kind: 'pricerange', label: 'Price range', icon: 'priceRange', points: 2, hint: 'Drag to measure price' },
  { kind: 'pricedaterange', label: 'Price + date range', icon: 'priceDateRange', points: 2, hint: 'Drag to measure both' },
  { kind: 'brush', label: 'Brush', icon: 'brush', points: 0, hint: 'Freehand; each bar crossed adds a point' },
  { kind: 'text', label: 'Text', icon: 'text', points: 1, key: 'Shift + T', hint: 'Click, then type' },
  { kind: 'callout', label: 'Callout', icon: 'callout', points: 1, hint: 'Click where the pointer should land' },
  { kind: 'fib', label: 'Fib retracement', icon: 'fib', points: 2, hint: 'Drag from swing low to swing high' },
  { kind: 'fibext', label: 'Fib extension', icon: 'fibExt', points: 3, hint: 'Swing low, swing high, then the retracement point' },
];

export const TOOL_BY_KIND: Record<DrawingKind, (typeof DRAWING_TOOLS)[number]> = DRAWING_TOOLS.reduce(
  (acc, t) => {
    acc[t.kind] = t;
    return acc;
  },
  {} as Record<DrawingKind, (typeof DRAWING_TOOLS)[number]>,
);

export const DEFAULT_STYLE: DrawStyle = {
  color: '#5b8ec9',
  opacity: 0.95,
  width: 1.5,
  style: 'solid',
  fill: null,
  fillOpacity: 0.14,
  font: 'sm',
  label: true,
};

export const PALETTE = ['#5b8ec9', '#c9a24b', '#3c9d78', '#cf6068', '#9a86c9', '#ccd5e2', '#76839a', '#d0747c'];

export function toolOf(kind: DrawingKind): number {
  return TOOL_BY_KIND[kind]?.points ?? 2;
}

export function newDrawing(kind: DrawingKind, anchors: Anchor[], patch: Partial<Drawing> = {}): Drawing {
  const now = Date.now();
  return {
    id: uid('d'),
    kind,
    datasetId: null,
    symbol: '',
    anchors,
    style: { ...DEFAULT_STYLE, ...(kind === 'rect' || kind === 'ellipse' || kind === 'circle' || kind === 'triangle' || kind === 'pricedaterange' || kind === 'daterange' ? { fill: '#5b8ec9' } : {}) },
    text: kind === 'text' || kind === 'callout' ? 'Note' : '',
    locked: false,
    hidden: false,
    levels: kind === 'fib' ? [...FIB_DEFAULT_LEVELS] : kind === 'fibext' ? [...FIB_EXT_DEFAULT_LEVELS] : [],
    createdAt: now,
    updatedAt: now,
    order: 0,
    ...patch,
  };
}

/* ------------------------------------------------------------- projection */

export interface ScreenPoint {
  x: number;
  y: number;
  index: number;
}

/** Index of the bar that owns `t` — the last bar at or before it. */
export function anchorIndex(series: CandleSeries, t: number): number {
  const i = series.indexAtOrBefore(t);
  if (i >= 0) return i;
  return 0;
}

export function project(anchor: Anchor, view: Viewport, series: CandleSeries): ScreenPoint {
  const index = anchorIndex(series, anchor.t);
  return { x: view.indexToX(index), y: view.priceToY(anchor.p), index };
}

export function unproject(x: number, y: number, view: Viewport, series: CandleSeries, snapPrice?: (price: number, index: number) => number): Anchor {
  const raw = view.xToIndex(x);
  const index = Math.max(0, Math.min(series.count - 1, Math.round(raw)));
  const price = view.yToPrice(y);
  return { t: series.time(index), p: snapPrice ? snapPrice(price, index) : price };
}

/** Snapping candidates: the extremes and close of the bar under the cursor. */
export function snapPrice(series: CandleSeries, index: number, price: number, tolerancePx: number, view: Viewport): number {
  const c = series.candle(index);
  if (!c) return price;
  const candidates = [c.h, c.l, c.o, c.c];
  let best = price;
  let bestD = tolerancePx;
  for (const cand of candidates) {
    const d = Math.abs(view.priceToY(cand) - view.priceToY(price));
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best;
}

/* --------------------------------------------------------------- geometry */

export interface Segment {
  a: ScreenPoint;
  b: ScreenPoint;
}

/** Axis-aligned box from two anchors, in screen space (a.left/right/top/bottom). */
export function boxOf(a: ScreenPoint, b: ScreenPoint): { x: number; y: number; w: number; h: number } {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function fibLevels(d: Pick<Drawing, 'anchors' | 'levels'>): { level: number; price: number; index: number }[] {
  if (d.anchors.length < 2) return [];
  const a = d.anchors[0];
  const b = d.anchors[1];
  const span = b.p - a.p;
  return d.levels.map((level, i) => ({ level, price: b.p - span * level, index: i }));
}

/** Three-point extension: projection of the swing measured from the retracement. */
export function fibExtLevels(d: Pick<Drawing, 'anchors' | 'levels'>): { level: number; price: number; index: number }[] {
  if (d.anchors.length < 3) return [];
  const [a, b, c] = d.anchors;
  const swing = b.p - a.p;
  return d.levels.map((level, i) => ({ level, price: c.p + swing * level, index: i }));
}

export function isTimeOnly(kind: DrawingKind): boolean {
  return kind === 'vline' || kind === 'daterange';
}

export function isPriceOnly(kind: DrawingKind): boolean {
  return kind === 'hline' || kind === 'pricerange';
}

/** Horizontal extent the shape occupies in bar-index space (for clipping/visibility). */
export function indexSpan(d: Drawing, series: CandleSeries): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const a of d.anchors) {
    const i = anchorIndex(series, a.t);
    if (i < lo) lo = i;
    if (i > hi) hi = i;
  }
  if (!Number.isFinite(lo)) return [0, 0];
  if (d.kind === 'ray') hi = series.count - 1;
  if (d.kind === 'xline') {
    lo = 0;
    hi = series.count - 1;
  }
  return [lo, hi];
}

export function priceSpan(d: Drawing): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const a of d.anchors) {
    if (a.p < lo) lo = a.p;
    if (a.p > hi) hi = a.p;
  }
  for (const l of fibLevels(d)) {
    if (l.price < lo) lo = l.price;
    if (l.price > hi) hi = l.price;
  }
  for (const l of fibExtLevels(d)) {
    if (l.price < lo) lo = l.price;
    if (l.price > hi) hi = l.price;
  }
  if (!Number.isFinite(lo)) return [0, 0];
  return [lo, hi];
}

/**
 * True when a shape cannot be painted at all because everything it knows about
 * lies beyond the replay barrier. Price-only tools (horizontal line, price range)
 * are exempt: their level spans all of time, and the level itself was chosen from
 * bars the user was allowed to see.
 */
export function touchesReplayBoundary(d: Drawing, series: CandleSeries, limitIndex: number): boolean {
  if (isPriceOnly(d.kind)) return false;
  const [lo] = indexSpan(d, series);
  return lo > limitIndex;
}

/* ---------------------------------------------------------------- metrics */

export function timeDelta(d: Drawing): { ms: number; bars: number } | null {
  if (d.anchors.length < 2) return null;
  return { ms: Math.abs(d.anchors[1].t - d.anchors[0].t), bars: 0 };
}

export function priceDelta(d: Drawing): number | null {
  if (d.anchors.length < 2) return null;
  return Math.abs(d.anchors[1].p - d.anchors[0].p);
}

/* ------------------------------------------------------------- hit testing */

export type HitTarget = { type: 'body' } | { type: 'anchor'; index: number } | null;

const HANDLE_PX = 7;

export function distToSegment(px: number, py: number, seg: Segment): number {
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - seg.a.x, py - seg.a.y);
  let t = ((px - seg.a.x) * dx + (py - seg.a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (seg.a.x + t * dx), py - (seg.a.y + t * dy));
}

/**
 * Where the pointer landed on a drawing: an anchor handle wins over the body so
 * resizing stays possible even when handles overlap the shape.
 */
export function hitTest(
  d: Drawing,
  view: Viewport,
  series: CandleSeries,
  x: number,
  y: number,
  tolerance = 6,
): HitTarget {
  const pts = d.anchors.map((a) => project(a, view, series));
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(pts[i].x - x, pts[i].y - y) <= HANDLE_PX + tolerance) return { type: 'anchor', index: i };
  }
  const tol = tolerance + d.style.width;
  switch (d.kind) {
    case 'hline': {
      return Math.abs(pts[0].y - y) <= tol ? { type: 'body' } : null;
    }
    case 'vline': {
      return Math.abs(pts[0].x - x) <= tol ? { type: 'body' } : null;
    }
    case 'trend':
    case 'arrow': {
      if (pts.length < 2) return null;
      return distToSegment(x, y, { a: pts[0], b: pts[1] }) <= tol ? { type: 'body' } : null;
    }
    case 'ray': {
      if (pts.length < 2) return null;
      const dir = pts[1].x - pts[0].x;
      const along = (x - pts[0].x) * Math.sign(dir || 1);
      if (along < 0) return null;
      const slope = (pts[1].y - pts[0].y) / (pts[1].x - pts[0].x || 1);
      const yOnLine = pts[0].y + slope * (x - pts[0].x);
      return Math.abs(yOnLine - y) <= tol ? { type: 'body' } : null;
    }
    case 'xline': {
      if (pts.length < 2) return null;
      const slope = (pts[1].y - pts[0].y) / (pts[1].x - pts[0].x || 1);
      const yOnLine = pts[0].y + slope * (x - pts[0].x);
      return Math.abs(yOnLine - y) <= tol ? { type: 'body' } : null;
    }
    case 'rect':
    case 'pricedaterange':
    case 'daterange':
    case 'pricerange': {
      if (pts.length < 2) return null;
      const box = boxOf(pts[0], pts[1]);
      const outside = x < box.x - tol || x > box.x + box.w + tol || y < box.y - tol || y > box.y + box.h + tol;
      if (outside) return null;
      // Filled boxes are grab-anywhere; outlines need the pointer near an edge.
      if (d.style.fill || d.kind === 'daterange' || d.kind === 'pricerange') return { type: 'body' };
      const nearEdge =
        Math.abs(x - box.x) <= tol ||
        Math.abs(x - (box.x + box.w)) <= tol ||
        Math.abs(y - box.y) <= tol ||
        Math.abs(y - (box.y + box.h)) <= tol;
      return nearEdge ? { type: 'body' } : null;
    }
    case 'circle':
    case 'ellipse': {
      if (pts.length < 2) return null;
      const box = boxOf(pts[0], pts[1]);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const rx = Math.max(1, box.w / 2);
      const ry = Math.max(1, box.h / 2);
      const v = Math.sqrt(((x - cx) * (x - cx)) / (rx * rx) + ((y - cy) * (y - cy)) / (ry * ry));
      const nearRing = Math.abs(v - 1) * Math.min(rx, ry) <= tol;
      if (d.style.fill) return v <= 1 + tol / Math.min(rx, ry) || nearRing ? { type: 'body' } : null;
      return nearRing ? { type: 'body' } : null;
    }
    case 'triangle': {
      if (pts.length < 2) return null;
      const box = boxOf(pts[0], pts[1]);
      return x >= box.x - tol && x <= box.x + box.w + tol && y >= box.y - tol && y <= box.y + box.h + tol ? { type: 'body' } : null;
    }
    case 'text':
    case 'callout': {
      if (!pts.length) return null;
      const w = Math.max(40, d.text.length * 6.6 + 16);
      const box = d.kind === 'callout' ? { x: pts[0].x, y: pts[0].y - 34, w, h: 22 } : { x: pts[0].x - w / 2, y: pts[0].y - 11, w, h: 22 };
      return x >= box.x - tol && x <= box.x + box.w + tol && y >= box.y - tol && y <= box.y + box.h + tol ? { type: 'body' } : null;
    }
    case 'brush': {
      for (let i = 1; i < pts.length; i++) {
        if (distToSegment(x, y, { a: pts[i - 1], b: pts[i] }) <= tol) return { type: 'body' };
      }
      return null;
    }
    case 'fib':
    case 'fibext': {
      if (pts.length < 2) return null;
      const view2 = { priceToY: (p: number) => view.priceToY(p) };
      const levels = d.kind === 'fib' ? fibLevels(d) : fibExtLevels(d);
      const lo = Math.min(pts[0].x, pts[1].x);
      const hi = Math.max(pts[0].x, pts[1].x);
      for (const l of levels) {
        const ly = view2.priceToY(l.price);
        if (Math.abs(ly - y) <= tol && (x >= lo - tol && x <= hi + tol)) return { type: 'body' };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Screen positions of the grab handles, for painting and hit-testing alike. */
export function handlesOf(d: Drawing, view: Viewport, series: CandleSeries): ScreenPoint[] {
  return d.anchors.map((a) => project(a, view, series));
}

/* ---------------------------------------------------------- serialisation */

export interface SerializedDrawing {
  v: 1;
  id: string;
  kind: DrawingKind;
  datasetId: string | null;
  symbol: string;
  anchors: Anchor[];
  style: DrawStyle;
  text: string;
  locked: boolean;
  hidden: boolean;
  levels: number[];
  createdAt: number;
  updatedAt: number;
  order: number;
  note?: string;
}

export function serialize(d: Drawing): SerializedDrawing {
  return { v: 1, ...structuredCloneSafe(d) };
}

export function deserialize(raw: SerializedDrawing | Drawing): Drawing | null {
  const d = raw as Partial<Drawing>;
  if (!d || typeof d.kind !== 'string' || !Array.isArray(d.anchors)) return null;
  return {
    id: typeof d.id === 'string' ? d.id : uid('d'),
    kind: d.kind as DrawingKind,
    datasetId: d.datasetId ?? null,
    symbol: d.symbol ?? '',
    anchors: d.anchors.filter((a) => a && Number.isFinite(a.t) && Number.isFinite(a.p)),
    style: { ...DEFAULT_STYLE, ...(d.style ?? {}) },
    text: typeof d.text === 'string' ? d.text : '',
    locked: Boolean(d.locked),
    hidden: Boolean(d.hidden),
    levels: Array.isArray(d.levels) ? d.levels.filter((l) => Number.isFinite(l)) : [],
    createdAt: Number.isFinite(d.createdAt) ? (d.createdAt as number) : Date.now(),
    updatedAt: Number.isFinite(d.updatedAt) ? (d.updatedAt as number) : Date.now(),
    order: Number.isFinite(d.order) ? (d.order as number) : 0,
    note: typeof d.note === 'string' ? d.note : undefined,
  };
}

/** Plain-object copy (avoids structuredClone unavailability in some runtimes). */
export function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneDrawing(d: Drawing, patch: Partial<Drawing> = {}): Drawing {
  return { ...structuredCloneSafe(d), ...patch, id: uid('d'), createdAt: Date.now(), updatedAt: Date.now() };
}

export function moveDrawing(d: Drawing, dtBars: number, dPrice: number, series: CandleSeries): Drawing {
  if (dtBars === 0 && dPrice === 0) return d;
  const anchors = d.anchors.map((a) => {
    const i = Math.max(0, Math.min(series.count - 1, anchorIndex(series, a.t) + dtBars));
    return { t: series.time(i), p: a.p + dPrice };
  });
  return { ...d, anchors, updatedAt: Date.now() };
}
