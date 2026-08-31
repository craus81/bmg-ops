/**
 * The one company sales tax rate.
 *
 * Set in Settings -> Sales Tax by a super admin, stored on the singleton
 * `quote_settings` row (migration 245) and enforced there by a trigger. No
 * builder, API caller or AI tool call gets to pick its own rate: the estimate
 * builder shows this value read-only, and every server route that creates an
 * estimate reads it from here instead of trusting the request body.
 *
 * Units, because the two builders disagree and always have:
 *   - `quote_settings.sales_tax_rate_pct` and the wrap builder use a PERCENT
 *     (7.95 = 7.95%).
 *   - `estimates.tax_rate` and computeTotals() use a FRACTION (0.0795).
 * Convert with rateToPct/pctToRate rather than sprinkling *100 around.
 */

/**
 * Only reached when the settings row can't be read (a brand-new database, or
 * a transient error). Historically this exact number was hard-coded in the
 * estimate builder and three API routes -- keeping it as the fallback means a
 * failed read quotes the same rate it always did rather than 0% tax.
 */
export const FALLBACK_SALES_TAX_RATE = 0.0795;
export const FALLBACK_SALES_TAX_RATE_PCT = 7.95;

/**
 * null/undefined/'' are MISSING, not zero -- `Number(null)` is 0, and a
 * silent 0 here would quote a customer no sales tax at all.
 */
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function pctToRate(pct: unknown): number {
  const n = toNumber(pct);
  return n === null ? FALLBACK_SALES_TAX_RATE : n / 100;
}

export function rateToPct(rate: unknown): number {
  const n = toNumber(rate);
  return n === null ? FALLBACK_SALES_TAX_RATE_PCT : n * 100;
}

/** Format a FRACTION rate the way the builders and documents show it. */
export function formatTaxRate(rate: unknown): string {
  return `${rateToPct(rate).toFixed(2)}%`;
}

type AnySupabase = {
  from: (table: string) => any;
};

/**
 * Read the configured rate as a PERCENT. Works with any Supabase client
 * (service-role, server, or browser) -- `quote_settings` is readable by all
 * internal staff.
 */
export async function getSalesTaxRatePct(supabase: AnySupabase): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('quote_settings')
      .select('sales_tax_rate_pct')
      .eq('id', 1)
      .maybeSingle();
    if (error) return FALLBACK_SALES_TAX_RATE_PCT;
    const n = toNumber(data?.sales_tax_rate_pct);
    return n === null ? FALLBACK_SALES_TAX_RATE_PCT : n;
  } catch {
    return FALLBACK_SALES_TAX_RATE_PCT;
  }
}

/** Read the configured rate as a FRACTION (what `estimates.tax_rate` stores). */
export async function getSalesTaxRate(supabase: AnySupabase): Promise<number> {
  return pctToRate(await getSalesTaxRatePct(supabase));
}
