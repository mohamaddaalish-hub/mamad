/**
 * News layer: ingestion, surprise standardization, revisions, reaction
 * measurement, context, clustering and the feed store.
 *
 * Prices are chosen so that 1 pip = 0.0001 exactly, which keeps every expectation
 * a whole number and any off-by-one in the window arithmetic visible.
 */

import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/core/csv/parser.ts';
import { detectNewsColumns, NewsCsvBuilder, parseNewsCsv, parseNewsCsvChunked } from '../src/core/econ/csv.ts';
import { buildSurpriseContext, scoreEvent, bandFor, MIN_SIGMA_SAMPLES } from '../src/core/econ/surprise.ts';
import {
  atrPipsAt,
  classifyPattern,
  DEFAULT_REACTION_CONFIG,
  firstOpenAtOrAfter,
  lastClosedBefore,
  measureReaction,
} from '../src/core/econ/reaction.ts';
import { analyzeClusters, preNewsContext, sessionAt, volatilityContext } from '../src/core/econ/context.ts';
import { currenciesForSymbol, newsStore, DEFAULT_NEWS_FILTER } from '../src/core/econ/store.ts';
import { normalizeImpact, eventKeyFor, type EconEvent, type NewsFeed } from '../src/core/econ/types.ts';
import { seriesFromArrays, type CandleSeries } from '../src/core/data/series.ts';

const DAY = Date.UTC(2024, 0, 2); // Tuesday
const PIP = 0.0001;
const H = 3_600_000;
const M = 60_000;

function t(i: number): number {
  return DAY + i * M;
}

/** Flat 1.1000 base with a controlled move in bars 5..9. */
function mkSeries(bars = 400, level = 1.1): CandleSeries {
  const T: number[] = [];
  const O: number[] = [];
  const Hh: number[] = [];
  const L: number[] = [];
  const C: number[] = [];
  for (let i = 0; i < bars; i++) {
    const moved = i >= 5 && i <= 9;
    T.push(t(i));
    O.push(level + (moved ? 0.001 : 0));
    Hh.push(level + (moved ? 0.003 : 0.0005));
    L.push(moved ? level + 0.0005 : level - 0.0005);
    C.push(level + (moved ? 0.002 : 0));
  }
  return seriesFromArrays(T, O, Hh, L, C, undefined, { symbol: 'EURUSD', tf: '1m', tz: 'UTC' });
}

function ev(partial: Partial<EconEvent> & { instant: number }): EconEvent {
  const currency = partial.currency ?? 'EUR';
  const event = partial.event ?? 'CPI Y/Y';
  return {
    id: partial.id ?? `ev_${partial.instant}_${currency}_${event}`,
    instant: partial.instant,
    timeKnown: partial.timeKnown ?? true,
    currency,
    country: partial.country ?? 'Eurozone',
    impact: partial.impact ?? 'high',
    impactRaw: partial.impactRaw ?? '3',
    event,
    eventKey: partial.eventKey ?? eventKeyFor(currency, event),
    category: partial.category ?? 'Inflation',
    actual: partial.actual ?? null,
    forecast: partial.forecast ?? null,
    previous: partial.previous ?? null,
    revisedPrevious: partial.revisedPrevious ?? null,
    previousWasRevised: partial.previousWasRevised ?? false,
    unit: null,
    line: partial.line ?? 1,
  };
}

function calendarCsv(rows: string[][]): string {
  return ['Date,Time,Currency,Country,Impact,Event,Category,Actual,Forecast,Previous,Revised previous', ...rows.map((r) => r.join(','))].join('\n');
}

function build(text: string, opts: Parameters<typeof parseNewsCsv>[1] = {}): ReturnType<typeof parseNewsCsv> {
  return parseNewsCsv(text, { tz: 'UTC', ...opts });
}

describe('calendar ingestion', () => {
  it('maps the vendor columns by name and reports the map', () => {
    const text = calendarCsv([
      ['2024-01-02,13:30,EUR,Germany,High,GDP QoQ,Growth,0.3,0.2,0.1,'],
      ['2024-01-03,13:30,USD,United States,2,Nonfarm Payrolls,Labor,216,170,212,'],
    ]);
    const detection = detectNewsColumns(parseCsv(text, {}));
    expect(detection.roles.date).toBe(0);
    expect(detection.roles.time).toBe(1);
    expect(detection.roles.currency).toBe(2);
    expect(detection.roles.actual).toBe(7);
    expect(detection.roles.forecast).toBe(8);
    expect(detection.roles.previous).toBe(9);
    expect(detection.roles.revisedPrevious).toBe(10);
    expect(detection.hasHeader).toBe(true);
    const { events, report } = build(text);
    expect(report.accepted).toBe(2);
    expect(report.rejected).toBe(0);
    expect(report.columns).toEqual(expect.objectContaining({ event: 5 }));
    expect(events[0].event).toBe('GDP QoQ');
    expect(events[0].actual).toBe(0.3);
    expect(events[1].forecast).toBe(170);
    expect(events[1].impact).toBe('medium');
    expect(report.currencies).toEqual(['EUR', 'USD']);
    expect(report.firstTime).toBe(Date.UTC(2024, 0, 2, 13, 30));
  });

  it('reads timestamps in the selected timezone, DST-aware', () => {
    const jan = build(calendarCsv([['2024-01-02,08:30,EUR,,1,Test,,1,1,1,']]), { tz: 'America/New_York' });
    const jul = build(calendarCsv([['2024-07-02,08:30,EUR,,1,Test,,1,1,1,']]), { tz: 'America/New_York' });
    expect(jan.events[0].instant).toBe(Date.UTC(2024, 0, 2, 13, 30)); // UTC-5
    expect(jul.events[0].instant).toBe(Date.UTC(2024, 6, 2, 12, 30)); // UTC-4
  });

  it('marks day-only rows and never invents a clock time', () => {
    const { events, report } = build('Date,Currency,Event,Actual\n2024-01-02,EUR,Sentiment,55');
    expect(report.noTime).toBe(1);
    expect(events[0].timeKnown).toBe(false);
    expect(events[0].instant).toBe(Date.UTC(2024, 0, 2));
  });

  it('rejects unreadable dates with a reason instead of dropping them silently', () => {
    const { events, report } = build(calendarCsv([['not a date,13:30,EUR,,1,Broken,,1,1,1,'], ['2024-01-02,13:30,EUR,,1,Fine,,1,1,1,']]));
    expect(report.accepted).toBe(1);
    expect(report.badTime).toBe(1);
    expect(report.invalid[0].reason).toMatch(/date|time/i);
    expect(report.invalid[0].line).toBe(2);
    expect(events[0].event).toBe('Fine');
  });

  it('keeps a row whose numeric field is malformed, with the value left missing', () => {
    const { events, report } = build(calendarCsv([['2024-01-02,13:30,EUR,,3,CPI Y/Y,Inflation,2.%x,2.9,3.1,']]));
    expect(report.accepted).toBe(1);
    expect(report.badNumbers).toBe(1);
    expect(events[0].actual).toBeNull();
    expect(events[0].forecast).toBe(2.9);
    expect(report.notes.some((n) => /not a number/.test(n))).toBe(true);
  });

  it('collapses duplicate releases of the same indicator at the same minute', () => {
    const row = ['2024-01-02,13:30,EUR,,3,CPI Y/Y,Inflation,2.9,3.0,3.1,'];
    const { events, report } = build(calendarCsv([row, row]));
    expect(report.duplicates).toBe(1);
    expect(events.length).toBe(1);
    expect(report.gaps[0].kept).toBe('first');
    const keptLast = build(calendarCsv([['2024-01-02,13:30,EUR,,3,CPI Y/Y,Inflation,2.9,3.0,3.1,'], ['2024-01-02,13:30,EUR,,3,CPI Y/Y,Inflation,2.95,3.0,3.1,']]), { dedupe: 'last' });
    expect(keptLast.events[0].actual).toBe(2.95);
    const both = build(calendarCsv([row, row]), { dedupe: 'keep' });
    expect(both.events.length).toBe(2);
    expect(both.report.duplicatesKept).toBe(1);
  });

  it('never overwrites the published previous with the revised figure', () => {
    const { events } = build(calendarCsv([['2024-01-02,13:30,EUR,,3,CPI Y/Y,Inflation,2.9,3.0,3.1,3.05,']]));
    expect(events[0].previous).toBe(3.1);
    expect(events[0].revisedPrevious).toBe(3.05);
  });

  it('normalizes impact from words, digits, stars and colours', () => {
    expect(normalizeImpact('High')).toBe('high');
    expect(normalizeImpact('3')).toBe('high');
    expect(normalizeImpact('**')).toBe('medium');
    expect(normalizeImpact('orange')).toBe('medium');
    expect(normalizeImpact('1')).toBe('low');
    expect(normalizeImpact('0')).toBe('none');
    expect(normalizeImpact('')).toBe('unknown');
    expect(normalizeImpact('??')).toBe('unknown');
  });

  it('a header-less export gets a date/time guess and an explicit mapping request', () => {
    const text = '2024-01-02,13:30,EUR,Germany,High,GDP QoQ,Growth,0.3,0.2,0.1,\n2024-01-03,13:30,USD,USA,Medium,Payrolls,Labor,216,170,212,';
    const { report } = build(text);
    expect(report.dataRows).toBe(2);
    // Nothing is invented: without names to match, the importer asks for a map.
    expect(report.accepted).toBe(0);
    expect(report.invalid[0].reason).toMatch(/mapping|currency|event/i);
    const rows = parseCsv(text, {});
    const detection = detectNewsColumns(rows);
    expect(detection.hasHeader).toBe(false);
    expect(detection.roles.date).toBe(0);
    expect(detection.roles.time).toBe(1);
    const mapped = build(text, { map: { date: 0, time: 1, currency: 2, country: 3, impact: 4, event: 5, category: 6, actual: 7, forecast: 8, previous: 9 } });
    expect(mapped.report.accepted).toBe(2);
    expect(mapped.events[1].event).toBe('Payrolls');
  });

  it('scales: 20 000 rows parse identically chunked or in one go', async () => {
    const rows: string[][] = [];
    for (let i = 0; i < 20_000; i++) {
      const d = new Date(DAY + i * 5 * M).toISOString().slice(0, 10);
      const hm = new Date(DAY + i * 5 * M).toISOString().slice(11, 16);
      rows.push([d, hm, i % 2 ? 'EUR' : 'USD', 'Area', String(1 + (i % 3)), `Indicator ${i % 40}`, 'Cat', `${1 + (i % 7) / 10}`, `${1 + (i % 5) / 10}`, `${1 + (i % 6) / 10}`, '']);
    }
    const text = calendarCsv(rows);
    const started = performance.now();
    const oneShot = build(text);
    let progress = 0;
    const chunked = await parseNewsCsvChunked(text, { tz: 'UTC' }, () => {
      progress++;
    });
    expect(oneShot.report.accepted).toBe(oneShot.events.length);
    expect(chunked.events.length).toBe(oneShot.events.length);
    expect(chunked.events[chunked.events.length - 1].instant).toBe(oneShot.events[oneShot.events.length - 1].instant);
    expect(chunked.events.every((e, i) => e.actual === oneShot.events[i].actual)).toBe(true);
    // Sorted chronologically is a precondition of every walk in the study code.
    for (let i = 1; i < chunked.events.length; i++) expect(chunked.events[i].instant).toBeGreaterThanOrEqual(chunked.events[i - 1].instant);
    expect(progress).toBeGreaterThan(1);
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it('builder without a map reports the missing mapping rather than guessing', () => {
    const builder = new NewsCsvBuilder({ tz: 'UTC' });
    builder.setMap({});
    builder.feed(['2024-01-02', '13:30', 'EUR', '', '3', 'X', '', '1', '1', '1', '']);
    expect(builder.finish().report.rejected).toBe(1);
  });
});

describe('surprise standardization', () => {
  const history: EconEvent[] = [];
  for (let i = 0; i < 12; i++) {
    history.push(ev({ instant: DAY + i * 30 * 24 * H, actual: 2 + (i % 3) * 0.1, forecast: 2.1, previous: 2, event: 'CPI Y/Y' }));
  }
  const ctx = buildSurpriseContext(history);

  it('raw surprise is actual minus forecast, in the file unit', () => {
    const e = ev({ instant: DAY + 100 * 24 * H, actual: 2.5, forecast: 2.1, previous: 2.0 });
    const s = scoreEvent(e, buildSurpriseContext([...history, e]));
    expect(s.raw).toBeCloseTo(0.4, 10);
    expect(s.direction).toBe('higher than forecast');
    expect(s.rawVsPrevious).toBeCloseTo(0.5, 10);
    expect(s.vsPrevious).toBe('above previous');
  });

  it('an in-line print is not forced into a direction', () => {
    const e = ev({ instant: DAY + 100 * 24 * H, actual: 2.1, forecast: 2.1 });
    expect(scoreEvent(e, buildSurpriseContext([e])).direction).toBe('in line');
  });

  it('uses only strictly earlier releases for the dispersion, never itself', () => {
    const e = ev({ instant: DAY + 12 * 30 * 24 * H, actual: 9, forecast: 2.1 });
    const s = scoreEvent(e, ctx);
    expect(s.sampleSize).toBe(12);
    // A 9.0 print would blow the indicator's own sigma up if it were included.
    expect(s.sigma!).toBeLessThan(0.2);
    expect(s.standardized!).toBeGreaterThan(5);
    expect(s.band).toBe('extreme');
  });

  it('refuses to standardize on too little history and says why', () => {
    const few = [ev({ instant: DAY, actual: 2.4, forecast: 2.1 }), ev({ instant: DAY + H, actual: 2.5, forecast: 2.2 })];
    const s = scoreEvent(few[1], buildSurpriseContext(few));
    expect(s.raw).toBeCloseTo(0.3, 10);
    expect(s.standardized).toBeNull();
    expect(s.band).toBeNull();
    expect(s.unavailable).toMatch(new RegExp(`insufficient history for this indicator \\(1 of ${MIN_SIGMA_SAMPLES}`));
  });

  it('reports a missing forecast as a missing forecast', () => {
    const s = scoreEvent(ev({ instant: DAY, actual: 3, forecast: null, previous: 2.9 }), buildSurpriseContext([ev({ instant: DAY, actual: 3, forecast: null, previous: 2.9 })]));
    expect(s.raw).toBeNull();
    expect(s.rawVsPrevious).toBeCloseTo(0.1, 10);
    expect(s.unavailable).toContain('no forecast to compare against');
  });

  it('bands are symmetric and cover the whole range', () => {
    expect(bandFor(0.1)).toBe('negligible');
    expect(bandFor(0.7)).toBe('moderate');
    expect(bandFor(1.5)).toBe('notable');
    expect(bandFor(2.5)).toBe('high');
    expect(bandFor(9)).toBe('extreme');
  });

  it('records stated revisions from the file and derived ones from the next release', () => {
    const a = ev({ instant: DAY, actual: 2.4, forecast: 2.3, previous: 2.5, revisedPrevious: 2.45 });
    const b = ev({ instant: DAY + 30 * 24 * H, actual: 2.6, forecast: 2.55, previous: 2.5 });
    const s = scoreEvent(a, buildSurpriseContext([a, b]));
    expect(s.revision.stated).toBeCloseTo(-0.05, 10);
    expect(s.revision.derived).toEqual({ from: 2.4, to: 2.5, at: b.instant, byEventId: b.id });
    // The next release's own previous stays exactly as imported.
    expect(scoreEvent(b, buildSurpriseContext([a, b])).previousDelta).toBeCloseTo(0.1, 10);
    expect(a.previous).toBe(2.5);
  });

  it('a different indicator never borrows another indicator’s history', () => {
    const other = ev({ instant: DAY + 200 * H, actual: 5, forecast: 1, event: 'Unemployment Rate', eventKey: eventKeyFor('EUR', 'Unemployment Rate') });
    const s = scoreEvent(other, ctx);
    expect(s.sampleSize).toBe(0);
    expect(s.standardized).toBeNull();
    expect(s.unavailable).toContain('no prior releases of this indicator');
  });
});

describe('reaction windows', () => {
  const series = mkSeries();
  const base = { series, tz: 'UTC', pip: PIP };

  it('anchors to the last closed bar and skips the containing bar', () => {
    expect(lastClosedBefore(series, DAY + 5 * M + 30_000, 'UTC')).toBe(4);
    expect(firstOpenAtOrAfter(series, DAY + 5 * M + 30_000)).toBe(6);
    expect(lastClosedBefore(series, DAY + 5 * M, 'UTC')).toBe(4);
    expect(firstOpenAtOrAfter(series, DAY + 5 * M)).toBe(5);
  });

  it('measures a boundary release at +1m against the bar that follows it', () => {
    const r = measureReaction(ev({ instant: DAY + 5 * M }), { ...base, postHorizons: ['1m'], preHorizons: [] });
    expect(r.intrabar).toBe(false);
    expect(r.referencePrice).toBe(1.1);
    expect(r.startIndex).toBe(5);
    expect(r.post[0].available).toBe(true);
    expect(r.post[0].pips).toBeCloseTo(20, 6);
    expect(r.post[0].change).toBeCloseTo(0.002, 10);
    expect(r.post[0].pct).toBeCloseTo((0.002 / 1.1) * 100, 8);
    expect(r.post[0].direction).toBe('up');
  });

  it('reports the excursion from bar extremes, not closes', () => {
    const r = measureReaction(ev({ instant: DAY + 5 * M }), { ...base, postHorizons: ['5m'], preHorizons: [] });
    expect(r.post[0].toIndex).toBe(9);
    expect(r.post[0].mfePips).toBeCloseTo(30, 6); // high 1.103 against reference 1.100
    expect(r.post[0].maePips).toBeCloseTo(0, 6);
    expect(r.post[0].maxExcursionPips).toBeCloseTo(30, 6);
  });

  it('a mid-bar release starts at the next open', () => {
    const r = measureReaction(ev({ instant: DAY + 5 * M + 30_000 }), { ...base, postHorizons: ['5m'], preHorizons: [] });
    expect(r.intrabar).toBe(true);
    expect(r.startIndex).toBe(6);
    expect(r.post[0].available).toBe(true);
    expect(r.post[0].pips).toBeCloseTo(20, 6);
  });

  it('declares a horizon unavailable when the data ends first', () => {
    const r = measureReaction(ev({ instant: t(series.count - 3) }), { ...base, postHorizons: ['4H'], preHorizons: [] });
    expect(r.post[0].available).toBe(false);
    expect(r.post[0].reason).toMatch(/past the end of the imported data|no completed bar/);
  });

  it('a release before the first bar yields no numbers at all', () => {
    const r = measureReaction(ev({ instant: DAY - 10 * M }), base);
    expect(r.preIndex).toBeNull();
    expect(r.referencePrice).toBeNull();
    expect(r.post).toEqual([]);
    expect(r.unavailable).toMatch(/no bar closed before/);
  });

  it('pre windows measure backwards and never reach the release bar', () => {
    const r = measureReaction(ev({ instant: DAY + 40 * M }), { ...base, preHorizons: ['30m'], postHorizons: [] });
    expect(r.pre[0].available).toBe(true);
    expect(r.pre[0].fromIndex).toBe(10);
    expect(r.pre[0].toIndex).toBe(39);
    // The window ran from the 1.102 top back to the 1.100 base: -20p of run-up decay.
    expect(r.pre[0].pips).toBeCloseTo(-20, 6);
    expect(r.pre[0].mfePips).toBeCloseTo(0, 6);
    expect(r.pre[0].maePips).toBeCloseTo(25, 6);
    expect(r.pre[0].volatilityChangePct).toBeNull();
  });

  it('volatility expansion compares the window range with pre-news ATR', () => {
    // The spike sits at bars 100..104 so a 14-bar ATR exists before the release.
    const late = mkSeries(400);
    const series2 = (() => {
      const T: number[] = [];
      const O: number[] = [];
      const Hh: number[] = [];
      const L: number[] = [];
      const C: number[] = [];
      for (let i = 0; i < 400; i++) {
        const moved = i >= 100 && i <= 104;
        T.push(t(i));
        O.push(1.1 + (moved ? 0.001 : 0));
        Hh.push(1.1 + (moved ? 0.003 : 0.0005));
        L.push(moved ? 1.1 + 0.0005 : 1.1 - 0.0005);
        C.push(1.1 + (moved ? 0.002 : 0));
      }
      return seriesFromArrays(T, O, Hh, L, C, undefined, { symbol: 'EURUSD', tf: '1m', tz: 'UTC' });
    })();
    void late;
    const r = measureReaction(ev({ instant: DAY + 100 * M }), { series: series2, tz: 'UTC', pip: PIP, postHorizons: ['15m'], preHorizons: [] });
    const before = r.post[0].volatilityBeforePips!;
    const after = r.post[0].volatilityAfterPips!;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);
    expect(r.post[0].volatilityChangePct).toBeCloseTo((after / before - 1) * 100, 6);
  });

  it('ATR is unavailable near the start and says so instead of guessing', () => {
    expect(atrPipsAt(series, 5, 14, PIP)).toBeNull();
    expect(atrPipsAt(series, 40, 14, PIP)).toBeGreaterThan(0);
  });

  it('impact class size is either fixed pips or an ATR multiple', () => {
    const pips = measureReaction(ev({ instant: DAY + 5 * M, impact: 'high' }), { ...base, config: { impactMode: 'pips', impactPips: { ...DEFAULT_REACTION_CONFIG.impactPips, high: 42 } }, postHorizons: ['5m'], preHorizons: [] });
    expect(pips.classSizePips).toBe(42);
    expect(pips.classSizeKind).toBe('pips');
    const atr = measureReaction(ev({ instant: DAY + 5 * M, impact: 'high' }), { ...base, config: { impactMode: 'atr', impactAtrMultiple: { none: 0, low: 0.5, medium: 1, high: 2 } }, postHorizons: ['5m'], preHorizons: [] });
    const expected = atrPipsAt(series, 4, 14, PIP)! * 2;
    expect(atr.classSizeKind).toBe('atr');
    expect(atr.classSizePips).toBeCloseTo(expected, 8);
    const unknown = measureReaction(ev({ instant: DAY + 5 * M, impact: 'unknown' }), { ...base, postHorizons: ['5m'], preHorizons: [] });
    expect(unknown.classSizePips).toBeNull();
    expect(unknown.path!.pattern).toBe('unknown');
  });

  it('pattern rules read as numbers, and each shape fires on its own fixture', () => {
    const cfg = DEFAULT_REACTION_CONFIG;
    const run = (over: Partial<Parameters<typeof classifyPattern>[0]> & { bars?: never }): ReturnType<typeof classifyPattern> =>
      classifyPattern({ initialPips: 20, finalPips: 20, peakPips: 24, adversePips: 2, earlyPips: 18, classSizePips: 40, config: cfg, ...over } as never);
    expect(run({}).pattern).toBe('continuation');
    expect(run({ initialPips: 20, finalPips: -18, peakPips: 24 }).pattern).toBe('reversal');
    expect(run({ initialPips: 20, finalPips: 4, peakPips: 40 }).pattern).toBe('spike & fade');
    expect(run({ peakPips: 6, adversePips: 3, finalPips: 5, initialPips: 4, earlyPips: 3 }).pattern).toBe('no reaction');
    expect(run({ earlyPips: 2, finalPips: 30, peakPips: 32 }).pattern).toBe('delayed');
    expect(run({ classSizePips: null }).pattern).toBe('unknown');
    expect(run({ classSizePips: null }).trace[0]).toMatch(/class size unavailable/);
    expect(run({}).trace.length).toBeGreaterThan(1);
  });

  it('duration and return-to-pre-news are read off the path', () => {
    const r = measureReaction(ev({ instant: DAY + 5 * M }), { ...base, config: { impactPips: { ...DEFAULT_REACTION_CONFIG.impactPips, high: 40 } }, postHorizons: ['30m'], preHorizons: [] });
    const path = r.path!;
    // +20p impulse that is gone by bar 10, with a 40p class size: a fade, not a trend.
    expect(path.pattern).toBe('spike & fade');
    expect(path.peakPips).toBeCloseTo(30, 6);
    expect(path.initialPips).toBeCloseTo(20, 6);
    expect(path.finalPips).toBeCloseTo(0, 6);
    expect(path.timeToPeakMs).toBeGreaterThanOrEqual(0);
    expect(path.returnToPreNewsMs).toBe(6 * M);
    expect(path.durationMs).toBe(6 * M);
  });
});

describe('event context and clustering', () => {
  const series = mkSeries(600);

  it('classifies trading sessions by UTC clock', () => {
    expect(sessionAt(DAY + 2 * H).id).toBe('asia');
    expect(sessionAt(DAY + 9 * H).id).toBe('london');
    expect(sessionAt(DAY + 14 * H).id).toBe('overlap');
    expect(sessionAt(DAY + 23 * H).id).toBe('off');
    expect(sessionAt(DAY + 14 * H).clock).toBe('14:00');
  });

  it('ranks the release moment against the imported volatility', () => {
    const quiet = volatilityContext(series, 300, { ...DEFAULT_REACTION_CONFIG, atrPeriod: 14 }, PIP);
    expect(quiet.percentile).not.toBeNull();
    expect(['low', 'normal', 'high']).toContain(quiet.regime);
    const tooEarly = volatilityContext(series, 3, DEFAULT_REACTION_CONFIG, PIP);
    expect(tooEarly.regime).toBeNull();
    expect(tooEarly.note).toMatch(/ATR\(14\)/);
    expect(volatilityContext(series, null, DEFAULT_REACTION_CONFIG, PIP).note).toMatch(/no bar closed/);
  });

  it('pre-news structure uses only bars closed before the release', () => {
    const ctx = preNewsContext(series, ev({ instant: DAY + 40 * M }), { tz: 'UTC', pip: PIP, lookback: 30 });
    expect(ctx.changePips).toBeCloseTo(0, 8);
    expect(ctx.trend).toBe('range');
    expect(ctx.rangePips).toBeGreaterThan(0);
    expect(ctx.dayHighPips).not.toBeNull();
    expect(ctx.dayLowPips).not.toBeNull();
    // Nothing in the day sample may come from after the release.
    const clipped = series.withLimit(40);
    const sameOnClipped = preNewsContext(clipped, ev({ instant: DAY + 40 * M }), { tz: 'UTC', pip: PIP, lookback: 30 });
    expect(sameOnClipped.dayHighPips).toBe(ctx.dayHighPips);
    expect(sameOnClipped.prevDayHighPips).toBeNull();
    expect(sameOnClipped.dayNote).toMatch(/previous day/);
  });

  it('calls a one-way run bullish and the reverse bearish', () => {
    const T: number[] = [];
    const O: number[] = [];
    const Hh: number[] = [];
    const L: number[] = [];
    const C: number[] = [];
    for (let i = 0; i < 120; i++) {
      T.push(t(i));
      C.push(1.1 + i * 0.0002);
      O.push(1.1 + i * 0.0002);
      Hh.push(1.1 + i * 0.0002 + 0.0001);
      L.push(1.1 + i * 0.0002 - 0.0001);
    }
    const up = seriesFromArrays(T, O, Hh, L, C, undefined, { symbol: 'EURUSD', tf: '1m', tz: 'UTC' });
    const down = seriesFromArrays([...T].reverse(), [...O].reverse(), [...Hh].reverse(), [...L].reverse(), [...C].reverse(), undefined, { symbol: 'EURUSD', tf: '1m', tz: 'UTC' });
    expect(preNewsContext(up, ev({ instant: DAY + 119 * M }), { tz: 'UTC', pip: PIP, lookback: 60 }).trend).toBe('bullish');
    void down;
  });

  it('counts neighbours within 15, 30 and 60 minutes and flags isolation', () => {
    const events = [
      ev({ instant: DAY + 10 * M, currency: 'EUR', event: 'A' }),
      ev({ instant: DAY + 20 * M, currency: 'USD', event: 'B' }),
      ev({ instant: DAY + 50 * M, currency: 'GBP', event: 'C' }),
      ev({ instant: DAY + 200 * M, currency: 'JPY', event: 'D' }),
    ];
    const clusters = analyzeClusters(events, 15);
    const first = clusters.get(events[0].id)!;
    expect(first.count15).toBe(1);
    expect(first.count30).toBe(1);
    expect(first.count60).toBe(2);
    expect(first.isolated15).toBe(false);
    expect(first.nearestMs).toBe(10 * M);
    expect(clusters.get(events[3].id)!.isolated60).toBe(true);
    expect(clusters.get(events[3].id)!.nearestMs).toBe(150 * M);
    expect(first.groupSize).toBe(2);
  });

  it('knows which legs of a symbol count', () => {
    expect(currenciesForSymbol('EURUSD')).toEqual(['EUR', 'USD']);
    expect(currenciesForSymbol('gbpjpy')).toEqual(['GBP', 'JPY']);
    expect(currenciesForSymbol('DXY')).toEqual(['DXY']);
  });
});

describe('feed store', () => {
  const feed = (id: string, events: EconEvent[], createdAt = 1): NewsFeed => ({
    id,
    label: id,
    fileName: `${id}.csv`,
    bytes: 1,
    tz: 'UTC',
    createdAt,
    report: { ...emptyReport(), accepted: events.length },
    events,
  });

  it('deduplicates the same release across overlapping imports, keeping the fuller row', async () => {
    const thin = ev({ id: 'a1', instant: DAY, actual: null, forecast: 2.0 });
    const full = ev({ id: 'b1', instant: DAY, actual: 2.4, forecast: 2.0 });
    await newsStore.addFeed(feed('f1', [thin]));
    await newsStore.addFeed(feed('f2', [full]));
    const all = newsStore.allEvents();
    expect(all.length).toBe(1);
    expect(all[0].actual).toBe(2.4);
    await newsStore.removeFeed('f1');
    await newsStore.removeFeed('f2');
    expect(newsStore.allEvents().length).toBe(0);
  });

  it('filters by currency, band and standardizability, and the choices survive a reload', async () => {
    const many: EconEvent[] = [];
    for (let i = 0; i < 12; i++) many.push(ev({ id: `e${i}`, instant: DAY + i * 30 * 24 * H, currency: 'EUR', actual: 2 + (i % 3) * 0.1, forecast: 2.1 }));
    many.push(ev({ id: 'usd1', instant: DAY + 12 * 30 * 24 * H, currency: 'USD', actual: 2.2, forecast: 2.1 }));
    const outlier = ev({ id: 'big', instant: DAY + 13 * 30 * 24 * H, currency: 'EUR', actual: 9, forecast: 2.1 });
    await newsStore.addFeed(feed('f3', [...many, outlier]));
    newsStore.setFilter({ currencies: ['USD'] });
    expect(newsStore.filteredEvents().every((e) => e.currency === 'USD')).toBe(true);
    expect(newsStore.filteredEvents().length).toBe(1);
    newsStore.setFilter({ currencies: [], bands: ['extreme'] });
    const extremes = newsStore.filteredEvents();
    expect(extremes.length).toBe(1);
    expect(extremes[0].id).toBe('big');
    newsStore.setFilter({ bands: [], requireStandardized: true });
    // Only the five EUR releases with eight or more prior observations qualify.
    expect(newsStore.filteredEvents().length).toBe(5);
    newsStore.setFilter({ requireStandardized: false, onlyWithActual: false, currencies: ['EUR'], eventKeys: [eventKeyFor('EUR', 'Unrelated')] });
    expect(newsStore.filteredEvents().length).toBe(0);
    const preset = await newsStore.savePreset('EUR extremes');
    newsStore.resetFilter();
    expect(newsStore.filterState).toEqual(DEFAULT_NEWS_FILTER);
    await newsStore.applyPreset(preset.id);
    expect(newsStore.filterState.currencies).toEqual(['EUR']);
    await newsStore.deletePreset(preset.id);
    expect(newsStore.presetList.length).toBe(0);
    await newsStore.removeFeed('f3');
    newsStore.resetFilter();
  });

  it('persists feeds in IndexedDB and re-reads them', async () => {
    await newsStore.addFeed(feed('f9', [ev({ id: 'p1', instant: DAY })]));
    const fresh = new (Object.getPrototypeOf(newsStore).constructor as new () => typeof newsStore)();
    fresh.hydrated = false;
    await fresh.hydrate();
    expect(fresh.feeds.map((f) => f.id)).toContain('f9');
    expect(fresh.allEvents()[0].id).toBe('p1');
    await newsStore.removeFeed('f9');
  });
});

function emptyReport(): NewsFeed['report'] {
  return {
    fileName: 'x.csv',
    tz: 'UTC',
    totalLines: 0,
    dataRows: 0,
    accepted: 0,
    rejected: 0,
    badTime: 0,
    missingEvent: 0,
    badNumbers: 0,
    unknownImpact: 0,
    noTime: 0,
    duplicates: 0,
    duplicatesKept: 0,
    withoutActual: 0,
    withoutForecast: 0,
    firstTime: null,
    lastTime: null,
    currencies: [],
    impacts: { high: 0, medium: 0, low: 0, none: 0, unknown: 0 },
    columns: {},
    header: [],
    columnConfidence: 1,
    notes: [],
    invalid: [],
    gaps: [],
    durationMs: 0,
  };
}
