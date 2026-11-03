import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { NS_MIRROR_SYNC_TYPE } from '@/lib/ledger/netsuite-mirror';
import { BOOKS_GL_SYNC } from '@/lib/books/netsuite-gl';
import { BOOKS_LISTS_SYNC } from '@/lib/books/netsuite-lists';
import { BOOKS_DAILY_CHECK } from '@/lib/books/daily-check';
import { checkOwnCreditMemos, type OwnCreditPairsData } from '@/lib/books/own-credit-memo-check';
import { OWN_CREDIT_MEMO_RULE } from '@/lib/books/own-credit-memo-posting';
import { OWN_COMPANY } from '@/lib/books/own-invoices';
import { ownBooks, type OwnBooks } from '@/lib/books/own-invoice-posting';

export const dynamic = 'force-dynamic';

const MONTH_RE = /^\d{4}-\d{2}$/;

/** The last day of a 'YYYY-MM' month. */
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * GET /api/admin/books/own-credit-memos?month=YYYY-MM — the credit memos
 * FleetSuite made that month (the newest month with any when it's left out),
 * Books' own copy of each (migration 466) next to NetSuite's credit memo
 * (migration 518, src/lib/books/own-credit-memo-check.ts), with every month
 * that has any and how the copies the check reads from last went.
 * GET /api/admin/books/own-credit-memos?id=<NetSuite id> — one of them, line
 * by line. Each says what the books hold for the credit memo (`books`): the
 * entry that stands and whether it was made from Books' own copy or
 * NetSuite's credit memo (src/lib/books/own-credit-memo-posting.ts), null
 * when none stands. Amounts are whole cents.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books
 * (docs/books.md "Posting FleetSuite's own credit memos").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const read = (syncType: string) =>
    service.from('sync_state').select('last_synced_at, last_result, updated_at').eq('sync_type', syncType).maybeSingle();
  /** What the books hold for these credit memos, by NetSuite's id. */
  const booksFor = async (ids: string[]): Promise<Map<string, OwnBooks> | { error: string }> => {
    if (!ids.length) return new Map();
    const res = await service.rpc('gl_invoice_postings', { p_company: OWN_COMPANY, p_source_ids: ids, p_lines: false });
    if (res.error) return { error: res.error.message };
    const postings = ((res.data ?? {}) as { invoices?: Parameters<typeof ownBooks>[0] }).invoices ?? [];
    return ownBooks(postings, 'credit_memo', OWN_CREDIT_MEMO_RULE);
  };

  const id = params.get('id');
  if (id !== null) {
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: "That isn't a NetSuite credit memo id" }, { status: 400 });
    const res = await service.rpc('gl_own_credit_memo_pairs', { p_from: null, p_to: null, p_netsuite_id: id });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    const [creditMemo] = checkOwnCreditMemos(res.data as OwnCreditPairsData).creditMemos;
    if (!creditMemo) return NextResponse.json({ error: 'FleetSuite has no copy of that credit memo' }, { status: 404 });
    const books = await booksFor([creditMemo.netsuiteId]);
    if ('error' in books) return NextResponse.json({ error: books.error }, { status: 500 });
    return NextResponse.json({ creditMemo: { ...creditMemo, books: books.get(creditMemo.netsuiteId) ?? null } });
  }

  const [months, mirror, copy, lists, check] = await Promise.all([
    service.rpc('gl_own_credit_memo_months'),
    read(NS_MIRROR_SYNC_TYPE), read(BOOKS_GL_SYNC), read(BOOKS_LISTS_SYNC), read(BOOKS_DAILY_CHECK),
  ]);
  const error = months.error || mirror.error || copy.error || lists.error || check.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const monthList = ((months.data ?? []) as Array<{ month: string; credit_memos: number }>);
  const asked = params.get('month');
  const month = asked && MONTH_RE.test(asked) ? asked : monthList[0]?.month.slice(0, 7) ?? null;

  let checked: ReturnType<typeof checkOwnCreditMemos> | null = null;
  if (month) {
    const res = await service.rpc('gl_own_credit_memo_pairs', { p_from: `${month}-01`, p_to: monthEnd(month), p_netsuite_id: null });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    checked = checkOwnCreditMemos(res.data as OwnCreditPairsData);
  }
  const books = await booksFor((checked?.creditMemos ?? []).map((c) => c.netsuiteId));
  if ('error' in books) return NextResponse.json({ error: books.error }, { status: 500 });

  const state = (row: typeof mirror) =>
    row.data ? { at: row.data.updated_at as string, error: ((row.data.last_result ?? null) as { error?: string } | null)?.error ?? null } : null;

  return NextResponse.json({
    months: monthList,
    month: month ? `${month}-01` : null,
    // The list leaves the line by line check to the credit memo's own page.
    creditMemos: (checked?.creditMemos ?? []).map(({ fields: _fields, lines: _lines, workedOut: _workedOut, ...row }) => ({
      ...row, books: books.get(row.netsuiteId) ?? null,
    })),
    counts: checked?.counts ?? null,
    lastMirror: state(mirror),
    lastCopy: state(copy),
    lastLists: state(lists),
    lastCheck: state(check),
  });
}
