/**
 * News markers on the existing canvas chart.
 *
 * Registered as an overlay painter + an interaction layer on the main engine,
 * exactly like drawings. Markers are anchored to the bar that contains the
 * release instant and drawn just under the plot's top edge as small glyphs; when
 * several events share a bar they stack into one glyph with a count. Only events
 * inside the visible index range are considered, and the event list is read
 * through the gated research snapshot, so a future event has no marker.
 */

import type { ChartEngine, InteractionLayer, OverlayPainter } from '../chart/engine.ts';
import type { RenderContext } from '../chart/render.ts';
import { overlayRegistry } from '../app/overlays.ts';
import { openDialog } from '../app/dialogs.ts';
import { computeResearch } from './service.ts';
import { newsStore } from './store.ts';
import { filterStore } from './filters.ts';
import { studyConfigStore } from './service.ts';
import { IMPACT_WEIGHT, type EconEvent } from './types.ts';
import type { EnrichedEvent } from './study.ts';

interface Glyph {
  x: number;
  y: number;
  r: number;
  events: EconEvent[];
  ambiguous: boolean;
  maxImpact: number;
}

const MARKER_Y = 10;

function colorFor(imp: number, rc: RenderContext): string {
  if (imp >= IMPACT_WEIGHT.high) return rc.style.bear;
  if (imp >= IMPACT_WEIGHT.medium) return '#c9a24b';
  return rc.style.mutedText;
}

class NewsMarkers {
  private engine: ChartEngine | null = null;
  private off: (() => void) | null = null;
  private layerOff: (() => void) | null = null;
  private storeOffs: (() => void)[] = [];
  private glyphs: Glyph[] = [];
  private hover: Glyph | null = null;
  private lastSnapVersion = '';
  private sortedFiltered: EnrichedEvent[] = [];

  /** Glyphs from the last paint (read-only; used by tests and diagnostics). */
  drawnGlyphs(): readonly { x: number; y: number; events: readonly EconEvent[] }[] {
    return this.glyphs;
  }

  attach(engine: ChartEngine): void {
    this.engine = engine;
    this.off = overlayRegistry.register('news', () => this.painters());
    this.layerOff = engine.addInteraction(this.layer());
    const rerender = () => this.engine?.requestRender();
    this.storeOffs = [newsStore.subscribe(rerender), filterStore.subscribe(rerender), studyConfigStore.subscribe(rerender)];
    overlayRegistry.sync();
  }

  detach(): void {
    this.off?.();
    this.layerOff?.();
    this.off = this.layerOff = null;
    for (const off of this.storeOffs) off();
    this.storeOffs = [];
    this.engine = null;
  }

  private painters(): OverlayPainter[] {
    return [{ id: 'markers', draw: (rc) => this.draw(rc) }];
  }

  private events(): EnrichedEvent[] {
    const snap = computeResearch();
    const tag = `${snap.version}|${snap.knownUntil}|${JSON.stringify(snap.filter)}|${snap.series?.count ?? 0}|${newsStore.get().hiddenIds.length}`;
    if (tag !== this.lastSnapVersion) {
      const hidden = new Set(newsStore.get().hiddenIds);
      this.sortedFiltered = snap.filtered.filter((e) => !hidden.has(e.event.id));
      this.lastSnapVersion = tag;
    }
    return this.sortedFiltered;
  }

  private draw(rc: RenderContext): void {
    this.glyphs = [];
    if (!newsStore.get().showOnChart) return;
    const series = rc.series;
    if (series.count === 0) return;
    const range = rc.view.visibleRange(series.count);
    const step = series.stepMs ?? 0;
    const t0 = series.time(Math.max(0, range.from));
    const lastIdx = Math.min(series.count - 1, range.to);
    const t1 = series.time(lastIdx) + (step || 1);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return;
    const list = this.events();
    // Binary search into time-sorted list.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].event.time < t0) lo = mid + 1;
      else hi = mid;
    }
    const buckets = new Map<number, Glyph>();
    let painted = 0;
    for (let i = lo; i < list.length && list[i].event.time <= t1 && painted < 600; i++) {
      const e = list[i];
      const idx = series.indexAtOrBefore(e.event.time);
      if (idx < 0) continue;
      let g = buckets.get(idx);
      if (!g) {
        g = { x: rc.view.indexToX(idx), y: rc.geom.plotTop + MARKER_Y, r: 4, events: [], ambiguous: false, maxImpact: 0 };
        buckets.set(idx, g);
      }
      g.events.push(e.event);
      g.ambiguous ||= e.cluster.ambiguous;
      g.maxImpact = Math.max(g.maxImpact, e.event.impact ? IMPACT_WEIGHT[e.event.impact] : 0.1);
      painted++;
    }
    const ctx = rc.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rc.geom.plotLeft, rc.geom.plotTop, rc.geom.plotW, rc.geom.plotH);
    ctx.clip();
    const detailId = newsStore.get().detailId;
    for (const g of buckets.values()) {
      if (g.x < rc.geom.plotLeft - 8 || g.x > rc.geom.plotRight + 8) continue;
      const color = colorFor(g.maxImpact, rc);
      const active = this.hover === g || (detailId !== null && g.events.some((e) => e.id === detailId));
      // Thin guide line down the bar for the active marker.
      if (active) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(g.x) + 0.5, g.y + g.r);
        ctx.lineTo(Math.round(g.x) + 0.5, rc.geom.plotBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      // Diamond glyph
      ctx.fillStyle = color;
      ctx.globalAlpha = active ? 1 : 0.85;
      ctx.beginPath();
      ctx.moveTo(g.x, g.y - g.r);
      ctx.lineTo(g.x + g.r, g.y);
      ctx.lineTo(g.x, g.y + g.r);
      ctx.lineTo(g.x - g.r, g.y);
      ctx.closePath();
      ctx.fill();
      if (g.ambiguous) {
        ctx.strokeStyle = rc.style.background;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (g.events.length > 1) {
        ctx.fillStyle = rc.style.mutedText;
        ctx.font = `9px ${rc.style.fontFamily}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(g.events.length), g.x + g.r + 2, g.y);
      }
      this.glyphs.push(g);
    }
    if (this.hover) {
      const g = this.hover;
      const lines = g.events.slice(0, 4).map((e) => `${e.currency} · ${e.event}`);
      if (g.events.length > 4) lines.push(`+${g.events.length - 4} more`);
      ctx.font = `10px ${rc.style.fontFamily}`;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
      const h = lines.length * 14 + 8;
      let x = g.x + 8;
      if (x + w > rc.geom.plotRight) x = g.x - 8 - w;
      const y = g.y + 8;
      ctx.fillStyle = rc.style.background;
      ctx.globalAlpha = 0.94;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rc.style.mutedText;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, w, h);
      ctx.fillStyle = rc.style.textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, x + 6, y + 4 + i * 14));
    }
    ctx.restore();
  }

  private hit(x: number, y: number): Glyph | null {
    for (const g of this.glyphs) {
      if (Math.abs(x - g.x) <= g.r + 3 && Math.abs(y - g.y) <= g.r + 3) return g;
    }
    return null;
  }

  private layer(): InteractionLayer {
    return {
      id: 'news',
      cursor: () => (this.hover ? 'pointer' : undefined),
      onPointerMove: (info) => {
        const g = this.hit(info.x, info.y);
        if (g !== this.hover) {
          this.hover = g;
          this.engine?.requestRender();
        }
        return false;
      },
      onPointerDown: (info) => {
        const g = this.hit(info.x, info.y);
        if (!g) return false;
        openEventDetail(g.events[0].id);
        return true;
      },
      onPointerUp: () => this.hover !== null,
    };
  }
}

export const newsMarkers = new NewsMarkers();

export function openEventDetail(id: string): void {
  newsStore.set({ detailId: id });
  openDialog('eventDetail', id);
  overlayRegistry.scheduleSync();
}
