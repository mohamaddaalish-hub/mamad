/**
 * Economic calendar data model (stage 8).
 *
 * Everything here is *as supplied by the user's file*. A missing value stays
 * missing — no interpolation, no carry-forward, and `previous` is never
 * overwritten by a revised figure: revisions are stored next to the original so
 * both remain inspectable.
 */

export type ImpactLabel = 'high' | 'medium' | 'low' | 'none' | 'unknown';

export const IMPACT_ORDER: Record<Exclude<ImpactLabel, 'unknown'>, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/** One calendar row, normalized. Times are UTC epoch ms unless `timeKnown` is false. */
export interface EconEvent {
  id: string;
  /** Release instant in UTC ms. When the row had no time this is midnight in the feed zone. */
  instant: number;
  /** False when the file gave only a date: the event is day-anchored, not minute-anchored. */
  timeKnown: boolean;
  currency: string;
  country: string | null;
  impact: ImpactLabel;
  /** The impact exactly as the file wrote it, so a mapping can always be audited. */
  impactRaw: string | null;
  event: string;
  /** Grouping key: currency + normalized name. Used for per-indicator history. */
  eventKey: string;
  category: string | null;
  actual: number | null;
  forecast: number | null;
  /** Previous as published *before* this release (the value traders had in mind). */
  previous: number | null;
  /** Revised previous when the file supplied one; `previous` is left untouched. */
  revisedPrevious: number | null;
  /** True when the file's previous column already held a revised figure. */
  previousWasRevised: boolean;
  unit: string | null;
  /** 1-based line in the source file, for audit. */
  line: number | null;
}

export interface NewsColumnMap {
  date: number;
  time?: number;
  currency?: number;
  country?: number;
  impact?: number;
  event?: number;
  category?: number;
  actual?: number;
  forecast?: number;
  previous?: number;
  revisedPrevious?: number;
}

export const NEWS_ROLES = [
  'date',
  'time',
  'currency',
  'country',
  'impact',
  'event',
  'category',
  'actual',
  'forecast',
  'previous',
  'revisedPrevious',
] as const;

export type NewsRole = (typeof NEWS_ROLES)[number];

export interface InvalidNewsRow {
  line: number;
  reason: string;
  cells: string[];
}

export interface NewsGap {
  /** Two rows that normalize to the same instant + currency + event name. */
  line: number;
  instant: number;
  currency: string;
  event: string;
  kept: 'first' | 'last';
}

export interface NewsImportReport {
  fileName: string;
  /** Timezone the file's timestamps were interpreted in. */
  tz: string;
  totalLines: number;
  dataRows: number;
  accepted: number;
  rejected: number;
  /** Rows whose date or time could not be read. */
  badTime: number;
  /** Rows with no usable event name. */
  missingEvent: number;
  /** Rows where a numeric field was present but unparsable. */
  badNumbers: number;
  /** Rows where the impact label was not recognised. */
  unknownImpact: number;
  /** Rows carrying a date but no clock time (day-anchored). */
  noTime: number;
  duplicates: number;
  duplicatesKept: number;
  /** Events whose actual value is missing (no surprise computable). */
  withoutActual: number;
  /** Events whose forecast is missing (surprise falls back to previous). */
  withoutForecast: number;
  firstTime: number | null;
  lastTime: number | null;
  currencies: string[];
  impacts: Record<ImpactLabel, number>;
  columns: Partial<Record<NewsRole, number>>;
  header: string[];
  columnConfidence: number;
  notes: string[];
  invalid: InvalidNewsRow[];
  gaps: NewsGap[];
  durationMs: number;
}

export interface NewsFeed {
  id: string;
  label: string;
  fileName: string;
  bytes: number;
  /** Timezone the raw file was written in; drives instant reconstruction. */
  tz: string;
  createdAt: number;
  report: NewsImportReport;
  /** Ascending by instant. */
  events: EconEvent[];
}

/** Impact label from whatever the file used: digits, stars, words, colours. */
export function normalizeImpact(raw: string | null | undefined): ImpactLabel {
  if (raw === undefined || raw === null) return 'unknown';
  const s = String(raw).trim().toLowerCase();
  if (!s) return 'unknown';
  if (/^(none|n\/?a|no impact|low$|(info|informasi))/.test(s) && s.startsWith('none')) return 'none';
  if (/^(3|high|high impact|red|important|bull|\*\*\*|!{2,}|a)$/.test(s)) return 'high';
  if (/^(2|medium|med|orange|moderate|\*\*|!{1}|b)$/.test(s)) return 'medium';
  if (/^(1|low|yellow|minor|\*|c)$/.test(s)) return 'low';
  if (/^(0|no|grey|gray|non|none)$/.test(s)) return 'none';
  const digits = s.match(/\d+/);
  if (digits) {
    const n = Number(digits[0]);
    if (n >= 3) return 'high';
    if (n === 2) return 'medium';
    if (n === 1) return 'low';
    if (n === 0) return 'none';
  }
  if (s.includes('high')) return 'high';
  if (s.includes('med')) return 'medium';
  if (s.includes('low')) return 'low';
  return 'unknown';
}

/** Deterministic grouping key so history lookups are stable across imports. */
export function eventKeyFor(currency: string, event: string): string {
  const name = event
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  // Strip the trailing period token many vendors append ("Gdp Qoq" vs "Gdp").
  return `${currency.toUpperCase()}:${name}`;
}

/** Stable id: same content in, same id out, so re-imports do not shuffle selections. */
export function eventIdFor(e: Pick<EconEvent, 'instant' | 'currency' | 'eventKey' | 'line'>): string {
  const base = `${e.instant}|${e.currency}|${e.eventKey}|${e.line ?? 0}`;
  let h = 2166136261;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `ev_${(h >>> 0).toString(36)}`;
}
