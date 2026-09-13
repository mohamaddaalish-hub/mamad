/** React bindings for the drawing store (external store, no context provider). */

import { useSyncExternalStore } from 'react';
import { drawingStore } from './store.ts';

const subscribe = (onChange: () => void): (() => void) => drawingStore.subscribe(onChange);

export function useDrawings() {
  return useSyncExternalStore(subscribe, () => drawingStore.getSnapshot());
}

export function useDrawingSelection(): string[] {
  return useSyncExternalStore(subscribe, () => drawingStore.getSnapshot().selection);
}

export function useDrawingCount(): number {
  return useSyncExternalStore(subscribe, () => drawingStore.getSnapshot().list.length);
}
