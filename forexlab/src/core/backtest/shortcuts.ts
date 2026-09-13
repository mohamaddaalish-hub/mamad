/**
 * Keyboard for manual trading: B and S arm an entry, C closes the oldest open
 * position at the newest revealed bar, Escape disarms. Registered after the replay
 * layer so the trade tool gets the first look at its keys and hands everything else
 * back untouched.
 */

import { registerShortcutHandler } from '../app/shortcuts.ts';
import { dialogStore } from '../app/dialogs.ts';
import { appStore } from '../app/state.ts';
import { tradeController } from './controller.ts';
import { armTrade } from '../app/modes.ts';

export function installTradeShortcuts(): () => void {
  return registerShortcutHandler({
    id: 'trades',
    onKey(e) {
      if (dialogStore.get().open !== null) return false;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (appStore.get().datasetId === null) return false;
      switch (e.key) {
        case 'b':
        case 'B':
          armTrade({ mode: 'open', side: 'buy', kind: 'market' });
          return true;
        case 's':
        case 'S':
          armTrade({ mode: 'open', side: 'sell', kind: 'market' });
          return true;
        case 'c':
        case 'C':
          if (tradeController.currentArm()?.mode === 'close') {
            tradeController.cancel();
            return true;
          }
          return tradeController.closeOldest();
        case 'Escape':
          return tradeController.cancel();
        default:
          return false;
      }
    },
  });
}
