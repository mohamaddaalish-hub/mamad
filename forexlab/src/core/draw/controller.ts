/**
 * Drawing controller: tool state, pointer interaction and the overlay painter.
 *
 * It plugs into the chart through the engine's existing extension points
 * (`addInteraction` + `overlayRegistry`), so the chart engine stays ignorant of
 * drawings. While a tool is active or a shape is being dragged the controller
 * consumes the pointer, which is what suppresses chart panning.
 */

import type { ChartEngine, InteractionLayer, OverlayPainter } from '../chart/engine.ts';
import { overlayRegistry } from '../app/overlays.ts';
import { appStore, pushDiagnostic } from '../app/state.ts';
import { drawingStore } from './store.ts';
import {
  hitTest,
  moveDrawing,
  newDrawing,
  snapPrice,
  toolOf,
  unproject,
  type Anchor,
  type Drawing,
  type DrawingKind,
} from './model.ts';
import { paintDrawings, type Draft } from './paint.ts';

type Gesture =
  | { type: 'create'; kind: DrawingKind; anchors: Anchor[]; done: boolean }
  | { type: 'move'; id: string; start: { x: number; y: number }; origin: Anchor[]; dx: number; dy: number }
  | { type: 'resize'; id: string; anchorIndex: number; origin: Anchor[] }
  | { type: 'brush'; id: string; anchors: Anchor[] };

export interface DrawSettings {
  /** Snap anchors to the hovered bar's high/low/close. */
  magnet: boolean;
  color: string;
  width: number;
  style: Drawing['style']['style'];
  opacity: number;
  fill: boolean;
}

const DEFAULTS: DrawSettings = { magnet: true, color: '#5b8ec9', width: 1.5, style: 'solid', opacity: 0.95, fill: false };

class DrawingController {
  tool: DrawingKind | null = null;
  gesture: Gesture | null = null;
  settings: DrawSettings = { ...DEFAULTS };
  private engine: ChartEngine | null = null;
  private disposer: (() => void) | null = null;
  private overlayOff: (() => void) | null = null;
  private pendingText: { id: string } | null = null;

  /* ------------------------------------------------------------ attach/detach */

  attach(engine: ChartEngine): void {
    this.engine = engine;
    this.disposer = engine.addInteraction(this.layer());
    this.overlayOff = overlayRegistry.register('drawings', () => this.painters());
    engine.setToolCursor(this.tool ? 'crosshair' : undefined);
    overlayRegistry.sync();
  }

  detach(): void {
    this.disposer?.();
    this.overlayOff?.();
    this.disposer = null;
    this.overlayOff = null;
    this.engine = null;
  }

  private painters(): OverlayPainter[] {
    const deps = {
      store: drawingStore,
      draft: (): Draft | null =>
        this.gesture && this.gesture.type === 'create'
          ? { kind: this.gesture.kind, anchors: this.gesture.anchors }
          : this.gesture && this.gesture.type === 'brush'
            ? { kind: 'brush', anchors: this.gesture.anchors }
            : null,
      limitIndex: () => {
        const replay = appStore.get().replay;
        const series = this.engine?.getSeries();
        if (!replay.active || !series) return null;
        return Math.min(series.count - 1, replay.cursor);
      },
    };
    return [{ id: 'drawings', draw: (rc) => paintDrawings(rc, deps) }];
  }

  private repaint(): void {
    this.engine?.requestRender();
  }

  /* ------------------------------------------------------------------- tools */

  /** Registered by app/modes so arming a drawing releases the other mode. */
  onToolChange: ((kind: DrawingKind | null) => void) | null = null;

  setTool(kind: DrawingKind | null): void {
    this.tool = kind;
    if (this.onToolChange) this.onToolChange(kind);
    this.gesture = null;
    appStore.set({ tool: kind });
    this.engine?.setToolCursor(kind ? 'crosshair' : undefined);
    if (kind) drawingStore.clearSelection();
    this.repaint();
  }

  toggleTool(kind: DrawingKind): void {
    this.setTool(this.tool === kind ? null : kind);
  }

  updateSettings(patch: Partial<DrawSettings>): void {
    this.settings = { ...this.settings, ...patch };
    const ids = drawingStore.selection;
    if (ids.length > 0) {
      // Editing the palette while something is selected restyles that selection.
      for (const id of ids) {
        const d = drawingStore.get(id);
        if (!d) continue;
        drawingStore.update(id, {
          style: {
            ...d.style,
            color: patch.color ?? d.style.color,
            width: patch.width ?? d.style.width,
            style: patch.style ?? d.style.style,
            opacity: patch.opacity ?? d.style.opacity,
            fill: patch.fill === undefined ? d.style.fill : patch.fill ? this.settings.color : null,
          },
        });
      }
    }
    this.repaint();
  }

  /* ------------------------------------------------------------ interaction */

  private layer(): InteractionLayer {
    return {
      id: 'drawings',
      cursor: () => (this.tool ? 'crosshair' : this.hoverCursor()),
      onPointerDown: (info, engine) => this.onDown(info, engine),
      onPointerMove: (info, engine) => this.onMove(info, engine),
      onPointerUp: (info, engine) => this.onUp(info, engine),
    };
  }

  private hoverCursor(): string | undefined {
    if (this.gesture?.type === 'move') return 'grabbing';
    if (this.gesture?.type === 'resize') return 'nwse-resize';
    return undefined;
  }

  private series() {
    return this.engine?.getSeries() ?? null;
  }

  private anchorAt(info: { x: number; y: number; index: number | null }): Anchor | null {
    const series = this.series();
    const engine = this.engine;
    if (!series || !engine) return null;
    const priceFn = this.settings.magnet
      ? (price: number, index: number) => snapPrice(series, index, price, 6, engine.view)
      : undefined;
    return unproject(info.x, info.y, engine.view, series, priceFn);
  }

  private onDown(info: { index: number | null; price: number; x: number; y: number }, engine: ChartEngine): boolean {
    const series = this.series();
    if (!series) return false;

    if (this.tool) {
      const anchor = this.anchorAt(info);
      if (!anchor) return false;
      const need = toolOf(this.tool);
      if (this.tool === 'brush') {
        this.gesture = { type: 'brush', id: '', anchors: [anchor] };
        return true;
      }
      if (need <= 1) {
        const d = this.commit(this.tool, [anchor]);
        this.tool = null;
        appStore.set({ tool: null });
        engine.setToolCursor(undefined);
        drawingStore.select([d.id]);
        this.repaint();
        return true;
      }
      this.gesture = { type: 'create', kind: this.tool, anchors: [anchor, anchor], done: false };
      return true;
    }

    // No tool: select / move / resize.
    const list = drawingStore.visibleFor(drawingStore.dataset());
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      if (d.hidden) continue;
      const hit = hitTest(d, engine.view, series, info.x, info.y);
      if (!hit) continue;
      const additive = true; // shift extends the selection
      if (hit.type === 'body') {
        const already = drawingStore.selection.includes(d.id);
        drawingStore.select(already && additive ? [...new Set([...drawingStore.selection, d.id])] : [d.id]);
        if (!d.locked) {
          drawingStore.begin('move');
          this.gesture = { type: 'move', id: d.id, start: { x: info.x, y: info.y }, origin: d.anchors.map((a) => ({ ...a })), dx: 0, dy: 0 };
        } else {
          pushDiagnostic('info', `${labelOf(d)} is locked — unlock it in the Drawings manager to edit`);
        }
      } else if (hit.type === 'anchor' && !d.locked) {
        drawingStore.select([d.id]);
        drawingStore.begin('resize');
        this.gesture = { type: 'resize', id: d.id, anchorIndex: hit.index, origin: d.anchors.map((a) => ({ ...a })) };
      } else {
        drawingStore.select([d.id]);
      }
      this.repaint();
      return true;
    }
    if (drawingStore.selection.length) {
      drawingStore.clearSelection();
      this.repaint();
    }
    return false;
  }

  private onMove(info: { index: number | null; price: number; x: number; y: number }, engine: ChartEngine): boolean {
    const series = this.series();
    const g = this.gesture;
    if (!g || !series) {
      // Hover feedback for selection handles even without a gesture.
      if (!this.tool && series) {
        const list = drawingStore.visibleFor(drawingStore.dataset());
        let found: string | null = null;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].hidden) continue;
          if (hitTest(list[i], engine.view, series, info.x, info.y)) {
            found = list[i].id;
            break;
          }
        }
        if (found !== drawingStore.hoverId) {
          drawingStore.setHover(found);
          this.repaint();
        }
      }
      return false;
    }
    const anchor = this.anchorAt(info);
    if (!anchor) return true;
    switch (g.type) {
      case 'create': {
        const need = toolOf(g.kind);
        const anchors = need === 2 ? [g.anchors[0], anchor] : need === 3 ? [g.anchors[0], g.anchors[1], anchor] : [anchor];
        this.gesture = { ...g, anchors };
        break;
      }
      case 'brush': {
        const last = g.anchors[g.anchors.length - 1];
        if (!last || last.t !== anchor.t || Math.abs(last.p - anchor.p) > 1e-12) {
          // One point per bar keeps freehand strokes cheap.
          g.anchors.push(anchor);
        }
        break;
      }
      case 'move': {
        const bars = Math.round((info.x - g.start.x) / Math.max(0.08, engine.view.pxPerBar));
        const dPrice = engine.view.yToPrice(info.y) - engine.view.yToPrice(g.start.y);
        g.dx = bars;
        g.dy = dPrice;
        const moved = moveDrawing({ ...drawingStore.get(g.id)!, anchors: g.origin }, bars, dPrice, series);
        drawingStore.setAnchors(g.id, moved.anchors, { transient: true });
        break;
      }
      case 'resize': {
        const anchors = g.origin.map((a, i) => (i === g.anchorIndex ? anchor : a));
        drawingStore.setAnchors(g.id, anchors, { transient: true });
        break;
      }
    }
    this.repaint();
    return true;
  }

  private onUp(info: { index: number | null; price: number; x: number; y: number }, _engine: ChartEngine): boolean {
    const g = this.gesture;
    if (!g) return false;
    this.gesture = null;
    const series = this.series();
    switch (g.type) {
      case 'create': {
        const need = toolOf(g.kind);
        const anchor = this.anchorAt(info);
        const anchors = anchor ? (need === 2 ? [g.anchors[0], anchor] : need === 3 ? [g.anchors[0], g.anchors[1], anchor] : [anchor]) : g.anchors;
        if (this.tool === g.kind) {
          // Single click without a drag still creates a usable shape at the cursor.
          this.commit(g.kind, anchors);
          this.setTool(null);
        }
        break;
      }
      case 'brush': {
        if (g.anchors.length > 1 && series) {
          const d = drawingStore.add('brush', g.anchors, this.stylePatch());
          this.applyText(d, g.anchors.length);
        }
        break;
      }
      case 'move':
      case 'resize': {
        drawingStore.end();
        break;
      }
    }
    this.repaint();
    return true;
  }

  private stylePatch(): Partial<Drawing> {
    return {
      style: {
        color: this.settings.color,
        width: this.settings.width,
        style: this.settings.style,
        opacity: this.settings.opacity,
        fill: this.settings.fill ? this.settings.color : null,
        fillOpacity: 0.14,
        font: 'sm',
        label: true,
      },
    };
  }

  private commit(kind: DrawingKind, anchors: Anchor[]): Drawing {
    const d = drawingStore.add(kind, anchors, this.stylePatch());
    if (kind === 'text' || kind === 'callout') this.promptText(d.id, d.text);
    return d;
  }

  private applyText(d: Drawing, points: number): void {
    if (points < 2) return;
    if (d.text) this.promptText(d.id, d.text);
  }

  /**
   * Text entry is delegated to the UI layer (an inline editor) so pointer capture
   * on the canvas does not steal focus from a DOM input.
   */
  promptText(id: string, current: string): void {
    this.pendingText = { id };
    const value = typeof window !== 'undefined' ? window.prompt('Drawing note', current) : null;
    this.pendingText = null;
    if (value !== null) drawingStore.update(id, { text: value });
    this.repaint();
  }

  get pendingTextInput(): { id: string } | null {
    return this.pendingText;
  }

  /* --------------------------------------------------------------- commands */

  deleteSelection(): number {
    const ids = drawingStore.selection;
    if (ids.length === 0) return 0;
    drawingStore.remove(ids);
    this.repaint();
    return ids.length;
  }

  duplicateSelection(): number {
    const ids = drawingStore.selection;
    if (ids.length === 0) return 0;
    const created = drawingStore.duplicate(ids);
    this.repaint();
    return created.length;
  }

  toggleLockSelection(): void {
    const ids = drawingStore.selection;
    if (ids.length === 0) return;
    const any = ids.some((id) => !drawingStore.get(id)?.locked);
    drawingStore.setLocked(ids, any);
    this.repaint();
  }

  toggleHideSelection(): void {
    const ids = drawingStore.selection;
    if (ids.length === 0) return;
    const anyVisible = ids.some((id) => !drawingStore.get(id)?.hidden);
    drawingStore.setHidden(ids, anyVisible);
    this.repaint();
  }

  selectAll(): void {
    drawingStore.select(drawingStore.visibleFor(drawingStore.dataset()).map((d) => d.id));
    this.repaint();
  }

  cancel(): boolean {
    if (this.gesture) {
      this.gesture = null;
      drawingStore.end();
      this.repaint();
      return true;
    }
    if (this.tool) {
      this.setTool(null);
      return true;
    }
    if (drawingStore.selection.length) {
      drawingStore.clearSelection();
      this.repaint();
      return true;
    }
    return false;
  }

  undo(): boolean {
    const label = drawingStore.undo();
    if (label === null) {
      pushDiagnostic('info', 'Nothing to undo');
      return false;
    }
    this.repaint();
    return true;
  }

  redo(): boolean {
    const label = drawingStore.redo();
    if (label === null) {
      pushDiagnostic('info', 'Nothing to redo');
      return false;
    }
    this.repaint();
    return true;
  }

  hideAll(hidden: boolean): void {
    for (const d of drawingStore.visibleFor(drawingStore.dataset())) {
      drawingStore.update(d.id, { hidden, locked: d.locked });
    }
    this.repaint();
  }

  focusSelection(): void {
    const ids = drawingStore.selection;
    const engine = this.engine;
    const series = this.series();
    if (!engine || !series || ids.length === 0) return;
    const d = drawingStore.get(ids[ids.length - 1]);
    if (!d) return;
    engine.goToTime(d.anchors[0].t, 'center');
    this.repaint();
  }
}

function labelOf(d: Drawing): string {
  return d.text ? `${d.kind} "${d.text}"` : d.kind;
}

export const drawingController = new DrawingController();

/** Convenience for tests and non-UI callers. */
export function addDrawing(kind: DrawingKind, anchors: Anchor[], patch: Partial<Drawing> = {}): Drawing {
  return newDrawing(kind, anchors, patch);
}
