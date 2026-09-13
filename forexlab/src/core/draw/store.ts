/**
 * Drawing store: the single owner of drawings, selection and undo/redo.
 *
 * Deliberately *not* React state — the chart repaints from here directly, and a
 * drag must not re-render the component tree. Panels subscribe to the same store.
 * Persistence reuses the existing IndexedDB layer (`kv` store, one record per
 * dataset), so drawings survive reloads without a second storage system.
 */

import * as idb from '../store/idb.ts';
import { pushDiagnostic } from '../app/state.ts';
import {
  cloneDrawing,
  type SerializedDrawing,
  deserialize,
  newDrawing,
  serialize,
  type Anchor,
  type Drawing,
  type DrawingKind,
} from './model.ts';

interface Edit {
  id: string;
  before: Drawing | null;
  after: Drawing | null;
}

interface HistoryEntry {
  edits: Edit[];
  label: string;
}

export type DrawListener = () => void;

export class DrawingStore {
  private drawings = new Map<string, Drawing>();
  private order: string[] = [];
  private listeners = new Set<DrawListener>();
  /** Cached, immutable view for React's useSyncExternalStore (must not recompute). */
  private snapshot: { list: Drawing[]; selection: string[]; hoverId: string | null; version: number } = {
    list: [],
    selection: [],
    hoverId: null,
    version: 0,
  };
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private pending: Edit[] | null = null;
  private pendingLabel = '';
  private datasetId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  selection: string[] = [];
  hoverId: string | null = null;

  /* ------------------------------------------------------------- reading */

  /** Insertion order — used internally when history snapshots are taken. */
  all(): Drawing[] {
    const out: Drawing[] = [];
    for (const id of this.order) {
      const d = this.drawings.get(id);
      if (d) out.push(d);
    }
    return out;
  }

  /** Paint/manager order: explicit z-order, ties broken by creation time. */
  sorted(): Drawing[] {
    return this.all().sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  /** Drawings belonging to the current dataset (legacy `null` matches anything). */
  visibleFor(datasetId: string | null): Drawing[] {
    return this.sorted().filter((d) => datasetId === null || d.datasetId === null || d.datasetId === datasetId);
  }

  get(id: string): Drawing | undefined {
    return this.drawings.get(id);
  }

  count(): number {
    return this.drawings.size;
  }

  subscribe(fn: DrawListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    this.snapshot = {
      list: this.sorted(),
      selection: this.selection,
      hoverId: this.hoverId,
      version: this.snapshot.version + 1,
    };
    for (const fn of this.listeners) fn();
  }

  /** Stable references between emits — safe as a getSnapshot result. */
  getSnapshot(): { list: Drawing[]; selection: string[]; hoverId: string | null; version: number } {
    return this.snapshot;
  }

  /* ------------------------------------------------------- history plumbing */

  private record(edit: Edit): void {
    if (this.pending) {
      // Inside a gesture: keep the first `before`, overwrite `after` each step.
      const existing = this.pending.find((e) => e.id === edit.id);
      if (existing) existing.after = edit.after;
      else this.pending.push(edit);
      return;
    }
    this.undoStack.push({ edits: [edit], label: 'draw' });
    this.redoStack.length = 0;
  }

  begin(label: string): void {
    this.pending = [];
    this.pendingLabel = label;
  }

  /** Finish a gesture: one undo step for the whole drag. */
  end(): void {
    if (!this.pending) return;
    const edits = this.pending.filter((e) => e.before !== e.after);
    this.pending = null;
    if (edits.length === 0) return;
    this.undoStack.push({ edits, label: this.pendingLabel });
    this.redoStack.length = 0;
    this.scheduleSave();
    this.emit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): string | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.applyEdits(entry.edits, false);
    this.redoStack.push(entry);
    this.scheduleSave();
    this.emit();
    return entry.label;
  }

  redo(): string | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.applyEdits(entry.edits, true);
    this.undoStack.push(entry);
    this.scheduleSave();
    this.emit();
    return entry.label;
  }

  private applyEdits(edits: Edit[], forward: boolean): void {
    for (const e of edits) {
      const value = forward ? e.after : e.before;
      if (value === null) this.drawings.delete(e.id);
      else this.drawings.set(e.id, value);
    }
    this.order = this.sorted().map((d) => d.id);
    this.selection = this.selection.filter((id) => this.drawings.has(id));
  }

  clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /* ------------------------------------------------------------- mutations */

  add(kind: DrawingKind, anchors: Anchor[], patch: Partial<Drawing> = {}): Drawing {
    const maxOrder = this.sorted().reduce((m, d) => Math.max(m, d.order), 0);
    const d = newDrawing(kind, anchors, {
      datasetId: this.datasetId,
      ...patch,
      order: patch.order ?? maxOrder + 1,
    });
    this.drawings.set(d.id, d);
    this.order.push(d.id);
    this.record({ id: d.id, before: null, after: cloneDrawing(d) });
    if (!this.pending) this.end();
    this.scheduleSave();
    this.emit();
    return d;
  }

  update(id: string, patch: Partial<Drawing>, opts: { transient?: boolean } = {}): void {
    const before = this.drawings.get(id);
    if (!before) return;
    if (before.locked && !('locked' in patch)) return; // locked drawings ignore edits
    const after: Drawing = { ...before, ...patch, updatedAt: Date.now() };
    this.drawings.set(id, after);
    this.record({ id, before: cloneDrawing(before), after: cloneDrawing(after) });
    if (opts.transient) {
      this.emit();
      return;
    }
    if (!this.pending) this.end();
    this.scheduleSave();
    this.emit();
  }

  /** Set anchors directly (used by move/resize gestures). */
  setAnchors(id: string, anchors: Anchor[], opts: { transient?: boolean } = {}): void {
    this.update(id, { anchors }, opts);
  }

  remove(ids: string | string[]): void {
    const list = Array.isArray(ids) ? ids : [ids];
    let touched = false;
    for (const id of list) {
      const before = this.drawings.get(id);
      if (!before) continue;
      if (before.locked) continue;
      this.drawings.delete(id);
      this.record({ id, before: cloneDrawing(before), after: null });
      touched = true;
    }
    this.order = this.order.filter((id) => this.drawings.has(id));
    this.selection = this.selection.filter((id) => this.drawings.has(id));
    if (!touched) {
      if (list.length) pushDiagnostic('warn', 'Locked drawings cannot be deleted — unlock them first');
      return;
    }
    if (!this.pending) this.end();
    this.scheduleSave();
    this.emit();
  }

  duplicate(ids: string | string[]): string[] {
    const list = Array.isArray(ids) ? ids : [ids];
    const created: string[] = [];
    this.begin('duplicate');
    let maxOrder = this.sorted().reduce((m, d) => Math.max(m, d.order), 0);
    for (const id of list) {
      const src = this.drawings.get(id);
      if (!src) continue;
      maxOrder += 1;
      const copy = cloneDrawing(src, { order: maxOrder });
      this.drawings.set(copy.id, copy);
      this.order.push(copy.id);
      this.record({ id: copy.id, before: null, after: cloneDrawing(copy) });
      created.push(copy.id);
    }
    this.end();
    this.selection = created;
    this.emit();
    return created;
  }

  setLocked(ids: string | string[], locked: boolean): void {
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      this.update(id, { locked });
    }
  }

  setHidden(ids: string | string[], hidden: boolean): void {
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      const d = this.drawings.get(id);
      if (!d) continue;
      this.update(id, { hidden, locked: d.locked });
    }
  }

  raise(id: string, dir: 1 | -1): void {
    const sorted = this.sorted();
    const i = sorted.findIndex((d) => d.id === id);
    if (i === -1) return;
    const j = Math.max(0, Math.min(sorted.length - 1, i + dir));
    if (i === j) return;
    const a = sorted[i];
    const b = sorted[j];
    this.begin('reorder');
    this.update(a.id, { order: b.order }, { transient: true });
    this.update(b.id, { order: a.order }, { transient: true });
    this.end();
  }

  /* ------------------------------------------------------------- selection */

  select(ids: string[], opts: { additive?: boolean } = {}): void {
    const next = opts.additive ? [...new Set([...this.selection, ...ids])] : ids;
    this.selection = next;
    this.emit();
  }

  clearSelection(): void {
    if (this.selection.length === 0) return;
    this.selection = [];
    this.emit();
  }

  setHover(id: string | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.emit();
  }

  /* -------------------------------------------------------------- scoping */

  /** Swap the drawing set when the active dataset changes. */
  async useDataset(datasetId: string | null): Promise<void> {
    if (this.datasetId === datasetId) return;
    await this.flush();
    this.datasetId = datasetId;
    this.drawings.clear();
    this.order = [];
    this.selection = [];
    this.hoverId = null;
    this.clearHistory();
    if (datasetId) {
      const saved = await idb.get<unknown>(this.keySpace(), this.storageKey(datasetId));
      if (Array.isArray(saved)) {
        for (const raw of saved) {
          const d = deserialize(raw as SerializedDrawing);
          if (!d) continue;
          this.drawings.set(d.id, d);
        }
        this.order = this.sorted().map((d) => d.id);
      }
    }
    this.emit();
  }

  dataset(): string | null {
    return this.datasetId;
  }

  private keySpace(): 'kv' {
    return 'kv';
  }

  private storageKey(datasetId: string): string {
    return `drawings:${datasetId}`;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 400);
  }

  /** Write the current set for the active dataset. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.datasetId) return;
    const payload = this.visibleFor(this.datasetId).map(serialize);
    try {
      await idb.put(this.keySpace(), payload, this.storageKey(this.datasetId));
    } catch (err) {
      pushDiagnostic('error', `Could not save drawings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async deleteForDataset(datasetId: string): Promise<void> {
    await idb.del(this.keySpace(), this.storageKey(datasetId));
    if (this.datasetId === datasetId) {
      this.drawings.clear();
      this.order = [];
      this.clearHistory();
      this.emit();
    }
  }

  /* -------------------------------------------------------------- transfer */

  exportJson(): string {
    return JSON.stringify({ app: 'forexlab', kind: 'drawings', v: 1, drawings: this.all().map(serialize) }, null, 2);
  }

  importJson(text: string, opts: { replace?: boolean } = {}): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      pushDiagnostic('error', `Drawing file could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    const list = (parsed as { drawings?: unknown[] })?.drawings;
    if (!Array.isArray(list)) {
      pushDiagnostic('error', 'Drawing file has no "drawings" array');
      return 0;
    }
    this.begin('import');
    if (opts.replace) {
      for (const d of this.sorted()) this.record({ id: d.id, before: cloneDrawing(d), after: null });
      this.drawings.clear();
      this.order = [];
    }
    let added = 0;
    let maxOrder = this.all().reduce((m, d) => Math.max(m, d.order), 0);
    for (const raw of list) {
      const d = deserialize(raw as SerializedDrawing);
      if (!d) continue;
      if (this.drawings.has(d.id)) d.id = `${d.id}-${added}`;
      d.order = ++maxOrder;
      d.datasetId = this.datasetId;
      this.drawings.set(d.id, d);
      this.order.push(d.id);
      this.record({ id: d.id, before: null, after: cloneDrawing(d) });
      added++;
    }
    this.end();
    this.emit();
    if (added) pushDiagnostic('info', `Imported ${added} drawing(s)`);
    return added;
  }
}

export const drawingStore = new DrawingStore();
