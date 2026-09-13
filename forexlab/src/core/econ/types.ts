/**
 * Economic-news domain types.
 *
 * Every numeric field that may be missing is `number | null` — the importer never
 * fabricates a value, and every derived metric that cannot be computed is an
 * explicit `Unavailable` rather than a zero. Timestamps are epoch ms UTC.
 */

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const IMPACTS = ['critical', 'veryHigh', 'high', 'medium', 'low'] as const;
export type Impact = (typeof IMPACTS)[number];
export const IMPACT_LABEL: Record<Impact, string> = {
  critical: 'Critical',
  veryHigh: 'Very High',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
/** Calendar importance as a 0..1 weight (metadata only — never market impact). */
export const IMPACT_WEIGHT: Record<Impact, number> = { critical: 1, veryHigh: 0.85, high: 0.7, medium: 0.4, low: 0.15 };

export const CATEGORIES = [
  'Inflation',
  'Employment',
  'Growth',
  'Monetary Policy',
  'Central Bank',
  'Manufacturing',
  'Services',
  'Consumer',
  'Housing',
  'Trade',
  'Government',
  'Sentiment',
  'Other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SESSIONS = ['asia', 'london', 'newYork', 'overlap', 'off'] as const;
export type Session = (typeof SESSIONS)[number];
export const SESSION_LABEL: Record<Session, string> = {
  asia: 'Asia',
  london: 'London',
  newYork: 'New York',
  overlap: 'London/NY overlap',
  off: 'Off-session',
};

export const SURPRISE_BANDS = [
  'extremeNegative',
  'strongNegative',
  'moderateNegative',
  'neutral',
  'moderatePositive',
  'strongPositive',
  'extremePositive',
] as const;
export type SurpriseBand = (typeof SURPRISE_BANDS)[number];
export const SURPRISE_BAND_LABEL: Record<SurpriseBand, string> = {
  extremeNegative: 'Extreme Negative',
  strongNegative: 'Strong Negative',
  moderateNegative: 'Moderate Negative',
  neutral: 'Neutral',
  moderatePositive: 'Moderate Positive',
  strongPositive: 'Strong Positive',
  extremePositive: 'Extreme Positive',
};

/** Standardized-surprise sigma buckets used by filters. */
export const SIGMA_BUCKETS = ['ltNeg2', 'neg2to1', 'neg1toHalf', 'neutral', 'half1', 'pos1to2', 'gtPos2'] as const;
export type SigmaBucket = (typeof SIGMA_BUCKETS)[number];
export const SIGMA_BUCKET_LABEL: Record<SigmaBucket, string> = {
  ltNeg2: '< −2σ',
  neg2to1: '−2σ to −1σ',
  neg1toHalf: '−1σ to −0.5σ',
  neutral: '−0.5σ to +0.5σ',
  half1: '+0.5σ to +1σ',
  pos1to2: '+1σ to +2σ',
  gtPos2: '> +2σ',
};

export const REVISION_KINDS = ['none', 'positive', 'negative', 'large'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];
export const REVISION_LABEL: Record<RevisionKind, string> = {
  none: 'No Revision',
  positive: 'Positive Revision',
  negative: 'Negative Revision',
  large: 'Large Revision',
};

export const VOL_REGIMES = ['low', 'normal', 'high'] as const;
export type VolRegime = (typeof VOL_REGIMES)[number];

export const ISOLATIONS = ['isolated', 'clustered', 'overlapping'] as const;
export type Isolation = (typeof ISOLATIONS)[number];

export const TRENDS = ['bullish', 'bearish', 'range', 'unknown'] as const;
export type Trend = (typeof TRENDS)[number];

export const PATTERNS = ['continuation', 'reversal', 'spikeFade', 'noReaction', 'delayed', 'unavailable'] as const;
export type ReactionPattern = (typeof PATTERNS)[number];
export const PATTERN_LABEL: Record<ReactionPattern, string> = {
  continuation: 'Continuation',
  reversal: 'Reversal',
  spikeFade: 'Spike & Fade',
  noReaction: 'No Reaction',
  delayed: 'Delayed Reaction',
  unavailable: 'Unavailable',
};

/** Explicit "cannot be computed" state with a machine-readable reason. */
export interface Unavailable {
  status: 'unavailable';
  reason: string;
}
export type Maybe<T> = { status: 'ok'; value: T } | Unavailable;

export function ok<T>(value: T): Maybe<T> {
  return { status: 'ok', value };
}
export function unavailable(reason: string): Unavailable {
  return { status: 'unavailable', reason };
}
export function isOk<T>(m: Maybe<T> | null | undefined): m is { status: 'ok'; value: T } {
  return !!m && m.status === 'ok';
}
export function valueOr<T>(m: Maybe<T> | null | undefined, fallback: T): T {
  return isOk(m) ? m.value : fallback;
}

/** One release of an indicator, exactly as imported (plus normalised keys). */
export interface EconEvent {
  id: string;
  /** Release instant, epoch ms UTC. */
  time: number;
  currency: Currency | string;
  country: string | null;
  impact: Impact | null;
  /** Human title as imported, e.g. "Consumer Price Index (YoY)". */
  event: string;
  /** Normalised indicator key: same indicator across releases shares a key. */
  key: string;
  /** Short event-type tag (CPI, NFP, GDP, PMI, FOMC ...) inferred from the title. */
  type: string;
  category: Category;
  subcategory: string | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  /** Stated in the file. `null` when the column is absent or empty. */
  revisedPrevious: number | null;
  /** Row number in the source file (1-based, header excluded), for diagnostics. */
  row: number;
  /** Unit hint from the raw cells (%, K, M, B) — display only. */
  unit: string | null;
  /** Import batch this event belongs to. */
  batchId: string;
}

/** Reaction horizons in ms. Negative = pre-release context, positive = post-release. */
export const PRE_HORIZONS_MIN = [-5, -15, -30, -60, -240, -1440] as const;
export const POST_HORIZONS_MIN = [1, 5, 15, 30, 60, 240, 1440] as const;
export const CURVE_HORIZONS_MIN = [-30, -15, -5, 0, 1, 5, 15, 30, 60, 240, 1440] as const;
export type PostHorizon = (typeof POST_HORIZONS_MIN)[number];

export function horizonLabel(min: number): string {
  const a = Math.abs(min);
  const s = a >= 1440 ? `${a / 1440}D` : a >= 60 ? `${a / 60}H` : `${a}m`;
  return min < 0 ? `−${s}` : min > 0 ? `+${s}` : '0';
}

export const MINUTE = 60_000;
