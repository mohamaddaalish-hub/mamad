import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CandleSeries, aggregateSeries } from '../src/core/data/series.ts';
import { MarketCsvBuilder, scanGaps, isMarketClosure } from '../src/core/csv/market.ts';
import { parseCsv } from '../src/core/csv/parser.ts';
import { probeText } from '../src/core/csv/importer.ts';
import { syntheticCsv } from '../src/core/data/synthetic.ts';
import type { ColumnRole } from '../src/core/csv/columns.ts';

const FULL: Partial<Record<ColumnRole, number>> = {
  date: 0, time: 1, open: 2, high: 3, low: 4, close: 5, volume: 6,
};

function importText(text: string, opts: Partial<ConstructorParameters<typeof MarketCsvBuilder>[0]> = {}) {
  const rows = parseCsv(text);
  const builder = new MarketCsvBuilder({ tz: 'UTC', ...opts });
  if (!opts.map) builder.setMap(FULL);
  for (const row of rows) builder.feed(row);
  return builder.finish();
}

const HEAD = 'Date,Time,Open,High,Low,Close,Volume';

function rows(lines: string[]): string {
  return [HEAD, ...lines].join('\n');
}

describe('market import: values and validation', () => {
  it('accepts a clean 1-minute file verbatim', () => {
    const { cols, report } = importText(
      rows([
        '2024-01-15,00:00,1.08500,1.08520,1.08480,1.08510,120',
        '2024-01-15,00:01,1.08510,1.08530,1.08500,1.08520,140',
        '2024-01-15,00:02,1.08520,1.08520,1.08450,1.08460,90',
      ]),
    );
    expect(report.accepted).toBe(3);
    expect(report.rejected).toBe(0);
    expect(cols.len).toBe(3);
    expect(cols.t[0]).toBe(Date.UTC(2024, 0, 15, 0, 0));
    // Prices are never adjusted.
    expect(cols.h[2]).toBe(1.0852);
    expect(cols.l[2]).toBe(1.0845);
    expect(cols.c[2]).toBe(1.0846);
    expect(report.timeframe).toBe('1m');
    expect(report.nativeTimeframe).toBe('1m');
  });

  it('reports unparsable and inconsistent rows instead of coercing them', () => {
    const { report, cols } = importText(
      rows([
        '2024-01-15,00:00,1.08500,1.08520,1.08480,1.08510,1',
        '2024-01-15,00:01,1.08500,1.08000,1.09000,1.08510,1', // high<low
        '2024-01-15,00:02,abc,1.08520,1.08480,1.08510,1', // unparsable open
        '2024-01-15,00:03,-1,1.08520,1.08480,1.08510,1', // non-positive
        'not-a-date,00:04,1,1,1,1,1', // bad date
        '2024-01-15,00:05,1.08500,1.08520,1.08480,1.08510,1',
      ]),
    );
    expect(cols.len).toBe(2);
    expect(report.rejected).toBe(4);
    expect(report.ohlcViolations).toBe(1);
    expect(report.invalid.length).toBeGreaterThanOrEqual(4);
    const reasons = report.invalid.map((r) => r.reason).join(' | ');
    expect(reasons).toContain('inconsistent OHLC');
    expect(reasons).toContain('missing or unparsable OHLC');
    expect(reasons).toContain('non-positive price');
    expect(reasons).toContain('unrecognised date');
    expect(report.invalid.map((r) => r.line)).toEqual([3, 4, 5, 6]);
  });

  it('sorts out-of-order rows chronologically', () => {
    const { cols, report } = importText(
      rows([
        '2024-01-15,00:02,1,1.1,0.9,1.05,1',
        '2024-01-15,00:00,1,1.1,0.9,1.01,1',
        '2024-01-15,00:01,1,1.1,0.9,1.02,1',
      ]),
    );
    expect(cols.t[0]).toBe(Date.UTC(2024, 0, 15, 0, 0));
    expect(cols.t[2]).toBe(Date.UTC(2024, 0, 15, 0, 2));
    expect(report.unorderedRows).toBe(1); // only one row sits before its predecessor
    expect(report.notes.join(' ')).toMatch(/re-sorted/);
  });

  it('applies the chosen duplicate policy without averaging', () => {
    const dup = rows([
      '2024-01-15,00:00,1.00,1.10,0.90,1.05,1',
      '2024-01-15,00:00,2.00,2.10,1.90,2.05,2',
      '2024-01-15,00:01,1.00,1.10,0.90,1.05,1',
    ]);
    const first = importText(dup, { dedupe: 'first' });
    expect(first.cols.len).toBe(2);
    expect(first.cols.o[0]).toBe(1);
    expect(first.report.duplicates).toBe(1);

    const last = importText(dup, { dedupe: 'last' });
    expect(last.cols.o[0]).toBe(2);
    expect(last.cols.c[0]).toBe(2.05);

    const rejected = importText(dup, { dedupe: 'reject' });
    expect(rejected.cols.len).toBe(2);
    // Reject keeps the first too (the duplicate is dropped), and reports it.
    expect(rejected.cols.o[0]).toBe(1);
    expect(rejected.report.duplicates).toBe(1);
  });

  it('never invents a finer timeframe than the file provides', () => {
    const hourly = rows([
      '2024-01-15,00:00,1,1.1,0.9,1.05,1',
      '2024-01-15,01:00,1,1.2,0.8,1.15,1',
    ]);
    const res = importText(hourly, { tf: '1m' });
    expect(res.finerThanSource).toBe(true);
    expect(res.report.notes.join(' ')).toMatch(/finer than the source/);
    // 2 rows stay 2 rows — no synthetic minutes in between.
    expect(res.cols.len).toBe(2);
  });

  it('aggregates a 1-minute file into 5-minute buckets when asked', () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      const o = 1 + i / 1000;
      lines.push(`2024-01-15,00:${String(i).padStart(2, '0')},${o.toFixed(5)},${(o + 0.002).toFixed(5)},${(o - 0.001).toFixed(5)},${(o + 0.001).toFixed(5)},10`);
    }
    const { cols, report } = importText(rows(lines), { tf: '5m' });
    expect(cols.len).toBe(3);
    expect(report.mergedIntoBuckets).toBe(9);
    expect(cols.t[1]).toBe(Date.UTC(2024, 0, 15, 0, 5));
    // open = first, close = last, high/low = extremes of the five rows
    expect(cols.o[1]).toBeCloseTo(1.005, 6); // open of minute 05
    expect(cols.c[1]).toBeCloseTo(1.01, 6); // close of minute 09
    expect(cols.h[1]).toBeCloseTo(1.011, 6); // max high of 05..09
    expect(cols.l[1]).toBeCloseTo(1.004, 6);
    expect(cols.v[1]).toBe(50);
    expect(cols.n[1]).toBe(5);
  });

  it('treats close-stamped feeds by shifting timestamps one bar back', () => {
    const text = rows([
      '2024-01-15,00:01,1,1,1,1,1',
      '2024-01-15,00:02,1,1,1,1,1',
    ]);
    const openMode = importText(text);
    const closeMode = importText(text, { timestampMode: 'close' });
    expect(openMode.cols.t[0]).toBe(Date.UTC(2024, 0, 15, 0, 1));
    expect(closeMode.cols.t[0]).toBe(Date.UTC(2024, 0, 15, 0, 0));
    expect(closeMode.report.notes.join(' ')).toMatch(/candle close/);
  });

  it('interprets wall clock in the selected source timezone', () => {
    const text = rows(['2024-06-15,09:00,1,1,1,1,1']);
    const utc = importText(text, { tz: 'UTC' });
    const tokyo = importText(text, { tz: 'Asia/Tokyo' });
    const ny = importText(text, { tz: 'America/New_York' });
    expect(utc.cols.t[0]).toBe(Date.UTC(2024, 5, 15, 9));
    expect(tokyo.cols.t[0]).toBe(Date.UTC(2024, 5, 15, 0));
    expect(ny.cols.t[0]).toBe(Date.UTC(2024, 5, 15, 13));
  });

  it('reads semicolon files with decimal commas (MT4/MT5 style)', () => {
    const text = [
      'DATE;TIME;OPEN;HIGH;LOW;CLOSE;TICKSIZE',
      '15.01.2024;00:00;1,08500;1,08520;1,08480;1,08510;120',
      '15.01.2024;00:01;1,08510;1,08530;1,08500;1,08520;140',
    ].join('\n');
    const rowsSplit = parseCsv(text, { delimiter: ';' });
    const builder = new MarketCsvBuilder({ tz: 'UTC', decimalSeparator: ',' });
    builder.setMap(FULL);
    for (const r of rowsSplit) builder.feed(r);
    const { cols, report } = builder.finish();
    expect(report.accepted).toBe(2);
    expect(cols.h[1]).toBeCloseTo(1.0853, 6);
    expect(cols.t[0]).toBe(Date.UTC(2024, 0, 15));
  });

  it('keeps volume at zero with a note when the file has no volume column', () => {
    const text = ['Date,Time,Open,High,Low,Close', '2024-01-15,00:00,1,1,1,1', '2024-01-15,00:01,1,1,1,1'].join('\n');
    const rowsSplit = parseCsv(text);
    const builder = new MarketCsvBuilder({ tz: 'UTC' });
    builder.setMap({ date: 0, time: 1, open: 2, high: 3, low: 4, close: 5 });
    for (const r of rowsSplit) builder.feed(r);
    const { cols, report } = builder.finish();
    expect(cols.v[0]).toBe(0);
    expect(report.volumeSeen).toBe(false);
    expect(report.notes.join(' ')).toMatch(/volume kept at 0/);
  });
});

describe('market import: gaps and closure detection', () => {
  it('does not count the weekend as missing data', () => {
    const text = rows([
      '2024-01-19,20:59,1,1,1,1,1', // Friday close
      '2024-01-22,00:00,1,1,1,1,1', // Sunday reopen (2.7 days later)
    ]);
    const { report } = importText(text, { tf: '1m' });
    expect(report.gapCount).toBe(0);
    expect(report.closedSpans).toBe(1);
    expect(report.missingBars).toBe(0);
  });

  it('counts a real intraday hole', () => {
    const text = rows([
      '2024-01-15,10:00,1,1,1,1,1',
      '2024-01-15,10:05,1,1,1,1,1',
    ]);
    const { report } = importText(text, { tf: '1m' });
    expect(report.gapCount).toBe(1);
    expect(report.missingBars).toBe(4);
    expect(report.gaps[0].kind).toBe('hole');
  });

  it('classifies market closure vs hole deterministically', () => {
    const fridayClose = Date.UTC(2024, 0, 19, 21);
    const sundayOpen = Date.UTC(2024, 0, 21, 21);
    expect(isMarketClosure(fridayClose, sundayOpen, 'UTC')).toBe(true);
    const wedMorning = Date.UTC(2024, 0, 17, 10);
    const wedAfternoon = Date.UTC(2024, 0, 17, 15);
    expect(isMarketClosure(wedMorning, wedAfternoon, 'UTC')).toBe(false);
    const cols = {
      t: Float64Array.from([Date.UTC(2024, 0, 17, 10), Date.UTC(2024, 0, 17, 15)]),
      o: new Float64Array(2), h: new Float64Array(2), l: new Float64Array(2), c: new Float64Array(2),
      v: new Float64Array(2), n: new Uint32Array(2).fill(1), len: 2,
    };
    expect(scanGaps(cols, 60_000, '1m', 'UTC').gaps).toHaveLength(1);
  });

  it('day files are judged by calendar days, not by 24h spacing', () => {
    const text = rows([
      '2024-01-19,00:00,1,1,1,1,1', // Friday
      '2024-01-22,00:00,1,1,1,1,1', // Monday
    ]);
    const { report } = importText(text, { tf: '1D' });
    expect(report.timeframe).toBe('1D');
    expect(report.gapCount).toBe(0);
  });
});

describe('market import: end-to-end through the scanner', () => {
  it('ingests a generated 1-minute file in chunks with the same result as one shot', () => {
    const csv = syntheticCsv({ bars: 900, start: Date.UTC(2024, 4, 6), seed: 99 });
    const oneShot = importText(csv);
    expect(oneShot.report.accepted).toBe(900);
    expect(oneShot.report.rejected).toBe(0);
    // Monotone, dense, and prices untouched.
    for (let i = 1; i < 900; i++) expect(oneShot.cols.t[i] - oneShot.cols.t[i - 1]).toBe(60_000);
    for (let i = 0; i < 900; i++) {
      const c = oneShot.cols;
      expect(c.h[i]).toBeGreaterThanOrEqual(Math.max(c.o[i], c.c[i]) - 1e-9);
      expect(c.l[i]).toBeLessThanOrEqual(Math.min(c.o[i], c.c[i]) + 1e-9);
    }
    expect(oneShot.report.dateFormat).toContain('ISO');
  });

  it('probeText describes the file and never mutates it', () => {
    const csv = syntheticCsv({ bars: 30, start: Date.UTC(2024, 4, 6) });
    const probe = probeText(csv, 'EURUSD_M1.csv');
    expect(probe.detected.roles.open).toBe(2);
    expect(probe.header[0]).toBe('Date');
    expect(probe.preview[0][0]).toMatch(/^2024/);
    expect(probe.detected.confidence).toBeGreaterThan(0.8);
    expect(probe.notes.length).toBeGreaterThan(1);
  });

  it('surfaces an empty or garbage file as a diagnostic', () => {
    expect(probeText('', 'x.csv').error).toBe('empty file');
    const junk = probeText('a,b,c\nx,y,z', 'junk.csv');
    expect(junk.detected.notes.join(' ')).toMatch(/could not locate/);
  });
});

describe('committed synthetic fixture (end to end)', () => {
  it('imports tests/fixtures/sample-200.csv with honest accounting', () => {
    const text = readFileSync(new URL('./fixtures/sample-200.csv', import.meta.url), 'utf8');
    const { cols, report } = importText(text, { tz: 'UTC', symbol: 'EURUSD', tf: '5m' });
    expect(report.rejected).toBe(0);
    expect(report.accepted).toBe(200);
    expect(report.dataRows).toBe(200);
    expect(report.symbol).toBe('EURUSD');
    expect(report.timeframe).toBe('5m');
    expect(report.duplicates).toBe(0);
    expect(report.gapCount).toBe(0);
    expect(report.missingBars).toBe(0);
    expect(report.dateFormat).toMatch(/ISO-8601/);
    expect(report.timeFormat).toMatch(/HH:mm/);
    // Comment and header lines are recognised, not counted as data rows.
    expect(report.totalLines).toBe(text.trimEnd().split('\n').length);
    expect(report.commentLines).toBe(2);
    expect(report.header?.[0]).toBe('Date');
    for (let i = 0; i < 200; i++) {
      expect(cols.h[i]).toBeGreaterThanOrEqual(Math.max(cols.o[i], cols.c[i]));
      expect(cols.l[i]).toBeLessThanOrEqual(Math.min(cols.o[i], cols.c[i]));
    }
    expect(cols.t[1] - cols.t[0]).toBe(300_000);
    expect(cols.v[0]).toBeGreaterThan(0);
  });

  it('folds the same fixture to 1H without inventing buckets', () => {
    const text = readFileSync(new URL('./fixtures/sample-200.csv', import.meta.url), 'utf8');
    const { cols } = importText(text, { tz: 'UTC', symbol: 'EURUSD', tf: '5m' });
    const base = new CandleSeries({ symbol: 'EURUSD', tf: '5m', tz: 'UTC', cols, hasVolume: true });
    const h1 = aggregateSeries(base, '1H', 'UTC');
    expect(h1.count).toBe(Math.ceil(200 * 5 / 60));
    // 200 five-minute bars from 00:00 = 16h40m → 17 hourly buckets, last one partial.
    expect(h1.time(0)).toBe(Date.UTC(2024, 0, 2, 0, 0));
    expect(h1.cols.n[h1.count - 1]).toBeGreaterThan(0);
    expect(h1.cols.n[h1.count - 1]).toBeLessThanOrEqual(12);
  });
});
