/**
 * Event study: per-event enrichment + cross-event statistics.
 *
 * `enrichEvent` composes surprise, revision, cluster, pre-news context and
 * reaction for one event against a gated series. `EventStudy` caches enrichments
 * per (event, knownUntil, series identity) and exposes the aggregate research
 * views: reaction curve, distribution, directional consistency, surprise ×
 * reaction matrix, session/regime breakdowns, and the descriptive News Impact Score.
 *
 * Nothing here is a signal. Every statistic carries its sample size.
 */

import type { CandleSeries } from '../data/series.ts';
import { clusterFor, preNewsContext, type ClusterInfo, type ContextConfig, type PreNewsContext, DEFAULT_CONTEXT_CONFIG, classifySession } from './context.ts';
import { computeReaction, type ReactionConfig, type ReactionResult, DEFAULT_REACTION_CONFIG } from './reaction.ts';
import {
  computeRevision,
  computeSurprise,
  EventIndex,
  type RevisionResult,
  type SurpriseConfig,
  type SurpriseResult,
  DEFAULT_SURPRISE_CONFIG,
} from './surprise.ts';
import {
  IMPACT_WEIGHT,
  POST_HORIZONS_MIN,
  SURPRISE_BANDS,
  type EconEvent,
  type Maybe,
  type Session,
  type SurpriseBand,
  type VolRegime,
  isOk,
  ok,
  unavailable,
} from './types.ts';

export interface StudyConfig {
  surprise: SurpriseConfig;
  context: ContextConfig;
  reaction: ReactionConfig;
  clusterWindowMin: 15 | 30 | 60;
  tz: string;
}

export const DEFAULT_STUDY_CONFIG: StudyConfig = {
  surprise: DEFAULT_SURPRISE_CONFIG,
  context: DEFAULT_CONTEXT_CONFIG,
  reaction: DEFAULT_REACTION_CONFIG,
  clusterWindowMin: 30,
  tz: 'UTC',
};

export interface EnrichedEvent {
  event: EconEvent;
  session: Session;
  surprise: SurpriseResult;
  revision: RevisionResult;
  cluster: ClusterInfo;
  context: PreNewsContext;
  reaction: ReactionResult;
  knownUntil: number;
}

export function enrichEvent(
  event: EconEvent,
  index: EventIndex,
  series: CandleSeries | null,
  knownUntil: number,
  cfg: StudyConfig = DEFAULT_STUDY_CONFIG,
): EnrichedEvent {
  const surprise = computeSurprise(event, index, cfg.surprise, knownUntil);
  const revision = computeRevision(event, index, surprise.errorStd, cfg.surprise, knownUntil);
  const cluster = clusterFor(event, index, cfg.clusterWindowMin);
  // Neighbours in the future of the boundary must not be reported.
  if (knownUntil < Number.POSITIVE_INFINITY) {
    const keep = (id: string) => {
      const e = index.byId.get(id);
      return !!e && e.time <= knownUntil;
    };
    cluster.neighbours = cluster.neighbours.filter(keep);
    cluster.highImpactNeighbours = cluster.highImpactNeighbours.filter(keep);
    cluster.simultaneous = cluster.simultaneous.filter(keep);
    cluster.isolation = cluster.neighbours.length === 0 ? 'isolated' : cluster.simultaneous.length > 0 ? 'overlapping' : 'clustered';
    cluster.ambiguous = cluster.highImpactNeighbours.length > 0;
  }
  return {
    event,
    session: classifySession(event.time),
    surprise,
    revision,
    cluster,
    context: preNewsContext(series, event.time, cfg.context, cfg.tz),
    reaction: computeReaction(series, event.time, cfg.reaction),
    knownUntil,
  };
}

/* ------------------------------------------------------------- aggregates */

export interface Quantiles {
  n: number;
  mean: number;
  median: number;
  std: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  min: number;
  max: number;
}

export function quantiles(values: number[]): Quantiles | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return null;
  const q = (p: number): number => {
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  let ss = 0;
  for (const x of v) ss += (x - mean) ** 2;
  return { n, mean, median: q(0.5), std: n > 1 ? Math.sqrt(ss / (n - 1)) : 0, p10: q(0.1), p25: q(0.25), p75: q(0.75), p90: q(0.9), min: v[0], max: v[n - 1] };
}

export function histogram(values: number[], bins = 20): { edges: number[]; counts: number[] } {
  const v = values.filter(Number.isFinite);
  if (v.length === 0) return { edges: [], counts: [] };
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const w = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const x of v) counts[Math.min(bins - 1, Math.floor((x - lo) / w))]++;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + i * w);
  return { edges, counts };
}

export interface HorizonStat {
  minutes: number;
  n: number;
  mean: number | null;
  median: number | null;
  std: number | null;
  /** Share of events moving in the same direction as the majority. */
  consistency: number | null;
  /** +1 when the majority went up, −1 down, 0 when tied/none. */
  majority: 1 | -1 | 0;
  up: number;
  down: number;
  flat: number;
  avgMfe: number | null;
  avgMae: number | null;
  avgVolRatio: number | null;
  lowSample: boolean;
}

export const LOW_SAMPLE = 10;

function postPips(e: EnrichedEvent, minutes: number): number | null {
  const h = e.reaction.post.find((x) => x.minutes === minutes);
  return h && isOk(h.pips) ? h.pips.value : null;
}

export function horizonStats(events: readonly EnrichedEvent[], minutes: number, expected?: (e: EnrichedEvent) => 1 | -1 | 0): HorizonStat {
  const vals: number[] = [];
  const mfe: number[] = [];
  const mae: number[] = [];
  const vr: number[] = [];
  let up = 0;
  let down = 0;
  let flat = 0;
  let agree = 0;
  let judged = 0;
  for (const e of events) {
    const p = postPips(e, minutes);
    if (p === null) continue;
    vals.push(p);
    if (p > 0) up++;
    else if (p < 0) down++;
    else flat++;
    const h = e.reaction.post.find((x) => x.minutes === minutes)!;
    if (isOk(h.mfeUp) && isOk(h.mfeDown)) {
      // Favourable = in the direction of the eventual move at this horizon
      const dir = p >= 0 ? 1 : -1;
      mfe.push(dir > 0 ? h.mfeUp.value : h.mfeDown.value);
      mae.push(dir > 0 ? h.mfeDown.value : h.mfeUp.value);
    }
    if (isOk(h.volRatio)) vr.push(h.volRatio.value);
    if (expected) {
      const exp = expected(e);
      if (exp !== 0 && p !== 0) {
        judged++;
        if (Math.sign(p) === exp) agree++;
      }
    }
  }
  const q = quantiles(vals);
  const majority: 1 | -1 | 0 = up > down ? 1 : down > up ? -1 : 0;
  const nonFlat = up + down;
  const consistency = expected ? (judged > 0 ? agree / judged : null) : nonFlat > 0 ? Math.max(up, down) / nonFlat : null;
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    minutes,
    n: vals.length,
    mean: q?.mean ?? null,
    median: q?.median ?? null,
    std: q?.std ?? null,
    consistency,
    majority,
    up,
    down,
    flat,
    avgMfe: avg(mfe),
    avgMae: avg(mae),
    avgVolRatio: avg(vr),
    lowSample: vals.length < LOW_SAMPLE,
  };
}

/** Curve of mean/median at each CURVE horizon with sample sizes. */
export function reactionCurve(events: readonly EnrichedEvent[]): { horizons: number[]; mean: (number | null)[]; median: (number | null)[]; n: number[] } {
  const horizons = events[0]?.reaction.curveHorizons ?? [-30, -15, -5, 0, 1, 5, 15, 30, 60, 240, 1440];
  const mean: (number | null)[] = [];
  const median: (number | null)[] = [];
  const n: number[] = [];
  horizons.forEach((_, i) => {
    const vals = events.map((e) => e.reaction.curve[i]).filter((v): v is number => v !== null);
    const q = quantiles(vals);
    mean.push(q?.mean ?? null);
    median.push(q?.median ?? null);
    n.push(vals.length);
  });
  return { horizons, mean, median, n };
}

/** Surprise band × horizon matrix. */
export function surpriseMatrix(events: readonly EnrichedEvent[]): { bands: SurpriseBand[]; horizons: number[]; cells: HorizonStat[][] } {
  const horizons = [...POST_HORIZONS_MIN];
  const cells = SURPRISE_BANDS.map((band) => {
    const group = events.filter((e) => isOk(e.surprise.band) && e.surprise.band.value === band);
    return horizons.map((h) => horizonStats(group, h));
  });
  return { bands: [...SURPRISE_BANDS], horizons, cells };
}

export function groupBy<K extends string>(events: readonly EnrichedEvent[], keyOf: (e: EnrichedEvent) => K | null): Map<K, EnrichedEvent[]> {
  const m = new Map<K, EnrichedEvent[]>();
  for (const e of events) {
    const k = keyOf(e);
    if (k === null) continue;
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(e);
  }
  return m;
}

export function bySession(events: readonly EnrichedEvent[]): Map<Session, EnrichedEvent[]> {
  return groupBy(events, (e) => e.session);
}

export function byRegime(events: readonly EnrichedEvent[]): Map<VolRegime, EnrichedEvent[]> {
  return groupBy(events, (e) => (isOk(e.context.regime) ? e.context.regime.value : null));
}

/** Impact duration mean over events with a known duration. */
export function meanImpactDuration(events: readonly EnrichedEvent[]): number | null {
  const v = events.map((e) => e.reaction.impactDurationMin).filter(isOk).map((m) => m.value);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/* ------------------------------------------------------ historical importance */

export interface MarketImportance {
  /** Mean |15m move| in pips across prior releases of the same indicator. */
  avgAbs15m: number | null;
  avgAbs60m: number | null;
  n: number;
  /** Rank 0..1 of this indicator's avgAbs15m against all indicators (with ≥ LOW_SAMPLE). */
  rank: number | null;
  label: 'unavailable' | 'low' | 'moderate' | 'high' | 'very high';
}

export function marketImportance(sameIndicator: readonly EnrichedEvent[], allIndicatorsAvg15: number[]): MarketImportance {
  const v15 = sameIndicator.map((e) => postPips(e, 15)).filter((x): x is number => x !== null).map(Math.abs);
  const v60 = sameIndicator.map((e) => postPips(e, 60)).filter((x): x is number => x !== null).map(Math.abs);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const a15 = avg(v15);
  if (a15 === null || v15.length < 3) return { avgAbs15m: a15, avgAbs60m: avg(v60), n: v15.length, rank: null, label: 'unavailable' };
  const sorted = [...allIndicatorsAvg15].sort((a, b) => a - b);
  let rank: number | null = null;
  if (sorted.length >= 3) {
    let lo = 0;
    while (lo < sorted.length && sorted[lo] < a15) lo++;
    rank = lo / sorted.length;
  }
  const label = rank === null ? (a15 < 3 ? 'low' : a15 < 8 ? 'moderate' : a15 < 15 ? 'high' : 'very high') : rank < 0.33 ? 'low' : rank < 0.66 ? 'moderate' : rank < 0.9 ? 'high' : 'very high';
  return { avgAbs15m: a15, avgAbs60m: avg(v60), n: v15.length, rank, label };
}

/* ------------------------------------------------------------ impact score */

export interface ImpactScore {
  score: Maybe<number>;
  components: { name: string; weight: number; value: number | null; note: string }[];
}

/**
 * Historical Analytical Score, 0–100. Descriptive only.
 * Components (weights sum to 1): calendar importance, surprise magnitude,
 * historical reaction magnitude, directional consistency, impact duration,
 * volatility expansion.
 */
export function impactScore(e: EnrichedEvent, history: readonly EnrichedEvent[]): ImpactScore {
  const comps: ImpactScore['components'] = [];
  const cal = e.event.impact ? IMPACT_WEIGHT[e.event.impact] : null;
  comps.push({ name: 'Calendar importance', weight: 0.15, value: cal, note: e.event.impact ?? 'unknown impact' });
  const z = isOk(e.surprise.z) ? Math.min(1, Math.abs(e.surprise.z.value) / 3) : null;
  comps.push({ name: 'Surprise magnitude', weight: 0.2, value: z, note: isOk(e.surprise.z) ? `|z| = ${Math.abs(e.surprise.z.value).toFixed(2)}` : e.surprise.z.reason });
  const h15 = horizonStats(history, 15);
  const mag = h15.mean !== null && h15.n >= 3 ? Math.min(1, (history.map((x) => Math.abs(postPips(x, 15) ?? 0)).reduce((a, b) => a + b, 0) / h15.n) / 20) : null;
  comps.push({ name: 'Historical reaction magnitude', weight: 0.25, value: mag, note: `${h15.n} prior releases, mean |15m| capped at 20 pips` });
  const cons = h15.consistency !== null && h15.n >= LOW_SAMPLE ? (h15.consistency - 0.5) * 2 : null;
  comps.push({ name: 'Directional consistency', weight: 0.15, value: cons === null ? null : Math.max(0, cons), note: h15.consistency === null ? 'unavailable' : `${(h15.consistency * 100).toFixed(0)}% (n=${h15.n})` });
  const dur = meanImpactDuration(history);
  comps.push({ name: 'Impact duration', weight: 0.1, value: dur === null ? null : Math.min(1, dur / 240), note: dur === null ? 'unavailable' : `${dur.toFixed(0)} min mean, capped at 4H` });
  const volR = h15.avgVolRatio;
  comps.push({ name: 'Volatility expansion', weight: 0.15, value: volR === null ? null : Math.min(1, Math.max(0, (volR - 1) / 3)), note: volR === null ? 'unavailable' : `post/pre ATR ${volR.toFixed(2)}×` });
  const known = comps.filter((c) => c.value !== null);
  const wsum = known.reduce((a, c) => a + c.weight, 0);
  if (wsum < 0.5) return { score: unavailable('too few components available'), components: comps };
  const s = known.reduce((a, c) => a + c.weight * (c.value as number), 0) / wsum;
  return { score: ok(Math.round(s * 100)), components: comps };
}

/* ------------------------------------------------------------------ cache */

/** Memoised enrichment keyed by event id + boundary + series identity. */
export class EventStudy {
  private cache = new Map<string, EnrichedEvent>();
  private seriesTag = 0;
  private lastSeries: CandleSeries | null = null;
  constructor(public cfg: StudyConfig = DEFAULT_STUDY_CONFIG) {}

  reset(): void {
    this.cache.clear();
  }

  setConfig(cfg: StudyConfig): void {
    this.cfg = cfg;
    this.cache.clear();
  }

  enrich(event: EconEvent, index: EventIndex, series: CandleSeries | null, knownUntil: number): EnrichedEvent {
    if (series !== this.lastSeries) {
      this.lastSeries = series;
      this.seriesTag++;
      this.cache.clear();
    }
    const k = `${event.id}|${knownUntil}|${this.seriesTag}|${series?.count ?? 0}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const v = enrichEvent(event, index, series, knownUntil, this.cfg);
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(k, v);
    return v;
  }

  enrichMany(events: readonly EconEvent[], index: EventIndex, series: CandleSeries | null, knownUntil: number): EnrichedEvent[] {
    return events.map((e) => this.enrich(e, index, series, knownUntil));
  }
}

export const eventStudy = new EventStudy();
