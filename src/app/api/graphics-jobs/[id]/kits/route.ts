import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { loadJobKits, linkFleetCheckins } from '@/lib/graphics-fleet';
import { isFinishedStatus } from '@/lib/graphics-status';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

async function readJob(id: string) {
  const { data } = await supabase.from('graphics_jobs').select('id, job_number, status, fleet_group_id').eq('id', id).maybeSingle();
  return data;
}

/**
 * GET /api/graphics-jobs/[id]/kits — the kits of a fleet order job
 * (migration 411): one per vehicle in the order, with its unit number,
 * estimate / SO, whether the vehicle is here, and whether its kit is on.
 * An ordinary job answers no kits.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const job = await readJob(params.id);
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (!job.fleet_group_id) return NextResponse.json({ kits: [] });
    // A vehicle checked in since the job was made links to it here, so it
    // never sits on the Needs Graphics queue waiting for a person.
    const kits = await loadJobKits(supabase, job);
    if (await linkFleetCheckins(supabase, job.id, kits.map(k => k.estimateId)) > 0) {
      return NextResponse.json({ kits: await loadJobKits(supabase, job) });
    }
    return NextResponse.json({ kits });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

const Schema = z.object({
  estimateId: z.string().uuid(),
  installed: z.boolean(),
});

/**
 * POST /api/graphics-jobs/[id]/kits — mark one vehicle's kit installed, or
 * undo it. The job stays in Ready while kits are still out (Craig,
 * 2026-10-19: "1 of 3 installed"); `allInstalled` tells the job page to
 * move it to Installed when the last one goes on.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { estimateId, installed } = parsed.data;

  try {
    const job = await readJob(params.id);
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    const kits = await loadJobKits(supabase, job);
    const kit = kits.find(k => k.estimateId === estimateId);
    if (!kit) return NextResponse.json({ error: 'That vehicle is not in this job’s fleet order.' }, { status: 404 });

    const unit = kit.unitNumber ? `unit ${kit.unitNumber}` : kit.estimateNumber;
    if (installed) {
      const { error } = await supabase.from('graphics_job_kits').upsert(
        { job_id: job.id, estimate_id: estimateId, installed_at: new Date().toISOString(), installed_by: auth.user?.id || null },
        { onConflict: 'job_id,estimate_id' },
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      const { error } = await supabase.from('graphics_job_kits').delete().eq('job_id', job.id).eq('estimate_id', estimateId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const after = await loadJobKits(supabase, job);
    const done = after.filter(k => k.installedAt).length;
    await supabase.from('graphics_status_history').insert({
      job_id: job.id,
      from_status: job.status,
      to_status: job.status,
      changed_by: auth.user?.id || null,
      note: installed
        ? `Kit for ${unit} installed (${done} of ${after.length})`
        : `Kit for ${unit} marked not installed (${done} of ${after.length})`,
    });

    // The job page moves the job to Installed through its normal status
    // change (history, billing ask, calendar) when this was the last kit.
    const allInstalled = installed && done === after.length && !isFinishedStatus(job.status as any);
    return NextResponse.json({ success: true, kits: after, allInstalled });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
