/**
 * Global keyboard map. Installed once; each handler is contributed by a subsystem
 * so modules stay decoupled (replay contributes Space/R/arrows, drawings
 * contribute H/V/T, the shell contributes F/G/zoom).
 */

import { appStore } from './state.ts';

export interface ShortcutHandler {
  id: string;
  /** Return true when the key was handled (stops default behaviour). */
  onKey(e: KeyboardEvent): boolean;
  /** Opt in to firing while a text input has focus (default: skip). */
  allowInInputs?: boolean;
}

const handlers: ShortcutHandler[] = [];
let installed = false;

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

export function registerShortcutHandler(handler: ShortcutHandler): () => void {
  handlers.unshift(handler);
  install();
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    const editing = isEditable(e.target);
    if (e.key === 'Escape' && !editing) {
      const tool = appStore.get().tool;
      if (tool) {
        appStore.set({ tool: null });
        e.preventDefault();
        return;
      }
    }
    for (const handler of handlers) {
      if (editing && !handler.allowInInputs) continue;
      if (handler.onKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
  });
}

/** Human-readable key hint per platform, used in tooltips. */
export function keyHint(...keys: string[]): string {
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent) ? '⌘' : 'Ctrl';
  return keys.map((k) => (k === 'Mod' ? mod : k)).join('+');
}
