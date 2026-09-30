import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  scanIds: z.array(z.string().uuid()).min(1).max(1000),
  archive: z.boolean(),
  reason: z.string().max(500).optional().nullable(),
});

/**
 * Archive (or unarchive) scans from the Scan Log without invoicing them.
 * An archived scan leaves the invoicing queue and the Ready/Waiting counts
 * (they all filter archived_at IS NULL) but still counts as an install for
 * installer pay and My week. Anyone who can open the Scan Log (the
 * 'reports' feature) may do this. Unarchive clears the reason and who.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'reports');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { scanIds, archive } = parsed.data;
  const reason = parsed.data.reason?.trim() || null;

  const updates = archive
    ? { archived_at: new Date().toISOString(), archived_by: auth.user.id, archive_reason: reason }
    : { archived_at: null, archived_by: null, archive_reason: null };

  // Archiving only touches live scans, so re-archiving never overwrites the
  // original date, reason or who.
  let query = supabase.from('scan_logs').update(updates).in('id', scanIds);
  query = archive ? query.is('archived_at', null) : query.not('archived_at', 'is', null);
  const { data, error } = await query.select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'scan_logs',
    recordId: null,
    action: archive ? 'archive' : 'unarchive',
    detail: { updated: data?.length || 0, scanIds, reason },
  });

  return NextResponse.json({ success: true, updated: data?.length || 0 });
}
