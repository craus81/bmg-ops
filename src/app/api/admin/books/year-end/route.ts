import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireBooks } from '@/lib/api-auth';
import { booksAllows } from '@/lib/books/access';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { readCompanies, type CompanyRow } from '@/lib/books/going-live';
import { BOOKS_COMPANIES, booksErrorFrom } from '@/lib/books/journal';
import { centralDate } from '@/lib/books/mistake-checks';
import { readMonthFacts } from '@/lib/books/months';
import { PLANNED_LIVE_FROM } from '@/lib/books/opening-balances';
import { loadReports } from '@/lib/books/report-data';
import { yearCloseAmounts, type YearCloseAmounts } from '@/lib/books/reports';
import { SALES_TAX_COMPANY } from '@/lib/books/sales-tax-data';
import {
  closeYearRefusal, defaultYear, readYearChecks, readYears, reopenYearRefusal, yearsShown, yearView, REASON_MAX,
  type YearFacts,
} from '@/lib/books/year-end';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

interface YearRead {
  companies: CompanyRow[];
  company: CompanyRow;
  facts: YearFacts;
  amounts: YearCloseAmounts;
  /** NetSuite's side is known: a copy has read its totals. */
  checked: boolean;
}

/** Everything a company's year shows, read as it is now: the close's amounts both sides, its months, checks and closes. */
async function readYear(service: SupabaseClient, company: CompanyRow, companies: CompanyRow[], year: number, today: string): Promise<YearRead> {
  const loaded = await loadReports(service, company.code);
  if ('error' in loaded) throw new Error(loaded.error);
  const chart = new Map(loaded.data.accounts.filter((a) => a.netsuite_account_id).map((a) => [a.netsuite_account_id!, a]));
  const accountName = (id: string) => {
    const a = chart.get(id);
    return a ? [a.number, a.name].filter(Boolean).join(' ') : `NetSuite account ${id}`;
  };
  const [{ periods, compared }, years, checks] = await Promise.all([
    readMonthFacts(service, company),
    readYears(service, company.id),
    readYearChecks(service, { company: company.code, year, makesSales: company.code === SALES_TAX_COMPANY, accountName }),
  ]);
  return {
    companies,
    company,
    facts: { name: company.name, liveFrom: company.books_live_from, year, today, periods, compared, years, ...checks },
    amounts: yearCloseAmounts(loaded.data, year),
    checked: loaded.data.opening.length > 0 || loaded.data.netsuite.length > 0,
  };
}

const booksCompanies = async (service: SupabaseClient) =>
  (await readCompanies(service)).filter((c) => (BOOKS_COMPANIES as readonly string[]).includes(c.code));

/**
 * GET /api/admin/books/year-end?company=BMG&year=2027 — one company's year
 * closing into retained earnings in FleetSuite's books, next to NetSuite's
 * (src/lib/books/reports.ts's yearCloseAmounts): retained earnings at
 * January 1, what was posted to them in the year, its net income and
 * retained earnings once it closes; what's done before it closes (its
 * months closed, matching NetSuite, journal entries made, bank accounts
 * reconciled, sales tax returns typed in); whether it's closed, every close
 * and reopen, and what can be done with it now (src/lib/books/year-end.ts,
 * docs/books.md "Year end"). Last year by default.
 *
 * POST { company, year, action: 'close' | 'reopen', reason } — closes the
 * year once every month of it is closed, years in order, or reopens the
 * latest one closed. Reopening needs a reason, and so does closing a year
 * with anything not done; migration 502 holds a closed year's months closed
 * and logs both, and they're audited.
 *
 * Super admins, the bookkeeper and the CPA see it; only a super admin closes
 * or reopens a year (docs/books.md "Who can open the books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  try {
    const companies = await booksCompanies(service);
    const asked = params.get('company');
    const company = companies.find((c) => c.code === asked) ?? companies.find((c) => c.code === 'BMG') ?? companies[0];
    if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });
    const today = centralDate(new Date());
    const shown = yearsShown(today);
    const askedYear = Number(params.get('year'));
    const year = shown.includes(askedYear) ? askedYear : defaultYear(today);
    const read = await readYear(service, company, companies, year, today);
    return NextResponse.json({
      companies: companies.map((c) => ({ code: c.code, name: c.name, liveFrom: c.books_live_from ?? null })),
      company: company.code,
      liveFrom: company.books_live_from ?? null,
      plannedLiveFrom: PLANNED_LIVE_FROM,
      today,
      years: shown,
      year,
      close: read.amounts,
      checked: read.checked,
      ...yearView(read.facts, read.amounts),
    });
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({
  company: z.string().min(1).max(20),
  year: z.number().int().min(2025).max(2200),
  action: z.enum(['close', 'reopen']),
  reason: z.string().max(REASON_MAX).optional().default(''),
});

export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;
  if (!booksAllows(auth.access, 'owner')) {
    return NextResponse.json({ error: 'Only a super admin closes or reopens a year.' }, { status: 403 });
  }

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { action, year } = parsed.data;
  const reason = parsed.data.reason.trim();
  const service = createServiceClient();
  try {
    const companies = await booksCompanies(service);
    const company = companies.find((c) => c.code === parsed.data.company);
    if (!company) return NextResponse.json({ error: `There's no company called ${parsed.data.company}.` }, { status: 400 });
    // The year as it is now, not when the page was opened.
    const read = await readYear(service, company, companies, year, centralDate(new Date()));
    const refused = action === 'close' ? closeYearRefusal(read.facts, reason) : reopenYearRefusal(read.facts, reason);
    if (refused) return NextResponse.json({ error: refused.message }, { status: refused.status });

    const closing = action === 'close';
    const { data, error } = await service.rpc('gl_set_year_status', {
      p_company: company.code,
      p_year: year,
      p_status: closing ? 'closed' : 'open',
      p_actor_id: auth.user.id,
      p_actor_name: auth.profile?.full_name || auth.user.email || null,
      p_reason: reason || null,
      // What FleetSuite's books have, kept with the close.
      p_net_income_cents: closing ? read.amounts.netIncome.fleetsuite : null,
      p_retained_earnings_cents: closing ? read.amounts.closed.fleetsuite : null,
    });
    if (error) {
      // The database's own refusal, in its words; anything else is a failure.
      const err = booksErrorFrom(error);
      if (err.kind === 'refused') return NextResponse.json({ error: err.message }, { status: 409 });
      throw err;
    }
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'gl_year_closes',
      recordId: `${company.code} ${year}`,
      action: closing ? 'close_year' : 'reopen_year',
      detail: { company: company.code, year, reason: reason || null },
    });
    return NextResponse.json({ company: company.code, year, status: (data as { status?: string } | null)?.status ?? (closing ? 'closed' : 'open') });
  } catch (err) {
    return failed(err);
  }
}
