import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireBooks } from '@/lib/api-auth';
import { booksAllows } from '@/lib/books/access';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { monthText } from '@/lib/books/differences';
import { POSTING_COMPANIES } from '@/lib/books/invoice-posting';
import { COPY_FROM, monthsBetween } from '@/lib/books/netsuite-gl';
import { buildReport } from '@/lib/books/report-builder';
import { BUILDER_BY, BUILDER_MONTHS, BUILDER_ROWS } from '@/lib/books/report-builder-words';
import { loadBuilder, loadSavedReports } from '@/lib/books/report-data';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });
const refuse = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * GET /api/admin/books/reports/builder?company=BMG&rows=customer&by=division&months=picked&from=2026-01&to=2026-09&division=graphics&location=3
 * — one company's profit and loss from FleetSuite's own books for the
 * months picked (from=, January of `to`'s year by default, through to=,
 * last month by default) or ones that move with the calendar
 * (months=year_to_date, last_month, last_quarter, last_year or
 * last_12_months; the year to date with no months picked), a line for each
 * account, customer or vendor (rows=; accounts by default), a column for
 * each month, quarter, year, division or location (by=month, quarter, year,
 * division or location; by=total for the months altogether; division by
 * default) and a Total, only one division's or one location's lines when
 * asked (src/lib/books/report-builder.ts, migrations 500 and 501,
 * docs/books.md "Report builder"), with the months there are to pick from
 * and the company's reports saved by name.
 *
 * POST { action: 'save', id, seen, name, company, rows, by, division,
 * location, months, from, to } — the report saved by name, a new one with
 * `id` null, else the saved report `id` changed, as the page saw it when it
 * was saved at `seen`; from and to ('YYYY-MM') only for months picked.
 * { action: 'remove', id, seen } — a saved report deleted. Anyone who opens
 * the books saves one; only its saver or a super admin changes or deletes
 * it. Saving a report changes nothing in the books.
 *
 * Super admins, the bookkeeper and the CPA (docs/books.md "Who can open the
 * books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const loaded = await loadBuilder(service, new URL(req.url).searchParams);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const saved = await loadSavedReports(service, loaded.company, auth.user.id, booksAllows(auth.access, 'owner'));
  if ('error' in saved) return NextResponse.json({ error: saved.error }, { status: 500 });
  const { ask } = loaded;

  return NextResponse.json({
    companies: loaded.companies,
    company: loaded.company,
    // A company that doesn't post has nothing on FleetSuite's side.
    posts: (POSTING_COMPANIES as readonly string[]).includes(loaded.company),
    monthList: monthsBetween(COPY_FROM, loaded.through),
    months: ask.months,
    from: ask.from,
    to: ask.to,
    by: ask.by,
    ...buildReport(loaded.data, loaded.split, loaded.locationNames, ask, loaded.parties),
    saved,
    // A location, customer or vendor comes from the copy of NetSuite's ledger, read with NetSuite's totals.
    copied: loaded.data.opening.length > 0 || loaded.data.netsuite.length > 0,
    lastPosting: loaded.lastPosting,
    lastCopy: loaded.lastCopy,
  });
}

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Months are YYYY-MM');
const stamp = z.string().min(1).max(60);

const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    id: z.string().uuid().nullable(),
    seen: stamp.nullable(),
    name: z.string().trim().min(1, 'Type a name for the report').max(60, 'Keep the name to 60 characters or fewer'),
    company: z.string().min(1).max(20),
    rows: z.enum(BUILDER_ROWS),
    by: z.enum(BUILDER_BY),
    division: z.enum(['upfit', 'graphics', 'shared', 'none']).nullable(),
    location: z.string().regex(/^(none|\d{1,12}|own:[a-z0-9_]{2,40})$/, 'That location isn\'t one the books have').nullable(),
    months: z.enum(BUILDER_MONTHS),
    from: month.nullable(),
    to: month.nullable(),
  }),
  z.object({ action: z.literal('remove'), id: z.string().uuid(), seen: stamp }),
]);
type Body = z.infer<typeof Schema>;

export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const owner = booksAllows(auth.access, 'owner');
  const service = createServiceClient();
  try {
    switch (body.action) {
      case 'save': return await save(service, body, { id: auth.user.id, name: auth.profile?.full_name || auth.user.email || null, owner });
      case 'remove': return await remove(service, body, { id: auth.user.id, owner });
    }
  } catch (err) {
    return failed(err);
  }
}

const NOT_YOURS = 'Only whoever saved that report, or a super admin, can change or delete it.';

async function save(service: SupabaseClient, body: Extract<Body, { action: 'save' }>, me: { id: string; name: string | null; owner: boolean }) {
  const picked = body.months === 'picked';
  if (picked) {
    if (!body.from || !body.to) return refuse(400, 'Pick the months the report covers.');
    if (`${body.from}-01` < COPY_FROM) return refuse(400, `Reports start from ${monthText(COPY_FROM)}, when FleetSuite's copy of NetSuite starts.`);
    if (body.from > body.to) return refuse(400, "The report's first month comes after its last.");
  }
  if (body.id && !body.seen) return refuse(400, 'Open the saved report again before saving changes to it.');

  const { data, error } = await service.rpc('books_saved_report_save', {
    p: {
      id: body.id, seen: body.seen, company: body.company, name: body.name, rows: body.rows, columns: body.by,
      division: body.division, location: body.location, months: body.months,
      from: picked ? `${body.from}-01` : null, to: picked ? `${body.to}-01` : null,
      by: me.id, by_name: me.name, owner: me.owner,
    },
  });
  if (error?.code === '23503') return refuse(400, `The books have no company ${body.company}.`);
  if (error?.code === '23505') return refuse(409, `There's a saved report called "${body.name}" already: pick another name.`);
  if (error) throw new Error(`Couldn't save the report: ${error.message}`);
  const answer = (data ?? {}) as { state?: string; id?: string; updated_at?: string };
  switch (answer.state) {
    case 'saved': break;
    case 'name_taken': return refuse(409, `There's a saved report called "${body.name}" already: pick another name.`);
    case 'changed': return refuse(409, 'That saved report was changed since you opened it: open it again.');
    case 'gone': return refuse(409, 'That saved report was deleted since you opened it: save it as a new report.');
    case 'not_yours': return refuse(403, `${NOT_YOURS} Save it as a new report instead.`);
    default: throw new Error(`Couldn't save the report: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  }
  await logAudit(service, {
    actorId: me.id, table: 'books_saved_reports', recordId: answer.id!, action: body.id ? 'changed' : 'saved',
    detail: { company: body.company, name: body.name, rows: body.rows, columns: body.by, months: body.months },
  });
  return NextResponse.json({ saved: true, id: answer.id, updatedAt: answer.updated_at ?? null });
}

async function remove(service: SupabaseClient, body: Extract<Body, { action: 'remove' }>, me: { id: string; owner: boolean }) {
  const { data, error } = await service.rpc('books_saved_report_remove', { p: { id: body.id, seen: body.seen, by: me.id, owner: me.owner } });
  if (error) throw new Error(`Couldn't delete the report: ${error.message}`);
  const answer = (data ?? {}) as { state?: string; name?: string };
  switch (answer.state) {
    case 'removed': break;
    case 'changed': return refuse(409, 'That saved report was changed since you opened it: open it again.');
    case 'gone': return refuse(409, 'That saved report was deleted already.');
    case 'not_yours': return refuse(403, NOT_YOURS);
    default: throw new Error(`Couldn't delete the report: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  }
  await logAudit(service, {
    actorId: me.id, table: 'books_saved_reports', recordId: body.id, action: 'deleted', detail: { name: answer.name ?? null },
  });
  return NextResponse.json({ removed: true, name: answer.name ?? null });
}
