import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { rewriteVehicleCredits, recomputeShiftCredits, backfillJobCredits, assignVehicleCredits } from '@/lib/pay-credits';
import { memberViews } from '@/lib/shifts';
import { logAudit } from '@/lib/audit';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GetSchema = z.object({
  cniJobId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
});

/**
 * Admin view of shifts + credits for the editor: every shift on a CNI job
 * (or one shift by id) with its active members and live credit rows.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;
  if (!q.data.cniJobId && !q.data.shiftId) {
    return NextResponse.json({ error: 'cniJobId or shiftId required' }, { status: 400 });
  }

  // Paginated: a long-running job's shift/credit history can exceed the
  // 1000-row cap, and a truncated editor view hides credits an admin would
  // then "correct" by re-adding — duplicating pay.
  const { data: shifts, error: shiftsErr } = await fetchAllRows<{
    id: string; context: string; cni_job_id: string | null; part_number: string | null;
    location_name: string | null; started_by: string; started_at: string; ended_at: string | null;
  }>((from, to) => {
    let shiftsQuery = service
      .from('work_shifts')
      .select('id, context, cni_job_id, part_number, location_name, started_by, started_at, ended_at')
      .order('started_at', { ascending: false })
      .order('id');
    if (q.data.shiftId) shiftsQuery = shiftsQuery.eq('id', q.data.shiftId);
    else shiftsQuery = shiftsQuery.eq('cni_job_id', q.data.cniJobId!);
    return shiftsQuery.range(from, to);
  });
  if (shiftsErr) {
    return NextResponse.json({ error: 'Failed to load shifts: ' + shiftsErr.message }, { status: 500 });
  }
  if (shifts.length === 0) return NextResponse.json({ shifts: [] });

  const shiftIds = shifts.map(s => s.id);
  // Chunked .in() + per-chunk pagination, same reason as above.
  const credits: any[] = [];
  for (let i = 0; i < shiftIds.length; i += 200) {
    const { data, error } = await fetchAllRows<any>((from, to) => service
      .from('install_credits')
      .select('id, shift_id, profile_id, scan_log_id, cni_job_vin_id, vin, part_number, rate_per_vehicle, share_weight, crew_size, total_weight, amount, payout_id, voided_at, created_at, edited_by, edited_at')
      .in('shift_id', shiftIds.slice(i, i + 200))
      .is('voided_at', null)
      .order('created_at')
      .order('id')
      .range(from, to));
    if (error) {
      return NextResponse.json({ error: 'Failed to load credits: ' + error.message }, { status: 500 });
    }
    credits.push(...data);
  }

  const profileIds = [...new Set([
    ...(credits || []).map(c => c.profile_id),
    ...shifts.map(s => s.started_by),
  ])];
  const { data: profiles } = profileIds.length
    ? await service.from('profiles').select('id, full_name').in('id', profileIds)
    : { data: [] as { id: string; full_name: string }[] };
  const names = new Map((profiles || []).map(p => [p.id, p.full_name]));

  const out = [];
  for (const s of shifts) {
    out.push({
      ...s,
      started_by_name: names.get(s.started_by) || 'Unknown',
      members: await memberViews(service, s.id),
      credits: (credits || [])
        .filter(c => c.shift_id === s.id)
        .map(c => ({ ...c, profile_name: names.get(c.profile_id) || 'Unknown' })),
    });
  }
  return NextResponse.json({ shifts: out });
}

const PostSchema = z.union([
  z.object({
    action: z.literal('rewrite_vehicle'),
    scanLogId: z.string().uuid().optional().nullable(),
    cniJobVinId: z.string().uuid().optional().nullable(),
    entries: z.array(z.object({
      profileId: z.string().uuid(),
      weight: z.number().positive().max(99),
    })).min(1).max(50),
  }),
  z.object({
    action: z.literal('recompute_shift'),
    shiftId: z.string().uuid(),
  }),
  z.object({
    action: z.literal('backfill_job'),
    cniJobId: z.string().uuid(),
    entries: z.array(z.object({
      profileId: z.string().uuid(),
      weight: z.number().positive().max(99),
    })).min(1).max(50),
  }),
  z.object({
    action: z.literal('assign_vehicle'),
    cniJobVinId: z.string().uuid(),
    entries: z.array(z.object({
      profileId: z.string().uuid(),
      weight: z.number().positive().max(99),
    })).min(1).max(50),
  }),
]);

/**
 * Admin corrections (audit-logged; locked/paid-out credits are refused):
 *  - rewrite_vehicle: replace one vehicle's credit list/weights.
 *  - recompute_shift: rewrite every unlocked vehicle on the shift from the
 *    shift's CURRENT roster ("Joe wasn't there Tuesday").
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;

  if (parsed.data.action === 'rewrite_vehicle') {
    const r = await rewriteVehicleCredits(service, {
      scanLogId: parsed.data.scanLogId,
      cniJobVinId: parsed.data.cniJobVinId,
      entries: parsed.data.entries.map(e => ({ profile_id: e.profileId, share_weight: e.weight })),
      editedBy: auth.user.id,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'install_credits',
      recordId: parsed.data.scanLogId || parsed.data.cniJobVinId || null,
      action: 'rewrite_vehicle',
      detail: { entries: parsed.data.entries },
    });
    return NextResponse.json({ success: true });
  }

  if (parsed.data.action === 'backfill_job') {
    const r = await backfillJobCredits(service, {
      cniJobId: parsed.data.cniJobId,
      entries: parsed.data.entries.map(e => ({ profile_id: e.profileId, share_weight: e.weight })),
      createdBy: auth.user.id,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'install_credits',
      recordId: parsed.data.cniJobId,
      action: 'backfill_job',
      detail: { entries: parsed.data.entries, created: r.created, skipped: r.skipped },
    });
    return NextResponse.json({ success: true, created: r.created, skipped: r.skipped });
  }

  if (parsed.data.action === 'assign_vehicle') {
    const r = await assignVehicleCredits(service, {
      cniJobVinId: parsed.data.cniJobVinId,
      entries: parsed.data.entries.map(e => ({ profile_id: e.profileId, share_weight: e.weight })),
      assignedBy: auth.user.id,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'install_credits',
      recordId: parsed.data.cniJobVinId,
      action: 'assign_vehicle',
      detail: { entries: parsed.data.entries },
    });
    return NextResponse.json({ success: true });
  }

  const r = await recomputeShiftCredits(service, parsed.data.shiftId, auth.user.id);
  if (!r.ok) return NextResponse.json({ error: r.error, rewritten: r.rewritten }, { status: 400 });
  await logAudit(service, {
    actorId: auth.user.id,
    table: 'install_credits',
    recordId: parsed.data.shiftId,
    action: 'recompute_shift',
    detail: { rewritten: r.rewritten, lockedSkipped: r.lockedSkipped },
  });
  return NextResponse.json({ success: true, rewritten: r.rewritten, lockedSkipped: r.lockedSkipped });
}
