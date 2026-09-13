/**
 * Drawing painters. Pure canvas code that reads the live store at paint time, so
 * a state change only needs `requestRender()` — no React involved.
 *
 * Replay rule: while a replay limits the view, geometry beyond the barrier is
 * clipped away and drawings that begin beyond it are not painted at all, so a
 * shape can never preview the future.
 */

import type { RenderContext } from '../chart/render.ts';
import { crisp } from '../chart/render.ts';
import { clamp } from '../chart/viewport.ts';
import { formatDate, formatTime } from '../time/tz.ts';
import { formatPips, formatPrice, priceToPips } from '../util/pips.ts';
import {
  boxOf,
  fibExtLevels,
  fibLevels,
  handlesOf,
  indexSpan,
  project,
  TOOL_BY_KIND,
  type Anchor,
  type Drawing,
  type DrawingKind,
  type LineStyle,
} from './model.ts';
import type { DrawingStore } from './store.ts';

export interface Draft {
  kind: DrawingKind;
  anchors: Anchor[];
}

export interface DrawingPaintDeps {
  store: DrawingStore;
  draft: () => Draft | null;
  /** Last index the user may see (replay barrier), or null when unlimited. */
  limitIndex: () => number | null;
}

const FONTS = { sm: 10, md: 11.5, lg: 14 } as const;

export function dashFor(style: LineStyle): number[] {
  return style === 'dash' ? [7, 4] : style === 'dot' ? [2, 3] : [];
}

export function paintDrawings(rc: RenderContext, deps: DrawingPaintDeps): void {
  const { ctx, geom, view, series } = rc;
  const limit = deps.limitIndex();
  const clippedTo = limit === null ? geom.plotRight : Math.min(geom.plotRight, view.indexToX(limit));
  // Cached, already z-sorted snapshot: no work per frame beyond painting.
  const datasetId = deps.store.dataset();
  const list = deps.store.getSnapshot().list.filter((d) => datasetId === null || d.datasetId === null || d.datasetId === datasetId);

  ctx.save();
  ctx.beginPath();
  ctx.rect(geom.plotLeft, geom.plotTop, Math.max(0, clippedTo - geom.plotLeft), geom.plotBottom - geom.plotTop);
  ctx.clip();

  for (const d of list) {
    if (d.hidden) continue;
    const [lo] = indexSpan(d, series);
    if (limit !== null && lo > limit) continue; // entirely in the future
    paintOne(rc, d, false);
  }
  ctx.restore();

  // Axis labels live outside the plot clip.
  ctx.save();
  for (const d of list) {
    if (d.hidden) continue;
    const [lo] = indexSpan(d, series);
    if (limit !== null && lo > limit) continue;
    paintAxisLabels(rc, d, clippedTo);
  }
  ctx.restore();

  const draft = deps.draft();
  if (draft) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(geom.plotLeft, geom.plotTop, geom.plotRight - geom.plotLeft, geom.plotBottom - geom.plotTop);
    ctx.clip();
    const asDrawing: Drawing = {
      id: 'draft',
      kind: draft.kind,
      datasetId: null,
      symbol: '',
      anchors: draft.anchors,
      style: { ...draftStyle() },
      text: draft.kind === 'text' || draft.kind === 'callout' ? '…' : '',
      locked: false,
      hidden: false,
      levels: draft.kind === 'fib' ? [0, 0.382, 0.5, 0.618, 1] : draft.kind === 'fibext' ? [0, 1, 1.272, 1.618] : [],
      createdAt: 0,
      updatedAt: 0,
      order: 0,
    };
    paintOne(rc, asDrawing, true);
    ctx.restore();
  }

  // Selection + handles, drawn over everything.
  const selected = new Set(deps.store.selection);
  for (const d of list) {
    if (d.hidden) continue;
    const isSel = selected.has(d.id);
    const isHover = deps.store.hoverId === d.id;
    if (!isSel && !isHover) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(geom.plotLeft, geom.plotTop, geom.plotRight - geom.plotLeft, geom.plotBottom - geom.plotTop);
    ctx.clip();
    ctx.strokeStyle = isSel ? rc.style.textColor : rc.style.mutedText;
    ctx.globalAlpha = isSel ? 0.85 : 0.5;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    halo(rc, d);
    ctx.setLineDash([]);
    if (isSel) {
      for (const h of handlesOf(d, view, series)) {
        const size = d.locked ? 4 : 7;
        ctx.fillStyle = rc.style.panelBg;
        ctx.strokeStyle = d.locked ? rc.style.mutedText : rc.style.textColor;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        if (d.locked) ctx.arc(h.x, h.y, size / 2 + 0.5, 0, Math.PI * 2);
        else ctx.rect(crisp(h.x - size / 2) - 0.5, crisp(h.y - size / 2) - 0.5, size, size);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function draftStyle(): Drawing['style'] {
  return { color: '#5b8ec9', opacity: 0.75, width: 1.4, style: 'dash', fill: null, fillOpacity: 0.1, font: 'sm', label: true };
}

function paintOne(rc: RenderContext, d: Drawing, isDraft: boolean): void {
  const { ctx, view, series, settings } = rc;
  const pts = d.anchors.map((a) => project(a, view, series));
  if (pts.length === 0) return;
  ctx.globalAlpha = clamp(d.style.opacity, 0.05, 1);
  ctx.strokeStyle = d.style.color;
  ctx.fillStyle = d.style.color;
  ctx.lineWidth = d.style.width;
  ctx.setLineDash(isDraft ? [] : dashFor(d.style.style));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const fontPx = FONTS[d.style.font];
  ctx.font = `${fontPx}px ${rc.style.fontFamily}`;
  const decimals = settings.priceDecimals;

  const strokeLine = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };
  const extend = (a: { x: number; y: number }, b: { x: number; y: number }, right: boolean, left = false): void => {
    const dx = b.x - a.x || 1e-6;
    const slope = (b.y - a.y) / dx;
    const x0 = left ? rc.geom.plotLeft - 4000 : a.x;
    const x1 = right ? rc.geom.plotRight + 4000 : b.x;
    ctx.beginPath();
    ctx.moveTo(x0, a.y + slope * (x0 - a.x));
    ctx.lineTo(x1, a.y + slope * (x1 - a.x));
    ctx.stroke();
  };

  switch (d.kind) {
    case 'hline': {
      ctx.beginPath();
      ctx.moveTo(rc.geom.plotLeft, crisp(pts[0].y));
      ctx.lineTo(rc.geom.plotRight, crisp(pts[0].y));
      ctx.stroke();
      break;
    }
    case 'vline': {
      ctx.beginPath();
      ctx.moveTo(crisp(pts[0].x), rc.geom.plotTop);
      ctx.lineTo(crisp(pts[0].x), rc.geom.plotBottom);
      ctx.stroke();
      break;
    }
    case 'trend': {
      if (pts.length < 2) break;
      strokeLine(pts[0], pts[1]);
      break;
    }
    case 'ray': {
      if (pts.length < 2) break;
      extend(pts[0], pts[1], pts[1].x > pts[0].x);
      strokeLine(pts[0], pts[1]);
      break;
    }
    case 'xline': {
      if (pts.length < 2) break;
      extend(pts[0], pts[1], true, true);
      break;
    }
    case 'rect':
    case 'pricedaterange': {
      if (pts.length < 2) break;
      const box = boxOf(pts[0], pts[1]);
      if (d.style.fill) {
        ctx.save();
        ctx.globalAlpha = clamp(d.style.fillOpacity, 0.02, 1);
        ctx.fillStyle = d.style.fill;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.restore();
      }
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      measurement(rc, d, box, decimals);
      break;
    }
    case 'daterange': {
      if (pts.length < 2) break;
      const box = { x: Math.min(pts[0].x, pts[1].x), y: rc.geom.plotTop, w: Math.abs(pts[1].x - pts[0].x), h: rc.geom.plotBottom - rc.geom.plotTop };
      ctx.save();
      ctx.globalAlpha = clamp(d.style.fillOpacity, 0.02, 1);
      ctx.fillStyle = d.style.fill ?? d.style.color;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(crisp(Math.min(pts[0].x, pts[1].x)), rc.geom.plotTop);
      ctx.lineTo(crisp(Math.min(pts[0].x, pts[1].x)), rc.geom.plotBottom);
      ctx.moveTo(crisp(Math.max(pts[0].x, pts[1].x)), rc.geom.plotTop);
      ctx.lineTo(crisp(Math.max(pts[0].x, pts[1].x)), rc.geom.plotBottom);
      ctx.stroke();
      measurement(rc, d, box, decimals);
      break;
    }
    case 'pricerange': {
      if (pts.length < 2) break;
      const y0 = Math.min(pts[0].y, pts[1].y);
      const y1 = Math.max(pts[0].y, pts[1].y);
      const box = { x: rc.geom.plotLeft, y: y0, w: rc.geom.plotRight - rc.geom.plotLeft, h: y1 - y0 };
      ctx.save();
      ctx.globalAlpha = clamp(d.style.fillOpacity, 0.02, 1);
      ctx.fillStyle = d.style.fill ?? d.style.color;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(rc.geom.plotLeft, crisp(y0));
      ctx.lineTo(rc.geom.plotRight, crisp(y0));
      ctx.moveTo(rc.geom.plotLeft, crisp(y1));
      ctx.lineTo(rc.geom.plotRight, crisp(y1));
      ctx.stroke();
      measurement(rc, d, box, decimals);
      break;
    }
    case 'circle':
    case 'ellipse': {
      if (pts.length < 2) break;
      const box = boxOf(pts[0], pts[1]);
      ctx.beginPath();
      ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, Math.max(1, box.w / 2), Math.max(1, box.h / 2), 0, 0, Math.PI * 2);
      if (d.style.fill) {
        ctx.save();
        ctx.globalAlpha = clamp(d.style.fillOpacity, 0.02, 1);
        ctx.fillStyle = d.style.fill;
        ctx.fill();
        ctx.restore();
      }
      ctx.stroke();
      break;
    }
    case 'triangle': {
      if (pts.length < 2) break;
      const box = boxOf(pts[0], pts[1]);
      ctx.beginPath();
      ctx.moveTo(box.x + box.w / 2, box.y);
      ctx.lineTo(box.x + box.w, box.y + box.h);
      ctx.lineTo(box.x, box.y + box.h);
      ctx.closePath();
      if (d.style.fill) {
        ctx.save();
        ctx.globalAlpha = clamp(d.style.fillOpacity, 0.02, 1);
        ctx.fillStyle = d.style.fill;
        ctx.fill();
        ctx.restore();
      }
      ctx.stroke();
      break;
    }
    case 'arrow': {
      if (pts.length < 2) break;
      strokeLine(pts[0], pts[1]);
      const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      const head = 8 + d.style.width * 2;
      ctx.beginPath();
      ctx.moveTo(pts[1].x, pts[1].y);
      ctx.lineTo(pts[1].x - head * Math.cos(angle - 0.4), pts[1].y - head * Math.sin(angle - 0.4));
      ctx.moveTo(pts[1].x, pts[1].y);
      ctx.lineTo(pts[1].x - head * Math.cos(angle + 0.4), pts[1].y - head * Math.sin(angle + 0.4));
      ctx.stroke();
      break;
    }
    case 'brush': {
      if (pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      break;
    }
    case 'text': {
      label(rc, d.text, pts[0].x, pts[0].y, { align: 'center', box: false });
      break;
    }
    case 'callout': {
      const bx = pts[0].x + 14;
      const by = pts[0].y - 26;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 2.6, 0, Math.PI * 2);
      ctx.fill();
      strokeLine(pts[0], { x: bx, y: by + 9 });
      label(rc, d.text, bx, by, { align: 'left', box: true });
      break;
    }
    case 'fib':
    case 'fibext': {
      if (pts.length < 2) break;
      const levels = d.kind === 'fib' ? fibLevels(d) : fibExtLevels(d);
      const x0 = Math.min(pts[0].x, pts[1].x);
      const x1 = Math.max(pts[0].x, pts[1].x);
      const left = d.kind === 'fib' ? rc.geom.plotLeft : x0;
      const right = d.kind === 'fib' ? rc.geom.plotRight : x1;
      for (let i = 0; i < levels.length; i++) {
        const y = view.priceToY(levels[i].price);
        if (i % 2 === 1 && i - 1 < levels.length) {
          const yPrev = view.priceToY(levels[i - 1].price);
          ctx.save();
          ctx.globalAlpha = clamp(d.style.fillOpacity, 0.02, 1) * 0.6;
          ctx.fillStyle = d.style.fill ?? d.style.color;
          ctx.fillRect(left, Math.min(y, yPrev), right - left, Math.abs(y - yPrev));
          ctx.restore();
        }
        ctx.beginPath();
        ctx.moveTo(left, crisp(y));
        ctx.lineTo(right, crisp(y));
        ctx.stroke();
        if (d.style.label) {
          const text = `${(levels[i].level * 100).toFixed(1).replace(/\.0$/, '')}  ${formatPrice(levels[i].price, decimals)}`;
          tag(rc, text, crisp(right) + 2, y, 'left');
        }
      }
      if (d.kind === 'fibext' && pts.length >= 3) {
        ctx.setLineDash([3, 3]);
        strokeLine(pts[0], pts[1]);
        strokeLine(pts[1], pts[2]);
        ctx.setLineDash([]);
      }
      break;
    }
    default:
      break;
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function halo(rc: RenderContext, d: Drawing): void {
  const { ctx, view, series, geom } = rc;
  const pts = d.anchors.map((a) => project(a, view, series));
  if (!pts.length) return;
  switch (d.kind) {
    case 'hline':
      ctx.beginPath();
      ctx.moveTo(geom.plotLeft, pts[0].y);
      ctx.lineTo(geom.plotRight, pts[0].y);
      ctx.stroke();
      return;
    case 'vline':
      ctx.beginPath();
      ctx.moveTo(pts[0].x, geom.plotTop);
      ctx.lineTo(pts[0].x, geom.plotBottom);
      ctx.stroke();
      return;
    case 'daterange': {
      if (pts.length < 2) return;
      const x0 = Math.min(pts[0].x, pts[1].x);
      const x1 = Math.max(pts[0].x, pts[1].x);
      ctx.strokeRect(x0, geom.plotTop + 1, x1 - x0, geom.plotBottom - geom.plotTop - 2);
      return;
    }
    case 'pricerange': {
      if (pts.length < 2) return;
      const y0 = Math.min(pts[0].y, pts[1].y);
      const y1 = Math.max(pts[0].y, pts[1].y);
      ctx.strokeRect(geom.plotLeft + 1, y0, geom.plotRight - geom.plotLeft - 2, y1 - y0);
      return;
    }
    case 'brush': {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      return;
    }
    case 'text':
    case 'callout': {
      const w = Math.max(40, d.text.length * 6.6 + 16);
      const box = d.kind === 'callout' ? { x: pts[0].x, y: pts[0].y - 36, w, h: 24 } : { x: pts[0].x - w / 2, y: pts[0].y - 12, w, h: 24 };
      ctx.strokeRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
      return;
    }
    default: {
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, 9, 0, Math.PI * 2);
        ctx.stroke();
        return;
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      ctx.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
    }
  }
}

function paintAxisLabels(rc: RenderContext, d: Drawing, clipRight: number): void {
  if (!d.style.label) return;
  const { view, series, geom, settings } = rc;
  const decimals = settings.priceDecimals;
  const pts = d.anchors.map((a) => project(a, view, series));
  const priceTag = (price: number, y: number, color: string) => {
    if (y < geom.plotTop - 4 || y > geom.plotBottom + 4) return;
    tag(rc, formatPrice(price, decimals), geom.plotRight + 2, y, 'left', color);
  };
  const timeTag = (t: number, x: number, color: string) => {
    if (x < geom.plotLeft || x > clipRight + 1) return;
    tag(rc, `${formatDate(t, rc.tz)} ${formatTime(t, rc.tz)}`, x, geom.plotBottom + 2, 'center', color);
  };
  switch (d.kind) {
    case 'hline':
      priceTag(d.anchors[0].p, pts[0].y, d.style.color);
      break;
    case 'vline':
      timeTag(d.anchors[0].t, pts[0].x, d.style.color);
      break;
    case 'pricerange':
      priceTag(d.anchors[0].p, pts[0].y, d.style.color);
      priceTag(d.anchors[1].p, pts[1].y, d.style.color);
      break;
    case 'daterange':
      timeTag(d.anchors[0].t, pts[0].x, d.style.color);
      timeTag(d.anchors[1].t, pts[1].x, d.style.color);
      break;
    case 'rect':
    case 'pricedaterange':
      priceTag(d.anchors[0].p, pts[0].y, d.style.color);
      priceTag(d.anchors[1].p, pts[1].y, d.style.color);
      break;
    default:
      break;
  }
}

/** Small measurement readout inside a range shape. */
function measurement(rc: RenderContext, d: Drawing, box: { x: number; y: number; w: number; h: number }, decimals: number): void {
  const parts: string[] = [];
  if (d.anchors.length >= 2) {
    const dp = Math.abs(d.anchors[1].p - d.anchors[0].p);
    if (d.kind !== 'daterange' && dp > 0) {
      parts.push(`${formatPips(priceToPips(dp, decimals))} pips`);
      parts.push(formatPrice(dp, decimals));
    }
    const ms = Math.abs(d.anchors[1].t - d.anchors[0].t);
    if (d.kind !== 'pricerange' && ms > 0) {
      const days = ms / 86_400_000;
      parts.push(days >= 1.5 ? `${days.toFixed(days >= 10 ? 0 : 1)} d` : `${Math.round(ms / 3_600_000)} h`);
      const bars = Math.abs(project(d.anchors[1], rc.view, rc.series).index - project(d.anchors[0], rc.view, rc.series).index) + 1;
      parts.push(`${bars} bars`);
    }
  }
  if (parts.length === 0) return;
  const text = parts.join(' · ');
  rc.ctx.save();
  rc.ctx.globalAlpha = clamp(d.style.opacity, 0.3, 1);
  tag(rc, text, box.x + box.w / 2, box.y + box.h / 2, 'center', d.style.color);
  rc.ctx.restore();
}

function label(
  rc: RenderContext,
  text: string,
  x: number,
  y: number,
  opts: { align: 'left' | 'center'; box: boolean },
): void {
  const ctx = rc.ctx;
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => l.length)) * 6.6 + (opts.box ? 14 : 6);
  const h = lines.length * 14 + (opts.box ? 10 : 4);
  const left = opts.align === 'center' ? x - w / 2 : x;
  if (opts.box) {
    ctx.fillStyle = rc.style.panelBg;
    ctx.strokeStyle = rc.style.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(left, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rc.style.textColor;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, left + (opts.box ? 7 : 3), y + (opts.box ? 7 : 2) + i * 14));
}

/** Axis-style tag: filled rounded box with text, anchored at a point. */
function tag(
  rc: RenderContext,
  text: string,
  x: number,
  y: number,
  align: 'left' | 'center' | 'right',
  accent?: string,
): void {
  const { ctx, geom } = rc;
  ctx.save();
  ctx.font = `${FONTS.sm}px ${rc.style.fontFamily}`;
  const w = ctx.measureText(text).width + 8;
  const h = 14;
  let left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  left = clamp(left, geom.plotLeft, geom.width - w - 1);
  const top = clamp(y - h / 2, 0, geom.height - h);
  ctx.fillStyle = accent ? mixAlpha(accent) : rc.style.axisBg;
  ctx.strokeStyle = rc.style.axisBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(left, top, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = rc.style.markerText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 4, top + h / 2 + 0.5);
  ctx.restore();
}

function mixAlpha(color: string): string {
  // Keep axis tags readable on both themes: the axis background with a coloured edge.
  return color.length === 7 ? `${color}22` : color;
}

export function toolLabel(kind: DrawingKind): string {
  return TOOL_BY_KIND[kind]?.label ?? kind;
}
