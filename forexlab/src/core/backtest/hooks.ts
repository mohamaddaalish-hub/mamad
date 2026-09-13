/** React bindings for the trade ledger (external store, no context provider). */

import { useSyncExternalStore } from 'react';
import { tradeLedger } from './store.ts';
import type { TradeResult } from './trade.ts';

const subscribe = (onChange: () => void): (() => void) => tradeLedger.subscribe(onChange);

/** Results for the current replay position: recomputed only when inputs change. */
export function useTradeResults(): TradeResult[] {
  return useSyncExternalStore(subscribe, () => tradeLedger.results());
}

export function useTradeCount(): number {
  return useSyncExternalStore(subscribe, () => tradeLedger.count());
}
