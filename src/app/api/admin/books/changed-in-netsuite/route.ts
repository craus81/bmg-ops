import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { readNames } from '@/lib/books/netsuite-feed';
import { recordUrl } from '@/lib/netsuite-sends';
import { actOn, changeOf, readDifferences, recordsWin, shownValue } from '@/lib/fleetsuite-records';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/**
 * GET /api/admin/books/changed-in-netsuite — Books → Changed in NetSuite
 * (src/lib/fleetsuite-records.ts, docs/books.md "FleetSuite's record wins"):
 * whether FleetSuite's record wins is on, the fields of customers and vendors
 * where NetSuite has something else than FleetSuite, newest first, and the
 * last ones dealt with.
 *
 * POST { id, act: 'keep' | 'take' } — keeps FleetSuite's, sending it on to
 * NetSuite, or takes NetSuite's into FleetSuite's record. Only while it's on.
 * Audited.
 *
 * Super admin only, as the books are.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  try {
    const [on, list] = await Promise.all([recordsWin(service), readDifferences(service)]);
    const names = await readNames(service, list.closed.map((r) => r.closed_by));
    return NextResponse.json({
      on,
      open: list.open.map((r) => changeOf(r, names, recordUrl)),
      closed: list.closed.map((r) => changeOf(r, names, recordUrl)),
      more: list.more,
    });
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({
  id: z.string().uuid(),
  act: z.enum(['keep', 'take']),
});

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { id, act } = parsed.data;
  const service = createServiceClient();
  try {
    if (!(await recordsWin(service))) {
      return NextResponse.json({
        error: "FleetSuite's record wins is switched off, so NetSuite's changes come into FleetSuite as they do now. Nothing was changed.",
      }, { status: 409 });
    }
    const result = await actOn(service, { id, act, by: auth.user.id });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const { row } = result;
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'record_differences',
      recordId: id,
      action: act === 'keep' ? 'keep_fleetsuite_record' : 'take_netsuite_record',
      detail: {
        kind: row.kind,
        netsuite_id: row.netsuite_id,
        name: row.name,
        field: row.field,
        outcome: result.status,
        fleetsuite: shownValue(row.fleetsuite_value),
        netsuite: shownValue(row.netsuite_value),
      },
    });
    return NextResponse.json({ id, status: result.status });
  } catch (err) {
    return failed(err);
  }
}
