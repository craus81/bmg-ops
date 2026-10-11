import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { BOOKS_GL_SYNC, COPY_FROM, copyNetSuiteGl, monthOfDate } from '@/lib/books/netsuite-gl';
import { lastMonth, monthStatuses, START, trialBalance, type TbAccount, type TbData } from '@/lib/books/trial-balance';

export const dynamic = 'force-dynamic';
// "Copy now" runs the same job as the cron, with the same budget.
export const maxDuration = 300;

const COPY_BUDGET_MS = 240_000;

/**
 * GET /api/admin/books/trial-balance?company=BMG&month=2026-09 — one
 * company's month-end trial balance from the copy of NetSuite's general
 * ledger, next to NetSuite's own (migration 361), with whether each month
 * since January 2025 matches. `month=start` is the starting entry.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const [companies, accounts, sync] = await Promise.all([
    service.from('gl_companies').select('id, code, name, netsuite_subsidiary_id').order('code'),
    fetchAllRows<Omit<TbAccount, 'company'> & { company_id: string | null }>((from, to) => service
      .from('gl_accounts')
      .select('netsuite_account_id, number, name, account_type, statement, company_id')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
  ]);
  const error = companies.error || accounts.error || sync.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codeOf = new Map((companies.data || []).map((c) => [c.id as string, c.code as string]));
  const codes = [...codeOf.values()];
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  const totals = await service.rpc('gl_netsuite_totals', { p_company: company });
  if (totals.error) return NextResponse.json({ error: totals.error.message }, { status: 500 });
  const t = (totals.data ?? {}) as Partial<TbData>;
  const data: TbData = {
    company,
    accounts: accounts.data.map(({ company_id, ...a }) => ({ ...a, company: company_id ? codeOf.get(company_id) ?? null : null })),
    opening: t.opening ?? [],
    netsuite: t.netsuite ?? [],
    copied: t.copied ?? [],
  };

  const currentMonth = monthOfDate(new Date().toISOString().slice(0, 10))!;
  const through = lastMonth(data, currentMonth);
  const months = monthStatuses(data, through);

  // Default to last month, the newest one NetSuite may already have closed.
  const askedMonth = params.get('month');
  const fromParam = askedMonth && /^\d{4}-\d{2}$/.test(askedMonth) ? `${askedMonth}-01` : null;
  const lastCalendar = new Date();
  lastCalendar.setUTCDate(1);
  lastCalendar.setUTCMonth(lastCalendar.getUTCMonth() - 1);
  const previous = monthOfDate(lastCalendar.toISOString().slice(0, 10))!;
  const month = askedMonth === START
    ? START
    : fromParam && fromParam >= COPY_FROM && fromParam <= through ? fromParam
      : previous >= COPY_FROM ? previous : COPY_FROM;

  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name, netsuite_subsidiary_id: c.netsuite_subsidiary_id })),
    company,
    month,
    months,
    ...trialBalance(data, month),
    // Nothing to compare until a run has read NetSuite's totals.
    checked: data.opening.length > 0 || data.netsuite.length > 0,
    lastRun: sync.data ? { at: sync.data.updated_at, result: sync.data.last_result } : null,
  });
}

/**
 * POST /api/admin/books/trial-balance — copy from NetSuite now rather than
 * wait for the two-hourly run. Same job, same record of how it went.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  return NextResponse.json(await copyNetSuiteGl(createServiceClient(), { deadline: Date.now() + COPY_BUDGET_MS }));
}
