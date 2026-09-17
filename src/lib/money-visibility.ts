/**
 * Who may see money.
 *
 * Owner decision (2026-09-17): what a customer was charged, what we paid,
 * and what we make on a job are none of the shop floor's business. A
 * designer and a print tech need the work, the dates and the artwork; an
 * installer needs the vehicle. Prices in front of people who don't quote
 * them invite guesses in front of customers.
 *
 * FIVE ROLES KEEP IT, and each one has to:
 *   admin / super_admin — run the place.
 *   sales              — quote it, so they set the number.
 *   finance            — AP and bookkeeping IS money; its whole feature set
 *                        is vendor payments, the ledger and credit apps.
 *   executive          — the P&L view exists for this role alone.
 *
 * WHAT THIS DOESN'T COVER — say it plainly rather than imply a wall:
 *   * Someone's OWN pay stays visible to them. What you earned is not what
 *     the customer was billed, and hiding a tech's own wages from them
 *     generates payroll questions rather than removing them.
 *   * A part's PRICE stays where ordering needs it. Shop techs hold
 *     `parts_ordering` precisely so they can raise a request from a short-
 *     readiness card; blinding that buys nothing and costs good decisions.
 *     Our COST, margin and spend totals are money and are hidden.
 *   * This is a UI and API rule, not a database one. graphics_jobs,
 *     estimates and friends are readable by any approved staff login under
 *     current RLS (migration 247 and kin), so an amount can still be read
 *     out of a network response by someone who goes looking. Closing that
 *     needs column-level policies or views — a bigger, separate job. Treat
 *     this as "not shown", not "cannot be obtained".
 *
 * Pure and client-safe, like features.ts, so the same predicate answers on
 * the server (route guards) and in the browser (what renders).
 */

/** Roles that see customer money, cost and margin. */
export const MONEY_ROLES: readonly string[] = ['admin', 'super_admin', 'sales', 'finance', 'executive'];

/**
 * May these roles see money? Takes the SAME effective-role array the feature
 * gates take, so "View As" narrows money exactly as it narrows everything
 * else — an admin checking what a print tech sees must see what they see.
 */
export function canSeeMoney(roles: readonly string[] | null | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some(r => MONEY_ROLES.includes(r));
}

/** Placeholder shown where an amount would be. Deliberately not "$0.00". */
export const MONEY_HIDDEN = '—';

/**
 * Format an amount, or the placeholder when this viewer may not see it.
 * Call sites read `money(total, canSeeMoney)` so the gate is impossible to
 * forget halfway through a template literal.
 */
export function formatMoney(
  amount: number | string | null | undefined,
  visible: boolean,
  opts?: { cents?: boolean },
): string {
  if (!visible) return MONEY_HIDDEN;
  // null/undefined/'' are "no amount", not zero — Number(null) is 0, and a
  // missing total rendered as "$0.00" reads as "this job is free".
  if (amount === null || amount === undefined || amount === '') return MONEY_HIDDEN;
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return MONEY_HIDDEN;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts?.cents === false ? 0 : 2,
    maximumFractionDigits: opts?.cents === false ? 0 : 2,
  });
}
