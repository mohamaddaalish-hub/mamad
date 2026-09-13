/**
 * Account and cost model for manual backtesting.
 *
 * Deliberately small and explicit: the ledger knows nothing about brokers. Every
 * cost that will be charged to a result is configured here, and anything the model
 * cannot compute honestly (e.g. converting quote-currency P&L into an account
 * currency the app has no rate for) is reported as needing conversion instead of
 * being invented.
 */

import { pipSizeFromDecimals } from '../util/pips.ts';

/**
 * What to do when one bar's range covers both the stop and the target. The true
 * intra-bar order is unknowable from OHLC, so the default is the pessimistic
 * reading; the optimistic one must be chosen on purpose and is always labelled.
 */
export type AmbiguityPolicy = 'adverse' | 'favorable' | 'first-touch-close';

export interface AccountSettings {
  /** Account currency label. P&L is computed in the instrument's quote currency. */
  currency: string;
  startingBalance: number;
  /** Percent of equity risked per trade when sizing mode is 'risk'. */
  riskPerTradePct: number;
  sizing: 'fixed' | 'risk';
  /** Base-currency units when sizing === 'fixed'. */
  fixedSize: number;
  /** Full round-trip spread in pips, charged once per closed trade. */
  spreadPips: number;
  /** Commission per side, in account currency. */
  commissionPerSide: number;
  /** Adverse fill deviation applied to each side, in pips. */
  slippagePips: number;
  ambiguityPolicy: AmbiguityPolicy;
  /** Label shown on the ledger; the timeframe a trade was recorded on. */
  /** Quote decimals, from the imported file — defines the pip size. */
  decimals: number;
}

export const DEFAULT_ACCOUNT: AccountSettings = {
  currency: 'USD',
  startingBalance: 10_000,
  riskPerTradePct: 1,
  sizing: 'risk',
  fixedSize: 10_000,
  spreadPips: 0.6,
  commissionPerSide: 0,
  slippagePips: 0.1,
  ambiguityPolicy: 'adverse',
  decimals: 5,
};

export const AMBIGUITY_POLICIES: { value: AmbiguityPolicy; label: string; detail: string }[] = [
  {
    value: 'adverse',
    label: 'Adverse (default)',
    detail: 'A bar that reaches both stop and target is counted as the stop. Pessimistic, so results are never flattered by an unknown path.',
  },
  {
    value: 'favorable',
    label: 'Favorable',
    detail: 'A bar that reaches both is counted as the target. Optimistic — every number tagged with this policy must be read as an upper bound.',
  },
  {
    value: 'first-touch-close',
    label: 'Resolve on the close',
    detail: 'Neither level is honoured inside an ambiguous bar: the position is exited at that bar\u0027s close instead, which is the only price in the bar with a known relation to the path.',
  },
];

export const PIP_SIZE = (decimals: number): number => pipSizeFromDecimals(decimals);

/** Price of one pip, used to turn pips into money for a given size. */
export function pipValuePerUnit(account: Pick<AccountSettings, 'decimals'>): number {
  return pipSizeFromDecimals(account.decimals);
}

export interface SizingResult {
  size: number;
  /** Money at risk, in the quote currency (equals account currency only when they match). */
  riskAmount: number;
  derived: boolean;
  problem: string | null;
}

/**
 * Units to trade. 'risk' mode derives size from the stop distance so the manual
 * workflow matches how the trades are actually recorded; it is only honest when a
 * stop is present, otherwise the fixed size is used and the panel says so.
 */
export function sizeFor(entry: number, stop: number | null, account: AccountSettings, equity: number): SizingResult {
  const riskPerUnit = Math.abs(entry - (stop ?? NaN));
  if (account.sizing === 'risk' && stop !== null && Number.isFinite(riskPerUnit) && riskPerUnit > 0) {
    const riskMoney = (equity > 0 ? equity : account.startingBalance) * (account.riskPerTradePct / 100);
    const size = riskMoney / riskPerUnit;
    if (!Number.isFinite(size) || size <= 0) {
      return { size: account.fixedSize, riskAmount: 0, derived: false, problem: 'Risk sizing produced no valid size — using the fixed size' };
    }
    return { size, riskAmount: riskMoney, derived: true, problem: null };
  }
  const size = Math.max(0, account.fixedSize);
  const riskAmount = stop !== null && Number.isFinite(riskPerUnit) ? size * riskPerUnit : 0;
  return {
    size,
    riskAmount,
    derived: false,
    problem:
      account.sizing === 'risk'
        ? stop === null
          ? 'No stop loss — risk sizing falls back to the fixed size'
          : null
        : null,
  };
}

export interface AccountCheck {
  ok: boolean;
  problems: string[];
}

export function validateAccount(a: AccountSettings): AccountCheck {
  const problems: string[] = [];
  if (!(a.startingBalance > 0)) problems.push('Starting balance must be greater than zero');
  if (a.riskPerTradePct < 0 || a.riskPerTradePct > 100) problems.push('Risk per trade must be between 0 and 100 percent');
  if (a.sizing === 'fixed' && !(a.fixedSize > 0)) problems.push('Fixed size must be greater than zero');
  if (a.spreadPips < 0) problems.push('Spread cannot be negative');
  if (a.slippagePips < 0) problems.push('Slippage cannot be negative');
  if (a.commissionPerSide < 0) problems.push('Commission cannot be negative');
  return { ok: problems.length === 0, problems };
}

/**
 * P&L is expressed in the instrument's quote currency. Converting to another
 * account currency would need an FX rate the app does not have by design, so it
 * is flagged instead of guessed.
 */
export function needsConversion(quoteCcy: string, accountCcy: string): boolean {
  const norm = (s: string): string => (s || '').toUpperCase().replace(/[^A-Z]/g, '');
  const q = norm(quoteCcy);
  const a = norm(accountCcy);
  if (!q || !a) return false;
  return q !== a;
}

/** Quote currency implied by a symbol label such as EURUSD or EUR/USD. */
export function quoteCurrency(symbol: string): string {
  const clean = (symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  return clean.length >= 6 ? clean.slice(3, 6) : '';
}

export function describeCosts(a: AccountSettings): string {
  return `spread ${a.spreadPips} pips per round trip · slippage ${a.slippagePips} pips per side · commission ${a.commissionPerSide} ${a.currency} per side`;
}
