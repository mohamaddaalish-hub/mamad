/**
 * Shell-level keyboard shortcuts. Subsystems register their own handlers
 * (replay, drawings) through `registerShortcutHandler`.
 *
 * Registration order matters: handlers are unshifted, so a later subsystem (for
 * example Bar Replay) wins over the shell for the same key. The shell therefore
 * only handles arrows while replay is idle.
 */

import { appStore } from './state.ts';
import { registerShortcutHandler } from './shortcuts.ts';
import { closeDialog, dialogStore, openDialog } from './dialogs.ts';
import { fitAll, jumpToFirst, jumpToLast, resetView, stepPeriod, zoomIn, zoomOut } from './actions.ts';
import { chartHost } from './actions.ts';

export function installGlobalShortcuts(): () => void {
  const disposers: (() => void)[] = [];
  disposers.push(
    registerShortcutHandler({
      id: 'shell',
      onKey(e) {
        const dialogOpen = dialogStore.get().open !== null;
        if (e.key === 'Escape') {
          if (dialogOpen) {
            closeDialog();
            return true;
          }
          if (appStore.get().tool) {
            appStore.set({ tool: null });
            return true;
          }
          if (appStore.get().fullscreen) {
            appStore.set({ fullscreen: false });
            return true;
          }
          return false;
        }
        // While a modal owns the keyboard only Escape is handled here.
        if (dialogOpen) return false;
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        const hasData = (chartHost.engine?.getSeries()?.count ?? 0) > 0;
        switch (e.key) {
          case 'g':
          case 'G':
            if (hasData) openDialog('goto');
            return true;
          case 'i':
          case 'I':
            openDialog('import');
            return true;
          case '?':
            openDialog('shortcuts');
            return true;
          case 'f':
          case 'F':
            appStore.set({ fullscreen: !appStore.get().fullscreen });
            return true;
          case '+':
          case '=':
            zoomIn();
            return true;
          case '-':
          case '_':
            zoomOut();
            return true;
          case '0':
            resetView();
            return true;
          case '\\':
            appStore.set({ leftOpen: !appStore.get().leftOpen });
            return true;
          case 'Home':
            if (e.shiftKey) jumpToFirst();
            else fitAll();
            return true;
          case 'End':
            jumpToLast();
            return true;
          case 'ArrowLeft':
          case 'ArrowRight': {
            // Replay (when active) registers later and consumes these first.
            if (appStore.get().replay.active || !hasData) return false;
            stepPeriod(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey ? 10 : 1);
            return true;
          }
          default:
            return false;
        }
      },
    }),
  );
  return () => {
    for (const d of disposers) d();
  };
}
