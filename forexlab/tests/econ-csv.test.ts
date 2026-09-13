import { describe, expect, it } from 'vitest';
import {
  detectNewsColumns,
  importNewsText,
  indicatorKey,
  inferCategory,
  inferEventType,
  normaliseCurrency,
  normaliseImpact,
  probeNewsText,
  requiredNewsRolesMissing,
} from '../src/core/econ/csv.ts';

const HEADER = 'Date,Time,Currency,Impact,Event,Actual,Forecast,Previous,Revised Previous';
const csv = (rows: string[]) => [HEADER, ...rows].join('\n');

describe('news CSV column detection', () => {
  it('detects standard headers', () => {
    const { map, hasHeader } = detectNewsColumns([HEADER.split(',')]);
    expect(hasHeader).toBe(true);
    expect(map).toMatchObject({ date: 0, time: 1, currency: 2, impact: 3, event: 4, actual: 5, forecast: 6, previous: 7, revised: 8 });
  });
  it('detects alias headers and semicolon delimiter', () => {
    const text = 'DateTime;Ccy;Importance;Title;Result;Consensus;Prior\n2024-03-12 12:30;USD;High;CPI (YoY);3.2;3.1;3.1';
    const p = probeNewsText(text);
    expect(p.delimiter).toBe(';');
    expect(p.map).toMatchObject({ datetime: 0, currency: 1, impact: 2, event: 3, actual: 4, forecast: 5, previous: 6 });
  });
  it('reports missing required roles', () => {
    expect(requiredNewsRolesMissing({ event: 1 })).toEqual(['date', 'currency']);
    expect(requiredNewsRolesMissing({ datetime: 0, event: 1, country: 2 })).toEqual([]);
  });
});

describe('news normalisation', () => {
  it('maps currencies and countries', () => {
    expect(normaliseCurrency('usd')).toEqual({ code: 'USD', known: true });
    expect(normaliseCurrency('', 'Eurozone')).toEqual({ code: 'EUR', known: true });
    expect(normaliseCurrency('XYZ')).toEqual({ code: 'XYZ', known: false });
  });
  it('maps impact labels', () => {
    expect(normaliseImpact('High')).toBe('high');
    expect(normaliseImpact('***')).toBe('high');
    expect(normaliseImpact('Very High')).toBe('veryHigh');
    expect(normaliseImpact('Medium')).toBe('medium');
    expect(normaliseImpact('holiday')).toBe('low');
    expect(normaliseImpact('??')).toBeNull();
  });
  it('infers category and type from titles', () => {
    expect(inferCategory(undefined, 'Core CPI (MoM)')).toBe('Inflation');
    expect(inferEventType('Core CPI (MoM)')).toBe('Core CPI');
    expect(inferEventType('Nonfarm Payrolls')).toBe('NFP');
    expect(inferCategory('', 'Nonfarm Payrolls')).toBe('Employment');
    expect(inferEventType('FOMC Rate Decision')).toBe('FOMC');
    expect(inferCategory(undefined, 'ISM Manufacturing PMI')).toBe('Manufacturing');
  });
  it('indicator keys ignore month qualifiers', () => {
    expect(indicatorKey('USD', 'CPI (YoY) (Mar)')).toBe(indicatorKey('USD', 'CPI (YoY) (Apr)'));
    expect(indicatorKey('USD', 'CPI (YoY)')).not.toBe(indicatorKey('EUR', 'CPI (YoY)'));
  });
});

describe('news import', () => {
  it('parses rows, converts the timezone and keeps missing values as null', () => {
    const text = csv([
      '2024-03-12,08:30,USD,High,CPI (YoY),3.2%,3.1%,3.1%,',
      '2024-03-12,08:30,USD,High,Core CPI (YoY),3.8%,3.7%,3.9%,3.8%',
      '2024-04-05,08:30,USD,High,Nonfarm Payrolls,303K,,270K,',
    ]);
    const r = importNewsText(text, { tz: 'America/New_York', dayFirst: false, batchId: 'b1' });
    expect(r.summary.accepted).toBe(3);
    expect(r.summary.rejected).toBe(0);
    // 08:30 New York in March (EDT, UTC−4) = 12:30Z
    expect(new Date(r.events[0].time).toISOString()).toBe('2024-03-12T12:30:00.000Z');
    const cpi = r.events.find((e) => e.type === 'CPI')!;
    expect(cpi.actual).toBe(3.2);
    expect(cpi.unit).toBe('%');
    const nfp = r.events.find((e) => e.type === 'NFP')!;
    expect(nfp.forecast).toBeNull();
    expect(nfp.actual).toBe(303); // magnitude kept as written; unit stored separately
    expect(nfp.unit).toBe('K');
    expect(r.summary.missingForecast).toBe(1);
    expect(r.summary.withRevised).toBe(1);
    const core = r.events.find((e) => e.type === 'Core CPI')!;
    expect(core.previous).toBe(3.9);
    expect(core.revisedPrevious).toBe(3.8);
  });

  it('rejects unusable rows with reasons and never invents timestamps', () => {
    const text = csv([
      '2024-03-12,08:30,USD,High,CPI (YoY),3.2,3.1,3.1,',
      'not-a-date,08:30,USD,High,CPI (YoY),3.2,3.1,3.1,',
      '2024-03-13,All Day,USD,Low,Bank Holiday,,,,',
      '2024-03-14,08:30,USD,High,,1,1,1,',
      '2024-03-15,08:30,USD,High,PPI,abc,1,1,',
    ]);
    const r = importNewsText(text, { tz: 'UTC', dayFirst: false, batchId: 'b' });
    expect(r.summary.accepted).toBe(1);
    expect(r.summary.rejected).toBe(4);
    const reasons = r.summary.rejectedRows.map((x) => x.reason);
    expect(reasons.some((x) => /unrecognised date|unreadable date/.test(x))).toBe(true);
    expect(reasons.some((x) => /no release time/.test(x))).toBe(true);
    expect(reasons.some((x) => /empty event title/.test(x))).toBe(true);
    expect(reasons.some((x) => /invalid numeric Actual/.test(x))).toBe(true);
  });

  it('detects duplicates (same indicator, same instant)', () => {
    const text = csv(['2024-03-12,08:30,USD,High,CPI (YoY),3.2,3.1,3.1,', '2024-03-12,08:30,USD,High,CPI (YoY),3.2,3.1,3.1,']);
    const r = importNewsText(text, { tz: 'UTC', dayFirst: false, batchId: 'b' });
    expect(r.summary.accepted).toBe(1);
    expect(r.summary.duplicates).toBe(1);
  });

  it('supports epoch timestamps and manual column mapping', () => {
    const text = 'a,b,c\n1710246600,USD,CPI\n1710246660000,EUR,HICP';
    const r = importNewsText(text, { tz: 'UTC', dayFirst: false, batchId: 'b', hasHeader: true, map: { timestamp: 0, currency: 1, event: 2 } });
    expect(r.summary.accepted).toBe(2);
    expect(r.events[0].time).toBe(1710246600000);
    expect(r.events[1].time).toBe(1710246660000);
  });

  it('fails cleanly when required columns are missing', () => {
    const r = importNewsText('x,y\n1,2', { tz: 'UTC', dayFirst: false, batchId: 'b' });
    expect(r.events).toHaveLength(0);
    expect(r.summary.rejectedRows[0].reason).toMatch(/missing required column/);
  });

  it('does not execute or interpret markup in titles', () => {
    const text = csv(['2024-03-12,08:30,USD,High,"<script>alert(1)</script>",1,1,1,']);
    const r = importNewsText(text, { tz: 'UTC', dayFirst: false, batchId: 'b' });
    expect(r.events[0].event).toBe('<script>alert(1)</script>');
  });
});
