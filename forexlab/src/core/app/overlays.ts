/**
 * Overlay registry: the plug-in point that keeps the chart engine decoupled from
 * drawings, trades, news markers and the replay marker.
 *
 * Each subsystem registers a provider that returns canvas painters. Providers are
 * called only when app state actually changes (not per frame) and each painter is
 * handed the render context at paint time.
 */

import type { ChartEngine, OverlayPainter } from '../chart/engine.ts';

export type OverlayProvider = () => OverlayPainter[];

class OverlayRegistry {
  private providers = new Map<string, OverlayProvider>();
  private engines = new Map<string, ChartEngine>();
  private pending = false;

  register(id: string, provider: OverlayProvider): () => void {
    this.providers.set(id, provider);
    this.sync();
    return () => {
      this.providers.delete(id);
      this.sync();
    };
  }

  attach(surfaceId: string, engine: ChartEngine): void {
    this.engines.set(surfaceId, engine);
    this.sync(surfaceId);
  }

  detach(surfaceId: string): void {
    this.engines.delete(surfaceId);
  }

  getEngine(surfaceId = 'main'): ChartEngine | undefined {
    return this.engines.get(surfaceId);
  }

  /** Recompute painters for one surface (default: all). */
  sync(surfaceId?: string): void {
    const painters: OverlayPainter[] = [];
    for (const [id, provider] of this.providers) {
      try {
        for (const p of provider()) painters.push({ ...p, id: `${id}:${p.id}` });
      } catch (err) {
        console.error(`[overlays] provider "${id}" failed`, err);
      }
    }
    for (const [key, engine] of this.engines) {
      if (surfaceId && key !== surfaceId) continue;
      engine.setLayers(painters);
    }
  }

  /** Coalesce several state updates into one painter rebuild. */
  scheduleSync(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.sync();
    });
  }
}

export const overlayRegistry = new OverlayRegistry();
