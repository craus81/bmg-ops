import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { booksAllows } from '@/lib/books/access';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { booksErrorFrom } from '@/lib/books/journal';
import { centralDate } from '@/lib/books/mistake-checks';
import { PLANNED_LIVE_FROM } from '@/lib/books/opening-balances';
import { closeYearRefusal, reopenYearRefusal, yearView, REASON_MAX } from '@/lib/books/year-end';
import { booksCompanies, pickYear, readYear } from '@/lib/books/year-end-data';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

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
    const today = centralDate(new Date());
    const picked = pickYear(companies, params, today);
    if (!picked) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });
    const { company, year } = picked;
    const read = await readYear(service, company, year, today);
    return NextResponse.json({
      companies: companies.map((c) => ({ code: c.code, name: c.name, liveFrom: c.books_live_from ?? null })),
      company: company.code,
      liveFrom: company.books_live_from ?? null,
      plannedLiveFrom: PLANNED_LIVE_FROM,
      today,
      years: picked.years,
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
    const read = await readYear(service, company, year, centralDate(new Date()));
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
