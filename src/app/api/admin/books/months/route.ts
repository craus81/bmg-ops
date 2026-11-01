import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireBooks } from '@/lib/api-auth';
import { booksAllows } from '@/lib/books/access';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import type { DiffData } from '@/lib/books/differences';
import { readCompanies, type CompanyRow } from '@/lib/books/going-live';
import { BOOKS_COMPANIES, BooksError, setPeriodStatus, type BooksCompany } from '@/lib/books/journal';
import { centralDate } from '@/lib/books/mistake-checks';
import { closeRefusal, comparedMonths, monthRows, readPeriods, reopenRefusal } from '@/lib/books/months';
import { PLANNED_LIVE_FROM } from '@/lib/books/opening-balances';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/** A company's months since its books went live, newest first, each compared with NetSuite as Differences vs NetSuite compares it. */
async function readMonths(service: SupabaseClient, company: CompanyRow, today: string) {
  const [periods, sides] = await Promise.all([
    readPeriods(service, company.id),
    service.rpc('gl_books_differences', { p_company: company.code }),
  ]);
  if (sides.error) throw new Error(`Couldn't compare the books with NetSuite: ${sides.error.message}`);
  const raw = (sides.data ?? {}) as Partial<DiffData>;
  const compared = comparedMonths({
    netsuite: raw.netsuite ?? [],
    fleetsuite: raw.fleetsuite ?? [],
    netsuite_kinds: raw.netsuite_kinds ?? [],
    fleetsuite_kinds: raw.fleetsuite_kinds ?? [],
  });
  return monthRows({ liveFrom: company.books_live_from, today, periods, compared });
}

/**
 * GET /api/admin/books/months?company=BMG — one company's months in
 * FleetSuite's books since they went live, newest first: whether each is
 * closed, how it compares with NetSuite, every close and reopen, and which
 * can be closed or reopened now (src/lib/books/months.ts, docs/books.md
 * "Closing a month").
 *
 * POST { company, month: 'YYYY-MM', action: 'close' | 'reopen', reason } —
 * closes the first month that's open and over, or reopens the latest one
 * closed. Reopening needs a reason, and so does closing a month that doesn't
 * match NetSuite; the journal logs both (migration 359), and they're audited.
 *
 * Super admins, the bookkeeper and the CPA see it; the bookkeeper and super
 * admins close a month, and only a super admin reopens one (docs/books.md "Who
 * can open the books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const service = createServiceClient();
  try {
    const companies = (await readCompanies(service)).filter((c) => (BOOKS_COMPANIES as readonly string[]).includes(c.code));
    const asked = new URL(req.url).searchParams.get('company');
    const company = companies.find((c) => c.code === asked) ?? companies.find((c) => c.code === 'BMG') ?? companies[0];
    if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });
    const today = centralDate(new Date());
    return NextResponse.json({
      companies: companies.map((c) => ({ code: c.code, name: c.name, liveFrom: c.books_live_from ?? null })),
      company: company.code,
      liveFrom: company.books_live_from ?? null,
      plannedLiveFrom: PLANNED_LIVE_FROM,
      today,
      months: await readMonths(service, company, today),
    });
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({
  company: z.string().min(1).max(20),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM'),
  action: z.enum(['close', 'reopen']),
  reason: z.string().max(500).optional().default(''),
});

export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { action, reason } = parsed.data;
  if (action === 'reopen' && !booksAllows(auth.access, 'owner')) {
    return NextResponse.json({ error: 'Only a super admin can reopen a month.' }, { status: 403 });
  }
  const month = `${parsed.data.month}-01`;
  const service = createServiceClient();
  try {
    const company = (await readCompanies(service)).find((c) => c.code === parsed.data.company);
    if (!company || !(BOOKS_COMPANIES as readonly string[]).includes(company.code)) {
      return NextResponse.json({ error: `There's no company called ${parsed.data.company}.` }, { status: 400 });
    }
    // What the months are now, not when the page was opened.
    const rows = await readMonths(service, company, centralDate(new Date()));
    const refused = action === 'close'
      ? closeRefusal({ name: company.name, liveFrom: company.books_live_from, rows, month, reason })
      : reopenRefusal({ rows, month, reason });
    if (refused) return NextResponse.json({ error: refused.message }, { status: refused.status });

    const name = auth.profile?.full_name || auth.user.email || null;
    let period;
    try {
      period = await setPeriodStatus(service, {
        company: company.code as BooksCompany,
        month: parsed.data.month,
        status: action === 'close' ? 'closed' : 'open',
        actor: { id: auth.user.id, name },
        reason: reason.trim() || null,
      });
    } catch (err) {
      // The journal's own refusal, in its words; anything else is a failure.
      if (err instanceof BooksError && err.kind === 'refused') return NextResponse.json({ error: err.message }, { status: 409 });
      throw err;
    }
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'gl_periods',
      recordId: period.id,
      action: action === 'close' ? 'close_month' : 'reopen_month',
      detail: { company: company.code, month, reason: reason.trim() || null },
    });
    return NextResponse.json({ company: company.code, month, status: period.status });
  } catch (err) {
    return failed(err);
  }
}
