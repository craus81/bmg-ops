import { NextRequest, NextResponse } from 'next/server';
import { requireBooks, requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { readNames } from '@/lib/books/netsuite-feed';
import {
  NUMBERS_PAGE, OUTSIDE_DAYS_OFF, OUTSIDE_PAGE, OWN_NUMBER_KINDS, isOwnNumberType, lettersTakenBy, numberView, outsideSince, outsideView,
  readNumbers, readOutside, readOwnNumbersSwitch, readSeries, seriesChange, seriesView,
} from '@/lib/books/own-numbers';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/**
 * GET /api/admin/books/own-numbers?show=invoice — Books → Own numbers
 * (src/lib/books/own-numbers.ts, docs/books.md "Own numbers"): whether
 * FleetSuite's own numbers is on, each kind's letters and next number, the
 * numbers FleetSuite took, newest first (of one kind when `show` names it),
 * with what became of each, and the sales orders and POs made in NetSuite
 * instead: since the day it went on, or the last 30 days while it's off.
 *
 * POST { type, prefix, next } — changes a kind's letters and next number.
 * A number already taken is never given again, whatever the next number is.
 * Audited.
 *
 * Super admins, the bookkeeper and the CPA see it; changing the numbers is
 * super admins' only (docs/books.md "Who can open the books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const asked = new URL(req.url).searchParams.get('show');
  const kind = isOwnNumberType(asked) ? asked : null;
  const service = createServiceClient();
  const now = new Date();
  try {
    const state = await readOwnNumbersSwitch(service);
    const since = outsideSince(state, now);
    const [series, numbers, outside] = await Promise.all([readSeries(service), readNumbers(service, kind), readOutside(service, since)]);
    const names = await readNames(service, [...series.map((r) => r.changed_by), ...numbers.map((r) => r.reserved_by)]);
    return NextResponse.json({
      now: now.toISOString(),
      on: state.on,
      changedAt: state.changedAt,
      kind,
      series: series.map((r) => seriesView(r, names)),
      numbers: numbers.map((r) => numberView(r, now, names)),
      numbersMore: numbers.length === NUMBERS_PAGE,
      since,
      offDays: OUTSIDE_DAYS_OFF,
      outside: outside.map(outsideView),
      outsideMore: outside.length === OUTSIDE_PAGE,
    });
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({
  type: z.string().max(40),
  prefix: z.string().max(40),
  next: z.union([z.number(), z.string().max(40)]),
});

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { type } = parsed.data;
  if (!isOwnNumberType(type)) return NextResponse.json({ error: "FleetSuite doesn't number that kind." }, { status: 400 });
  const change = seriesChange(parsed.data.prefix, parsed.data.next);
  if ('error' in change) return NextResponse.json({ error: change.error }, { status: 400 });
  const service = createServiceClient();
  try {
    const series = await readSeries(service);
    const was = series.find((r) => r.doc_type === type);
    if (!was) return NextResponse.json({ error: `FleetSuite has no numbers for ${OWN_NUMBER_KINDS[type].many.toLowerCase()}.` }, { status: 404 });
    const clash = lettersTakenBy(series, type, change.prefix);
    if (clash) return NextResponse.json({ error: `${clash} already use ${change.prefix}. Give each kind its own letters.` }, { status: 400 });
    const { data, error } = await service.rpc('own_number_series_set', {
      p_type: type, p_prefix: change.prefix, p_next: change.next, p_by: auth.user.id,
    });
    if (error) throw new Error(`Couldn't change the numbers: ${error.message}`);
    if (data !== true) return NextResponse.json({ error: `FleetSuite has no numbers for ${OWN_NUMBER_KINDS[type].many.toLowerCase()}.` }, { status: 404 });
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'own_number_series',
      recordId: type,
      action: 'change_own_numbers',
      detail: { type, prefix: change.prefix, next: change.next, was: { prefix: was.prefix, next: Number(was.next_seq) } },
    });
    return NextResponse.json({ type, prefix: change.prefix, next: change.next, nextNumber: `${change.prefix}${change.next}` });
  } catch (err) {
    return failed(err);
  }
}
