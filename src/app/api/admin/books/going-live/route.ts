import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { BOOKS_GL_SYNC, COPY_FROM, monthOfDate, monthsBetween } from '@/lib/books/netsuite-gl';
import { addDays, lastDay, PLANNED_LIVE_FROM, rehearse, workOutOpeningEntry, type OpeningAccount, type OpeningData } from '@/lib/books/opening-balances';
import { lastMonth, type TbData } from '@/lib/books/trial-balance';
import type { ReportAmount } from '@/lib/books/reports';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/going-live?company=BMG&month=2026-09 — the entry that
 * would open one company's books the day after a month ends, what still
 * differs from NetSuite's own totals then, what would stop it posting, and
 * the rehearsal: had the books gone live after that month, FleetSuite's
 * balances since next to NetSuite's (src/lib/books/opening-balances.ts,
 * docs/books.md "Going live"). The month defaults to the one before the
 * live date once it's over, else the same month a year earlier.
 *
 * Read only: nothing is posted, and the live date isn't set here. Super admin
 * only, as the books are.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const [companies, accounts, copy] = await Promise.all([
    service.from('gl_companies').select('id, code, name, books_live_from').order('code'),
    fetchAllRows<Omit<OpeningAccount, 'company'> & { company_id: string | null }>((from, to) => service
      .from('gl_accounts')
      .select('id, netsuite_account_id, number, name, account_type, statement, is_summary, company_id')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
  ]);
  const error = companies.error || accounts.error || copy.error;
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
  const data: OpeningData = {
    company,
    accounts: accounts.data.map(({ company_id, ...a }) => ({ ...a, company: company_id ? codeOf.get(company_id) ?? null : null })),
    opening: totals.opening ?? [],
    netsuite: totals.netsuite ?? [],
    copied: totals.copied ?? [],
  };

  const today = new Date().toISOString().slice(0, 10);
  const through = lastMonth(data, monthOfDate(today)!);
  const months = monthsBetween(COPY_FROM, through);
  const liveFrom: string | null = (companies.data || []).find((c) => c.code === company)?.books_live_from ?? null;
  // The month before the live date once it's over; until then the same
  // month a year earlier, a rehearsal of the same year end.
  const opening = monthOfDate(addDays(liveFrom ?? PLANNED_LIVE_FROM, -1))!;
  const yearEarlier = `${Number(opening.slice(0, 4)) - 1}${opening.slice(4)}`;
  const askedMonth = params.get('month');
  const fromParam = askedMonth && /^\d{4}-\d{2}$/.test(askedMonth) ? `${askedMonth}-01` : null;
  const month = fromParam && months.includes(fromParam) ? fromParam
    : lastDay(opening) < today ? opening
      : months.includes(yearEarlier) ? yearEarlier : months[0];

  const journal = (fleetsuite.data ?? []) as ReportAmount[];
  const entry = workOutOpeningEntry(data, journal, month, today);
  const rehearsal = rehearse(data, journal, month, through);
  const copied = (copy.data?.last_result ?? null) as { error?: string } | null;
  return NextResponse.json({
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name, liveFrom: c.books_live_from ?? null })),
    company,
    liveFrom,
    plannedLiveFrom: PLANNED_LIVE_FROM,
    month,
    months,
    through,
    today,
    entry,
    rehearsal,
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null } : null,
  });
}
