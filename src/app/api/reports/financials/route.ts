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
 * Sourcing — balances come straight off the GL accounts (the same numbers the
 * Chart of Accounts shows), discovered by account TYPE so nothing has to be
 * mapped by hand:
 *  - Cash  = sum of Bank account balances.
 *  - Card  = sum of Credit Card balances we owe on.
 *  - A/P   = the Accounts Payable control account balance (unpaid vendor bills)
 *            — summing individual open bills is unreliable (partial payments,
 *            unapplied credits); the control account is the truth.
 *  - A/R   = open customer invoices, aged by due date (the aging split needs
 *            invoice-level data; the total ties to the A/R control account).
 * GL sign convention is debit-positive / credit-negative, so asset balances
 * (Bank) come back positive and liability balances (Credit Card, A/P) come
 * back negative — we negate the latter to a positive "owed".
 *
 * ?debug=1 (super_admin) returns the raw per-account balances so the numbers
 * can be reconciled against the Chart of Accounts.
 */

function rolesOf(profile: any): string[] {
  return profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
}

const DAY_MS = 86_400_000;

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Days a due date is past today (negative / null → not yet due).
function daysPastDue(due: string | null): number | null {
  if (!due) return null;
  const t = Date.parse(due);
  if (Number.isNaN(t)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((todayUtc - t) / DAY_MS);
}

// Optional allowlist of account internal IDs from an env var ("1,2,3").
function idSet(raw: string | undefined): Set<string> | null {
  const ids = (raw || '').split(',').map(s => s.trim()).filter(s => /^\d{1,18}$/.test(s));
  return ids.length ? new Set(ids) : null;
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

  // ── GL account balances (cash, cards, A/P) by account type ─────────────
  const balRows = (await suiteqlQuery(`
    SELECT a.id, a.accttype, a.acctname, SUM(tal.amount) AS bal
    FROM account a
    JOIN transactionaccountingline tal ON tal.account = a.id
    WHERE tal.posting = 'T'
      AND a.isinactive = 'F'
      AND a.accttype IN ('Bank', 'CreditCard', 'AcctPay')
    GROUP BY a.id, a.accttype, a.acctname
  `))?.items || [];

  // Optional env allowlists to narrow which bank / card accounts count.
  const bankFilter = idSet(process.env.NETSUITE_BANK_ACCOUNT_IDS);
  const cardFilter = idSet(process.env.NETSUITE_CARD_ACCOUNT_ID);

  let cash = 0, cardOwed = 0, vendorBills = 0;
  const cards: { id: string; name: string; owed: number }[] = [];
  const debugRows: any[] = [];
  for (const r of balRows) {
    const id = String(r.id);
    const bal = num(r.bal);
    if (debug) debugRows.push({ id, type: r.accttype, name: r.acctname, rawBal: bal });
    if (r.accttype === 'Bank') {
      if (bankFilter && !bankFilter.has(id)) continue;
      cash += bal; // asset: debit-normal, already positive
    } else if (r.accttype === 'CreditCard') {
      if (cardFilter && !cardFilter.has(id)) continue;
      const owed = -bal; // liability: credit-normal → negate to owed
      if (owed > 0.005) { cardOwed += owed; cards.push({ id, name: r.acctname, owed }); }
    } else if (r.accttype === 'AcctPay') {
      vendorBills += -bal; // liability → positive owed
    }
  }

  const apTotal = vendorBills + cardOwed;
  const net = cash + arTotal - apTotal;

  return {
    ar: { total: arTotal, pastDue, openCount: arRows.length, buckets, topOverdue },
    ap: { vendorBills, cardOwed, total: apTotal, cards },
    cash,
    net,
    ...(debug ? { debug: debugRows.sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id)) } : {}),
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const roles = rolesOf(auth.profile);
  if (!(roles.includes('super_admin') || roles.includes('executive'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Debug (raw per-account balances) is super_admin-only.
  const debug = req.nextUrl.searchParams.get('debug') === '1' && roles.includes('super_admin');

  try {
    const data = await loadFinancials(debug);
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
