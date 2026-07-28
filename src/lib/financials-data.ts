/**
 * Shared data helpers behind the Home → Financials tab and its drill-downs
 * (/api/reports/financials and the routes under it). Everything reads
 * NetSuite live:
 *
 *  - Open A/R invoices via SuiteQL (the integration role can read CustInvc).
 *    `foreignamountunpaid` (the open balance) is preferred over
 *    `foreigntotal` so partially-paid invoices age at what's actually owed;
 *    the column isn't guaranteed for every account/role, so the query
 *    degrades to totals when it's rejected.
 *  - Open vendor bills via SuiteQL — HEADERS only. The role cannot see bill
 *    payments, vendor credits, or card charges, so the sum of open bills is
 *    the drill-down detail under the A/P account balance from the financials
 *    RESTlet, not a replacement for it (see the RESTlet header comment).
 *  - GL account balances (cash / cards / A/P) via the financials RESTlet,
 *    grouped by the env-configured account ids. Never sum SuiteQL lines for
 *    these — it can never reconcile to the Chart of Accounts.
 *
 * The aging math lives here so the tile numbers and the drill-down lists come
 * from the exact same rows and always agree.
 */

import { suiteqlQueryAll, getAccountBalancesFromRestlet, transactionUrl } from '@/lib/netsuite';

export type AgingBucketKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus';

export interface OpenArInvoice {
  id: string;
  tranid: string;
  date: string | null; // ISO
  dueDate: string | null; // ISO
  po: string | null;
  customer: string;
  entityId: string | null;
  total: number;
  unpaid: number; // open balance; falls back to total when the column is unavailable
  daysPastDue: number; // 0 = current (no due date, or not yet due)
  bucket: AgingBucketKey;
  nsUrl: string;
}

export interface OpenVendorBill {
  id: string;
  tranid: string;
  date: string | null; // ISO
  dueDate: string | null; // ISO
  vendor: string;
  memo: string | null;
  total: number;
  unpaid: number;
  daysPastDue: number;
  nsUrl: string;
}

export interface AccountBalance {
  id: string;
  name: string | null; // null when the RESTlet didn't return this id
  type: string | null;
  balance: number | null;
}

const DAY_MS = 86_400_000;

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalize NetSuite dates ('YYYY-MM-DD' or 'M/D/YYYY') to ISO, else null. */
function isoDate(d: unknown): string | null {
  if (!d) return null;
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Whole days the ISO date is in the past (UTC); 0 if absent or not yet due. */
export function daysPastDue(dueIso: string | null): number {
  if (!dueIso) return 0;
  const t = Date.parse(dueIso);
  if (Number.isNaN(t)) return 0;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.floor((todayUtc - t) / DAY_MS));
}

export function bucketFor(days: number): AgingBucketKey {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90plus';
}

export async function fetchOpenArInvoices(): Promise<{ invoices: OpenArInvoice[]; unpaidColumn: boolean }> {
  const select = (withUnpaid: boolean) => `
    SELECT t.id, t.tranid, t.trandate, t.duedate, t.otherrefnum, t.foreigntotal${withUnpaid ? ', t.foreignamountunpaid' : ''}, t.entity, c.companyname AS customer
    FROM transaction t
    LEFT JOIN customer c ON c.id = t.entity
    WHERE t.type = 'CustInvc' AND t.status = 'A'
  `;
  let rows: any[];
  let unpaidColumn = true;
  try {
    rows = await suiteqlQueryAll(select(true));
  } catch {
    unpaidColumn = false;
    rows = await suiteqlQueryAll(select(false));
  }
  const invoices = rows.map((r): OpenArInvoice => {
    const total = num(r.foreigntotal);
    const unpaid = unpaidColumn && r.foreignamountunpaid != null ? num(r.foreignamountunpaid) : total;
    const dueDate = isoDate(r.duedate);
    const days = daysPastDue(dueDate);
    return {
      id: String(r.id),
      tranid: String(r.tranid || r.id),
      date: isoDate(r.trandate),
      dueDate,
      po: r.otherrefnum ? String(r.otherrefnum) : null,
      customer: r.customer || 'Unknown',
      entityId: r.entity != null ? String(r.entity) : null,
      total,
      unpaid,
      daysPastDue: days,
      bucket: bucketFor(days),
      nsUrl: transactionUrl('custinvc', r.id),
    };
  });
  return { invoices, unpaidColumn };
}

export interface ArAging {
  total: number;
  pastDue: number;
  openCount: number;
  buckets: Record<AgingBucketKey, number>;
  topOverdue: { customer: string; amount: number; days: number }[];
}

/**
 * Aggregate open invoices into the tile shape. Top overdue is per CUSTOMER
 * (summed past-due balance, oldest invoice age) — that's the actionable list
 * for chasing payment, and each row drills into that customer's invoices.
 */
export function computeArAging(invoices: OpenArInvoice[]): ArAging {
  const buckets: Record<AgingBucketKey, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  let total = 0;
  const byCustomer = new Map<string, { customer: string; amount: number; days: number }>();
  for (const inv of invoices) {
    total += inv.unpaid;
    buckets[inv.bucket] += inv.unpaid;
    if (inv.bucket === 'current') continue;
    const cur = byCustomer.get(inv.customer) || { customer: inv.customer, amount: 0, days: 0 };
    cur.amount += inv.unpaid;
    cur.days = Math.max(cur.days, inv.daysPastDue);
    byCustomer.set(inv.customer, cur);
  }
  const pastDue = buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90plus;
  const topOverdue = [...byCustomer.values()].sort((a, b) => b.amount - a.amount).slice(0, 6);
  return { total, pastDue, openCount: invoices.length, buckets, topOverdue };
}

export async function fetchOpenVendorBills(): Promise<{ bills: OpenVendorBill[]; unpaidColumn: boolean }> {
  const select = (withUnpaid: boolean, withVendorJoin: boolean) => `
    SELECT t.id, t.tranid, t.trandate, t.duedate, t.memo, t.foreigntotal${withUnpaid ? ', t.foreignamountunpaid' : ''}, t.entity${withVendorJoin ? ', v.companyname AS vendor' : ''}
    FROM transaction t
    ${withVendorJoin ? 'LEFT JOIN vendor v ON v.id = t.entity' : ''}
    WHERE t.type = 'VendBill' AND t.status = 'A'
  `;
  // Neither the vendor join nor the unpaid column is guaranteed for the
  // integration role — degrade one at a time before giving up.
  const attempts: [boolean, boolean][] = [[true, true], [false, true], [true, false], [false, false]];
  let rows: any[] | null = null;
  let unpaidColumn = true;
  let lastErr: unknown;
  for (const [withUnpaid, withJoin] of attempts) {
    try {
      rows = await suiteqlQueryAll(select(withUnpaid, withJoin));
      unpaidColumn = withUnpaid;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!rows) throw lastErr;
  const bills = rows.map((r): OpenVendorBill => {
    const total = num(r.foreigntotal);
    const unpaid = unpaidColumn && r.foreignamountunpaid != null ? num(r.foreignamountunpaid) : total;
    const dueDate = isoDate(r.duedate);
    return {
      id: String(r.id),
      tranid: String(r.tranid || r.id),
      date: isoDate(r.trandate),
      dueDate,
      vendor: r.vendor || (r.entity != null ? `Vendor #${r.entity}` : 'Unknown vendor'),
      memo: r.memo ? String(r.memo) : null,
      total,
      unpaid,
      daysPastDue: daysPastDue(dueDate),
      nsUrl: transactionUrl('vendbill', r.id),
    };
  });
  return { bills, unpaidColumn };
}

export function idList(raw: string | undefined): string[] {
  return (raw || '').split(',').map(s => s.trim()).filter(s => /^\d{1,18}$/.test(s));
}

export async function fetchAccountGroups(): Promise<{
  success: boolean;
  error?: string;
  bank: AccountBalance[];
  card: AccountBalance[];
  ap: AccountBalance[];
}> {
  const bankIds = idList(process.env.NETSUITE_BANK_ACCOUNT_IDS);
  const cardIds = idList(process.env.NETSUITE_CARD_ACCOUNT_ID);
  const apIds = idList(process.env.NETSUITE_AP_ACCOUNT_IDS);
  const allIds = [...new Set([...bankIds, ...cardIds, ...apIds])];

  const result = await getAccountBalancesFromRestlet(allIds);
  const bals = result.balances || {};
  const mk = (ids: string[]) => ids.map((id): AccountBalance => ({
    id,
    name: bals[id]?.name ?? null,
    type: bals[id]?.type ?? null,
    balance: bals[id] ? num(bals[id].balance) : null,
  }));
  return {
    success: result.success,
    error: result.success ? undefined : (result.error || 'Balances unavailable'),
    bank: mk(bankIds),
    card: mk(cardIds),
    ap: mk(apIds),
  };
}
