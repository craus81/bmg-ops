import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';

/**
 * At-risk customer detection over the NetSuite-synced spend columns on
 * `customers`. "Spent real money last year, has gone quiet this year" —
 * the signal was already in the database; nothing surfaced it.
 *
 * Rule (kept explainable on purpose):
 *   - meaningful account:  last_year_spend >= minLastYearSpend
 *   - gone quiet:          no order in >= quietDays (or never ordered)
 *   - behind pace:         ytd_spend under half of last year's pace for
 *                          this point in the calendar year
 * Severity: 'critical' when YTD is zero or under 20% of pace.
 */

export interface AtRiskCustomer {
  id: string;
  netsuite_id: string;
  company_name: string;
  entity_id: string | null;
  last_year_spend: number;
  ytd_spend: number;
  total_spend: number;
  last_order_date: string | null;
  days_quiet: number | null;
  /** ytd_spend / (last_year_spend * fraction-of-year-elapsed); 1.0 = on pace. */
  pace: number;
  severity: 'critical' | 'watch';
  account_owner_id: string | null;
  internal_notes: string | null;
  at_risk_dismissed_at: string | null;
}

export interface AtRiskOptions {
  minLastYearSpend?: number;
  quietDays?: number;
  /** Include manually dismissed accounts (the report page's toggle);
   *  the cron and dashboard use the default and never see them. */
  includeDismissed?: boolean;
}

export const AT_RISK_DEFAULTS = { minLastYearSpend: 10_000, quietDays: 60, includeDismissed: false };

export async function evaluateAtRiskCustomers(
  service: SupabaseClient<any, any, any>,
  opts: AtRiskOptions = {},
): Promise<{ flagged: AtRiskCustomer[]; scanned: number; options: Required<AtRiskOptions> }> {
  const options = { ...AT_RISK_DEFAULTS, ...opts };
  // Paginated (R3-1 MAJOR sweep): an unbounded read capped at 1000 rows,
  // so customers past the cap were never evaluated and `scanned` lied.
  const { data: rows } = await fetchAllRows<any>((from, to) =>
    service
      .from('customers')
      .select('id, netsuite_id, company_name, entity_id, last_year_spend, ytd_spend, total_spend, last_order_date, account_owner_id, internal_notes, at_risk_dismissed_at')
      .gte('last_year_spend', options.minLastYearSpend)
      .eq('active', true)
      .order('id')
      .range(from, to));

  const now = Date.now();
  const startOfYear = new Date(new Date().getFullYear(), 0, 1).getTime();
  // Fraction of the calendar year elapsed — floor of ~1 month so the pace
  // test doesn't divide by near-zero in the first days of January.
  const yearFraction = Math.max((now - startOfYear) / (365 * 86_400_000), 1 / 12);

  const flagged: AtRiskCustomer[] = [];
  for (const c of rows || []) {
    if (!options.includeDismissed && c.at_risk_dismissed_at) continue;
    const lastYear = Number(c.last_year_spend) || 0;
    const ytd = Number(c.ytd_spend) || 0;
    const daysQuiet = c.last_order_date
      ? Math.floor((now - new Date(c.last_order_date).getTime()) / 86_400_000)
      : null;
    const quiet = daysQuiet == null || daysQuiet >= options.quietDays;
    const expected = lastYear * yearFraction;
    const pace = expected > 0 ? ytd / expected : 1;
    if (quiet && pace < 0.5) {
      flagged.push({
        id: c.id,
        netsuite_id: c.netsuite_id,
        company_name: c.company_name,
        entity_id: c.entity_id ?? null,
        last_year_spend: lastYear,
        ytd_spend: ytd,
        total_spend: Number(c.total_spend) || 0,
        last_order_date: c.last_order_date ?? null,
        days_quiet: daysQuiet,
        pace,
        severity: ytd === 0 || pace < 0.2 ? 'critical' : 'watch',
        account_owner_id: c.account_owner_id ?? null,
        internal_notes: c.internal_notes ?? null,
        at_risk_dismissed_at: c.at_risk_dismissed_at ?? null,
      });
    }
  }
  flagged.sort((a, b) => b.last_year_spend - a.last_year_spend);
  return { flagged, scanned: (rows || []).length, options };
}
