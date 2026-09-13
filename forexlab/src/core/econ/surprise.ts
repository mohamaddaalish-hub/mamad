/**
 * Surprise and revision engine (stage 9).
 *
 * The raw surprise is `actual − forecast` in the unit the file used. What makes a
 * number *important* is not its size but how unusual it is for that specific
 * indicator: CPI printing +0.3 is enormous, CPI printing +0.01 is noise. So the
 * magnitude is standardized against the historical dispersion of the forecast
 * error for the same indicator, built only from releases that happened BEFORE the
 * event being scored — a release can never be judged against its own future.
 *
 * There is deliberately no universal "big surprise" threshold in this file.
 */

import type { EconEvent } from './types.ts';

export type SurpriseBand = 'negligible' | 'moderate' | 'notable' | 'high' | 'extreme';

/** Bands are on |z|, the standardized surprise. Tunable, documented, not magic. */
export const SURPRISE_BANDS: { band: SurpriseBand; upTo: number }[] = [
  { band: 'negligible', upTo: 0.5 },
  { band: 'moderate', upTo: 1 },
  { band: 'notable', upTo: 2 },
  { band: 'high', upTo: 3 },
  { band: 'extreme', upTo: Infinity },
];

export const BAND_LABEL: Record<SurpriseBand, string> = {
  negligible: 'Negligible',
  moderate: 'Moderate',
  notable: 'Notable',
  high: 'High',
  extreme: 'Extreme',
};

/** Below this many prior releases the dispersion estimate is not trustworthy. */
export const MIN_SIGMA_SAMPLES = 8;

export interface RevisionInfo {
  /** Revision the file itself published (`revised previous` − `previous`). */
  stated: number | null;
  /**
   * Revision inferred from the *next* release of the same indicator: if the next
   * release's `previous` differs from this release's `actual`, someone revised it.
   * Nothing is overwritten — the original values stay as imported.
   */
  derived: { from: number; to: number; at: number; byEventId: string } | null;
}

export interface Surprise {
  eventId: string;
  /** actual − forecast, in the file's own unit. */
  raw: number | null;
  /** actual − previous, the other comparison traders run. */
  rawVsPrevious: number | null;
  /** previous − earlier previous (how the base itself moved), when derivable. */
  previousDelta: number | null;
  direction: 'higher than forecast' | 'lower than forecast' | 'in line' | 'unknown';
  vsPrevious: 'above previous' | 'below previous' | 'equal to previous' | 'unknown';
  /** Dispersion of past forecast errors for this indicator (sample SD). */
  sigma: number | null;
  sampleSize: number;
  /** raw / sigma. Null when it cannot be honest. */
  standardized: number | null;
  band: SurpriseBand | null;
  revision: RevisionInfo;
  /** Human-readable reason for any null above. */
  unavailable: string | null;
}

export interface SurpriseContext {
  /** Per-indicator history of (actual − forecast) with their instants. */
  history: Map<string, { instant: number; diff: number }[]>;
  /** Per-indicator history of published values, for derived revisions. */
  series: Map<string, EconEvent[]>;
}

/** Build the lookups once per event list; every score is then O(log n). */
export function buildSurpriseContext(events: EconEvent[]): SurpriseContext {
  const history = new Map<string, { instant: number; diff: number }[]>();
  const series = new Map<string, EconEvent[]>();
  for (const e of events) {
    let list = series.get(e.eventKey);
    if (!list) {
      list = [];
      series.set(e.eventKey, list);
    }
    list.push(e);
    if (e.actual === null || e.forecast === null) continue;
    let hist = history.get(e.eventKey);
    if (!hist) {
      hist = [];
      history.set(e.eventKey, hist);
    }
    hist.push({ instant: e.instant, diff: e.actual - e.forecast });
  }
  for (const list of history.values()) list.sort((a, b) => a.instant - b.instant);
  for (const list of series.values()) list.sort((a, b) => a.instant - b.instant);
  return { history, series };
}

function sampleStddev(values: number[]): { sigma: number; n: number } | null {
  const n = values.length;
  if (n < MIN_SIGMA_SAMPLES) return { sigma: null as unknown as number, n };
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let acc = 0;
  for (const v of values) acc += (v - mean) * (v - mean);
  const varSample = acc / (n - 1);
  return { sigma: Math.sqrt(varSample), n };
}

export function bandFor(absZ: number): SurpriseBand {
  for (const row of SURPRISE_BANDS) if (absZ <= row.upTo) return row.band;
  return 'extreme';
}

/**
 * Score one event. `events` must be the full imported list (the context is built
 * from it) so history is complete; only strictly earlier releases are consulted.
 */
export function scoreEvent(event: EconEvent, ctx: SurpriseContext): Surprise {
  const out: Surprise = {
    eventId: event.id,
    raw: null,
    rawVsPrevious: null,
    previousDelta: null,
    direction: 'unknown',
    vsPrevious: 'unknown',
    sigma: null,
    sampleSize: 0,
    standardized: null,
    band: null,
    revision: { stated: null, derived: null },
    unavailable: null,
  };
  const reasons: string[] = [];

  if (event.actual === null) {
    reasons.push('no actual value in the file');
  } else if (event.forecast === null) {
    reasons.push('no forecast to compare against');
  } else {
    out.raw = event.actual - event.forecast;
    const eps = Math.abs(event.forecast) * 1e-9;
    out.direction = Math.abs(out.raw) <= eps ? 'in line' : out.raw > 0 ? 'higher than forecast' : 'lower than forecast';
  }

  if (event.actual !== null && event.previous !== null) {
    out.rawVsPrevious = event.actual - event.previous;
    out.vsPrevious =
      Math.abs(out.rawVsPrevious) <= Math.abs(event.previous) * 1e-9
        ? 'equal to previous'
        : out.rawVsPrevious > 0
          ? 'above previous'
          : 'below previous';
  } else if (event.actual !== null) {
    reasons.push('no previous value to compare against');
  }

  // ---- revision: the file's own revised-previous column, then the derived one.
  if (event.revisedPrevious !== null && event.previous !== null) {
    out.revision.stated = event.revisedPrevious - event.previous;
  }
  const list = ctx.series.get(event.eventKey);
  if (list && event.actual !== null) {
    const at = list.findIndex((e) => e.id === event.id);
    const next = at >= 0 ? list[at + 1] : undefined;
    if (next && next.previous !== null && Math.abs(next.previous - event.actual) > 1e-12) {
      out.revision.derived = { from: event.actual, to: next.previous, at: next.instant, byEventId: next.id };
    }
  }
  if (list && event.previous !== null) {
    const at = list.findIndex((e) => e.id === event.id);
    const prior = at > 0 ? list[at - 1] : undefined;
    if (prior && prior.actual !== null) out.previousDelta = event.previous - prior.actual;
  }

  // ---- standardization against the indicator's own history, strictly before now
  const hist = ctx.history.get(event.eventKey);
  if (hist) {
    const before: number[] = [];
    for (const h of hist) {
      if (h.instant >= event.instant) break;
      before.push(h.diff);
    }
    out.sampleSize = before.length;
    if (out.raw !== null) {
      if (before.length < MIN_SIGMA_SAMPLES) {
        reasons.push(`insufficient history for this indicator (${before.length} of ${MIN_SIGMA_SAMPLES} prior releases)`);
      } else {
        const stats = sampleStddev(before);
        if (stats && stats.sigma > 0 && Number.isFinite(stats.sigma)) {
          out.sigma = stats.sigma;
          out.standardized = out.raw / stats.sigma;
          out.band = bandFor(Math.abs(out.standardized));
        } else {
          reasons.push('historical dispersion is zero or undefined for this indicator');
        }
      }
    }
  } else if (out.raw !== null) {
    reasons.push('no prior releases of this indicator in the imported data');
  }

  out.unavailable = reasons.length ? reasons.join('; ') : null;
  return out;
}

/** Magnitude used by the impact score: standardized when honest, else null. */
export function surpriseMagnitude(s: Surprise): { value: number; kind: 'standardized' | 'raw-fallback' } | null {
  if (s.standardized !== null) return { value: Math.abs(s.standardized), kind: 'standardized' };
  return null;
}

export const BAND_ORDER: SurpriseBand[] = ['negligible', 'moderate', 'notable', 'high', 'extreme'];
