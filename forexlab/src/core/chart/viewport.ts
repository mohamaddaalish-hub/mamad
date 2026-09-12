/**
 * View geometry and index/price ↔ pixel transforms.
 *
 * The horizontal axis is *index* based (no weekend holes, like a professional FX
 * chart), while labels are resolved through the series so they always show real
 * bar times. Price is linear.
 */

import type { CandleSeries } from '../data/series.ts';

export interface ChartGeom {
  width: number;
  height: number;
  dpr: number;
  axisW: number;
  axisH: number;
  plotLeft: number;
  plotTop: number;
  plotW: number;
  plotH: number;
  plotRight: number;
  plotBottom: number;
}

export interface ViewOptions {
  /** Fractional index anchored at the right edge of the plot (minus rightGap). */
  rightIndex: number;
  pxPerBar: number;
  rightGap: number;
  priceMin: number;
  priceMax: number;
  autoPrice: boolean;
}

export const MIN_PX_PER_BAR = 0.08;
export const MAX_PX_PER_BAR = 120;
export const DEFAULT_PX_PER_BAR = 7;

export function geometry(width: number, height: number, dpr: number, axisW = 66, axisH = 26): ChartGeom {
  const plotRight = Math.max(10, width - axisW);
  const plotBottom = Math.max(10, height - axisH);
  return {
    width,
    height,
    dpr,
    axisW,
    axisH,
    plotLeft: 0,
    plotTop: 0,
    plotW: plotRight,
    plotH: plotBottom,
    plotRight,
    plotBottom,
  };
}

export class Viewport {
  geom: ChartGeom;
  rightIndex = 0;
  pxPerBar = DEFAULT_PX_PER_BAR;
  rightGap = 24;
  priceMin = 0;
  priceMax = 1;
  autoPrice = true;

  constructor(geom: ChartGeom, opts: Partial<ViewOptions> = {}) {
    this.geom = geom;
    Object.assign(this, opts);
  }

  get pxPerPrice(): number {
    const span = this.priceMax - this.priceMin;
    return span > 0 ? this.geom.plotH / span : 1;
  }

  indexToX(i: number): number {
    return this.geom.plotRight - this.rightGap - (this.rightIndex - i) * this.pxPerBar;
  }

  xToIndex(x: number): number {
    return this.rightIndex - (this.geom.plotRight - this.rightGap - x) / this.pxPerBar;
  }

  priceToY(p: number): number {
    const span = this.priceMax - this.priceMin;
    if (!(span > 0)) return this.geom.plotTop + this.geom.plotH / 2;
    return this.geom.plotTop + ((this.priceMax - p) / span) * this.geom.plotH;
  }

  yToPrice(y: number): number {
    const span = this.priceMax - this.priceMin;
    return this.priceMax - ((y - this.geom.plotTop) / this.geom.plotH) * span;
  }

  /** Visible index window, clamped to the accessible candle count. */
  visibleRange(count: number): { from: number; to: number } {
    const left = this.xToIndex(this.geom.plotLeft);
    const to = Math.max(0, Math.min(count, Math.ceil(this.rightIndex) + 2));
    const from = Math.max(0, Math.min(Math.floor(left) - 1, to));
    return { from, to };
  }

  /** Number of whole bars visible across the plot. */
  visibleBars(): number {
    return this.geom.plotW / Math.max(0.01, this.pxPerBar);
  }

  clampPan(count: number): void {
    // Keep at least a quarter of the plot covered by real candles.
    const minRight = Math.min(count - 1, this.visibleBars() * 0.25);
    const maxRight = count - 1 + this.visibleBars() * 0.6;
    this.rightIndex = Math.max(minRight, Math.min(maxRight, this.rightIndex));
    if (!Number.isFinite(this.rightIndex)) this.rightIndex = Math.max(0, count - 1);
  }

  zoomAt(x: number, factor: number, count: number): void {
    const anchorIndex = this.xToIndex(x);
    const next = Math.max(MIN_PX_PER_BAR, Math.min(MAX_PX_PER_BAR, this.pxPerBar * factor));
    if (next === this.pxPerBar) return;
    this.pxPerBar = next;
    this.rightIndex = anchorIndex + (this.geom.plotRight - this.rightGap - x) / this.pxPerBar;
    this.clampPan(count);
  }

  panBy(dxPx: number, count: number): void {
    this.rightIndex -= dxPx / this.pxPerBar;
    this.clampPan(count);
  }

  /** Anchor the view so `index` sits at `x`. */
  anchorIndexAt(index: number, x: number, count: number): void {
    this.rightIndex = index + (this.geom.plotRight - this.rightGap - x) / this.pxPerBar;
    this.clampPan(count);
  }

  snapshot(): ViewOptions {
    return {
      rightIndex: this.rightIndex,
      pxPerBar: this.pxPerBar,
      rightGap: this.rightGap,
      priceMin: this.priceMin,
      priceMax: this.priceMax,
      autoPrice: this.autoPrice,
    };
  }

  /** Fit every accessible candle into the plot. */
  fitAll(count: number): void {
    if (count <= 0) {
      this.rightIndex = 0;
      this.pxPerBar = DEFAULT_PX_PER_BAR;
      return;
    }
    const usable = Math.max(20, this.geom.plotW - this.rightGap - 2);
    this.pxPerBar = Math.max(MIN_PX_PER_BAR, Math.min(MAX_PX_PER_BAR, usable / Math.max(1, count)));
    this.rightIndex = count - 1;
  }

  /** Autoscale price over a [min,max] envelope with a calm amount of padding. */
  applyPriceBounds(min: number, max: number): void {
    if (!(Number.isFinite(min) && Number.isFinite(max))) return;
    let lo = min;
    let hi = max;
    if (hi - lo < 1e-10) {
      const pad = Math.max(1e-5, Math.abs(hi) * 1e-5);
      lo -= pad;
      hi += pad;
    }
    const pad = (hi - lo) * 0.08;
    this.priceMin = lo - pad;
    this.priceMax = hi + pad;
  }
}

/** Round a bar index to the nearest accessible index. */
export function nearestIndex(series: CandleSeries, index: number): number {
  return Math.max(0, Math.min(series.count - 1, Math.round(index)));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
