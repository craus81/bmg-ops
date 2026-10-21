import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { sanitizeCopiedProofs } from '@/lib/estimate-copied-proofs';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/estimates/[id]/copied-proofs?jobId= — stop showing an art
 * proof a duplicate brought along from the original's graphics job
 * (src/lib/estimate-copied-proofs.ts). Same locks as graphics-attach: what
 * the customer approved, or what became a Sales Order, stays as it is.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const jobId = req.nextUrl.searchParams.get('jobId') || '';
  if (!UUID.test(params.id) || !UUID.test(jobId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const { data: estimate } = await supabase
    .from('estimates')
    .select('id, customer_approved, status, netsuite_so_id, copied_graphics_proofs')
    .eq('id', params.id)
    .maybeSingle();
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (estimate.netsuite_so_id) {
    return NextResponse.json({ error: 'This estimate was already converted to a Sales Order — its contents are locked.' }, { status: 409 });
  }
  if (estimate.customer_approved || estimate.status === 'accepted') {
    return NextResponse.json({ error: 'This estimate was accepted by the customer — what they approved is locked. Start a new estimate instead.' }, { status: 409 });
  }

  const before = sanitizeCopiedProofs(estimate.copied_graphics_proofs);
  const next = before.filter(p => p.job_id !== jobId);
  if (next.length === before.length) return NextResponse.json({ success: true, copied: next });

  const { error } = await supabase
    .from('estimates')
    .update({ copied_graphics_proofs: next.length > 0 ? next : null, updated_at: new Date().toISOString(), updated_by: auth.user.id })
    .eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'estimates',
    recordId: params.id,
    action: 'estimate_copied_proof_removed',
    detail: { graphics_job_id: jobId },
  });
  return NextResponse.json({ success: true, copied: next });
}
