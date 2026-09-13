/**
 * Replay keyboard layer. Registered last so it outranks the shell and drawing
 * handlers for its own keys (Space, arrows, R) — which is exactly the rule the
 * spec asks for: while replay is running those keys belong to replay.
 */

import { registerShortcutHandler } from '../app/shortcuts.ts';
import { dialogStore } from '../app/dialogs.ts';
import { appStore } from '../app/state.ts';
import { barReplay } from './engine.ts';

export function installReplayShortcuts(): () => void {
  return registerShortcutHandler({
    id: 'replay',
    onKey(e) {
      if (dialogStore.get().open !== null) return false;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const active = appStore.get().replay.active;
      switch (e.key) {
        case ' ':
        case 'Spacebar':
          barReplay.playPause();
          return true;
        case 'ArrowRight':
          // Inactive replay leaves the arrow to the shell's bar-by-bar navigation.
          if (!active) return false;
          barReplay.step(e.shiftKey ? 10 : 1);
          return true;
        case 'ArrowLeft':
          if (!active) return false;
          barReplay.step(e.shiftKey ? -10 : -1);
          return true;
        case 'r':
        case 'R':
          if (!active) return false;
          barReplay.restart();
          return true;
        case '.':
          if (active) barReplay.step(1);
          return active;
        case ',':
          if (active) barReplay.step(-1);
          return active;
        case 'Escape':
          if (!active) return false;
          barReplay.stop();
          return true;
        default:
          return false;
      }
    },
  });
}
