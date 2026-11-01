import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { buildYear1099, type Year1099Data } from '@/lib/books/1099s';
import { BOOKS_ACCOUNTS_SYNC, type BooksAccountsSyncResult } from '@/lib/books/netsuite-accounts';
import { BOOKS_LISTS_SYNC, type BooksListsSyncResult } from '@/lib/books/netsuite-lists';
import { BOOKS_GL_SYNC, COPY_FROM } from '@/lib/books/netsuite-gl';
import { BOOKS_BILL_PAYMENTS_SYNC } from '@/lib/books/netsuite-bill-payments';
import { BOOKS_SPENDING_SYNC } from '@/lib/books/netsuite-spending';
import { chicagoDate } from '@/lib/books/own-invoices';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/admin/books/1099s?company=BMG&year=2025 — the 1099 dry run (part
 * 50, migration 481, src/lib/books/1099s.ts): what each vendor marked to get
 * a 1099 was paid in one company's year on the accounts that count toward
 * one, by category, worked out from FleetSuite's copy of NetSuite, with what
 * was left out or can't be split, and how the copies it reads last went. The
 * year is any from the copy's first (2025) to this one in Central time, last
 * year when it's left out. Amounts are whole cents. Nothing is filed or sent.
 *
 * Super admin only, as the rest of the books (docs/books.md "1099s").
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const thisYear = Number(chicagoDate().slice(0, 4));
  const firstYear = Number(COPY_FROM.slice(0, 4));
  const years: number[] = [];
  for (let y = thisYear; y >= firstYear; y--) years.push(y);
  const askedYear = params.get('year');
  const year = askedYear === null ? Math.max(firstYear, thisYear - 1) : /^\d{4}$/.test(askedYear) ? Number(askedYear) : NaN;
  if (!years.includes(year)) {
    return NextResponse.json({ error: `Pick a year from ${firstYear} to ${thisYear}` }, { status: 400 });
  }

  const service = createServiceClient();
  const read = (syncType: string) =>
    service.from('sync_state').select('last_synced_at, last_result, updated_at').eq('sync_type', syncType).maybeSingle();
  const [companies, accounts, lists, ledger, billPayments, spending] = await Promise.all([
    service.from('gl_companies').select('code, name').order('code'),
    read(BOOKS_ACCOUNTS_SYNC), read(BOOKS_LISTS_SYNC), read(BOOKS_GL_SYNC), read(BOOKS_BILL_PAYMENTS_SYNC), read(BOOKS_SPENDING_SYNC),
  ]);
  const error = companies.error || accounts.error || lists.error || ledger.error || billPayments.error || spending.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codes = (companies.data || []).map((c) => c.code as string);
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  const res = await service.rpc('gl_1099_year', { p_company: company, p_year: year });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const result = buildYear1099(res.data as Year1099Data);

  // How each copy the year is read from last went: when it last finished, and why the last try failed.
  type SyncRow = { last_synced_at?: string | null; last_result?: unknown; updated_at?: string } | null;
  const copy = (row: SyncRow) => (row ? {
    at: row.last_synced_at ?? null,
    tried: row.updated_at ?? null,
    error: ((row.last_result ?? null) as { error?: string } | null)?.error ?? null,
  } : null);
  const chart = (accounts.data?.last_result ?? null) as BooksAccountsSyncResult | null;
  const listed = (lists.data?.last_result ?? null) as BooksListsSyncResult | null;
  const vendors = listed?.lists?.vendor;

  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name })),
    company,
    year,
    years,
    ...result,
    copies: {
      chart: copy(accounts.data as SyncRow),
      // Whether the last copy of the chart could read which accounts count toward a 1099, and how many NetSuite has.
      accounts1099: chart ? (chart.accounts1099 ?? null) : null,
      lists: copy(lists.data as SyncRow),
      // The vendors list's own trouble: NetSuite wouldn't give it, or not the 1099 flags or legal names.
      vendors: vendors ? { error: vendors.error ?? null, missing: vendors.missing ?? [] } : null,
      ledger: copy(ledger.data as SyncRow),
      billPayments: copy(billPayments.data as SyncRow),
      spending: copy(spending.data as SyncRow),
    },
  });
}
