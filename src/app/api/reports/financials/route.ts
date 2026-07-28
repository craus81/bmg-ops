import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { fetchOpenArInvoices, computeArAging, fetchAccountGroups } from '@/lib/financials-data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reports/financials
 *
 * The executive P&L snapshot behind the Home → Financials tab: A/R aging,
 * A/P, cash + credit-card balances, and net position — all from NetSuite.
 * The transaction lists behind each number live in the sibling routes
 * (./ar-invoices, ./ap-bills, ./accounts, ./invoice-pdf) and share the same
 * data helpers (src/lib/financials-data.ts) so the drill-downs always
 * reconcile with these tiles.
 *
 * Access is super_admin or executive ONLY (not regular admin) — matching the
 * `financials` feature in src/lib/features.ts (requireFinancials).
 *
 * Sourcing:
 *  - A/R = open customer invoices, aged by due date (SuiteQL — the role can
 *    read invoices, so this reconciles to the A/R control account). Aged by
 *    open balance when foreignamountunpaid is available, else invoice total.
 *  - Cash / Card / A/P = GL account balances from the financials RESTlet
 *    (scripts/netsuite-financials-restlet.js), keyed by internal ID in env
 *    (NETSUITE_BANK_ACCOUNT_IDS / NETSUITE_CARD_ACCOUNT_ID /
 *    NETSUITE_AP_ACCOUNT_IDS). SuiteQL can't produce these for the integration
 *    role — it can't see bill payments / card charges / the account table, so
 *    summing transaction lines never matches the Chart of Accounts. The RESTlet
 *    runs an account search under its own role and returns the CoA balance.
 *    Until it's deployed, the balance tiles report "unavailable" rather than a
 *    wrong number; A/R is unaffected.
 */

async function loadFinancials(debug: boolean) {
  // ── A/R: open customer invoices, aged by due date ──────────────────────
  const { invoices } = await fetchOpenArInvoices();
  const aging = computeArAging(invoices);

  // ── Cash / Card / A/P — account balances via the financials RESTlet ────
  const acct = await fetchAccountGroups();
  const balancesOk = acct.success;

  let cash: number | null = null;
  let cardOwed: number | null = null;
  let vendorBills: number | null = null;
  if (balancesOk) {
    // Assets read positive; liability "owed" is the magnitude (a card in
    // credit — negative — isn't a payable, so it's excluded).
    cash = acct.bank.reduce((s, a) => s + (a.balance || 0), 0);
    cardOwed = acct.card.reduce((s, a) => s + ((a.balance || 0) > 0.005 ? Math.abs(a.balance || 0) : 0), 0);
    vendorBills = acct.ap.reduce((s, a) => s + Math.abs(a.balance || 0), 0);
  }

  const apTotal = balancesOk ? (vendorBills || 0) + (cardOwed || 0) : null;
  const net = balancesOk ? (cash || 0) + aging.total - (apTotal || 0) : null;

  return {
    ar: {
      total: aging.total,
      pastDue: aging.pastDue,
      openCount: aging.openCount,
      buckets: aging.buckets,
      topOverdue: aging.topOverdue,
    },
    ap: { vendorBills, cardOwed, total: apTotal },
    cash,
    net,
    config: {
      balancesOk,
      balancesError: balancesOk ? null : acct.error || null,
      bankConfigured: acct.bank.length > 0,
      cardConfigured: acct.card.length > 0,
      apConfigured: acct.ap.length > 0,
    },
    ...(debug ? { debug: { accounts: acct } } : {}),
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const roles: string[] = auth.profile?.roles?.length ? auth.profile.roles : [auth.profile?.role];
  const debug = req.nextUrl.searchParams.get('debug') === '1' && roles.includes('super_admin');

  try {
    const data = await loadFinancials(debug);
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
