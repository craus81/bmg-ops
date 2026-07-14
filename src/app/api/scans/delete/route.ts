import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/scans/delete — delete scan_logs rows, handling their pay credits.
 *
 * A scan logged during a shift carries install_credits rows (the per-vehicle
 * pay ledger) that reference it with a plain FK, so a bare DELETE on the scan
 * is refused by Postgres — which is why client-side deletes silently did
 * nothing. Deleting a mistaken scan deletes its unpaid credits with it (a
 * mistaken scan means a mistaken credit). Credits already attached to a
 * payout are money that has been or is being paid out; those scans are
 * reported back as blocked instead of quietly rewriting payroll history.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { ids } = parsed.data;

  try {
    const { data: credits, error: creditsErr } = await service
      .from('install_credits')
      .select('id, scan_log_id, payout_id')
      .in('scan_log_id', ids);
    if (creditsErr) {
      return NextResponse.json({ error: 'Failed to check pay credits: ' + creditsErr.message }, { status: 500 });
    }

    const blockedIds = new Set((credits || []).filter(c => c.payout_id).map(c => c.scan_log_id as string));
    const deletableIds = ids.filter(id => !blockedIds.has(id));

    let blocked: { id: string; vin: string | null }[] = [];
    if (blockedIds.size > 0) {
      const { data: rows } = await service
        .from('scan_logs')
        .select('id, vin')
        .in('id', [...blockedIds]);
      blocked = (rows || []).map(r => ({ id: r.id, vin: r.vin }));
    }

    if (deletableIds.length > 0) {
      const creditIds = (credits || [])
        .filter(c => c.scan_log_id && deletableIds.includes(c.scan_log_id) && !c.payout_id)
        .map(c => c.id);
      if (creditIds.length > 0) {
        const { error } = await service.from('install_credits').delete().in('id', creditIds);
        if (error) {
          return NextResponse.json({ error: 'Failed to delete pay credits: ' + error.message }, { status: 500 });
        }
      }

      // cni_job_vins.scan_log_id is ON DELETE SET NULL, so job links clear
      // themselves; anything else still referencing the scan surfaces here.
      const { error } = await service.from('scan_logs').delete().in('id', deletableIds);
      if (error) {
        return NextResponse.json({ error: 'Failed to delete scans: ' + error.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, deleted: deletableIds.length, blocked });
  } catch (err: any) {
    console.error('Delete scans error:', err);
    return NextResponse.json({ error: err.message || 'Failed to delete scans' }, { status: 500 });
  }
}
