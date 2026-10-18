import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { BOOKS_GL_SYNC, COPY_FROM, monthOfDate } from '@/lib/books/netsuite-gl';
import { BOOKS_INVOICE_POSTING, POSTING_COMPANIES, type InvoicePostingResult } from '@/lib/books/invoice-posting';
import { BOOKS_DAILY_CHECK, type DailyCheckResult } from '@/lib/books/daily-check';
import {
  accountNamer, accountRows, compareMonth, copyHolds, explainDocument, indexMonths, kindRows, lastMonth, monthStatuses,
  NETSUITE_TYPE, postedKinds, type DiffChartAccount, type DiffData, type DiffDocumentData, type GlTotals,
} from '@/lib/books/differences';

export const dynamic = 'force-dynamic';

/** Documents listed for a month, the largest differences first. */
const DOCUMENTS_SHOWN = 300;

/**
 * GET /api/admin/books/differences?company=BMG&month=2026-09 — one company's
 * own books next to NetSuite's (migration 377), month by month: how each
 * month since January 2025 compares, and for the month asked for (last month
 * by default) each account, each kind of document, and each document that
 * FleetSuite posts differently from NetSuite, with why.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const [companies, chart, posting, copy, check] = await Promise.all([
    service.from('gl_companies').select('code, name, netsuite_subsidiary_id').order('code'),
    fetchAllRows<DiffChartAccount>((from, to) => service
      .from('gl_accounts')
      .select('id, netsuite_account_id, number, name')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_DAILY_CHECK).maybeSingle(),
  ]);
  const error = companies.error || chart.error || posting.error || copy.error || check.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codes = (companies.data || []).map((c) => c.code as string);
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  const [sides, totals] = await Promise.all([
    service.rpc('gl_books_differences', { p_company: company }),
    service.rpc('gl_netsuite_totals', { p_company: company }),
  ]);
  const rpcError = sides.error || totals.error;
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });
  const raw = (sides.data ?? {}) as Partial<DiffData>;
  const data: DiffData = {
    netsuite: raw.netsuite ?? [],
    fleetsuite: raw.fleetsuite ?? [],
    netsuite_kinds: raw.netsuite_kinds ?? [],
    fleetsuite_kinds: raw.fleetsuite_kinds ?? [],
  };

  const posted = postedKinds(data, (POSTING_COMPANIES as readonly string[]).includes(company));
  const index = indexMonths(data);
  const currentMonth = monthOfDate(new Date().toISOString().slice(0, 10))!;
  const through = lastMonth(data, currentMonth);

  // Default to last month, the newest one NetSuite may already have closed, as the trial balance does.
  const askedMonth = params.get('month');
  const fromParam = askedMonth && /^\d{4}-\d{2}$/.test(askedMonth) ? `${askedMonth}-01` : null;
  const lastCalendar = new Date();
  lastCalendar.setUTCDate(1);
  lastCalendar.setUTCMonth(lastCalendar.getUTCMonth() - 1);
  const previous = monthOfDate(lastCalendar.toISOString().slice(0, 10))!;
  const month = fromParam && fromParam >= COPY_FROM && fromParam <= through ? fromParam
    : previous >= COPY_FROM ? previous : COPY_FROM;

  // The month's documents that differ, of the kinds FleetSuite posts.
  const kinds = Object.fromEntries(Object.entries(NETSUITE_TYPE).filter(([, type]) => posted.has(type)));
  let docs: { counts: Record<string, number>; documents: DiffDocumentData[] } | null = null;
  if (Object.keys(kinds).length) {
    const res = await service.rpc('gl_books_difference_documents', {
      p_company: company, p_month: month, p_kinds: kinds, p_limit: DOCUMENTS_SHOWN,
    });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    docs = { counts: (res.data as any)?.counts ?? {}, documents: (res.data as any)?.documents ?? [] };
  }

  const name = accountNamer(chart.data);
  const cmp = compareMonth(index.get(month), month, posted);
  const run = (posting.data?.last_result ?? null) as InvoicePostingResult | null;
  const copied = (copy.data?.last_result ?? null) as { error?: string } | null;
  const checked = (check.data?.last_result ?? null) as DailyCheckResult | null;

  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name, netsuite_subsidiary_id: c.netsuite_subsidiary_id })),
    company,
    month,
    months: monthStatuses(index, posted, through),
    status: cmp.status,
    differing: cmp.differing,
    covered: cmp.covered,
    posts: posted.size > 0,
    accounts: accountRows(cmp, name),
    kinds: kindRows(cmp, docs?.counts ?? null),
    documents: (docs?.documents ?? []).map((d) => explainDocument(d, { name })),
    documentsTotal: docs ? Object.values(docs.counts).reduce((n, c) => n + c, 0) : 0,
    // Null until a copy has read NetSuite's own totals.
    copyHolds: copyHolds(totals.data as GlTotals | null, month),
    lastPosting: posting.data ? { at: posting.data.updated_at, error: run?.error ?? null, partial: !!run?.partial } : null,
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null } : null,
    lastCheck: check.data ? { at: check.data.updated_at, error: checked?.error ?? null } : null,
  });
}
