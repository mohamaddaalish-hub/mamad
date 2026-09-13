import { describe, expect, it } from 'vitest';
import { EventIndex, bandForZ, computeRevision, computeSurprise, rawSurprise, sigmaBucket } from '../src/core/econ/surprise.ts';
import { classifySession, clusterFor, preNewsContext } from '../src/core/econ/context.ts';
import { computeReaction } from '../src/core/econ/reaction.ts';
import { enrichEvent, horizonStats, impactScore, quantiles, reactionCurve, surpriseMatrix, histogram } from '../src/core/econ/study.ts';
import { isOk } from '../src/core/econ/types.ts';
import { MIN, ev, minuteSeries, releases } from './helpers/econ.ts';

const T0 = Date.UTC(2023, 0, 2, 0, 0);

describe('surprise engine', () => {
  it('raw surprise = actual − forecast; unavailable when either is missing', () => {
    expect(rawSurprise({ actual: 3.2, forecast: 3.0 })).toEqual({ status: 'ok', value: expect.closeTo(0.2, 9) });
    expect(rawSurprise({ actual: null, forecast: 3 }).status).toBe('unavailable');
    expect(rawSurprise({ actual: 3, forecast: null }).status).toBe('unavailable');
  });

  it('standardized surprise uses only prior releases of the same indicator', () => {
    // 10 prior releases with errors alternating ±0.1, then a +0.3 surprise.
    const pairs: [number, number][] = [];
    for (let i = 0; i < 10; i++) pairs.push([3 + (i % 2 ? 0.1 : -0.1), 3]);
    pairs.push([3.3, 3]);
    const list = releases(T0, pairs);
    const idx = new EventIndex(list);
    const last = list[list.length - 1];
    const s = computeSurprise(last, idx);
    expect(s.sample).toBe(10);
    expect(isOk(s.z)).toBe(true);
    // errors mean 0, std ≈ 0.105 → z ≈ 2.85
    expect(isOk(s.z) && s.z.value).toBeGreaterThan(2.5);
    expect(isOk(s.band) && s.band.value).toBe('extremePositive');
    expect(isOk(s.sigma) && s.sigma.value).toBe('gtPos2');
    // The first release has no history
    const first = computeSurprise(list[0], idx);
    expect(first.z.status).toBe('unavailable');
    expect(first.z.status === 'unavailable' && first.z.reason).toMatch(/insufficient history: 0/);
  });

  it('a future release never changes the z-score of an earlier event', () => {
    const pairs: [number, number][] = [];
    for (let i = 0; i < 9; i++) pairs.push([3 + (i % 2 ? 0.1 : -0.1), 3]);
    const base = releases(T0, pairs);
    const target = base[8];
    const zBefore = computeSurprise(target, new EventIndex(base));
    // Add a wild future release (huge error) after the target.
    const future = ev(target.time + 30 * 86_400_000, { actual: 9, forecast: 3, id: 'fut', key: target.key });
    const zAfter = computeSurprise(target, new EventIndex([...base, future]));
    expect(zAfter).toEqual(zBefore);
  });

  it('respects knownUntil for the prior sample and reports zero variance', () => {
    const list = releases(T0, Array.from({ length: 12 }, () => [3, 3] as [number, number]));
    list[11].actual = 3.5;
    const idx = new EventIndex(list);
    const s = computeSurprise(list[11], idx);
    expect(s.z.status).toBe('unavailable');
    expect(s.z.status === 'unavailable' && s.z.reason).toMatch(/zero variance/);
    // knownUntil before the 8th prior → insufficient
    const s2 = computeSurprise(list[11], idx, undefined, list[3].time);
    expect(s2.sample).toBe(4);
  });

  it('bands and buckets', () => {
    expect(bandForZ(0.2)).toBe('neutral');
    expect(bandForZ(-0.7)).toBe('moderateNegative');
    expect(bandForZ(1.5)).toBe('strongPositive');
    expect(bandForZ(-2.5)).toBe('extremeNegative');
    expect(sigmaBucket(-2.1)).toBe('ltNeg2');
    expect(sigmaBucket(0.75)).toBe('half1');
    expect(sigmaBucket(2.5)).toBe('gtPos2');
  });
});

describe('revision engine', () => {
  it('stated revision preserves the original previous', () => {
    const e = ev(T0, { previous: 3.0, revisedPrevious: 3.2 });
    const r = computeRevision(e, new EventIndex([e]), 0.1);
    expect(r.source).toBe('stated');
    expect(r.originalPrevious).toBe(3.0);
    expect(r.revisedPrevious).toBe(3.2);
    expect(isOk(r.amount) && r.amount.value).toBeCloseTo(0.2);
    expect(isOk(r.kind) && r.kind.value).toBe('large'); // 0.2 ≥ 1σ of 0.1
    const small = computeRevision(e, new EventIndex([e]), 1);
    expect(isOk(small.kind) && small.kind.value).toBe('positive');
  });

  it('derived revision is only observable at the next release', () => {
    const a = ev(T0, { actual: 3.0, id: 'a' });
    const b = ev(T0 + 30 * 86_400_000, { actual: 3.1, previous: 2.9, id: 'b' }); // restates a's 3.0 as 2.9
    const idx = new EventIndex([a, b]);
    const full = computeRevision(a, idx, null);
    expect(full.source).toBe('derived');
    expect(isOk(full.kind) && full.kind.value).toBe('negative');
    expect(full.observableAt).toBe(b.time);
    const gated = computeRevision(a, idx, null, undefined, b.time - 1);
    expect(gated.source).toBe('none');
    expect(gated.kind.status).toBe('unavailable');
  });
});

describe('sessions and clusters', () => {
  it('classifies sessions on local clocks', () => {
    expect(classifySession(Date.UTC(2024, 2, 12, 12, 30))).toBe('overlap'); // 08:30 NY / 12:30 London
    expect(classifySession(Date.UTC(2024, 2, 12, 9, 0))).toBe('london');
    expect(classifySession(Date.UTC(2024, 2, 12, 19, 0))).toBe('newYork');
    expect(classifySession(Date.UTC(2024, 2, 12, 1, 0))).toBe('asia'); // 10:00 JST
    expect(classifySession(Date.UTC(2024, 2, 11, 22, 0))).toBe('asia'); // 07:00 JST
  });

  it('detects isolated, clustered and overlapping releases', () => {
    const nfp = ev(T0, { event: 'Nonfarm Payrolls', id: 'nfp', key: 'USD|nfp' });
    const ur = ev(T0, { event: 'Unemployment Rate', id: 'ur', key: 'USD|ur' });
    const later = ev(T0 + 20 * MIN, { event: 'Speech', id: 'sp', key: 'USD|sp', impact: 'low' });
    const lone = ev(T0 + 5 * 3_600_000, { id: 'lone', key: 'USD|lone' });
    const idx = new EventIndex([nfp, ur, later, lone]);
    const c = clusterFor(nfp, idx, 30);
    expect(c.isolation).toBe('overlapping');
    expect(c.simultaneous).toEqual(['ur']);
    expect(c.neighbours.sort()).toEqual(['sp', 'ur']);
    expect(c.ambiguous).toBe(true);
    expect(clusterFor(later, idx, 15).isolation).toBe('isolated');
    expect(clusterFor(later, idx, 30).isolation).toBe('clustered');
    expect(clusterFor(lone, idx, 60).isolation).toBe('isolated');
  });
});

describe('pre-news context and reaction', () => {
  const release = T0 + 600 * MIN;
  const series = minuteSeries(T0, 3000, { jumps: { [release]: 12, [release + 1 * MIN]: 4, [release + 20 * MIN]: -2 } });

  it('context only uses bars before the release', () => {
    const ctx = preNewsContext(series, release);
    expect(isOk(ctx.refPrice)).toBe(true);
    expect(ctx.refTime).toBe(release - MIN); // last bar closed at release
    expect(isOk(ctx.atrPips)).toBe(true);
    expect(isOk(ctx.change30m)).toBe(true);
    expect(ctx.trend).not.toBe('unknown');
    // Same context whether or not the future exists.
    const clipped = series.withLimit(600);
    const ctx2 = preNewsContext(clipped, release);
    expect(ctx2.refPrice).toEqual(ctx.refPrice);
    expect(ctx2.atrPips).toEqual(ctx.atrPips);
    expect(ctx2.change1h).toEqual(ctx.change1h);
  });

  it('measures post-release horizons, MFE/MAE and peak', () => {
    const r = computeReaction(series, release);
    expect(r.refIndex).toBe(599);
    const m1 = r.post.find((h) => h.minutes === 1)!;
    expect(isOk(m1.pips) && m1.pips.value).toBeGreaterThan(10); // 12 pip jump at release bar
    const m5 = r.post.find((h) => h.minutes === 5)!;
    expect(isOk(m5.pips) && m5.pips.value).toBeGreaterThan(14);
    expect(isOk(m5.mfeUp) && m5.mfeUp.value).toBeGreaterThanOrEqual(isOk(m5.pips) ? m5.pips.value - 0.5 : 0);
    expect(isOk(r.peakMove)).toBe(true);
    expect(r.timeToPeakMin).not.toBeNull();
    expect(['continuation', 'spikeFade', 'reversal']).toContain(r.pattern);
    expect(r.curve[3]).toBe(0);
  });

  it('marks horizons beyond the known boundary UNAVAILABLE instead of guessing', () => {
    const gated = series.withLimit(600 + 10); // know 10 minutes after release
    const r = computeReaction(gated, release);
    expect(isOk(r.post.find((h) => h.minutes === 5)!.pips)).toBe(true);
    const m15 = r.post.find((h) => h.minutes === 15)!;
    expect(m15.pips.status).toBe('unavailable');
    expect(m15.pips.status === 'unavailable' && m15.pips.reason).toMatch(/not yet known/);
    expect(r.post.find((h) => h.minutes === 1440)!.pips.status).toBe('unavailable');
    expect(r.impactDurationMin.status).toBe('unavailable');
  });

  it('reports no reaction when price does not move', () => {
    const flat = minuteSeries(T0, 3000, { seed: 3 });
    const r = computeReaction(flat, release, { atrBars: 14, noReactionPips: 50, fadeFraction: 0.6, reversalFraction: 1 });
    expect(r.pattern).toBe('noReaction');
  });
});

describe('aggregate statistics', () => {
  it('quantiles and histogram', () => {
    const q = quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])!;
    expect(q.median).toBe(5.5);
    expect(q.p10).toBeCloseTo(1.9);
    expect(q.p90).toBeCloseTo(9.1);
    expect(q.n).toBe(10);
    const h = histogram([1, 2, 3, 4], 2);
    expect(h.counts).toEqual([2, 2]);
    expect(quantiles([])).toBeNull();
  });

  it('directional consistency, matrix and curve across enriched events', () => {
    // 12 monthly releases; each release jumps +8 pips (positive surprise) or −8 (negative).
    const pairs: [number, number][] = Array.from({ length: 14 }, (_, i) => [3 + (i % 3 === 0 ? -0.2 : 0.2) + (i % 2 ? 0.05 : -0.05), 3]);
    const list = releases(T0 + 300 * MIN, pairs);
    const jumps: Record<number, number> = {};
    for (const e of list) jumps[e.time] = (e.actual! - e.forecast!) > 0 ? 8 : -8;
    const series = minuteSeries(T0, 14 * 30 * 1440 + 3000, { jumps });
    const idx = new EventIndex(list);
    const enriched = list.map((e) => enrichEvent(e, idx, series, Number.POSITIVE_INFINITY));
    const stat = horizonStats(enriched, 5, (e) => (isOk(e.surprise.direction) ? e.surprise.direction.value : 0));
    expect(stat.n).toBe(14);
    expect(stat.consistency).toBeGreaterThan(0.9);
    const m = surpriseMatrix(enriched);
    const total = m.cells.flat().reduce((a, c) => a + c.n, 0);
    expect(total).toBeGreaterThan(0);
    const curve = reactionCurve(enriched);
    expect(curve.horizons).toContain(0);
    expect(curve.n[curve.horizons.indexOf(5)]).toBe(14);
    const score = impactScore(enriched[13], enriched.slice(0, 13));
    expect(isOk(score.score)).toBe(true);
    expect(score.components.length).toBe(6);
  });
});
