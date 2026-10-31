import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { COPY_FROM, monthOfDate, monthsBetween } from '@/lib/books/netsuite-gl';
import { lastDay, PLANNED_LIVE_FROM, rehearse, workOutOpeningEntry } from '@/lib/books/opening-balances';
import {
  GO_LIVE_FROM, goLiveRefusal, openingMonth, openingWait, readChart, readCompanies, readLastCopy, readOpeningEntries,
  readOpeningParties, readTotals, withCompanies,
} from '@/lib/books/going-live';
import { centralDate } from '@/lib/books/mistake-checks';
import { lastMonth } from '@/lib/books/trial-balance';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/**
 * GET /api/admin/books/going-live?company=BMG&month=2026-09 — the entry that
 * would open one company's books the day after a month ends, customer by
 * customer and vendor by vendor on the receivable and payable accounts, what
 * still differs from NetSuite's own totals then, what would stop it posting,
 * and the rehearsal: had the books gone live after that month, FleetSuite's
 * balances since next to NetSuite's (src/lib/books/opening-balances.ts,
 * docs/books.md "Going live"). The month defaults to the one before the
 * live date once it's over, else the same month a year earlier. Once the
 * books are live, the opening entries posted, and for the month before why
 * the next one waits.
 *
 * POST { company, confirm } — the tap: sets the day the company's books go
 * live, January 1, 2027, which can't be undone (migration 359). Offered from
 * December 1, 2026, `confirm` being the company's code typed out; audited.
 * The posting run posts the opening entry once December 31 is over
 * (src/lib/books/going-live.ts).
 *
 * Super admin only, as the books are.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  try {
    const [companies, chart, lastCopy] = await Promise.all([readCompanies(service), readChart(service), readLastCopy(service)]);
    const codeOf = new Map(companies.map((c) => [c.id, c.code]));
    const codes = companies.map((c) => c.code);
    const asked = params.get('company');
    const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
    if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

    const { data, journal } = await readTotals(service, company, withCompanies(chart, codeOf));
    const today = centralDate(new Date());
    const through = lastMonth(data, monthOfDate(today)!);
    const months = monthsBetween(COPY_FROM, through);
    const liveFrom = companies.find((c) => c.code === company)?.books_live_from ?? null;
    // The month before the live date once it's over; until then the same
    // month a year earlier, a rehearsal of the same year end.
    const opening = openingMonth(liveFrom ?? PLANNED_LIVE_FROM);
    const yearEarlier = `${Number(opening.slice(0, 4)) - 1}${opening.slice(4)}`;
    const askedMonth = params.get('month');
    const fromParam = askedMonth && /^\d{4}-\d{2}$/.test(askedMonth) ? `${askedMonth}-01` : null;
    const month = fromParam && months.includes(fromParam) ? fromParam
      : lastDay(opening) < today ? opening
        : months.includes(yearEarlier) ? yearEarlier : months[0];

    const [parties, openingEntries] = await Promise.all([
      readOpeningParties(service, company, lastDay(month)),
      readOpeningEntries(service, company),
    ]);
    const entry = workOutOpeningEntry(data, journal, month, today, parties);
    return NextResponse.json({
      companies: companies.map((c) => ({ code: c.code, name: c.name, liveFrom: c.books_live_from ?? null })),
      company,
      liveFrom,
      plannedLiveFrom: PLANNED_LIVE_FROM,
      goLiveFrom: GO_LIVE_FROM,
      month,
      months,
      through,
      today,
      entry,
      rehearsal: rehearse(data, journal, month, through),
      openingEntries,
      // Once the books are live, why the opening entry for the day before won't post with the next posting run.
      waiting: liveFrom && month === openingMonth(liveFrom) ? openingWait(entry, lastCopy) : null,
      lastCopy,
    });
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({
  company: z.string().min(1).max(20),
  confirm: z.string().max(40),
});

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const service = createServiceClient();
  try {
    const company = (await readCompanies(service)).find((c) => c.code === parsed.data.company);
    if (!company) return NextResponse.json({ error: `There's no company called ${parsed.data.company}.` }, { status: 400 });
    const refused = goLiveRefusal(company, parsed.data.confirm, centralDate(new Date()));
    if (refused) return NextResponse.json({ error: refused.message }, { status: refused.status });

    // Only while it isn't set, so two taps at once set it once.
    const set = await service
      .from('gl_companies')
      .update({ books_live_from: PLANNED_LIVE_FROM })
      .eq('id', company.id)
      .is('books_live_from', null)
      .select('id');
    if (set.error) throw new Error(set.error.message);
    if (!set.data?.length) return NextResponse.json({ error: `${company.name}'s books have already gone live.` }, { status: 409 });
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'gl_companies',
      recordId: company.id,
      action: 'go_live',
      detail: { company: company.code, live_from: PLANNED_LIVE_FROM },
    });
    return NextResponse.json({ company: company.code, liveFrom: PLANNED_LIVE_FROM });
  } catch (err) {
    return failed(err);
  }
}
