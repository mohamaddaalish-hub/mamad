/**
 * High-frequency view state (crosshair, view metrics) kept out of the main app
 * store so panning repaints a two-line status bar instead of the whole tree.
 */

import { createStore, useSlice } from '../store/state.ts';
import type { HoverInfo } from '../chart/engine.ts';

export interface ViewState {
  hover: HoverInfo | null;
  rightIndex: number;
  pxPerBar: number;
  visibleBars: number;
  /** True while a tool (drawing, replay marker drag) owns the pointer. */
  toolActive: boolean;
  fps: number;
}

export const viewStore = createStore<ViewState>({
  hover: null,
  rightIndex: 0,
  pxPerBar: 0,
  visibleBars: 0,
  toolActive: false,
  fps: 60,
});

export function useView<K>(select: (s: ViewState) => K): K {
  return useSlice(viewStore, select);
}
