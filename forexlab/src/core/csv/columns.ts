/**
 * Header / column-role detection for market CSV files.
 *
 * Detection is name-first with a value-based fallback, and every decision is
 * reported back so the importer UI can show what was guessed and let the user
 * override the mapping per role.
 */

export type ColumnRole = 'date' | 'time' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'symbol';

export interface ColumnMap {
  roles: Partial<Record<ColumnRole, number>>;
  confidence: number;
  notes: string[];
  hasHeader: boolean;
  delimiter: string;
  /** Inferred from the date column's separators; drives dayFirst handling. */
  dayFirst?: boolean;
}

export const ROLE_ALIASES: Record<ColumnRole, string[]> = {
  date: ['date', 'datetime', 'dt', 'day', 'bar_date', 'date_time', 'time', 'timestamp', 'ticktime', 't'],
  time: ['time', 'hh:mm', 'clock', 'bar_time', 'ticktime', 'timestamp', 'time_of_day'],
  open: ['open', 'o', 'open_price', 'openp', 'op', 'askopen', 'open(p)', 'p_open'],
  high: ['high', 'h', 'high_price', 'highp', 'highbid', 'high(p)', 'p_high'],
  low: ['low', 'l', 'low_price', 'lowp', 'lowbid', 'low(p)', 'p_low'],
  close: ['close', 'c', 'close_price', 'closep', 'last', 'last_price', 'px_last', 'close(p)', 'p_close'],
  volume: ['volume', 'vol', 'v', 'tick_volume', 'ticks', 'size', 'count', 'numticks'],
  symbol: ['symbol', 'pair', 'instrument', 'ticker', 'currency_pair', 'security'],
};

const NUMERIC = /^[-+]?[\d.,]+(?:[eE][-+]?\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const SLASH_DATE = /^(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(:\d{2})?([.,]\d+)?\s*(AM|PM)?$/i;
const COMPACT_DATE = /^\d{8}(\d{4,6})?$/;

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_()[\]-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreName(name: string, role: ColumnRole): number {
  const n = norm(name).replace(/ /g, '');
  const aliases = ROLE_ALIASES[role];
  for (let i = 0; i < aliases.length; i++) {
    const a = norm(aliases[i]).replace(/ /g, '');
    if (n === a) return 1 - i * 0.02;
    if (a.length > 2 && (n === `${a}_price` || n.startsWith(`${a}price`) || n.startsWith(`${a}(`))) return 0.8;
    if (a.length > 3 && n.includes(a) && !n.includes('prev')) return 0.6;
  }
  return 0;
}

export interface DetectOptions {
  /** Prefer DD/MM when a slash/dot date is ambiguous. */
  dayFirst?: boolean;
  delimiter?: string;
}

/**
 * Inspect a sample of rows (already split into cells) and return a role map.
 * `rows` should include the header when one exists — typically the first ~50 rows.
 */
export function detectColumns(rows: string[][], opts: DetectOptions = {}): ColumnMap {
  const notes: string[] = [];
  if (rows.length === 0) {
    return { roles: {}, confidence: 0, notes: ['empty file'], hasHeader: false, delimiter: opts.delimiter ?? ',' };
  }
  const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
  const first = rows[0].map((c) => c ?? '');
  const headerScore = first.reduce((acc, cell) => {
    const c = cell.trim();
    if (!c) return acc;
    const known = (Object.keys(ROLE_ALIASES) as ColumnRole[]).some((r) => scoreName(c, r) > 0);
    const looksNumeric = NUMERIC.test(c);
    return acc + (known ? 1 : looksNumeric ? -1 : 0.15);
  }, 0);
  const hasHeader = headerScore >= 1;
  const header = hasHeader ? first : [];
  const dataRows = (hasHeader ? rows.slice(1) : rows).filter((r) => r.some((c) => (c ?? '').trim() !== ''));
  if (dataRows.length === 0) {
    return {
      roles: {},
      confidence: 0,
      notes: ['no data rows after header'],
      hasHeader,
      delimiter: opts.delimiter ?? ',',
    };
  }

  const colStats: {
    numeric: number;
    dateLike: number;
    slashDate: number;
    timeLike: number;
    compact: number;
    text: number;
    maxNum: number;
    monotonic: number;
    total: number;
    samples: string[];
    lastNum: number;
  }[] = [];
  for (let c = 0; c < width; c++) {
    colStats.push({
      numeric: 0, dateLike: 0, slashDate: 0, timeLike: 0, compact: 0, text: 0,
      maxNum: -Infinity, monotonic: 0, total: 0, samples: [], lastNum: -Infinity,
    });
  }
  const sampleLimit = Math.min(dataRows.length, 400);
  for (let r = 0; r < sampleLimit; r++) {
    const row = dataRows[r];
    for (let c = 0; c < width; c++) {
      const raw = (row[c] ?? '').trim();
      const st = colStats[c];
      st.total++;
      if (r < 5 && raw) st.samples.push(raw);
      if (!raw) continue;
      if (ISO_DATE.test(raw)) st.dateLike++;
      else if (SLASH_DATE.test(raw)) st.slashDate++;
      else if (COMPACT_DATE.test(raw) && raw.length >= 8) st.compact++;
      else if (TIME_ONLY.test(raw)) st.timeLike++;
      else if (NUMERIC.test(raw)) {
        st.numeric++;
        const num = Number(raw.replace(/[.,](?=\d{3}\b)/g, ''));
        if (Number.isFinite(num)) {
          if (num > st.lastNum) st.monotonic++;
          st.lastNum = num;
          if (num > st.maxNum) st.maxNum = num;
        }
      } else st.text++;
    }
  }

  const roles: Partial<Record<ColumnRole, number>> = {};
  const take = (role: ColumnRole, col: number, why: string) => {
    if (col < 0) return false;
    if (roles[role] !== undefined) return false;
    for (const other of Object.keys(roles) as ColumnRole[]) {
      if (roles[other] === col) return false;
    }
    roles[role] = col;
    notes.push(`${role} → column ${letter(col)} (${why})`);
    return true;
  };

  // Pass 1: explicit header names.
  if (hasHeader) {
    for (const role of ['date', 'time', 'open', 'high', 'low', 'close', 'volume', 'symbol'] as ColumnRole[]) {
      let bestCol = -1;
      let bestScore = 0;
      for (let c = 0; c < width; c++) {
        const s = scoreName(header[c] ?? '', role);
        if (s > bestScore) {
          bestScore = s;
          bestCol = c;
        }
      }
      if (bestScore >= 0.5) take(role, bestCol, `header name, ${Math.round(bestScore * 100)}% match`);
    }
  }

  // Pass 2: value inference for whatever is still missing.
  const frac = (c: number, key: 'dateLike' | 'slashDate' | 'timeLike' | 'compact' | 'numeric' | 'text') =>
    colStats[c].total > 0 ? colStats[c][key] / colStats[c].total : 0;

  const dateCandidates: { c: number; score: number; why: string }[] = [];
  for (let c = 0; c < width; c++) {
    const st = colStats[c];
    const dateFrac = frac(c, 'dateLike') + frac(c, 'slashDate') + frac(c, 'compact');
    if (dateFrac > 0.8) dateCandidates.push({ c, score: dateFrac, why: 'date-shaped values' });
    if (st.maxNum > 1_000_000_000 && st.maxNum < 1e12 && frac(c, 'numeric') > 0.8) {
      dateCandidates.push({ c, score: frac(c, 'numeric') * 0.95, why: 'epoch-shaped numbers' });
    }
  }
  dateCandidates.sort((a, b) => b.score - a.score);
  let dayFirst: boolean | undefined;
  for (const cand of dateCandidates) {
    if (take('date', cand.c, cand.why)) {
      // Disambiguate DD/MM vs MM/DD from the observed leading component.
      const col = cand.c;
      let big = 0;
      let small = 0;
      let ambiguous = 0;
      for (let r = 0; r < Math.min(dataRows.length, 200); r++) {
        const m = SLASH_DATE.exec((dataRows[r][col] ?? '').trim());
        if (!m) continue;
        const a = +m[1];
        const b = +m[2];
        if (String(m[1]).length === 4) continue;
        if (a > 12) big++;
        else if (b > 12) small++;
        else ambiguous++;
      }
      if (big > small && big > 0) dayFirst = true;
      else if (small > big && small > 0) dayFirst = false;
      else dayFirst = opts.dayFirst ?? false;
      if (ambiguous > 0) {
        notes.push(
          `ambiguous day/month in date column — assuming ${dayFirst ? 'DD/MM (day first)' : 'MM/DD (month first)'}`,
        );
      }
      break;
    }
  }

  // A single datetime column carrying both date and time needs no time column.
  const dateCol = roles.date;
  const dateHasClock =
    dateCol !== undefined &&
    dataRows.some((r) => {
      const v = (r[dateCol] ?? '').trim();
      return /\d{1,2}:\d{2}/.test(v);
    });

  if (!dateHasClock) {
    let timeCol = -1;
    let best = 0;
    for (let c = 0; c < width; c++) {
      if (roles.date === c) continue;
      const s = frac(c, 'timeLike');
      if (s > best) {
        best = s;
        timeCol = c;
      }
    }
    if (best > 0.6) take('time', timeCol, 'clock-shaped values');
  }

  const priceRoles: ColumnRole[] = ['open', 'high', 'low', 'close'];
  const numericCols = colStats
    .map((_st, c) => ({ c, score: frac(c, 'numeric') }))
    .filter((x) => x.score > 0.85 && x.c !== roles.date && x.c !== roles.time)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
  for (const role of priceRoles) {
    if (roles[role] !== undefined) continue;
    for (const c of numericCols) {
      if (take(role, c, 'numeric column fallback')) break;
    }
  }
  if (roles.volume === undefined) {
    const rest = numericCols.filter((c) => !Object.values(roles).includes(c));
    if (rest.length > 0) take('volume', rest[0], 'remaining numeric column');
  }

  const required: ColumnRole[] = ['date', 'open', 'high', 'low', 'close'];
  const missing = required.filter((role) => roles[role] === undefined);
  let confidence = 0;
  if (missing.length === 0) {
    // Named header columns are a much stronger signal than value-shape guessing.
    confidence = hasHeader ? 0.95 : 0.65;
  } else {
    notes.push(`could not locate: ${missing.join(', ')}`);
  }
  const extra = numericCols.filter((c) => !Object.values(roles).includes(c));
  if (extra.length > 0) notes.push(`ignored columns: ${extra.map(letter).join(', ')}`);

  return {
    roles,
    confidence: Number(confidence.toFixed(2)),
    notes,
    hasHeader,
    delimiter: opts.delimiter ?? ',',
    dayFirst,
  };
}

export function letter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function isCompleteMap(map: Partial<Record<ColumnRole, number>> | undefined): boolean {
  if (!map) return false;
  return map.date !== undefined && map.open !== undefined && map.high !== undefined &&
    map.low !== undefined && map.close !== undefined;
}
