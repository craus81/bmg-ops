import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQueryAll, suiteqlQuery } from '@/lib/netsuite';
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
 *  - A/R = open customer invoices, aged by due date.
 *  - Cash / Card / A/P = GL account balances, summed straight from
 *    transactionaccountingline for specific account internal IDs (set in env):
 *      NETSUITE_BANK_ACCOUNT_IDS  → cash (asset)
 *      NETSUITE_CARD_ACCOUNT_ID   → credit cards (liability)
 *      NETSUITE_AP_ACCOUNT_IDS    → A/P control account (liability)
 *    The `account` table is NOT queryable by the integration role in this
 *    NetSuite instance ("Record 'account' was not found"), so accounts can't
 *    be auto-discovered by type — they're addressed by internal ID. We also
 *    deliberately do NOT join `transaction`: an inner join there drops posting
 *    lines whose transaction the role can't read, which undercounts balances.
 *  GL sign is debit-positive / credit-negative, so Bank sums positive and the
 *  liabilities sum negative — negated to a positive "owed".
 *
 * ?debug=1 (super_admin) returns the raw per-account balances for reconciling
 * against the Chart of Accounts.
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

// GL balance per account, straight from the accounting lines (no `account`
// or `transaction` join — both are restricted / lossy for this role).
async function accountBalances(ids: string[]): Promise<Record<string, number> | null> {
  if (ids.length === 0) return {};
  try {
    const rows = (await suiteqlQuery(`
      SELECT tal.account AS id, SUM(tal.amount) AS bal
      FROM transactionaccountingline tal
      WHERE tal.posting = 'T' AND tal.account IN (${ids.join(',')})
      GROUP BY tal.account
    `))?.items || [];
    const out: Record<string, number> = {};
    for (const id of ids) out[id] = 0; // accounts with no posted lines → 0
    for (const r of rows) out[String(r.id)] = num(r.bal);
    return out;
  } catch {
    return null; // balances unavailable → A/R still renders
  }
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

  // ── GL account balances (cash, cards, A/P) by internal ID ──────────────
  const bankIds = idList(process.env.NETSUITE_BANK_ACCOUNT_IDS);
  const cardIds = idList(process.env.NETSUITE_CARD_ACCOUNT_ID);
  const apIds = idList(process.env.NETSUITE_AP_ACCOUNT_IDS);
  const bals = await accountBalances([...new Set([...bankIds, ...cardIds, ...apIds])]);
  const balancesOk = bals !== null;
  const b = bals || {};

  let cash = 0;
  for (const id of bankIds) cash += b[id] || 0; // asset: debit-normal, positive
  let cardOwed = 0;
  for (const id of cardIds) { const owed = -(b[id] || 0); if (owed > 0.005) cardOwed += owed; }
  let vendorBills = 0;
  for (const id of apIds) vendorBills += -(b[id] || 0); // liability → positive owed

  const apTotal = vendorBills + cardOwed;
  const net = cash + arTotal - apTotal;

  return {
    ar: { total: arTotal, pastDue, openCount: arRows.length, buckets, topOverdue },
    ap: { vendorBills, cardOwed, total: apTotal },
    cash,
    net,
    config: {
      balancesOk,
      bankConfigured: bankIds.length > 0,
      cardConfigured: cardIds.length > 0,
      apConfigured: apIds.length > 0,
    },
    ...(debug ? { debug: { balances: b, bankIds, cardIds, apIds } } : {}),
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
