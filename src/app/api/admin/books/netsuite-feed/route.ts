import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import {
  FEED_KINDS, feedSend, lookRefusal, markLooked, readNames, readSends, readSummary, readToLook, SEND_COLUMNS,
  type FeedFilter, type SendRecord,
} from '@/lib/books/netsuite-feed';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

const FILTERS: readonly FeedFilter[] = ['all', 'took', 'refused', 'unsure'];

/**
 * GET /api/admin/books/netsuite-feed?show=all|took|refused|unsure&kind=invoice&page=0 —
 * Books → NetSuite feed (src/lib/books/netsuite-feed.ts, docs/books.md
 * "NetSuite feed"): every send FleetSuite made to NetSuite, newest first, a
 * page of 50 at a time, with what NetSuite answered; how many it took,
 * refused and left FleetSuite unsure about in the last 7 days; and the sends
 * FleetSuite can't be sure about that nobody has looked for in NetSuite yet.
 *
 * POST { id, note } — notes that a super admin looked for one of those in
 * NetSuite, and what they found. Audited.
 *
 * Super admin only, as the books are.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const asked = params.get('show') as FeedFilter | null;
  const filter = asked && FILTERS.includes(asked) ? asked : 'all';
  const kind = FEED_KINDS.find((k) => k.key === params.get('kind'))?.key ?? null;
  const page = Math.min(Math.max(Number.parseInt(params.get('page') ?? '0', 10) || 0, 0), 1000);
  const service = createServiceClient();
  const now = new Date();
  try {
    const [summary, toLook, sends] = await Promise.all([
      readSummary(service, now),
      readToLook(service, now),
      readSends(service, { now, filter, kind, page }),
    ]);
    const rows = [...toLook, ...sends.rows];
    const names = await readNames(service, rows.flatMap((r) => [r.user_id, r.looked_by]));
    return NextResponse.json({
      now: now.toISOString(),
      show: filter,
      kind,
      page,
      kinds: FEED_KINDS,
      summary,
      toLook: toLook.map((r) => feedSend(r, now, names)),
      sends: sends.rows.map((r) => feedSend(r, now, names)),
      more: sends.more,
    });
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({
  id: z.string().uuid(),
  note: z.string().max(300).optional().default(''),
});

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { id } = parsed.data;
  const note = parsed.data.note.trim() || null;
  const service = createServiceClient();
  const now = new Date();
  try {
    const { data, error } = await service.from('netsuite_sends').select(SEND_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw new Error(`Couldn't read the send: ${error.message}`);
    const refused = lookRefusal(data as SendRecord | null, now);
    if (refused) return NextResponse.json({ error: refused.message }, { status: refused.status });
    if (!(await markLooked(service, { id, by: auth.user.id, note, now }))) {
      return NextResponse.json({ error: 'Someone has already looked at this one.' }, { status: 409 });
    }
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'netsuite_sends',
      recordId: id,
      action: 'look_at_send',
      detail: { note },
    });
    return NextResponse.json({ id, lookedAt: now.toISOString() });
  } catch (err) {
    return failed(err);
  }
}
