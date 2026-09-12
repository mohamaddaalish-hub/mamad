/**
 * Canvas painters. Pure functions of a render context so they can be exercised
 * headlessly and reused by the fullscreen surface without a second engine.
 *
 * Everything drawn here is indexed in base-row space; the level-of-detail plan
 * decides which rows are touched, so the cost of a frame is bounded by plot
 * width rather than dataset size.
 */

import type { CandleSeries } from '../data/series.ts';
import type { CandleColumns } from '../data/types.ts';
import type { Pyramid, RenderPlan } from '../data/pyramid.ts';
import type { ChartStyle, ChartSettings } from './style.ts';
import type { Viewport, ChartGeom } from './viewport.ts';
import {
  computePriceTicks,
  computeTimeTicks,
  formatAxisDateTime,
  type PriceTick,
  type TimeTick,
} from './axes.ts';
import { formatNumber } from '../util/format.ts';
import { tzOffsetMs } from '../time/tz.ts';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  view: Viewport;
  geom: ChartGeom;
  style: ChartStyle;
  settings: ChartSettings;
  series: CandleSeries;
  pyramid: Pyramid;
  tz: string;
  plan: RenderPlan;
  timeTicks: TimeTick[];
  priceTicks: PriceTick[];
}

export interface Paint {
  cols: CandleColumns;
  depth: number;
  factor: number;
  from: number;
  to: number;
}

const DAY = 86_400_000;

export function crisp(v: number): number {
  return Math.round(v) + 0.5;
}

export function paintsFor(rc: RenderContext): Paint[] {
  const out: Paint[] = [];
  for (const seg of rc.plan.segments) {
    const cols = seg.depth === 0 ? rc.series.underlying() : rc.pyramid.level(seg.depth).cols;
    out.push({ cols, depth: seg.depth, factor: seg.factor, from: seg.from, to: seg.to });
  }
  return out;
}

/** Centre x of a (possibly aggregated) row, in base-index space. */
export function rowCenterX(rc: RenderContext, paint: Paint, i: number): number {
  return rc.view.indexToX(i * paint.factor + (paint.factor - 1) / 2);
}

export function drawBackground(rc: RenderContext): void {
  const { ctx, geom, style } = rc;
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, geom.width, geom.height);
}

export function drawGrid(rc: RenderContext): void {
  if (!rc.settings.showGrid) return;
  const { ctx, geom, style, timeTicks, priceTicks } = rc;
  ctx.save();
  ctx.globalAlpha = style.gridOpacity;
  ctx.strokeStyle = style.gridColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const tick of timeTicks) {
    if (tick.major) continue;
    const x = crisp(tick.x);
    ctx.moveTo(x, geom.plotTop);
    ctx.lineTo(x, geom.plotBottom);
  }
  for (const tick of priceTicks) {
    const y = crisp(tick.y);
    ctx.moveTo(geom.plotLeft, y);
    ctx.lineTo(geom.plotRight, y);
  }
  ctx.stroke();
  ctx.strokeStyle = style.axisBorder;
  ctx.beginPath();
  for (const tick of timeTicks) {
    if (!tick.major) continue;
    const x = crisp(tick.x);
    ctx.moveTo(x, geom.plotTop);
    ctx.lineTo(x, geom.plotBottom);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Vertical separators where a new trading day starts in the chart timezone.
 * Uses one offset lookup per end of the visible range (DST changes only twice a
 * year), so the per-row work is integer arithmetic.
 */
export function dayBoundaryXs(rc: RenderContext): number[] {
  const { series, view, tz } = rc;
  const range = view.visibleRange(series.count);
  const count = range.to - range.from;
  if (count < 2 || count > 60_000) return [];
  const stepMs = series.stepMs ?? DAY;
  if ((DAY / stepMs) * view.pxPerBar < 4) return [];
  const cols = series.underlying();
  const offStart = tz === 'UTC' ? 0 : tzOffsetMs(cols.t[range.from], tz);
  const offEnd = tz === 'UTC' ? 0 : tzOffsetMs(cols.t[range.to - 1], tz);
  const constant = offStart === offEnd;
  const out: number[] = [];
  let prevDay = Math.floor((cols.t[range.from] + offStart) / DAY);
  for (let i = range.from + 1; i < range.to; i++) {
    const off = constant ? offStart : tzOffsetMs(cols.t[i], tz);
    const day = Math.floor((cols.t[i] + off) / DAY);
    if (day !== prevDay) {
      out.push(view.indexToX(i));
      prevDay = day;
    }
  }
  return out;
}

export function drawSessionSeparators(rc: RenderContext, xs: number[]): void {
  if (!rc.settings.showSessionSeparators || xs.length === 0) return;
  const { ctx, geom, style } = rc;
  ctx.save();
  ctx.strokeStyle = style.sessionLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of xs) {
    ctx.moveTo(crisp(x), geom.plotTop);
    ctx.lineTo(crisp(x), geom.plotBottom);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawPriceAction(rc: RenderContext): void {
  const { ctx, view, settings } = rc;
  const paints = paintsFor(rc);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, view.geom.plotRight, view.geom.plotBottom);
  ctx.clip();
  if (settings.mode === 'line' || settings.mode === 'area') drawLineOrArea(rc, paints, settings.mode);
  else if (settings.mode === 'bars') drawOhlcBars(rc, paints);
  else drawCandles(rc, paints);
  ctx.restore();
}

function drawCandles(rc: RenderContext, paints: Paint[]): void {
  const { ctx, view, style, settings } = rc;
  for (const paint of paints) {
    const wPx = paint.factor * view.pxPerBar;
    const bw = Math.max(1, Math.floor(wPx * 0.72));
    const wickW = Math.max(1, Math.min(2, Math.round(wPx * 0.14)));
    const { o, h, l, c } = paint.cols;
    const left = -bw - 4;
    const right = view.geom.plotRight + bw + 4;
    for (let dir = 0; dir < 2; dir++) {
      const color = dir === 0 ? style.bull : style.bear;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = paint.from; i < paint.to; i++) {
        const up = c[i] >= o[i];
        if ((dir === 0) !== up) continue;
        const x = rowCenterX(rc, paint, i);
        if (x < left || x > right) continue;
        const yO = view.priceToY(o[i]);
        const yC = view.priceToY(c[i]);
        const top = Math.min(yO, yC);
        const height = Math.max(1, Math.abs(yC - yO));
        if (bw <= 1) {
          ctx.rect(Math.round(x), top, 1, height);
        } else {
          ctx.rect(Math.round(x - bw / 2), Math.round(top), bw, Math.max(1, Math.round(height)));
        }
      }
      ctx.fill();
      // Wicks: single-pixel-wide lines at half-pixel offset for crispness.
      ctx.strokeStyle = dir === 0 ? style.wickBull : style.wickBear;
      ctx.lineWidth = wickW;
      ctx.beginPath();
      for (let i = paint.from; i < paint.to; i++) {
        const up = c[i] >= o[i];
        if ((dir === 0) !== up) continue;
        const x = rowCenterX(rc, paint, i);
        if (x < left || x > right) continue;
        const cx = Math.round(x) + 0.5;
        ctx.moveTo(cx, view.priceToY(h[i]));
        ctx.lineTo(cx, view.priceToY(l[i]));
      }
      ctx.stroke();
      if (settings.outlineCandles && bw >= 4) {
        ctx.strokeStyle = style.theme === 'dark' ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = paint.from; i < paint.to; i++) {
          const up = c[i] >= o[i];
          if ((dir === 0) !== up) continue;
          const x = rowCenterX(rc, paint, i);
          if (x < left || x > right) continue;
          const yO = view.priceToY(o[i]);
          const yC = view.priceToY(c[i]);
          const top = Math.min(yO, yC);
          const height = Math.max(1, Math.abs(yC - yO));
          ctx.rect(Math.round(x - bw / 2) + 0.5, Math.round(top) + 0.5, bw - 1, Math.max(1, Math.round(height) - 1));
        }
        ctx.stroke();
      }
    }
  }
}

function drawOhlcBars(rc: RenderContext, paints: Paint[]): void {
  const { ctx, view, style } = rc;
  for (const paint of paints) {
    const barPx = paint.factor * view.pxPerBar;
    const tick = Math.max(2, Math.min(12, barPx * 0.32));
    ctx.lineWidth = barPx > 3 ? 1.4 : 1;
    const { o, h, l, c } = paint.cols;
    for (let dir = 0; dir < 2; dir++) {
      ctx.strokeStyle = dir === 0 ? style.bull : style.bear;
      ctx.beginPath();
      for (let i = paint.from; i < paint.to; i++) {
        const up = c[i] >= o[i];
        if ((dir === 0) !== up) continue;
        const x = rowCenterX(rc, paint, i);
        if (x < -tick || x > view.geom.plotRight + tick) continue;
        const cx = Math.round(x) + 0.5;
        ctx.moveTo(cx, view.priceToY(h[i]));
        ctx.lineTo(cx, view.priceToY(l[i]));
        ctx.moveTo(cx - tick, view.priceToY(o[i]));
        ctx.lineTo(cx, view.priceToY(o[i]));
        ctx.moveTo(cx, view.priceToY(c[i]));
        ctx.lineTo(cx + tick, view.priceToY(c[i]));
      }
      ctx.stroke();
    }
  }
}

function drawLineOrArea(rc: RenderContext, paints: Paint[], mode: 'line' | 'area'): void {
  const { ctx, view, style } = rc;
  const pts: number[] = [];
  for (const paint of paints) {
    const { c } = paint.cols;
    for (let i = paint.from; i < paint.to; i++) {
      pts.push(rowCenterX(rc, paint, i), view.priceToY(c[i]));
    }
  }
  if (pts.length < 4) {
    if (pts.length === 2) {
      ctx.fillStyle = style.lineColor;
      ctx.fillRect(pts[0] - 1.5, pts[1] - 1.5, 3, 3);
    }
    return;
  }
  if (mode === 'area') {
    const grad = ctx.createLinearGradient(0, view.geom.plotTop, 0, view.geom.plotBottom);
    grad.addColorStop(0, style.areaTop);
    grad.addColorStop(1, style.areaBottom);
    ctx.beginPath();
    ctx.moveTo(pts[0], view.geom.plotBottom);
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.lineTo(pts[pts.length - 2], view.geom.plotBottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.strokeStyle = style.lineColor;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

export function drawVolume(rc: RenderContext): void {
  if (!rc.settings.showVolume || !rc.series.hasVolume) return;
  const { view, style, ctx } = rc;
  const paints = paintsFor(rc);
  let max = 0;
  for (const paint of paints) {
    const { v } = paint.cols;
    for (let i = paint.from; i < paint.to; i++) if (v[i] > max) max = v[i];
  }
  if (max <= 0) return;
  const paneH = Math.max(24, Math.min(90, view.geom.plotH * 0.16));
  const baseY = view.geom.plotBottom - 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, view.geom.plotRight, view.geom.plotBottom);
  ctx.clip();
  for (const paint of paints) {
    const { o, c, v } = paint.cols;
    const bw = Math.max(1, Math.floor(paint.factor * view.pxPerBar * 0.6));
    for (let i = paint.from; i < paint.to; i++) {
      const h = (v[i] / max) * paneH;
      if (h < 0.6) continue;
      const x = rowCenterX(rc, paint, i);
      if (x < -bw || x > view.geom.plotRight + bw) continue;
      ctx.fillStyle = c[i] >= o[i] ? style.volumeUp : style.volumeDown;
      ctx.fillRect(Math.round(x - bw / 2), baseY - h, Math.max(1, bw), h);
    }
  }
  ctx.restore();
}

/** Shade the region past the replay barrier so it is visually unmistakable. */
export function drawReplayBarrier(rc: RenderContext, barrierIndex: number): void {
  const { ctx, view, style, geom } = rc;
  const x = view.indexToX(barrierIndex + 0.5);
  if (x >= geom.plotRight) return;
  ctx.save();
  const start = Math.max(0, x);
  ctx.fillStyle = style.replayShade;
  ctx.fillRect(start, geom.plotTop, Math.max(0, geom.plotRight - start), geom.plotH);
  ctx.strokeStyle = style.replayLine;
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(crisp(x), geom.plotTop);
  ctx.lineTo(crisp(x), geom.plotBottom);
  ctx.stroke();
  ctx.restore();
}

export function drawAxes(rc: RenderContext): void {
  const { ctx, geom, style, view, timeTicks, priceTicks, settings } = rc;
  ctx.save();
  ctx.fillStyle = style.axisBg;
  ctx.fillRect(geom.plotRight, 0, geom.axisW, geom.height);
  ctx.fillRect(0, geom.plotBottom, geom.width, geom.axisH);
  ctx.strokeStyle = style.axisBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(crisp(geom.plotRight), 0);
  ctx.lineTo(crisp(geom.plotRight), geom.height);
  ctx.moveTo(0, crisp(geom.plotBottom));
  ctx.lineTo(geom.width, crisp(geom.plotBottom));
  ctx.stroke();

  ctx.fillStyle = style.mutedText;
  ctx.font = `${style.fontSize}px ${style.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const tick of priceTicks) {
    if (tick.y < 8 || tick.y > geom.plotBottom - 6) continue;
    ctx.fillText(tick.label, geom.plotRight + 7, tick.y);
  }
  ctx.textAlign = 'center';
  for (const tick of timeTicks) {
    ctx.fillStyle = tick.major ? style.textColor : style.mutedText;
    ctx.fillText(tick.label, tick.x, geom.plotBottom + geom.axisH / 2);
  }

  const last = rc.series.count > 0 ? rc.series.underlying().c[rc.series.count - 1] : null;
  if (last !== null) {
    const y = view.priceToY(last);
    if (y > 2 && y < geom.plotBottom - 2) {
      ctx.strokeStyle = style.theme === 'dark' ? 'rgba(200,208,222,0.32)' : 'rgba(60,72,92,0.28)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, crisp(y));
      ctx.lineTo(geom.plotRight, crisp(y));
      ctx.stroke();
      ctx.setLineDash([]);
      drawAxisLabel(rc, formatNumber(last, settings.priceDecimals), geom.plotRight + 2, y, 'price');
    }
  }
  ctx.restore();
}

export function drawAxisLabel(
  rc: RenderContext,
  text: string,
  x: number,
  y: number,
  kind: 'price' | 'time',
): void {
  const { ctx, style, geom } = rc;
  ctx.save();
  ctx.font = `${style.fontSize}px ${style.fontFamily}`;
  const w = ctx.measureText(text).width + 10;
  const h = style.fontSize + 8;
  ctx.fillStyle = style.theme === 'dark' ? '#2c3546' : '#dde3ec';
  if (kind === 'price') {
    roundRect(ctx, x, y - h / 2, w, Math.min(h, geom.plotBottom - 2 - y + h / 2), 3);
    ctx.fill();
    ctx.fillStyle = style.textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y);
  } else {
    const cx = Math.max(geom.plotLeft + w / 2, Math.min(geom.plotRight - w / 2, x));
    roundRect(ctx, cx - w / 2, geom.plotBottom + 2, w, geom.axisH - 4, 3);
    ctx.fill();
    ctx.fillStyle = style.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, geom.plotBottom + geom.axisH / 2);
  }
  ctx.restore();
}

export function drawCrosshair(
  rc: RenderContext,
  cursor: { x: number; y: number } | null,
  snapIndex: number | null,
): void {
  if (!cursor) return;
  const { ctx, geom, style, view, settings, tz, series } = rc;
  ctx.save();
  ctx.strokeStyle = style.crosshair;
  ctx.globalAlpha = 0.72;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  const x = snapIndex !== null ? view.indexToX(snapIndex) : cursor.x;
  ctx.beginPath();
  if (x <= geom.plotRight) {
    ctx.moveTo(crisp(x), geom.plotTop);
    ctx.lineTo(crisp(x), geom.plotBottom);
  }
  if (cursor.y < geom.plotBottom) {
    ctx.moveTo(geom.plotLeft, crisp(cursor.y));
    ctx.lineTo(geom.plotRight, crisp(cursor.y));
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  if (settings.showCrosshairLabels) {
    if (cursor.y < geom.plotBottom && x <= geom.plotRight) {
      drawAxisLabel(
        rc,
        formatNumber(view.yToPrice(cursor.y), settings.priceDecimals),
        geom.plotRight + 2,
        cursor.y,
        'price',
      );
    }
    if (snapIndex !== null && x <= geom.plotRight) {
      drawAxisLabel(rc, formatAxisDateTime(series.time(snapIndex), tz, true), x, 0, 'time');
    }
  }
  ctx.restore();
}

/** Top-left readout: symbol, timeframe, and the OHLC of the hovered candle. */
export function drawLegend(rc: RenderContext, hoverIndex: number | null, extra?: string): void {
  const { ctx, style, settings, series, tz } = rc;
  const idx = hoverIndex !== null && hoverIndex >= 0 ? hoverIndex : series.count - 1;
  const candle = idx >= 0 ? series.candle(idx) : null;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let x = 10;
  const y = 14;
  const write = (text: string, color: string, weight = '') => {
    if (!text) return;
    ctx.fillStyle = color;
    ctx.font = `${weight ? `${weight} ` : ''}${style.fontSize}px ${style.fontFamily}`;
    ctx.fillText(text, x, y);
    x += ctx.measureText(text).width + 7;
  };
  write(series.symbol, style.textColor, '600');
  write(series.tf, style.mutedText);
  if (extra) write(extra, style.mutedText);
  if (candle) {
    write(formatAxisDateTime(candle.t, tz, series.stepMs !== undefined && series.stepMs < DAY), style.mutedText);
    const dir = candle.c >= candle.o ? style.bull : style.bear;
    write('O', style.mutedText);
    write(formatNumber(candle.o, settings.priceDecimals), dir);
    write('H', style.mutedText);
    write(formatNumber(candle.h, settings.priceDecimals), dir);
    write('L', style.mutedText);
    write(formatNumber(candle.l, settings.priceDecimals), dir);
    write('C', style.mutedText);
    write(formatNumber(candle.c, settings.priceDecimals), dir);
    const prev = idx > 0 ? series.underlying().c[idx - 1] : candle.o;
    if (prev) {
      const chg = ((candle.c - prev) / prev) * 100;
      write(`${chg >= 0 ? '+' : ''}${chg.toFixed(3)}%`, chg >= 0 ? style.bull : style.bear);
    }
    if (series.hasVolume && candle.v > 0) {
      write('Vol', style.mutedText);
      write(compactNumber(candle.v), style.mutedText);
    }
  }
  ctx.restore();
}

export function compactNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export function computeTicks(rc: Omit<RenderContext, 'timeTicks' | 'priceTicks' | 'plan'>): {
  range: { from: number; to: number };
  timeTicks: TimeTick[];
  priceTicks: PriceTick[];
} {
  const range = rc.view.visibleRange(rc.series.count);
  const timeTicks = computeTimeTicks(rc.series, rc.view, range, { tz: rc.tz });
  const priceTicks = computePriceTicks(rc.view, Math.max(3, Math.floor(rc.geom.plotH / 54)));
  return { range, timeTicks, priceTicks };
}
