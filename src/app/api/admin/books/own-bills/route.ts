import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { transactionUrl } from '@/lib/netsuite';
import { BOOKS_BILLS_SYNC } from '@/lib/books/netsuite-bills';
import { BOOKS_GL_SYNC } from '@/lib/books/netsuite-gl';
import { BOOKS_LISTS_SYNC } from '@/lib/books/netsuite-lists';
import { BOOKS_DAILY_CHECK } from '@/lib/books/daily-check';
import { checkOwnBills, type BillPairsData, type OwnBillCheck } from '@/lib/books/own-bill-check';

export const dynamic = 'force-dynamic';

const MONTH_RE = /^\d{4}-\d{2}$/;

/** The last day of a 'YYYY-MM' month. */
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** NetSuite's page for a bill or a purchase order; null without NetSuite's account in the environment. */
const link = (page: 'vendbill' | 'purchord', netsuiteId: string | null) => {
  if (!netsuiteId) return null;
  try {
    return transactionUrl(page, netsuiteId);
  } catch {
    return null;
  }
};

/** A checked bill with NetSuite's pages for it and the purchase order it was made from, and who made it. */
const withLinks = (bill: OwnBillCheck, names: Map<string, string>) => ({
  ...bill,
  netsuiteUrl: link('vendbill', bill.netsuiteId),
  poUrl: link('purchord', bill.poId),
  madeByName: bill.madeBy ? names.get(bill.madeBy) ?? null : null,
});

/** The names of the people who made the bills (Snapped by …). */
async function namesOf(service: ReturnType<typeof createServiceClient>, bills: OwnBillCheck[]): Promise<Map<string, string>> {
  const ids = [...new Set(bills.map((b) => b.madeBy).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const { data, error } = await service.from('profiles').select('id, full_name').in('id', ids);
  if (error) throw new Error(error.message);
  return new Map((data ?? []).filter((p: { full_name: string | null }) => p.full_name).map((p: { id: string; full_name: string }) => [p.id, p.full_name]));
}

/**
 * GET /api/admin/books/own-bills?month=YYYY-MM — Books' own copies of the
 * bills FleetSuite made that month (the newest month with any when it's
 * left out), each next to NetSuite's bill (migration 435,
 * src/lib/books/own-bill-check.ts), with every month that has any and how
 * the copies the check reads from last went.
 * GET /api/admin/books/own-bills?id=<NetSuite id> — one of them, line by
 * line. Amounts are whole cents.
 *
 * Super admin only, as the rest of the books (docs/books.md "FleetSuite's
 * own bills and receipts").
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const read = (syncType: string) =>
    service.from('sync_state').select('last_synced_at, last_result, updated_at').eq('sync_type', syncType).maybeSingle();

  // How far the copies of NetSuite's bills and ledger had come, which says whether NetSuite's side is still to come.
  const [bills, ledger] = await Promise.all([read(BOOKS_BILLS_SYNC), read(BOOKS_GL_SYNC)]);
  const copyError = bills.error || ledger.error;
  if (copyError) return NextResponse.json({ error: copyError.message }, { status: 500 });
  const copies = {
    bills: (bills.data?.last_synced_at as string | null | undefined) ?? null,
    ledger: (ledger.data?.last_synced_at as string | null | undefined) ?? null,
  };

  const id = params.get('id');
  if (id !== null) {
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: "That isn't a NetSuite bill id" }, { status: 400 });
    const res = await service.rpc('gl_own_bill_pairs', { p_from: null, p_to: null, p_netsuite_id: id });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    const [bill] = checkOwnBills(res.data as BillPairsData, copies).bills;
    if (!bill) return NextResponse.json({ error: 'Books has no copy of that bill' }, { status: 404 });
    try {
      return NextResponse.json({ bill: withLinks(bill, await namesOf(service, [bill])) });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  const [months, lists, check] = await Promise.all([
    service.rpc('gl_own_bill_months'), read(BOOKS_LISTS_SYNC), read(BOOKS_DAILY_CHECK),
  ]);
  const error = months.error || lists.error || check.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const monthList = ((months.data ?? []) as Array<{ month: string; bills: number }>);
  const asked = params.get('month');
  const month = asked && MONTH_RE.test(asked) ? asked : monthList[0]?.month.slice(0, 7) ?? null;

  let checked: ReturnType<typeof checkOwnBills> | null = null;
  if (month) {
    const res = await service.rpc('gl_own_bill_pairs', { p_from: `${month}-01`, p_to: monthEnd(month), p_netsuite_id: null });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    checked = checkOwnBills(res.data as BillPairsData, copies);
  }

  let names: Map<string, string>;
  try {
    names = await namesOf(service, checked?.bills ?? []);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const state = (row: typeof bills) =>
    row.data ? { at: row.data.updated_at as string, error: ((row.data.last_result ?? null) as { error?: string } | null)?.error ?? null } : null;

  return NextResponse.json({
    months: monthList,
    month: month ? `${month}-01` : null,
    // The list leaves the line by line check to the bill's own page.
    bills: (checked?.bills ?? []).map(({ fields: _fields, lines: _lines, workedOut: _workedOut, ...row }) => withLinks(row as OwnBillCheck, names)),
    counts: checked?.counts ?? null,
    lastBills: state(bills),
    lastLedger: state(ledger),
    lastLists: state(lists),
    lastCheck: state(check),
  });
}
