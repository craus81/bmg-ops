import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQueryAll, getAccountBalancesFromRestlet } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reports/financials
 *
 * The executive P&L snapshot behind the Home → Financials tab: A/R aging,
 * A/P, cash + credit-card balances, and net position — all from NetSuite.
 *
 * Access is super_admin or executive ONLY (not regular admin) — matching the
 * `financials` feature in src/lib/features.ts. We can't use requireStaff here
 * because `executive` is a standalone role outside INTERNAL_STAFF_ROLES, so we
 * authorize explicitly after a plain authenticated+approved check.
 *
 * Sourcing:
 *  - A/R = open customer invoices, aged by due date (SuiteQL — the role can
 *    read invoices, so this reconciles to the A/R control account).
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

function rolesOf(profile: any): string[] {
  return profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
}

const DAY_MS = 86_400_000;

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function daysPastDue(due: string | null): number | null {
  if (!due) return null;
  const t = Date.parse(due);
  if (Number.isNaN(t)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((todayUtc - t) / DAY_MS);
}

function idList(raw: string | undefined): string[] {
  return (raw || '').split(',').map(s => s.trim()).filter(s => /^\d{1,18}$/.test(s));
}

async function loadFinancials(debug: boolean) {
  // ── A/R: open customer invoices, aged by due date ──────────────────────
  const arRows = await suiteqlQueryAll(`
    SELECT t.id, t.duedate, t.foreigntotal AS amount, c.companyname AS customer
    FROM transaction t
    LEFT JOIN customer c ON c.id = t.entity
    WHERE t.type = 'CustInvc' AND t.status = 'A'
  `);

  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  const overdue: { customer: string; amount: number; days: number }[] = [];
  let arTotal = 0;
  for (const r of arRows) {
    const amt = num(r.amount);
    arTotal += amt;
    const d = daysPastDue(r.duedate);
    if (d === null || d <= 0) { buckets.current += amt; continue; }
    if (d <= 30) buckets.d1_30 += amt;
    else if (d <= 60) buckets.d31_60 += amt;
    else if (d <= 90) buckets.d61_90 += amt;
    else buckets.d90plus += amt;
    overdue.push({ customer: r.customer || 'Unknown', amount: amt, days: d });
  }
  const pastDue = buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90plus;
  const topOverdue = overdue.sort((a, b) => b.amount - a.amount).slice(0, 6);

  // ── Cash / Card / A/P — account balances via the financials RESTlet ────
  const bankIds = idList(process.env.NETSUITE_BANK_ACCOUNT_IDS);
  const cardIds = idList(process.env.NETSUITE_CARD_ACCOUNT_ID);
  const apIds = idList(process.env.NETSUITE_AP_ACCOUNT_IDS);
  const allIds = [...new Set([...bankIds, ...cardIds, ...apIds])];

  const balResult = await getAccountBalancesFromRestlet(allIds);
  const balancesOk = balResult.success;
  const bals = balResult.balances || {};
  const bal = (id: string) => num(bals[id]?.balance);

  let cash: number | null = null;
  let cardOwed: number | null = null;
  let vendorBills: number | null = null;
  if (balancesOk) {
    // Assets read positive; liability "owed" is the magnitude (a card in
    // credit — negative — isn't a payable, so it's excluded).
    cash = bankIds.reduce((s, id) => s + bal(id), 0);
    cardOwed = cardIds.reduce((s, id) => { const owed = Math.abs(bal(id)); return s + (bal(id) > 0.005 ? owed : 0); }, 0);
    vendorBills = apIds.reduce((s, id) => s + Math.abs(bal(id)), 0);
  }

  const apTotal = balancesOk ? (vendorBills || 0) + (cardOwed || 0) : null;
  const net = balancesOk ? (cash || 0) + arTotal - (apTotal || 0) : null;

  return {
    ar: { total: arTotal, pastDue, openCount: arRows.length, buckets, topOverdue },
    ap: { vendorBills, cardOwed, total: apTotal },
    cash,
    net,
    config: {
      balancesOk,
      balancesError: balancesOk ? null : balResult.error || null,
      bankConfigured: bankIds.length > 0,
      cardConfigured: cardIds.length > 0,
      apConfigured: apIds.length > 0,
    },
    ...(debug ? { debug: { balances: bals, bankIds, cardIds, apIds } } : {}),
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const roles = rolesOf(auth.profile);
  if (!(roles.includes('super_admin') || roles.includes('executive'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const debug = req.nextUrl.searchParams.get('debug') === '1' && roles.includes('super_admin');

  try {
    const data = await loadFinancials(debug);
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
