/**
 * Web Worker: runs a controlled optimisation grid off the main thread.
 * Receives already-gated events and a compacted, gated candle payload, so it
 * cannot observe anything the main thread was not allowed to know.
 */

import { runGridSync, type OptimizeMessage, type OptimizeRequest } from '../core/backtest/optimize.ts';

const ctx = self as unknown as { postMessage(m: OptimizeMessage): void; onmessage: ((e: MessageEvent) => void) | null };

ctx.onmessage = (e: MessageEvent<OptimizeRequest | { type: 'cancel' }>) => {
  const msg = e.data;
  if (msg.type !== 'optimize') return;
  try {
    runGridSync(msg, (m) => ctx.postMessage(m));
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
