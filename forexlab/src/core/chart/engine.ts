/**
 * Chart engine: owns the canvas, the viewport, pointer interaction and the frame
 * scheduler. React never re-renders to move the chart — the app calls imperative
 * setters and the engine repaints at most once per animation frame.
 *
 * Layers (drawings, trades, news markers, replay marker) are plugged in as
 * `OverlayPainter`s so this file stays independent of those subsystems.
 */

import type { CandleSeries } from '../data/series.ts';
import type { Pyramid } from '../data/pyramid.ts';
import {
  computeTicks,
  dayBoundaryXs,
  drawAxes,
  drawBackground,
  drawCrosshair,
  drawGrid,
  drawLegend,
  drawPriceAction,
  drawReplayBarrier,
  drawSessionSeparators,
  drawVolume,
  type RenderContext,
} from './render.ts';
import { resolveStyle, DEFAULT_CHART_SETTINGS, type ChartSettings, type ChartStyle } from './style.ts';
import { geometry, MAX_PX_PER_BAR, MIN_PX_PER_BAR, Viewport, type ChartGeom } from './viewport.ts';
import { formatAxisDateTime } from './axes.ts';
import { formatNumber } from '../util/format.ts';

export interface OverlayPainter {
  id: string;
  draw(rc: RenderContext): void;
  hit?(x: number, y: number, rc: RenderContext): unknown;
  /** Painted before candles (underlay) when true. */
  behind?: boolean;
}

export interface HoverInfo {
  index: number | null;
  time: number | null;
  price: number;
  x: number;
  y: number;
  candle: { t: number; o: number; h: number; l: number; c: number; v: number } | null;
}

export interface ViewSnapshot {
  rightIndex: number;
  pxPerBar: number;
  priceMin: number;
  priceMax: number;
  autoPrice: boolean;
  timeAtRightEdge: number | null;
}

export interface EngineHooks {
  onViewChanged?(snapshot: ViewSnapshot): void;
  onHover?(info: HoverInfo | null): void;
  onPointerDownInfo?(info: { index: number | null; price: number; x: number; y: number }): boolean | void;
  onDoubleClickInfo?(info: { index: number | null; price: number; x: number; y: number }): boolean | void;
  onWheelZoom?(): void;
}

export interface InteractionLayer {
  id: string;
  onPointerDown?(info: { index: number | null; price: number; x: number; y: number }, engine: ChartEngine): boolean;
  onPointerMove?(info: { index: number | null; price: number; x: number; y: number }, engine: ChartEngine): boolean;
  onPointerUp?(info: { index: number | null; price: number; x: number; y: number }, engine: ChartEngine): boolean;
  cursor?: () => string | undefined;
}

interface PointerState {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  axis: 'plot' | 'price' | 'time' | null;
}

export class ChartEngine {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  view: Viewport;
  geom: ChartGeom;
  style: ChartStyle;
  settings: ChartSettings;
  private series: CandleSeries | null = null;
  private pyramid: Pyramid | null = null;
  tz = 'UTC';
  private layers: OverlayPainter[] = [];
  private interactions: InteractionLayer[] = [];
  private hooks: EngineHooks;
  private pointers = new Map<number, PointerState>();
  private pinch: { dist: number; midY: number } | null = null;
  private cursor: { x: number; y: number } | null = null;
  private hoverIndex: number | null = null;
  private barrier: number | null = null;
  private raf = 0;
  private dirty = true;
  private batch = 0;
  private destroyed = false;
  private resizeObserver: ResizeObserver | null = null;
  private legendNote = '';
  cursorStyle: string = 'crosshair';

  constructor(canvas: HTMLCanvasElement, opts: { settings?: ChartSettings; hooks?: EngineHooks } = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.settings = opts.settings ?? DEFAULT_CHART_SETTINGS;
    this.style = resolveStyle(this.settings);
    this.hooks = opts.hooks ?? {};
    const rect = canvas.getBoundingClientRect();
    this.geom = geometry(Math.max(80, rect.width), Math.max(80, rect.height), dpr());
    this.view = new Viewport(this.geom);
    this.bind();
    this.loop();
  }

  // ---------------------------------------------------------------- lifecycle
  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('dblclick', this.onDoubleClick);
    c.addEventListener('contextmenu', this.onContextMenu);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(c.parentElement ?? c);
    }
    this.handleResize();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('dblclick', this.onDoubleClick);
    c.removeEventListener('contextmenu', this.onContextMenu);
    this.resizeObserver?.disconnect();
  }

  // ------------------------------------------------------------------- setters
  setHooks(hooks: EngineHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  attachSeries(series: CandleSeries | null, pyramid: Pyramid | null, opts: { tz?: string; keepTimeAnchor?: boolean } = {}): void {
    const anchorTime = opts.keepTimeAnchor ? this.anchorTime() : null;
    const pxPerBar = this.view.pxPerBar;
    this.series = series;
    this.pyramid = pyramid;
    if (opts.tz) this.tz = opts.tz;
    if (!series || series.count === 0) {
      this.view.rightIndex = 0;
      this.view.pxPerBar = pxPerBar;
      this.markDirty();
      return;
    }
    if (anchorTime !== null) {
      const idx = series.indexAtOrBefore(anchorTime);
      this.view.rightIndex = (idx >= 0 ? idx : series.count - 1) + this.view.rightGap / Math.max(0.2, pxPerBar);
    } else {
      this.view.rightIndex = series.count - 1;
    }
    this.view.pxPerBar = pxPerBar;
    this.view.clampPan(series.count);
    this.markDirty();
  }

  private anchorTime(): number | null {
    if (!this.series || this.series.count === 0) return null;
    const i = Math.max(0, Math.min(this.series.count - 1, Math.floor(this.view.rightIndex)));
    return this.series.time(i);
  }

  setSettings(settings: ChartSettings): void {
    this.settings = settings;
    this.style = resolveStyle(settings);
    this.markDirty();
  }

  setLayers(layers: OverlayPainter[]): void {
    this.layers = layers;
    this.markDirty();
  }

  addInteraction(layer: InteractionLayer): () => void {
    this.interactions.push(layer);
    return () => {
      this.interactions = this.interactions.filter((l) => l !== layer);
    };
  }

  setReplayBarrier(index: number | null, follow = false): void {
    this.barrier = index;
    if (follow && index !== null && this.series) {
      this.view.rightIndex = Math.max(0, Math.min(this.series.count - 1, index));
    }
    this.markDirty();
  }

  setLegendNote(note: string): void {
    if (this.legendNote === note) return;
    this.legendNote = note;
    this.markDirty();
  }

  // -------------------------------------------------------------- view control
  requestRender(): void {
    this.markDirty();
  }

  beginBatch(): void {
    this.batch++;
  }

  endBatch(): void {
    this.batch = Math.max(0, this.batch - 1);
    this.markDirty();
  }

  private markDirty(): void {
    if (this.batch > 0) return;
    this.dirty = true;
  }

  get count(): number {
    return this.series?.count ?? 0;
  }

  getSeries(): CandleSeries | null {
    return this.series;
  }

  getVisibleRange(): { from: number; to: number } {
    return this.view.visibleRange(this.count);
  }

  zoomBy(factor: number, anchorX?: number): void {
    const x = anchorX ?? this.geom.plotLeft + this.geom.plotW / 2;
    this.view.zoomAt(x, factor, this.count);
    this.emitView();
    this.markDirty();
  }

  setBarSpacing(pxPerBar: number): void {
    const center = this.geom.plotLeft + this.geom.plotW / 2;
    const anchorIndex = this.view.xToIndex(center);
    this.view.pxPerBar = Math.max(MIN_PX_PER_BAR, Math.min(MAX_PX_PER_BAR, pxPerBar));
    this.view.rightIndex = anchorIndex + (this.geom.plotRight - this.view.rightGap - center) / this.view.pxPerBar;
    this.view.clampPan(this.count);
    this.emitView();
    this.markDirty();
  }

  goToIndex(index: number, align: 'right' | 'center' = 'right', opts: { autoscale?: boolean } = {}): void {
    if (!this.series) return;
    const i = Math.max(0, Math.min(this.series.count - 1, index));
    const width = this.geom.plotW;
    if (align === 'center') {
      this.view.rightIndex = i + (width / 2 - this.view.rightGap) / this.view.pxPerBar;
    } else {
      this.view.rightIndex = i + (this.view.rightGap + 4) / this.view.pxPerBar;
    }
    this.view.clampPan(this.series.count);
    if (opts.autoscale) this.autoscale();
    this.emitView();
    this.markDirty();
  }

  goToTime(time: number, align: 'right' | 'center' = 'right'): boolean {
    if (!this.series) return false;
    const i = this.series.indexAtOrBefore(time);
    if (i < 0) return false;
    this.goToIndex(i, align);
    return true;
  }

  fitAll(): void {
    this.view.fitAll(this.count);
    this.autoscale();
    this.emitView();
    this.markDirty();
  }

  autoscale(): void {
    this.view.autoPrice = true;
    this.markDirty();
    this.emitView();
  }

  /** Back to the default lens: last ~110 candles, auto price scale. */
  resetView(): void {
    this.view.autoPrice = true;
    this.view.pxPerBar = Math.max(MIN_PX_PER_BAR, Math.min(MAX_PX_PER_BAR, this.geom.plotW / 110));
    this.view.rightIndex = this.count - 1;
    this.view.clampPan(this.count);
    this.emitView();
    this.markDirty();
  }

  snapshot(): ViewSnapshot {
    return {
      rightIndex: this.view.rightIndex,
      pxPerBar: this.view.pxPerBar,
      priceMin: this.view.priceMin,
      priceMax: this.view.priceMax,
      autoPrice: this.view.autoPrice,
      timeAtRightEdge: this.anchorTime(),
    };
  }

  restoreSnapshot(snap: ViewSnapshot | null | undefined): void {
    if (!snap) {
      this.fitAll();
      return;
    }
    this.view.pxPerBar = Math.max(MIN_PX_PER_BAR, Math.min(MAX_PX_PER_BAR, snap.pxPerBar));
    this.view.autoPrice = snap.autoPrice !== false;
    if (!this.view.autoPrice) {
      this.view.priceMin = snap.priceMin;
      this.view.priceMax = snap.priceMax;
    }
    if (snap.timeAtRightEdge != null && this.series) this.goToTime(snap.timeAtRightEdge, 'right');
    else {
      this.view.rightIndex = snap.rightIndex;
      this.view.clampPan(this.count);
    }
    this.markDirty();
  }

  exportPng(scale = 2): string {
    try {
      return this.canvas.toDataURL('image/png');
    } catch {
      void scale;
      return '';
    }
  }

  // -------------------------------------------------------------- interaction
  private handleResize(): void {
    const host = this.canvas.parentElement ?? this.canvas;
    const rect = host.getBoundingClientRect();
    const width = Math.max(80, Math.floor(rect.width));
    const height = Math.max(80, Math.floor(rect.height));
    const ratio = dpr();
    this.geom = geometry(width, height, ratio, this.geom.axisW, this.geom.axisH);
    this.view.geom = this.geom;
    const needResize = this.canvas.width !== Math.floor(width * ratio) || this.canvas.height !== Math.floor(height * ratio);
    if (needResize) {
      this.canvas.width = Math.floor(width * ratio);
      this.canvas.height = Math.floor(height * ratio);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
    this.markDirty();
  }

  private localPoint(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private classifyAxis(x: number, y: number): 'plot' | 'price' | 'time' | null {
    if (x > this.geom.plotRight) return y <= this.geom.plotBottom ? 'price' : null;
    if (y > this.geom.plotBottom) return 'time';
    if (x >= 0 && y >= 0) return 'plot';
    return null;
  }

  private infoFor(x: number, y: number): { index: number | null; price: number; x: number; y: number } {
    const rawIndex = this.view.xToIndex(x);
    let index: number | null = null;
    if (this.series && this.count > 0) {
      const i = Math.round(rawIndex);
      if (i >= 0 && i < this.count) index = i;
    }
    return { index, price: this.view.yToPrice(y), x, y };
  }

  private onPointerDown = (e: PointerEvent): void => {
    const { x, y } = this.localPoint(e);
    const axis = this.classifyAxis(x, y);
    this.canvas.setPointerCapture?.(e.pointerId);
    const info = this.infoFor(x, y);
    for (const layer of this.interactions) {
      if (layer.onPointerDown && layer.onPointerDown(info, this)) {
        this.pointers.set(e.pointerId, { id: e.pointerId, x, y, startX: x, startY: y, axis });
        return;
      }
    }
    if (axis === null) return;
    this.pointers.set(e.pointerId, { id: e.pointerId, x, y, startX: x, startY: y, axis });
    if (this.pointers.size === 2) this.startPinch();
    if (axis === 'plot' && e.button === 0) this.hooks.onPointerDownInfo?.(info);
  };

  private startPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    this.pinch = {
      dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
      midY: (pts[0].y + pts[1].y) / 2,
    };
  }

  private onPointerMove = (e: PointerEvent): void => {
    const { x, y } = this.localPoint(e);
    const held = this.pointers.get(e.pointerId);
    const info = this.infoFor(x, y);
    for (const layer of this.interactions) {
      if (layer.onPointerMove && layer.onPointerMove(info, this)) {
        this.markDirty();
        return;
      }
    }
    if (!held) {
      this.cursor = { x, y };
      this.updateHover(x, y);
      this.applyCursorStyle(x, y);
      return;
    }
    const dx = x - held.x;
    const dy = y - held.y;
    if (this.pointers.size >= 2 && this.pinch) {
      this.pointers.set(e.pointerId, { ...held, x, y });
      this.updatePinch();
      return;
    }
    held.x = x;
    held.y = y;
    if (held.axis === 'plot') {
      this.view.panBy(-dx * 1, this.count);
      // Horizontal drag pans time; vertical drag with no auto-scale pans price.
      if (!this.view.autoPrice) {
        const span = this.view.priceMax - this.view.priceMin;
        const shift = (dy / Math.max(1, this.geom.plotH)) * span;
        this.view.priceMax += shift;
        this.view.priceMin += shift;
      }
      this.emitView();
      this.markDirty();
      return;
    }
    if (held.axis === 'price') {
      if (this.view.autoPrice) this.view.autoPrice = false;
      const span = this.view.priceMax - this.view.priceMin;
      const shift = (dy / Math.max(1, this.geom.plotH)) * span;
      this.view.priceMax += shift;
      this.view.priceMin += shift;
      this.emitView();
      this.markDirty();
      return;
    }
    if (held.axis === 'time') {
      const factor = Math.exp(-dx / 180);
      this.view.pxPerBar = Math.max(MIN_PX_PER_BAR, Math.min(MAX_PX_PER_BAR, this.view.pxPerBar * factor));
      this.view.clampPan(this.count);
      this.emitView();
      this.markDirty();
    }
  };

  private updatePinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2 || !this.pinch) return;
    const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
    const midY = (pts[0].y + pts[1].y) / 2;
    const ratio = dist / this.pinch.dist;
    this.view.pxPerBar = Math.max(MIN_PX_PER_BAR, Math.min(MAX_PX_PER_BAR, this.view.pxPerBar * ratio));
    if (!this.view.autoPrice) {
      const span = this.view.priceMax - this.view.priceMin;
      const shift = ((this.pinch.midY - midY) / Math.max(1, this.geom.plotH)) * span;
      this.view.priceMax += shift;
      this.view.priceMin += shift;
    }
    this.pinch = { dist, midY };
    this.view.clampPan(this.count);
    this.emitView();
    this.markDirty();
  }

  private onPointerUp = (e: PointerEvent): void => {
    const { x, y } = this.localPoint(e);
    const info = this.infoFor(x, y);
    for (const layer of this.interactions) {
      if (layer.onPointerUp && layer.onPointerUp(info, this)) break;
    }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.canvas.releasePointerCapture?.(e.pointerId);
    this.markDirty();
  };

  private onPointerLeave = (): void => {
    if (this.pointers.size === 0) {
      this.cursor = null;
      this.hoverIndex = null;
      this.hooks.onHover?.(null);
      this.markDirty();
    }
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const { x, y } = this.localPoint(e);
    const axis = this.classifyAxis(x, y);
    const info = this.infoFor(x, y);
    for (const layer of this.interactions) {
      if (layer.onPointerDown && layer.onPointerDown(info, this)) return;
    }
    if (axis === 'price' || axis === 'time') {
      this.autoscale();
      return;
    }
    if (axis !== 'plot') return;
    void this.hooks.onDoubleClickInfo?.(info);
  };

  private onContextMenu = (e: MouseEvent): void => {
    // Right-drag is used for zoom boxes by tools; suppress the browser menu on the plot.
    if (this.interactions.some((l) => l.cursor)) e.preventDefault();
  };

  private onWheel = (e: WheelEvent): void => {
    const { x, y } = this.localPoint(e);
    const axis = this.classifyAxis(x, y);
    if (axis === null) return;
    e.preventDefault();
    const shiftScroll = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // Horizontal wheel/two-finger swipe pans time.
      const amount = (shiftScroll ? e.deltaX : e.deltaY) * Math.max(0.6, this.view.pxPerBar / 6);
      this.view.panBy(amount, this.count);
      this.emitView();
      this.markDirty();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && axis === 'price') {
      // Ctrl+wheel over the price axis: manual vertical scale.
      const factor = Math.exp(-e.deltaY / 400);
      const mid = (this.view.priceMax + this.view.priceMin) / 2;
      const half = ((this.view.priceMax - this.view.priceMin) / 2) / factor;
      this.view.autoPrice = false;
      this.view.priceMin = mid - half;
      this.view.priceMax = mid + half;
      this.emitView();
      this.markDirty();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // Pinch-zoom trackpad gesture.
      const factor = Math.exp(-e.deltaY / 240);
      this.view.zoomAt(x, factor, this.count);
      this.hooks.onWheelZoom?.();
      this.emitView();
      this.markDirty();
      return;
    }
    if (shiftScroll) {
      this.view.panBy(e.deltaX / Math.max(0.5, this.view.pxPerBar) * this.view.pxPerBar, this.count);
      this.emitView();
      this.markDirty();
      return;
    }
    const factor = Math.exp(-e.deltaY / 240);
    this.view.zoomAt(x, factor, this.count);
    this.hooks.onWheelZoom?.();
    this.emitView();
    this.markDirty();
  };

  private applyCursorStyle(x: number, y: number): void {
    let next = this.cursorStyle;
    const axis = this.classifyAxis(x, y);
    if (axis === 'price') next = 'ns-resize';
    else if (axis === 'time') next = 'ew-resize';
    else if (this.cursorStyle !== 'crosshair') next = this.cursorStyle;
    else next = 'crosshair';
    if (this.canvas.style.cursor !== next) this.canvas.style.cursor = next;
  }

  setToolCursor(style: string | undefined): void {
    this.cursorStyle = style ?? 'crosshair';
    if (this.cursor) this.applyCursorStyle(this.cursor.x, this.cursor.y);
  }

  private updateHover(x: number, y: number): void {
    if (!this.series || this.count === 0) {
      this.hooks.onHover?.(null);
      return;
    }
    const raw = this.view.xToIndex(x);
    const i = Math.round(raw);
    const info: HoverInfo = {
      index: i >= 0 && i < this.count ? i : null,
      time: i >= 0 && i < this.count ? this.series.time(i) : null,
      price: this.view.yToPrice(y),
      x,
      y,
      candle: i >= 0 && i < this.count ? this.series.candle(i) : null,
    };
    // Only notify the app when the *candle* under the cursor changes: crosshair
    // geometry is drawn internally, so per-pixel React churn is unnecessary.
    if (info.index !== this.hoverIndex) {
      this.hoverIndex = info.index;
      this.hooks.onHover?.(info);
      this.markDirty();
    }
  }

  private emitView(): void {
    this.hooks.onViewChanged?.(this.snapshot());
  }

  // --------------------------------------------------------------- rendering
  private loop = (): void => {
    if (this.destroyed) return;
    if (this.dirty && this.batch === 0) {
      this.dirty = false;
      this.renderFrame();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private renderContextBase(): RenderContext | null {
    if (!this.series || !this.pyramid || this.series.count === 0) return null;
    const range = this.view.visibleRange(this.series.count);
    const budget = Math.max(24, Math.floor(this.geom.plotW / 1.6));
    const plan = this.pyramid.plan(range.from, range.to, this.series.count, budget);
    if (this.view.autoPrice) {
      const bounds = this.pyramid.boundsFor(plan);
      const extra = this.layerPriceExtent();
      if (extra) {
        if (extra.min < bounds.min) bounds.min = extra.min;
        if (extra.max > bounds.max) bounds.max = extra.max;
      }
      this.view.applyPriceBounds(bounds.min, bounds.max);
    }
    const { timeTicks, priceTicks } = computeTicks({
      ctx: this.ctx,
      view: this.view,
      geom: this.geom,
      style: this.style,
      settings: this.settings,
      series: this.series,
      pyramid: this.pyramid,
      tz: this.tz,
    });
    return {
      ctx: this.ctx,
      view: this.view,
      geom: this.geom,
      style: this.style,
      settings: this.settings,
      series: this.series,
      pyramid: this.pyramid,
      tz: this.tz,
      plan,
      timeTicks,
      priceTicks,
    };
  }

  /** Let overlays widen the auto-scale range (e.g. a trade entry far off screen). */
  private layerPriceExtent(): { min: number; max: number } | null {
    return this.priceExtentHint ?? null;
  }

  priceExtentHint: { min: number; max: number } | null = null;

  private renderFrame(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.geom.dpr, 0, 0, this.geom.dpr, 0, 0);
    ctx.clearRect(0, 0, this.geom.width, this.geom.height);
    if (!this.series || this.series.count === 0 || !this.pyramid) {
      ctx.fillStyle = this.style.background;
      ctx.fillRect(0, 0, this.geom.width, this.geom.height);
      this.drawEmptyState();
      return;
    }
    const rc = this.renderContextBase();
    if (!rc) return;
    drawBackground(rc);
    drawGrid(rc);
    drawSessionSeparators(rc, dayBoundaryXs(rc));
    for (const layer of this.layers) if (layer.behind) safeDraw(layer, rc);
    drawVolume(rc);
    drawPriceAction(rc);
    for (const layer of this.layers) if (!layer.behind) safeDraw(layer, rc);
    if (this.barrier !== null) drawReplayBarrier(rc, this.barrier);
    drawAxes(rc);
    drawLegend(rc, this.hoverIndex, this.legendNote || this.replayLabel());
    drawCrosshair(rc, this.cursor, this.snapIndexForCrosshair());
  }

  private replayLabel(): string {
    if (this.barrier === null || !this.series) return '';
    const t = this.series.time(Math.min(this.barrier, this.series.count - 1));
    return t != null ? `REPLAY @ ${formatAxisDateTime(t, this.tz, true)}` : 'REPLAY';
  }

  private snapIndexForCrosshair(): number | null {
    if (!this.cursor || !this.series) return null;
    const i = Math.round(this.view.xToIndex(this.cursor.x));
    if (i < 0 || i >= this.count) return null;
    if (this.cursor.x > this.geom.plotRight) return null;
    return i;
  }

  private drawEmptyState(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = this.style.mutedText;
    ctx.font = `13px ${this.style.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = this.geom.plotRight / 2;
    const cy = this.geom.plotH / 2;
    ctx.fillText('Import a historical OHLC CSV to begin.', cx, cy - 12);
    ctx.font = `11px ${this.style.fontFamily}`;
    ctx.fillText(
      'No live feed by design — every candle on this chart comes from your own files.',
      cx,
      cy + 8,
    );
    ctx.restore();
  }

  /** Price of the y cursor and price scale label helper used by tools. */
  priceLabel(price: number): string {
    return formatNumber(price, this.settings.priceDecimals);
  }
}

function safeDraw(layer: OverlayPainter, rc: RenderContext): void {
  try {
    layer.draw(rc);
  } catch (err) {
    console.error(`[chart] overlay "${layer.id}" failed`, err);
  }
}

export function dpr(): number {
  if (typeof window === 'undefined') return 1;
  return Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
}
