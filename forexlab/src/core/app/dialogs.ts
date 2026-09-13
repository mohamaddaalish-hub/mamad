/**
 * Modal/dialog host state + the canonical shortcut documentation.
 *
 * Dialogs live in their own tiny store so opening one never touches the app
 * store that the chart engine subscribes to.
 */

import { createStore, useSlice } from '../store/state.ts';

export type DialogId = 'goto' | 'import' | 'shortcuts' | 'confirm';

export interface DialogState {
  open: DialogId | null;
  /** Free-form payload for dialogs that need context (confirm messages, replay start). */
  payload: unknown;
}

export const dialogStore = createStore<DialogState>({ open: null, payload: null });

export function useDialog<K>(select: (s: DialogState) => K): K {
  return useSlice(dialogStore, select);
}

export function openDialog(id: DialogId, payload: unknown = null): void {
  dialogStore.set({ open: id, payload });
}

export function closeDialog(): void {
  if (dialogStore.get().open !== null) dialogStore.set({ open: null, payload: null });
}

export interface ShortcutDoc {
  keys: string;
  label: string;
  scope: string;
}

/** Single source of truth for tooltips and the shortcut sheet. */
export const SHORTCUTS: ShortcutDoc[] = [
  { keys: 'G', label: 'Go to date / time', scope: 'Chart' },
  { keys: 'Home', label: 'Fit all bars', scope: 'Chart' },
  { keys: 'End', label: 'Go to newest bar', scope: 'Chart' },
  { keys: 'Shift + Home', label: 'Go to first bar', scope: 'Chart' },
  { keys: '← / →', label: 'Previous / next bar (when replay is idle)', scope: 'Chart' },
  { keys: '+ / −', label: 'Zoom in / out', scope: 'Chart' },
  { keys: '0', label: 'Reset view', scope: 'Chart' },
  { keys: 'F', label: 'Fullscreen chart', scope: 'Shell' },
  { keys: '\\', label: 'Toggle left rail', scope: 'Shell' },
  { keys: 'I', label: 'Import CSV', scope: 'Data' },
  { keys: 'H', label: 'Horizontal line tool', scope: 'Drawings' },
  { keys: 'V', label: 'Vertical line tool', scope: 'Drawings' },
  { keys: 'T', label: 'Trend line tool', scope: 'Drawings' },
  { keys: 'L', label: 'Lock / unlock the selection', scope: 'Drawings' },
  { keys: 'Shift + H', label: 'Hide or show every drawing', scope: 'Drawings' },
  { keys: 'Del', label: 'Delete the selection', scope: 'Drawings' },
  { keys: 'Mod + D', label: 'Duplicate the selection', scope: 'Drawings' },
  { keys: 'Mod + A', label: 'Select all drawings', scope: 'Drawings' },
  { keys: 'Esc', label: 'Cancel tool or gesture, close dialog, exit fullscreen', scope: 'Global' },
  { keys: 'Ctrl (⌘) + Z', label: 'Undo (drawings, trades)', scope: 'History' },
  { keys: 'Shift + Ctrl (⌘) + Z', label: 'Redo (drawings, trades)', scope: 'History' },
  { keys: 'Space', label: 'Play / pause Bar Replay', scope: 'Replay' },
  { keys: 'R', label: 'Restart replay at the start point', scope: 'Replay' },
  { keys: '→', label: 'Step one bar forward', scope: 'Replay' },
  { keys: '←', label: 'Step one bar back (while replaying)', scope: 'Replay' },
  { keys: 'Esc', label: 'Exit replay (full dataset returns)', scope: 'Replay' },
  { keys: 'Shift + →', label: 'Step ten bars', scope: 'Replay' },
  { keys: 'Ctrl (⌘) + drag', label: 'Pinch-zoom on trackpads', scope: 'Chart' },
  { keys: 'Wheel', label: 'Zoom around the cursor; Shift = pan time', scope: 'Chart' },
  { keys: 'Double-click axis', label: 'Restore automatic price scale', scope: 'Chart' },
];
