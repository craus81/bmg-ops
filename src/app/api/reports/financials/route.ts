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
 * Sourcing notes (verify against the live NetSuite instance):
 *  - A/R: open customer invoices (CustInvc, status 'A' = Open in this install),
 *    aged by due date. Amount uses foreigntotal — proven by the existing
 *    invoice queries. Partial payments would need amountremaining to be exact.
 *  - A/P: open vendor bills (VendBill, status 'A'). The VendBill open-status
 *    key mirrors CustInvc; if it differs, the total simply comes back empty
 *    rather than erroring.
 *  - Cash + card balances come from GL account registers, keyed by internal
 *    IDs in env (NETSUITE_BANK_ACCOUNT_IDS, NETSUITE_CARD_ACCOUNT_ID). Until
 *    those are set the two tiles report "unmapped" instead of a wrong number.
 */

function rolesOf(profile: any): string[] {
  return profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
}

const DAY_MS = 86_400_000;

// Days a due date is past today (negative / null → not yet due).
function daysPastDue(due: string | null): number | null {
  if (!due) return null;
  const t = Date.parse(due);
  if (Number.isNaN(t)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((todayUtc - t) / DAY_MS);
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Sum the posted GL balance of one or more accounts. Best-effort: a bad id or
// a query the integration role can't run returns null, never throws.
async function accountBalance(ids: string[]): Promise<number | null> {
  const clean = ids.map(s => s.trim()).filter(s => /^\d{1,18}$/.test(s));
  if (clean.length === 0) return null;
  try {
    const q = `
      SELECT SUM(tal.amount) AS bal
      FROM transactionaccountingline tal
      JOIN transaction t ON t.id = tal.transaction
      WHERE tal.posting = 'T' AND tal.account IN (${clean.join(',')})
    `;
    const res = await suiteqlQuery(q);
    const row = res?.items?.[0];
    if (!row) return 0;
    return num(row.bal);
  } catch {
    return null;
  }
}

async function loadFinancials() {
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

  // ── A/P: open vendor bills ─────────────────────────────────────────────
  let vendorBills = 0, apCount = 0, apDueThisWeek = 0, apOverdue = 0;
  try {
    const apRows = await suiteqlQueryAll(`
      SELECT t.id, t.duedate, t.foreigntotal AS amount
      FROM transaction t
      WHERE t.type = 'VendBill' AND t.status = 'A'
    `);
    for (const r of apRows) {
      const amt = num(r.amount);
      vendorBills += amt;
      apCount += 1;
      const d = daysPastDue(r.duedate);
      if (d !== null && d > 0) apOverdue += amt;
      else if (d !== null && d >= -7) apDueThisWeek += amt;
    }
  } catch {
    vendorBills = 0; // status key differs → leave empty, don't fail the page
  }

  // ── Cash + credit card (GL account registers, keyed by env) ────────────
  const bankIds = (process.env.NETSUITE_BANK_ACCOUNT_IDS || '').split(',').filter(Boolean);
  const cardIds = (process.env.NETSUITE_CARD_ACCOUNT_ID || '').split(',').filter(Boolean);
  const cash = await accountBalance(bankIds);
  const cardRaw = await accountBalance(cardIds);
  // Card is a liability (credit-normal) — what we owe is the magnitude.
  const cardOwed = cardRaw === null ? null : Math.abs(cardRaw);

  const apTotal = vendorBills + (cardOwed ?? 0);
  const net = (cash ?? 0) + arTotal - apTotal;

  return {
    ar: {
      total: arTotal,
      pastDue,
      openCount: arRows.length,
      buckets,
      topOverdue,
    },
    ap: {
      vendorBills,
      cardOwed,
      total: apTotal,
      openCount: apCount,
      dueThisWeek: apDueThisWeek,
      overdue: apOverdue,
    },
    cash,
    net,
    config: {
      cashMapped: cash !== null,
      cardMapped: cardOwed !== null,
    },
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const roles = rolesOf(auth.profile);
  if (!(roles.includes('super_admin') || roles.includes('executive'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const data = await loadFinancials();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
