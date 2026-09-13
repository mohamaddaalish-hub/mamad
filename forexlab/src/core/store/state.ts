import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * Tiny external store wired to React through `useSyncExternalStore`.
 *
 * Rule of the codebase: bulk data (typed arrays, event tables) never goes in here.
 * The store holds view state and ids; registries hold the payloads.
 */


export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  replace(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? (patch as (s: T) => Partial<T>)(state) : patch;
      let changed = false;
      for (const key of Object.keys(next) as (keyof T)[]) {
        if (!Object.is(state[key], next[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    replace(next) {
      if (Object.is(state, next)) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Selector hook with snapshot caching so components can derive objects
 * (`{a,b}`) without triggering re-render loops.
 */
export function useSlice<T extends object, K>(
  store: Store<T>,
  select: (state: T) => K,
  isEqual: (a: K, b: K) => boolean = shallowEqual,
): K {
  const cache = useRef<{ state: T; value: K } | null>(null);
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getSnapshot = useCallback(() => {
    const state = store.get();
    const hit = cache.current;
    if (hit && hit.state === state) return hit.value;
    const value = select(state);
    if (hit && isEqual(hit.value, value)) {
      cache.current = { state, value: hit.value };
      return hit.value;
    }
    cache.current = { state, value };
    return value;
  }, [store, select, isEqual]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as never)[k], (b as never)[k])) return false;
  }
  return true;
}

export function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
