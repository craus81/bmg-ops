import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { BOOKS_GL_SYNC, COPY_FROM, monthOfDate } from '@/lib/books/netsuite-gl';
import { BOOKS_INVOICE_POSTING, POSTING_COMPANIES, type InvoicePostingResult } from '@/lib/books/invoice-posting';
import {
  lastReportMonth, report, reportMonths, REPORT_KINDS, type ReportAccount, type ReportAmount, type ReportData, type ReportKind,
} from '@/lib/books/reports';
import type { TbData } from '@/lib/books/trial-balance';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/reports?company=BMG&report=profit_and_loss&from=2026-01&to=2026-09
 * — one company's profit and loss for the months from `from` through `to`
 * (`to` alone by default, last month by default), or its balance sheet or
 * trial balance (report=balance_sheet, trial_balance) at the end of `to`,
 * from FleetSuite's own books, next to NetSuite's own totals
 * (src/lib/books/reports.ts, migration 396), with whether the report for
 * each month alone since January 2025 matches.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const [companies, accounts, posting, copy] = await Promise.all([
    service.from('gl_companies').select('id, code, name, netsuite_subsidiary_id').order('code'),
    fetchAllRows<Omit<ReportAccount, 'company'> & { company_id: string | null }>((from, to) => service
      .from('gl_accounts')
      .select('id, netsuite_account_id, number, name, account_type, statement, parent_id, company_id')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
  ]);
  const error = companies.error || accounts.error || posting.error || copy.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codeOf = new Map((companies.data || []).map((c) => [c.id as string, c.code as string]));
  const codes = [...codeOf.values()];
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  const [netsuite, fleetsuite] = await Promise.all([
    service.rpc('gl_netsuite_totals', { p_company: company }),
    service.rpc('gl_books_totals', { p_company: company }),
  ]);
  const rpcError = netsuite.error || fleetsuite.error;
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });
  const totals = (netsuite.data ?? {}) as Partial<TbData>;
  const data: ReportData = {
    company,
    accounts: accounts.data.map(({ company_id, ...a }) => ({ ...a, company: company_id ? codeOf.get(company_id) ?? null : null })),
    opening: totals.opening ?? [],
    netsuite: totals.netsuite ?? [],
    fleetsuite: (fleetsuite.data ?? []) as ReportAmount[],
  };

  const askedKind = params.get('report');
  const kind: ReportKind = REPORT_KINDS.find((k) => k === askedKind) ?? 'profit_and_loss';

  const currentMonth = monthOfDate(new Date().toISOString().slice(0, 10))!;
  const through = lastReportMonth(data, currentMonth);
  const monthParam = (name: string) => {
    const v = params.get(name);
    const m = v && /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : null;
    return m && m >= COPY_FROM && m <= through ? m : null;
  };

  // The end defaults to last month, the newest one NetSuite may already have
  // closed, as the trial balance does; the start to the end's month alone.
  const lastCalendar = new Date();
  lastCalendar.setUTCDate(1);
  lastCalendar.setUTCMonth(lastCalendar.getUTCMonth() - 1);
  const previous = monthOfDate(lastCalendar.toISOString().slice(0, 10))!;
  const to = monthParam('to') ?? (previous >= COPY_FROM ? previous : COPY_FROM);
  const askedFrom = monthParam('from');
  const from = askedFrom && askedFrom <= to ? askedFrom : to;

  const run = (posting.data?.last_result ?? null) as InvoicePostingResult | null;
  const copied = (copy.data?.last_result ?? null) as { error?: string } | null;

  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name, netsuite_subsidiary_id: c.netsuite_subsidiary_id })),
    company,
    // 1084 doesn't post yet, so its side holds only the starting balances.
    posts: (POSTING_COMPANIES as readonly string[]).includes(company),
    report: kind,
    from,
    to,
    months: reportMonths(data, kind, through),
    ...report(data, kind, { from, to }),
    // Nothing to compare until a copy has read NetSuite's totals.
    checked: data.opening.length > 0 || data.netsuite.length > 0,
    lastPosting: posting.data ? { at: posting.data.updated_at, error: run?.error ?? null, partial: !!run?.partial } : null,
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null } : null,
  });
}
