import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { statusAfterFixBy, type QcStatus } from '@/lib/qc-fixes';
import { qcPhotoSignedUrl } from '@/lib/qc-fixes-server';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const COLUMNS = 'id, customer_id, vin_last6, vin, checkin_id, vehicle_label, reported_by_name, comments, status, fix_by, note_to_customer, fixed_at, fixed_by, fixed_email_sent_at, created_at, updated_at';

const ListSchema = z.object({
  id: z.string().uuid().optional(),
  show: z.enum(['new', 'scheduled', 'fixed']).optional(),
  /** Every report on one vehicle (the vehicle page's QC section). */
  vin: z.string().trim().min(6).max(17).optional(),
});

/**
 * GET /api/qc-fixes — the QC Fixes page (migration 380): reports a
 * customer's QC team sent through their link, by tab (new / scheduled /
 * fixed), with tab counts. `id` adds that one report whatever its tab, so
 * the alert's link always opens it. `vin` lists one vehicle's reports.
 * Scheduled sorts by fix-by date (soonest first); the others newest first.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = validateSearchParams(req, ListSchema);
  if (parsed.error) return parsed.error;
  const { id, show = 'new', vin } = parsed.data;

  let query = supabase.from('qc_fix_reports').select(COLUMNS);
  if (vin) {
    query = query.eq('vin', vin.toUpperCase()).order('created_at', { ascending: false });
  } else {
    query = query.eq('status', show);
    query = show === 'scheduled'
      ? query.order('fix_by', { ascending: true }).order('created_at', { ascending: true })
      : query.order(show === 'fixed' ? 'fixed_at' : 'created_at', { ascending: false });
  }
  const { data: rows, error } = await query.order('id').limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const reports = [...(rows || [])];
  if (id && !reports.some(r => r.id === id)) {
    const { data: one } = await supabase.from('qc_fix_reports').select(COLUMNS).eq('id', id).maybeSingle();
    if (one) reports.unshift(one);
  }

  const ids = reports.map(r => r.id);
  const customerIds = [...new Set(reports.map(r => r.customer_id))];
  const userIds = [...new Set(reports.map(r => r.fixed_by).filter(Boolean))] as string[];
  const count = (status: QcStatus) => supabase.from('qc_fix_reports').select('id', { count: 'exact', head: true }).eq('status', status);
  const [{ data: photos }, { data: customers }, { data: people }, { count: newCount }, { count: scheduledCount }] = await Promise.all([
    ids.length ? supabase.from('qc_fix_photos').select('id, report_id, kind, file_name, storage_path, size_bytes').in('report_id', ids).order('created_at').order('id') : Promise.resolve({ data: [] as any[] }),
    customerIds.length ? supabase.from('customers').select('id, company_name, qc_notify_emails').in('id', customerIds) : Promise.resolve({ data: [] as any[] }),
    userIds.length ? supabase.from('profiles').select('id, full_name').in('id', userIds) : Promise.resolve({ data: [] as any[] }),
    count('new'),
    count('scheduled'),
  ]);
  const customerById = new Map((customers || []).map((c: any) => [c.id, c]));
  const nameById = new Map((people || []).map((p: any) => [p.id, p.full_name]));
  const photosBy = new Map<string, any[]>();
  // Signed (1 h) so the page's <img> tags load without a session header.
  const signed = await Promise.all((photos || []).map(async (p: any) => ({
    id: p.id, report_id: p.report_id, kind: p.kind, file_name: p.file_name, size_bytes: p.size_bytes,
    url: await qcPhotoSignedUrl(p).catch(() => null),
  })));
  for (const p of signed) photosBy.set(p.report_id, [...(photosBy.get(p.report_id) || []), { id: p.id, kind: p.kind, file_name: p.file_name, size_bytes: p.size_bytes, url: p.url }]);

  return NextResponse.json({
    newCount: newCount ?? 0,
    scheduledCount: scheduledCount ?? 0,
    reports: reports.map(r => ({
      ...r,
      customer_name: customerById.get(r.customer_id)?.company_name || null,
      customer_emails: customerById.get(r.customer_id)?.qc_notify_emails || [],
      fixed_by_name: r.fixed_by ? nameById.get(r.fixed_by) || null : null,
      photos: photosBy.get(r.id) || [],
    })),
  });
}

const PatchSchema = z.object({
  id: z.string().uuid(),
  /** YYYY-MM-DD, or null to clear. Setting one schedules a new report. */
  fixBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** Shown to the customer on their link next to the fix-by date. */
  note: z.string().trim().max(1000).nullable().optional(),
  /** Mark fixed without emailing anyone (the email path marks it fixed itself). */
  fixed: z.boolean().optional(),
});

/** PATCH /api/qc-fixes — set the fix-by date / note, mark fixed without an email, or reopen. */
export async function PATCH(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { id, fixBy, note, fixed } = parsed.data;

  const { data: report } = await supabase.from('qc_fix_reports').select('id, status, fix_by').eq('id', id).maybeSingle();
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now };
  if (note !== undefined) update.note_to_customer = note || null;
  let status = report.status as QcStatus;
  if (fixed === true) {
    status = 'fixed';
    update.fixed_at = now;
    update.fixed_by = auth.user.id;
  } else if (fixed === false) {
    status = 'new';
    update.fixed_at = null;
    update.fixed_by = null;
  }
  const nextFixBy = fixBy !== undefined ? fixBy : report.fix_by;
  if (fixBy !== undefined) update.fix_by = fixBy;
  update.status = statusAfterFixBy(status, nextFixBy);

  const { error } = await supabase.from('qc_fix_reports').update(update).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'qc_fix_reports',
    recordId: id,
    action: fixed === true ? 'qc_fix_marked_fixed' : fixed === false ? 'qc_fix_reopened' : 'qc_fix_updated',
    detail: { fixBy: fixBy ?? undefined, status: update.status },
  });
  return NextResponse.json({ ok: true, status: update.status });
}
