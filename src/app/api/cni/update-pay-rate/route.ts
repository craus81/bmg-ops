import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { repriceJobCredits } from '@/lib/pay-credits';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  jobId: z.string().uuid(),
  rate: z.number().min(0).max(100000).nullable(),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Admin: change a CNI job's per-vehicle pay rate AND re-price the credits
 * already on the books to match. Vehicles that were completed before the
 * change get the new rate retroactively (preserving their crew split); any
 * already on a payout are locked and left untouched. Returns how many
 * vehicles were re-priced and how many were skipped as locked.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, rate } = parsed.data;

  const { error: upErr } = await supabase
    .from('cni_jobs')
    .update({ pay_per_vehicle: rate, updated_by: auth.user.id })
    .eq('id', jobId);
  if (upErr) {
    return NextResponse.json({ error: 'Failed to update rate: ' + upErr.message }, { status: 500 });
  }

  const result = await repriceJobCredits(supabase, { cniJobId: jobId, rate, editedBy: auth.user.id });
  if (!result.ok) {
    return NextResponse.json({ error: 'Rate saved, but re-pricing failed: ' + result.error }, { status: 500 });
  }

  return NextResponse.json({ success: true, repriced: result.repriced, lockedSkipped: result.lockedSkipped });
}
