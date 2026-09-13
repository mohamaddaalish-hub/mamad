/**
 * Drawing keyboard layer. Registered after the shell handler, so it wins for the
 * keys it owns and leaves everything else (fullscreen, zoom, replay) alone.
 *
 * Keys are matched case-sensitively on purpose: `h` selects the horizontal-line
 * tool while `Shift + H` hides or shows all drawings.
 */

import { registerShortcutHandler } from '../app/shortcuts.ts';
import { dialogStore } from '../app/dialogs.ts';
import { pushDiagnostic } from '../app/state.ts';
import { drawingController } from './controller.ts';
import { toggleDrawingTool } from '../app/modes.ts';
import { drawingStore } from './store.ts';
import type { DrawingKind } from './model.ts';

const TOOL_KEYS: Record<string, DrawingKind> = {
  h: 'hline',
  v: 'vline',
  t: 'trend',
};

export function installDrawingShortcuts(): () => void {
  return registerShortcutHandler({
    id: 'drawings',
    onKey(e) {
      if (dialogStore.get().open !== null) return false;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;

      if (mod && !e.altKey) {
        if (key === 'z' || key === 'Z') return e.shiftKey ? drawingController.redo() : drawingController.undo();
        if (key === 'y' || key === 'Y') return drawingController.redo();
        if (key === 'd' || key === 'D') return drawingController.duplicateSelection() > 0;
        if (key === 'a' || key === 'A') {
          drawingController.selectAll();
          return true;
        }
        return false;
      }
      if (e.altKey) return false;

      switch (key) {
        case 'Delete':
        case 'Backspace': {
          const n = drawingController.deleteSelection();
          if (n > 0) pushDiagnostic('info', `Removed ${n} drawing(s)`);
          return n > 0;
        }
        case 'Escape':
          return drawingController.cancel();
        case 'l':
        case 'L':
          if (drawingStore.selection.length === 0) return false;
          drawingController.toggleLockSelection();
          return true;
        case 'H':
          // Shift + H (or caps): toggle visibility of every drawing.
          drawingController.hideAll(drawingStore.getSnapshot().list.some((d) => !d.hidden));
          return true;
        default: {
          const tool = TOOL_KEYS[key];
          if (!tool) return false;
          toggleDrawingTool(tool);
          return true;
        }
      }
    },
  });
}
