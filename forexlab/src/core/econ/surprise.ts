/**
 * Surprise + revision engine.
 *
 * Raw surprise = Actual − Forecast, in the indicator's own unit.
 *
 * Standardized surprise is *indicator-specific and historical-only*: the forecast
 * error distribution is estimated from prior releases of the same indicator
 * (strictly before the event's release instant, and never after `knownUntil`).
 * Nothing about the event itself, later releases or later revisions can enter the
 * estimate. When fewer than `minSample` prior releases exist, or the prior errors
 * have zero variance, the result is an explicit UNAVAILABLE.
 */

import {
  type EconEvent,
  type Maybe,
  type RevisionKind,
  type SigmaBucket,
  type SurpriseBand,
  ok,
  unavailable,
} from './types.ts';

export interface SurpriseConfig {
  /** Prior releases required before a z-score is reported. */
  minSample: number;
  /** Upper cap on how many prior releases feed the distribution (most recent first). */
  maxSample: number;
  /** |z| thresholds for the moderate / strong / extreme bands. */
  bands: { moderate: number; strong: number; extreme: number };
  /** A revision counts as "large" when |amount| ≥ this many prior-error sigmas. */
  largeRevisionSigma: number;
}

export const DEFAULT_SURPRISE_CONFIG: SurpriseConfig = {
  minSample: 8,
  maxSample: 60,
  bands: { moderate: 0.5, strong: 1, extreme: 2 },
  largeRevisionSigma: 1,
};

export interface SurpriseResult {
  raw: Maybe<number>;
  /** Sign of raw surprise (+1 / −1 / 0). */
  direction: Maybe<1 | -1 | 0>;
  /** Actual − Previous (uses revised previous when stated, since that is what the market compared against). */
  vsPrevious: Maybe<number>;
  z: Maybe<number>;
  band: Maybe<SurpriseBand>;
  sigma: Maybe<SigmaBucket>;
  /** Prior releases used for the distribution. */
  sample: number;
  /** Mean / std of prior forecast errors (for the inspector). */
  errorMean: number | null;
  errorStd: number | null;
}

export interface RevisionResult {
  kind: Maybe<RevisionKind>;
  amount: Maybe<number>;
  /** 'stated' when the file had a Revised Previous, 'derived' when inferred from the next release. */
  source: 'stated' | 'derived' | 'none';
  /** Earliest instant at which the revision was observable. Derived revisions become known at the *next* release. */
  observableAt: number | null;
  originalPrevious: number | null;
  revisedPrevious: number | null;
  magnitudeSigma: number | null;
}

/** Events sorted by time and grouped by indicator key — built once per dataset. */
export class EventIndex {
  readonly byKey = new Map<string, EconEvent[]>();
  readonly byId = new Map<string, EconEvent>();
  readonly sorted: EconEvent[];

  constructor(events: readonly EconEvent[]) {
    this.sorted = [...events].sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
    for (const e of this.sorted) {
      this.byId.set(e.id, e);
      let arr = this.byKey.get(e.key);
      if (!arr) this.byKey.set(e.key, (arr = []));
      arr.push(e);
    }
  }

  /** Releases of the same indicator strictly before `event.time` and not after `knownUntil`. */
  prior(event: EconEvent, knownUntil = Number.POSITIVE_INFINITY): EconEvent[] {
    const arr = this.byKey.get(event.key) ?? [];
    const out: EconEvent[] = [];
    for (const e of arr) {
      if (e.time >= event.time) break;
      if (e.time > knownUntil) break;
      if (e.id !== event.id) out.push(e);
    }
    return out;
  }

  /** Next release of the same indicator after `event`. */
  next(event: EconEvent): EconEvent | null {
    const arr = this.byKey.get(event.key) ?? [];
    for (const e of arr) if (e.time > event.time) return e;
    return null;
  }

  /** Events in [from, to] by binary search on the sorted list. */
  between(from: number, to: number): EconEvent[] {
    const s = this.sorted;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (s[mid].time < from) lo = mid + 1;
      else hi = mid;
    }
    const out: EconEvent[] = [];
    for (let i = lo; i < s.length && s[i].time <= to; i++) out.push(s[i]);
    return out;
  }
}

export function rawSurprise(e: Pick<EconEvent, 'actual' | 'forecast'>): Maybe<number> {
  if (e.actual === null) return unavailable('missing actual');
  if (e.forecast === null) return unavailable('missing forecast');
  return ok(e.actual - e.forecast);
}

export function meanStd(values: readonly number[]): { mean: number; std: number } {
  const n = values.length;
  if (n === 0) return { mean: NaN, std: NaN };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  if (n < 2) return { mean, std: 0 };
  let ss = 0;
  for (const v of values) ss += (v - mean) ** 2;
  return { mean, std: Math.sqrt(ss / (n - 1)) };
}

export function bandForZ(z: number, cfg: SurpriseConfig = DEFAULT_SURPRISE_CONFIG): SurpriseBand {
  const a = Math.abs(z);
  const b = cfg.bands;
  if (a < b.moderate) return 'neutral';
  const tier = a < b.strong ? 'moderate' : a < b.extreme ? 'strong' : 'extreme';
  return `${tier}${z > 0 ? 'Positive' : 'Negative'}` as SurpriseBand;
}

export function sigmaBucket(z: number): SigmaBucket {
  if (z < -2) return 'ltNeg2';
  if (z < -1) return 'neg2to1';
  if (z < -0.5) return 'neg1toHalf';
  if (z <= 0.5) return 'neutral';
  if (z <= 1) return 'half1';
  if (z <= 2) return 'pos1to2';
  return 'gtPos2';
}

/**
 * Standardized surprise for one event. `knownUntil` is the replay boundary: prior
 * releases after it do not exist yet (they cannot, since they are before the event,
 * but the guard makes the contract explicit and cheap).
 */
export function computeSurprise(
  event: EconEvent,
  index: EventIndex,
  cfg: SurpriseConfig = DEFAULT_SURPRISE_CONFIG,
  knownUntil = Number.POSITIVE_INFINITY,
): SurpriseResult {
  const raw = rawSurprise(event);
  const direction: Maybe<1 | -1 | 0> =
    raw.status === 'ok' ? ok(raw.value > 0 ? 1 : raw.value < 0 ? -1 : 0) : unavailable(raw.reason);
  const prevRef = event.revisedPrevious ?? event.previous;
  const vsPrevious: Maybe<number> =
    event.actual === null ? unavailable('missing actual') : prevRef === null ? unavailable('missing previous') : ok(event.actual - prevRef);
  const priors = index.prior(event, knownUntil);
  const errors: number[] = [];
  for (let i = priors.length - 1; i >= 0 && errors.length < cfg.maxSample; i--) {
    const p = priors[i];
    if (p.actual !== null && p.forecast !== null) errors.push(p.actual - p.forecast);
  }
  const sample = errors.length;
  const base = { raw, direction, vsPrevious, sample };
  if (raw.status !== 'ok') {
    const u = unavailable(raw.reason);
    return { ...base, z: u, band: u, sigma: u, errorMean: null, errorStd: null };
  }
  if (sample < cfg.minSample) {
    const u = unavailable(`insufficient history: ${sample} prior release${sample === 1 ? '' : 's'} with actual+forecast (need ${cfg.minSample})`);
    return { ...base, z: u, band: u, sigma: u, errorMean: null, errorStd: null };
  }
  const { mean, std } = meanStd(errors);
  if (!(std > 0)) {
    const u = unavailable('zero variance in prior forecast errors');
    return { ...base, z: u, band: u, sigma: u, errorMean: mean, errorStd: 0 };
  }
  const z = (raw.value - mean) / std;
  return { ...base, z: ok(z), band: ok(bandForZ(z, cfg)), sigma: ok(sigmaBucket(z)), errorMean: mean, errorStd: std };
}

/**
 * Revision of the *previous* figure.
 *  - Stated: the row carries Revised Previous → observable at this release.
 *  - Derived: the next release's Previous differs from this row's Actual → observable
 *    only at that next release. Consumers must pass `knownUntil` so a derived
 *    revision cannot be seen before it historically appeared.
 */
export function computeRevision(
  event: EconEvent,
  index: EventIndex,
  errorStd: number | null,
  cfg: SurpriseConfig = DEFAULT_SURPRISE_CONFIG,
  knownUntil = Number.POSITIVE_INFINITY,
): RevisionResult {
  const none = (reason: string): RevisionResult => ({
    kind: unavailable(reason),
    amount: unavailable(reason),
    source: 'none',
    observableAt: null,
    originalPrevious: event.previous,
    revisedPrevious: event.revisedPrevious,
    magnitudeSigma: null,
  });
  if (event.revisedPrevious !== null) {
    if (event.previous === null) return none('revised previous stated but original previous missing');
    return classify(event.revisedPrevious - event.previous, 'stated', event.time, event.previous, event.revisedPrevious);
  }
  // Derived: does the next release restate this actual as a different "previous"?
  const next = index.next(event);
  if (!next) return none('no revision stated; no later release to derive one from');
  if (next.time > knownUntil) return none('no revision stated; later release not yet known');
  if (event.actual === null || next.previous === null) return none('no revision stated; actual/next previous missing');
  const amount = next.previous - event.actual;
  if (Math.abs(amount) < 1e-12) {
    return {
      kind: ok('none'),
      amount: ok(0),
      source: 'derived',
      observableAt: next.time,
      originalPrevious: event.actual,
      revisedPrevious: null,
      magnitudeSigma: 0,
    };
  }
  return classify(amount, 'derived', next.time, event.actual, next.previous);

  function classify(amt: number, source: 'stated' | 'derived', at: number, orig: number, rev: number): RevisionResult {
    const sig = errorStd && errorStd > 0 ? Math.abs(amt) / errorStd : null;
    let kind: RevisionKind = amt === 0 ? 'none' : amt > 0 ? 'positive' : 'negative';
    if (sig !== null && sig >= cfg.largeRevisionSigma && kind !== 'none') kind = 'large';
    return {
      kind: ok(kind),
      amount: ok(amt),
      source,
      observableAt: at,
      originalPrevious: orig,
      revisedPrevious: rev,
      magnitudeSigma: sig,
    };
  }
}
