import { describe, expect, it } from 'vitest';
import { CsvScanner, parseCsv, sniffDelimiter, splitRecord } from '../src/core/csv/parser.ts';
import { parseDateToken, parseNumber, parseTimeToken, toInstant } from '../src/core/csv/values.ts';
import { detectColumns, isCompleteMap, letter } from '../src/core/csv/columns.ts';
import { createResolver } from '../src/core/time/wallclock.ts';

describe('csv scanner', () => {
  it('splits quoted fields, embedded delimiters and escaped quotes', () => {
    const rows = parseCsv('a,"b,c","say ""hi"""\n1,2,3');
    expect(rows).toEqual([
      ['a', 'b,c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF and quoted newlines', () => {
    const rows = parseCsv('x,"line1\r\nline2"\r\ny,z\r\n');
    expect(rows).toEqual([['x', 'line1\r\nline2'], ['y', 'z']]);
  });

  it('reassembles records split across chunks at any boundary', () => {
    const text = 'Date,Open,High\r\n2024-01-15,1.08500,1.08520\r\n2024-01-16,1.08510,1.08530\r\n';
    for (let size = 1; size <= 12; size++) {
      const out: string[][] = [];
      const scanner = new CsvScanner({ delimiter: ',' });
      const sink = { row: (cells: string[]) => out.push(cells) };
      for (let i = 0; i < text.length; i += size) {
        scanner.push(text.slice(i, i + size), sink, i + size >= text.length);
      }
      expect(out).toHaveLength(3);
      expect(out[1]).toEqual(['2024-01-15', '1.08500', '1.08520']);
    }
  });

  it('keeps a quoted record spanning chunks', () => {
    const out: string[][] = [];
    const scanner = new CsvScanner({ delimiter: ',' });
    const sink = { row: (cells: string[]) => out.push(cells) };
    scanner.push('a,"multi\nline', sink, false);
    scanner.push('tail",b', sink, true);
    expect(out).toEqual([['a', 'multi\nlinetail', 'b']]);
  });

  it('skips blank lines but counts them', () => {
    expect(parseCsv('a,b\n\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('sniffs the delimiter', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(sniffDelimiter('a|b|c\n1|2|3')).toBe('|');
  });

  it('splitRecord is usable standalone', () => {
    expect(splitRecord('1;"2;3";4', ';')).toEqual(['1', '2;3', '4']);
  });
});

describe('number parsing', () => {
  it('reads plain and padded decimals', () => {
    expect(parseNumber('1.08530')).toBe(1.0853);
    expect(parseNumber(' 1.08530 ')).toBe(1.0853);
    expect(parseNumber('-0.00012')).toBe(-0.00012);
    expect(parseNumber('1e-5')).toBe(1e-5);
  });

  it('handles decimal commas and thousands groups', () => {
    expect(parseNumber('1,08530', { decimalSeparator: ',' })).toBe(1.0853);
    expect(parseNumber('1,0950')).toBe(1.095); // auto: single comma → decimal
    expect(parseNumber('1.234,56')).toBe(1234.56); // auto: EU grouping
    expect(parseNumber('1,234,567')).toBe(1234567); // thousands groups
    expect(parseNumber('10,240')).toBe(10240);
  });

  it('rejects junk instead of guessing', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('n/a')).toBeNull();
    expect(parseNumber('—')).toBeNull();
    expect(parseNumber('1.2.3')).toBeNull();
    expect(parseNumber('12abc')).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });

  it('keeps percent magnitudes as reported', () => {
    expect(parseNumber('3.2%')).toBe(3.2);
    expect(parseNumber('(2.5)')).toBe(-2.5);
  });
});

describe('date / time token parsing', () => {
  it('recognises the common FX export shapes', () => {
    expect(parseDateToken('2024-03-15', false).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('2024/03/15', false).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('15.03.2024', false).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('03/15/2024', false).wall).toBe(Date.UTC(2024, 2, 15));
    // "3/15/2024" has no valid day-first reading (month 15), so the value itself
    // disambiguates it to 15 March even when dayFirst is set.
    expect(parseDateToken('3/15/2024', true).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('15/03/2024', true).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('15-Mar-2024', false).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('Mar 15, 2024', false).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('20240315', false).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('45366', false).format).toBe('Excel serial');
    expect(parseDateToken('45366', false).wall).toBe(Date.UTC(2024, 2, 15));
    expect(parseDateToken('45366.5', false).wall).toBe(Date.UTC(2024, 2, 15, 12));
    expect(parseDateToken('202403151600', false).wall).toBe(Date.UTC(2024, 2, 15, 16, 0));
    expect(parseDateToken('1710504000', false).absolute).toBe(1710504000000);
    expect(parseDateToken('1710504000000', false).absolute).toBe(1710504000000);
  });

  it('honours explicit zones inside the cell', () => {
    const iso = parseDateToken('2024-03-15T16:00:00Z', false);
    expect(iso.absolute).toBe(Date.UTC(2024, 2, 15, 16));
    const off = parseDateToken('2024-03-15 16:00', false);
    expect(off.absolute).toBeNull(); // zone comes from the import setting
  });

  it('reads times in several shapes', () => {
    expect(parseTimeToken('16:30').ms).toBe(16 * 3_600_000 + 30 * 60_000);
    expect(parseTimeToken('16:30:45').ms).toBe(16 * 3_600_000 + 30 * 60_000 + 45_000);
    expect(parseTimeToken('4:30 PM').ms).toBe(16 * 3_600_000 + 30 * 60_000);
    expect(parseTimeToken('1630').ms).toBe(16 * 3_600_000 + 30 * 60_000);
    expect(parseTimeToken('0.6875').ms).toBe(Math.round(0.6875 * 86_400_000));
    expect(parseTimeToken('99:99').ms).toBeNull();
    expect(parseTimeToken('').ms).toBeNull();
  });

  it('combines date + time through the timezone resolver', () => {
    const utc = createResolver('UTC');
    const r = toInstant(parseDateToken('2024-03-15', false), parseTimeToken('16:00').ms, utc);
    expect(r.instant).toBe(Date.UTC(2024, 2, 15, 16));
    const tokyo = createResolver('Asia/Tokyo');
    const r2 = toInstant(parseDateToken('2024-03-15', false), parseTimeToken('16:00').ms, tokyo);
    expect(r2.instant).toBe(Date.UTC(2024, 2, 15, 16) - 9 * 3_600_000);
  });

  it('refuses to invent a date', () => {
    expect(parseDateToken('', false).wall).toBeNull();
    expect(parseDateToken('15/32/2024', false).wall).toBeNull();
    expect(parseDateToken('not-a-date', false).error).toContain('unrecognised');
  });
});

describe('column detection', () => {
  it('maps a standard header row', () => {
    const rows = parseCsv('Date,Time,Open,High,Low,Close,Volume\n2024-01-15,00:01,1,1,1,1,10');
    const map = detectColumns(rows);
    expect(map.roles).toMatchObject({ date: 0, time: 1, open: 2, high: 3, low: 4, close: 5, volume: 6 });
    expect(map.hasHeader).toBe(true);
    expect(map.confidence).toBeGreaterThan(0.9);
    expect(isCompleteMap(map.roles)).toBe(true);
  });

  it('maps dukascopy-style tick headers and truefx close headers', () => {
    const a = parseCsv('2024/01/15,00:00,00:01,1.08500,1.08520,1.08480,1.08510,123');
    expect(a[0]).toHaveLength(8);
    const b = parseCsv('DATE;TIME;OPEN;HIGH;LOW;CLOSE;TICKSIZE\n2024.01.15;00:00;1.08500;1.08520;1.08480;1.08510;10');
    const map = detectColumns(b, { delimiter: ';' });
    expect(map.hasHeader).toBe(true);
    expect(Object.values(map.roles).filter((v) => v !== undefined).length).toBeGreaterThanOrEqual(5);
  });

  it('falls back to value shapes with no header, and reports day-first ambiguity', () => {
    const rows = [
      ['15/01/2024', '00:00', '1.0850', '1.0852', '1.0848', '1.0851'],
      ['16/01/2024', '00:00', '1.0851', '1.0853', '1.0849', '1.0852'],
      ['17/01/2024', '00:00', '1.0852', '1.0854', '1.0850', '1.0853'],
    ];
    const map = detectColumns(rows);
    expect(map.hasHeader).toBe(false);
    expect(map.roles.date).toBe(0);
    expect(map.roles.open).toBe(2);
    expect(map.dayFirst).toBe(true);
  });

  it('keeps a datetime column as the date role', () => {
    const rows = parseCsv('datetime,open,high,low,close\n2024-01-15T00:00:00,1,1,1,1\n2024-01-15T00:01:00,1,1,1,1');
    const map = detectColumns(rows);
    expect(map.roles.date).toBe(0);
    expect(map.roles.time).toBeUndefined();
  });

  it('reports what it could not find', () => {
    const map = detectColumns([['foo', 'bar'], ['baz', 'qux']]);
    expect(isCompleteMap(map.roles)).toBe(false);
    expect(map.notes.join(' ')).toMatch(/could not locate/);
    expect(letter(0)).toBe('A');
    expect(letter(27)).toBe('AB');
  });
});
