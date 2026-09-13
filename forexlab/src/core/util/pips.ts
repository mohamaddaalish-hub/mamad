/**
 * Pip arithmetic. One place, used by drawings, the trade ledger and news reaction
 * measurement, so "pip" never means two different things in the same app.
 *
 * A pip is the 4th decimal for 5-digit quotes (EUR/USD 1.08530 → 0.0001) and the
 * 2nd decimal for JPY-style quotes (152.345 → 0.01). Index/CFX-style instruments
 * have no pip convention, so callers pass a tick size instead.
 */

/**
 * Explicit mapping: quote precision implies the pip size.
 * 5 or 3 decimals → last digit is a point, one pip = 10 points.
 * 3 decimals on JPY pairs (152.345) also means 0.01.
 */
export function pipSizeFromDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return 0.0001;
  if (decimals >= 5) return 0.0001;
  if (decimals === 4) return 0.001;
  if (decimals === 3) return 0.01;
  if (decimals === 2) return 0.01;
  if (decimals === 1) return 0.1;
  return 1;
}

export function priceToPips(delta: number, decimals: number): number {
  const pip = pipSizeFromDecimals(decimals);
  return delta / pip;
}

export function pipsToPrice(pips: number, decimals: number): number {
  return pips * pipSizeFromDecimals(decimals);
}

export function formatPips(pips: number, decimals = 1): string {
  if (!Number.isFinite(pips)) return '—';
  const sign = pips > 0 ? '+' : pips < 0 ? '−' : '';
  return `${sign}${Math.abs(pips).toFixed(decimals)}`;
}

export function formatPrice(price: number, decimals: number): string {
  if (!Number.isFinite(price)) return '—';
  return price.toFixed(Math.max(0, Math.min(8, decimals)));
}
