/**
 * Timeframe selection helpers shared by the toolbar, the importer and replay.
 */

import { TIMEFRAMES, type TimeframeId } from './timeframes.ts';

export const TIMEFRAME_OPTIONS: { value: TimeframeId; label: string; title: string }[] = TIMEFRAMES.map((tf) => ({
  value: tf.id,
  label: tf.id,
  title: tf.label,
}));

export interface TimeframeAvailability {
  id: TimeframeId;
  /** Coarser or equal to the source spacing, so it can be derived honestly. */
  derived: boolean;
  /** The exact timeframe of the imported file. */
  native: boolean;
  reason: string;
}

/**
 * A dataset only ever supports its own timeframe and coarser ones. Offering a
 * finer timeframe would mean inventing bars, which this project never does.
 */
export function availabilityFor(nativeTf: TimeframeId | undefined): Map<TimeframeId, TimeframeAvailability> {
  const out = new Map<TimeframeId, TimeframeAvailability>();
  const nativeRank = TIMEFRAMES.find((t) => t.id === nativeTf)?.rank ?? -1;
  for (const tf of TIMEFRAMES) {
    if (nativeTf === undefined) {
      out.set(tf.id, { id: tf.id, derived: false, native: false, reason: 'Load a dataset first' });
      continue;
    }
    const derived = tf.rank >= nativeRank;
    out.set(tf.id, {
      id: tf.id,
      derived,
      native: tf.id === nativeTf,
      reason: derived
        ? tf.id === nativeTf
          ? 'Native timeframe of the imported file'
          : `Aggregated from ${nativeTf} bars (open = first, high = max, low = min, close = last)`
        : `Source data is ${nativeTf} — finer timeframes would require fabricating bars`,
    });
  }
  return out;
}

export function timeframeLabel(id: TimeframeId): string {
  return TIMEFRAMES.find((t) => t.id === id)?.label ?? id;
}
