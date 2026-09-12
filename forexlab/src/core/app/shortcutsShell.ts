/**
 * Shell-level keyboard shortcuts. Subsystems register their own handlers
 * (replay, drawings) through `registerShortcutHandler`.
 */

import { appStore } from './state.ts';
import { registerShortcutHandler } from './shortcuts.ts';
import { fitAll, resetView, zoomIn, zoomOut } from './actions.ts';

export function installGlobalShortcuts(): () => void {
  const disposers: (() => void)[] = [];
  disposers.push(
    registerShortcutHandler({
      id: 'shell',
      onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        switch (e.key) {
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
          case 'Escape':
            if (appStore.get().fullscreen) {
              appStore.set({ fullscreen: false });
              return true;
            }
            return false;
          default:
            return false;
        }
      },
    }),
  );
  disposers.push(
    registerShortcutHandler({
      id: 'view-fit',
      onKey(e) {
        if (e.key === 'Home') {
          fitAll();
          return true;
        }
        return false;
      },
    }),
  );
  return () => {
    for (const d of disposers) d();
  };
}
