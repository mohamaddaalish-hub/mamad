/**
 * Aggregations over measured events (stage 11).
 *
 * Every aggregate reports `n` next to the number, and every distribution prints the
 * median as well as the mean: a news reaction sample is small and lumpy, and an
 * average on its own would be a lie by omission.
 */

import type { EconEvent } from './types.ts';
import type { Surprise, SurpriseBand } from './surprise.ts';
import { BAND_ORDER } from './surprise.ts';
import { POST_HORIZONS, type EventReaction, type HorizonId, type HorizonMeasure } from './reaction.ts';
import type { PreNewsContext, SessionInfo, VolatilityContext, ClusterInfo, TrendLabel } from './context.ts';
import type { ReactionPattern } from './reaction.ts';

export interface StudyRow {
  event: EconEvent;
  surprise: Surprise;
  reaction: EventReaction;
  pre: PreNewsContext;
  vol: VolatilityContext;
  session: SessionInfo;
  cluster: ClusterInfo | null;
}

export function postAt(reaction: EventReaction, horizon: HorizonId): HorizonMeasure | null {
  return reaction.post.find((m) => m.horizon === horizon) ?? null;
}

export function preAt(reaction: EventReaction, horizon: HorizonId): HorizonMeasure | null {
  return reaction.pre.find((m) => m.horizon === horizon) ?? null;
}

/** |pips| ÷ impact-class size: the only comparable unit across events. */
export function normalizedSize(row: StudyRow, horizon: HorizonId): number | null {
  const m = postAt(row.reaction, horizon);
  if (!m || !m.available || m.pips === null) return null;
  const size = row.reaction.classSizePips;
  if (size === null || size <= 0) return null;
  return Math.abs(m.pips) / size;
}

/** Reaction signed the way the surprise pointed: +1 means the market followed. */
export function alignedPips(row: StudyRow, horizon: HorizonId): number | null {
  const m = postAt(row.reaction, horizon);
  if (!m || !m.available || m.pips === null) return null;
  const dir = row.surprise.raw === null ? 0 : row.surprise.raw > 0 ? 1 : row.surprise.raw < 0 ? -1 : 0;
  if (dir === 0) return null;
  return m.pips * dir;
}

export interface CurvePoint {
  horizon: HorizonId;
  label: string;
  n: number;
  /** Signed close-to-reference move in pips. */
  avgPips: number | null;
  medianPips: number | null;
  sdPips: number | null;
  /** Direction-aligned, in pips: positive means price followed the surprise. */
  alignedAvgPips: number | null;
  alignedMedianPips: number | null;
  /** Normalized by the impact class size, sign kept. */
  normalizedAvg: number | null;
  normalizedMedian: number | null;
  /** Share of events whose aligned move was positive (0-1). */
  followedShare: number | null;
  unavailable: string | null;
}

export function reactionCurve(rows: StudyRow[], horizons: HorizonId[] = POST_HORIZONS.map((h) => h.id)): CurvePoint[] {
  return horizons.map((id) => {
    const spec = POST_HORIZONS.find((h) => h.id === id)!;
    const signed: number[] = [];
    const aligned: number[] = [];
    const normalized: number[] = [];
    let followed = 0;
    let decidable = 0;
    for (const row of rows) {
      const m = postAt(row.reaction, id);
      if (!m || !m.available || m.pips === null) continue;
      signed.push(m.pips);
      const a = alignedPips(row, id);
      if (a !== null) {
        aligned.push(a);
        decidable++;
        if (a > 0) followed++;
      }
      const n = normalizedSize(row, id);
      if (n !== null) normalized.push(n * (m.pips >= 0 ? 1 : -1));
    }
    const stats = describe(signed);
    const aStats = describe(aligned);
    const nStats = describe(normalized);
    return {
      horizon: id,
      label: spec.label,
      n: signed.length,
      avgPips: stats.mean,
      medianPips: stats.median,
      sdPips: stats.sd,
      alignedAvgPips: aStats.mean,
      alignedMedianPips: aStats.median,
      normalizedAvg: nStats.mean,
      normalizedMedian: nStats.median,
      followedShare: decidable > 0 ? followed / decidable : null,
      unavailable: signed.length === 0 ? `no event has a complete ${spec.label} window in the current range` : null,
    };
  });
}

export interface Distribution {
  label: string;
  n: number;
  mean: number | null;
  median: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  bins: { from: number; to: number; count: number }[];
  unavailable: string | null;
}

export function describe(values: number[]): { mean: number | null; median: number | null; sd: number | null } {
  const n = values.length;
  if (n === 0) return { mean: null, median: null, sd: null };
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  if (n === 1) return { mean, median: mean, sd: null };
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  let acc = 0;
  for (const v of values) acc += (v - mean) * (v - mean);
  return { mean, median, sd: Math.sqrt(acc / (n - 1)) };
}

export function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Histogram with fixed bin count; returns null-valued stats rather than inventing them. */
export function distribution(values: number[], label: string, binCount = 12): Distribution {
  const n = values.length;
  const stats = describe(values);
  if (n === 0) {
    return {
      label,
      n: 0,
      mean: null,
      median: null,
      sd: null,
      min: null,
      max: null,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      bins: [],
      unavailable: 'no observations',
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[n - 1];
  const bins: Distribution['bins'] = [];
  if (max - min < 1e-12) {
    bins.push({ from: min, to: max, count: n });
  } else {
    const width = (max - min) / binCount;
    for (let b = 0; b < binCount; b++) bins.push({ from: min + b * width, to: min + (b + 1) * width, count: 0 });
    for (const v of values) {
      const idx = Math.min(binCount - 1, Math.floor((v - min) / width));
      bins[idx].count++;
    }
  }
  return {
    label,
    n,
    mean: stats.mean,
    median: stats.median,
    sd: stats.sd,
    min,
    max,
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    bins,
    unavailable: null,
  };
}

export interface ConsistencyRow {
  horizon: HorizonId;
  label: string;
  n: number;
  up: number;
  down: number;
  flat: number;
  /** Share moving with the surprise sign, 0-1. Null with no decidable sample. */
  followedShare: number | null;
  /** Share moving against it. */
  fadedShare: number | null;
  meanAbsPips: number | null;
  unavailable: string | null;
}

export function directionalConsistency(rows: StudyRow[], horizons: HorizonId[] = POST_HORIZONS.map((h) => h.id)): ConsistencyRow[] {
  return horizons.map((id) => {
    const spec = POST_HORIZONS.find((h) => h.id === id)!;
    let up = 0;
    let down = 0;
    let flat = 0;
    let decidable = 0;
    let followed = 0;
    let faded = 0;
    const abs: number[] = [];
    for (const row of rows) {
      const m = postAt(row.reaction, id);
      if (!m || !m.available || m.pips === null) continue;
      decidable++;
      if (m.pips > 0) up++;
      else if (m.pips < 0) down++;
      else flat++;
      abs.push(Math.abs(m.pips));
      const a = alignedPips(row, id);
      if (a !== null) {
        if (a > 0) followed++;
        else if (a < 0) faded++;
      }
    }
    return {
      horizon: id,
      label: spec.label,
      n: decidable,
      up,
      down,
      flat,
      followedShare: decidable > 0 ? followed / decidable : null,
      fadedShare: decidable > 0 ? faded / decidable : null,
      meanAbsPips: abs.length ? abs.reduce((x, y) => x + y, 0) / abs.length : null,
      unavailable: decidable === 0 ? `no complete ${spec.label} window in range` : null,
    };
  });
}

export interface PatternBreakdown {
  pattern: ReactionPattern;
  count: number;
  share: number | null;
  avgAlignedPips: number | null;
  avgHorizon: HorizonId | null;
}

export const PATTERN_ORDER: ReactionPattern[] = ['continuation', 'reversal', 'spike & fade', 'delayed', 'no reaction', 'unknown'];

export function patternBreakdown(rows: StudyRow[]): PatternBreakdown[] {
  const usable = rows.filter((r) => r.reaction.path !== null);
  const buckets = new Map<ReactionPattern, { count: number; aligned: number[]; horizon: HorizonId | null }>();
  for (const p of PATTERN_ORDER) buckets.set(p, { count: 0, aligned: [], horizon: null });
  for (const row of usable) {
    const hit = buckets.get(row.reaction.path!.pattern)!;
    hit.count++;
    if (hit.horizon === null) hit.horizon = row.reaction.path!.horizon;
    const a = alignedPips(row, row.reaction.path!.horizon);
    if (a !== null) hit.aligned.push(a);
  }
  return PATTERN_ORDER.map((p) => {
    const hit = buckets.get(p)!;
    return {
      pattern: p,
      count: hit.count,
      share: usable.length > 0 ? hit.count / usable.length : null,
      avgAlignedPips: hit.aligned.length ? hit.aligned.reduce((x, y) => x + y, 0) / hit.aligned.length : null,
      avgHorizon: hit.horizon,
    };
  });
}

/** Seven bands on each axis: no-data plus six magnitude steps, same on both sides. */
export const MATRIX_BUCKETS: { label: string; upTo: number }[] = [
  { label: 'no data', upTo: -1 },
  { label: '0–0.5', upTo: 0.5 },
  { label: '0.5–1', upTo: 1 },
  { label: '1–1.5', upTo: 1.5 },
  { label: '1.5–2', upTo: 2 },
  { label: '2–3', upTo: 3 },
  { label: '> 3', upTo: Infinity },
];

export function matrixBucket(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  for (let i = 1; i < MATRIX_BUCKETS.length; i++) if (value <= MATRIX_BUCKETS[i].upTo) return i;
  return MATRIX_BUCKETS.length - 1;
}

export interface MatrixCell {
  surpriseBucket: number;
  reactionBucket: number;
  n: number;
  avgAlignedPips: number | null;
  followedShare: number | null;
}

export interface Matrix {
  horizon: HorizonId;
  cells: MatrixCell[][];
  rowTotals: number[];
  colTotals: number[];
  total: number;
  note: string;
}

/**
 * Surprise magnitude (rows) against reaction magnitude (columns), both expressed as
 * |value| ÷ reference scale so the axes mean the same thing. Cells carry their own
 * sample count; an empty cell stays empty.
 */
export function surpriseReactionMatrix(rows: StudyRow[], horizon: HorizonId = '1H'): Matrix {
  const size = MATRIX_BUCKETS.length;
  const aligned: number[][][] = Array.from({ length: size }, () => Array.from({ length: size }, () => [] as number[]));
  const followed: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const decidable: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const cellN: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  let total = 0;
  for (const row of rows) {
    const m = postAt(row.reaction, horizon);
    if (!m || !m.available || m.pips === null) continue;
    const sign = row.surprise.raw === null || row.surprise.raw === 0 ? 1 : row.surprise.raw > 0 ? 1 : -1;
    const s = matrixBucket(row.surprise.standardized === null ? null : Math.abs(row.surprise.standardized));
    const r = matrixBucket(normalizedSize(row, horizon));
    cellN[s][r]++;
    aligned[s][r].push(m.pips * sign);
    total++;
    const a = alignedPips(row, horizon);
    if (a !== null) {
      decidable[s][r]++;
      if (a > 0) followed[s][r]++;
    }
  }
  const rowTotals = new Array<number>(size).fill(0);
  const colTotals = new Array<number>(size).fill(0);
  const cells: MatrixCell[][] = [];
  for (let i = 0; i < size; i++) {
    const rowCells: MatrixCell[] = [];
    for (let j = 0; j < size; j++) {
      rowTotals[i] += cellN[i][j];
      colTotals[j] += cellN[i][j];
      const list = aligned[i][j];
      rowCells.push({
        surpriseBucket: i,
        reactionBucket: j,
        n: cellN[i][j],
        avgAlignedPips: list.length ? list.reduce((x, y) => x + y, 0) / list.length : null,
        followedShare: decidable[i][j] ? followed[i][j] / decidable[i][j] : null,
      });
    }
    cells.push(rowCells);
  }
  const skipped = rows.length - total;
  return {
    horizon,
    cells,
    rowTotals,
    colTotals,
    total,
    note: skipped > 0 ? `${skipped} of ${rows.length} events lack a complete ${horizon} window and are not counted` : `all ${total} events measured`,
  };
}

export interface EventHistoryRow {
  event: EconEvent;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  surpriseRaw: number | null;
  standardized: number | null;
  band: SurpriseBand | null;
  revision: number | null;
  pips: Record<string, number | null>;
  pattern: ReactionPattern | null;
  session: SessionInfo['id'];
  isolated: boolean;
}

export function eventHistory(rows: StudyRow[], horizons: HorizonId[]): EventHistoryRow[] {
  return rows.map((row) => {
    const pips: Record<string, number | null> = {};
    for (const h of horizons) {
      const m = postAt(row.reaction, h);
      pips[h] = m && m.available ? m.pips : null;
    }
    return {
      event: row.event,
      actual: row.event.actual,
      forecast: row.event.forecast,
      previous: row.event.previous,
      surpriseRaw: row.surprise.raw,
      standardized: row.surprise.standardized,
      band: row.surprise.band,
      revision: row.surprise.revision.stated ?? (row.surprise.revision.derived ? row.surprise.revision.derived.to - row.surprise.revision.derived.from : null),
      pips,
      pattern: row.reaction.path?.pattern ?? null,
      session: row.session.id,
      isolated: row.cluster ? row.cluster.isolated30 : true,
    };
  });
}

export interface PeriodStats {
  period: string;
  /** Month key 'YYYY-MM' or year key 'YYYY'. */
  from: number;
  to: number;
  n: number;
  avgAbsZ: number | null;
  medianAbsZ: number | null;
  avg1HPips: number | null;
  followedShare: number | null;
  highImpactCount: number;
  trendMix: Record<TrendLabel, number>;
}

/** Six-month and yearly period views, each with its sample size stated. */
export function periodStats(rows: StudyRow[], mode: 'month' | 'year'): PeriodStats[] {
  const buckets = new Map<string, StudyRow[]>();
  for (const row of rows) {
    const d = new Date(row.event.instant);
    const key = mode === 'month' ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` : `${d.getUTCFullYear()}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(row);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, list]) => {
      const zs = list.map((r) => (r.surprise.standardized === null ? null : Math.abs(r.surprise.standardized))).filter((v): v is number => v !== null);
      const moves = list.map((r) => postAt(r.reaction, '1H')).filter((m) => m !== null && m.available && m.pips !== null) as HorizonMeasure[];
      let followed = 0;
      let decidable = 0;
      const trendMix: Record<TrendLabel, number> = { bullish: 0, bearish: 0, range: 0, unknown: 0 };
      for (const r of list) trendMix[r.pre.trend]++;
      for (const r of list) {
        const a = alignedPips(r, '1H');
        if (a === null) continue;
        decidable++;
        if (a > 0) followed++;
      }
      const sortedZ = [...zs].sort((a, b) => a - b);
      const first = list[0].event.instant;
      const last = list[list.length - 1].event.instant;
      return {
        period: key,
        from: first,
        to: last,
        n: list.length,
        avgAbsZ: zs.length ? zs.reduce((x, y) => x + y, 0) / zs.length : null,
        medianAbsZ: sortedZ.length ? quantile(sortedZ, 0.5) : null,
        avg1HPips: moves.length ? moves.reduce((x, m) => x + (m.pips ?? 0), 0) / moves.length : null,
        followedShare: decidable ? followed / decidable : null,
        highImpactCount: list.filter((r) => r.event.impact === 'high').length,
        trendMix,
      };
    })
    .map((p) => ({ ...p, from: p.from, to: p.to }));
}

export interface SampleSplit<T> {
  training: T[];
  validation: T[];
  outOfSample: T[];
  trainEnd: number | null;
  validEnd: number | null;
  note: string | null;
}

/**
 * Chronological separation for walk-forward work. The split is by *time*, never by
 * random draw, and the boundaries are reported so a result can never be quoted
 * without saying which segment it came from.
 */
export function splitByTime<T extends { instant: number }>(items: T[], trainEnd: number | null, validEnd: number | null): SampleSplit<T> {
  if (trainEnd === null || validEnd === null || validEnd <= trainEnd) {
    return { training: items, validation: [], outOfSample: [], trainEnd, validEnd, note: 'no split boundaries set — every figure below is in-sample' };
  }
  const training = items.filter((x) => x.instant <= trainEnd);
  const validation = items.filter((x) => x.instant > trainEnd && x.instant <= validEnd);
  const outOfSample = items.filter((x) => x.instant > validEnd);
  return { training, validation, outOfSample, trainEnd, validEnd, note: null };
}

/** Guard used by the dashboard so a mixed sample can never be presented as one. */
export function isDisjoint<T extends { instant: number }>(split: SampleSplit<T>): boolean {
  const last = (list: T[]): number => (list.length ? list[list.length - 1].instant : -Infinity);
  return last(split.training) <= (split.trainEnd ?? Infinity) && (split.trainEnd ?? -Infinity) < last(split.validation) && last(split.validation) <= (split.validEnd ?? Infinity);
}

export function bandCounts(rows: StudyRow[]): Record<SurpriseBand | 'none', number> {
  const out = { negligible: 0, moderate: 0, notable: 0, high: 0, extreme: 0, none: 0 } as Record<SurpriseBand | 'none', number>;
  for (const r of rows) {
    if (r.surprise.band) out[r.surprise.band]++;
    else out.none++;
  }
  for (const b of BAND_ORDER) void b;
  return out;
}
