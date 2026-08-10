import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  scanIds: z.array(z.string().uuid()).min(1).max(20),
  storagePath: z.string().trim().min(1).max(1000),
  contentType: z.string().max(120).optional().nullable(),
});

/**
 * POST /api/scans/photos — attach an uploaded completion photo (K8) to the
 * scan_logs row(s) a capture just created. Service-role write because field
 * and CNI installers aren't internal staff (same reason scans themselves go
 * through /api/scans/log). The file is already on R2 (uploaded via the
 * storage shim); this records the linkage — one scan_photos row per scan id,
 * so a multi-part scan shows the photo on each part's Scan Log line.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  // Same self-enforced gate as /api/scans/log: approved accounts that are
  // not customer-only. Whoever may log a scan may photograph it.
  const { data: profile } = await supabase
    .from('profiles').select('role, roles, status').eq('id', auth.user.id).single();
  if (!profile || profile.status !== 'approved') {
    return NextResponse.json({ error: 'Account not approved' }, { status: 403 });
  }
  const roles: string[] = profile.roles?.length ? profile.roles : (profile.role ? [profile.role] : []);
  if (roles.includes('customer') && roles.length === 1) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { scanIds, storagePath, contentType } = parsed.data;

  try {
    // Attach only to rows that exist — a stale id (deleted scan) shouldn't
    // fail the whole batch.
    const { data: existing, error: readErr } = await supabase
      .from('scan_logs')
      .select('id')
      .in('id', scanIds);
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    const validIds = (existing || []).map(r => r.id);
    if (validIds.length === 0) {
      return NextResponse.json({ error: 'No matching scans' }, { status: 404 });
    }

    const rows = validIds.map(id => ({
      scan_log_id: id,
      storage_path: storagePath,
      content_type: contentType || null,
      taken_by: auth.user.id,
    }));
    const { error: insertErr } = await supabase.from('scan_photos').insert(rows);
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

    return NextResponse.json({ success: true, attached: validIds.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to save photo' }, { status: 500 });
  }
}
