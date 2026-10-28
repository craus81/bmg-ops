import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { validateExpiry, checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { loadEstimateGraphics, loadEstimateProofs } from '@/lib/estimate-graphics';
import { publicEstimate, publicLines, publicProofs, loadApprovalLines } from '@/lib/estimate-approval-view';
import { loadApprovalDownloads } from '@/lib/estimate-approval-downloads';
import { recordQuoteView } from '@/lib/quote-view-recorder';
import { compareUnits } from '@/lib/estimate-fleet';
import { vehicleDescription } from '@/lib/estimate-document';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

/**
 * GET /api/approve/fleet/[token]
 *
 * The approval page of a fleet order sent in one email (migration 412,
 * Craig 2026-10-19). The token is the approval token of the estimate the
 * email was sent from; the order's other vehicles are the estimates sharing
 * its approval_batch_id. Each vehicle comes back with ITS OWN token: the
 * page approves a vehicle by POSTing to /api/approve/estimate/[that token],
 * so every approval is recorded, fingerprinted and snapshotted on its own
 * estimate exactly as a single approval is. Whoever holds this link was
 * sent all of those links in the same email, so handing them back gives
 * nothing new.
 *
 * Also returns one vehicle's full estimate (the first still open, else the
 * sender's) so the page can show what each vehicle gets.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  const allowed = await checkRateLimit(ip, 'approve_fleet_get');
  if (!allowed) {
    return NextResponse.json({ error: 'Too many attempts, please wait and retry.', status: 'error' }, { status: 429 });
  }

  const { data: main } = await supabase
    .from('estimates')
    .select('id, approval_batch_id, approval_token_expires_at')
    .eq('approval_token', params.token)
    .maybeSingle();
  if (!main) return NextResponse.json({ status: 'invalid', error: 'not_found' }, { status: 404 });
  if (!validateExpiry(main.approval_token_expires_at).ok) return NextResponse.json({ status: 'expired' }, { status: 410 });
  // Sent on its own since (a single send clears the batch): the page sends
  // the customer to that estimate's own approval page.
  if (!main.approval_batch_id) return NextResponse.json({ status: 'single' });

  const { data: rows } = await supabase
    .from('estimates')
    .select('*, vehicle_platforms(label)')
    .eq('approval_batch_id', main.approval_batch_id);
  const members = (rows || [])
    .map(e => ({ ...e, vehicle_platform_label: (e as any).vehicle_platforms?.label || null }))
    .sort((a, b) => compareUnits(a.unit_number, b.unit_number));
  if (members.length === 0) return NextResponse.json({ status: 'invalid', error: 'not_found' }, { status: 404 });

  // Picked together on the Estimates list (Craig, 2026-10-28) rather than
  // one fleet order: different jobs, so the page lists each estimate with
  // what it is for and shows no single estimate's items as everyone's.
  const batch = !members.every(e => e.fleet_group_id && e.fleet_group_id === members[0].fleet_group_id);

  const vehicles = members.map(e => ({
    token: e.approval_token as string,
    estimateNumber: e.estimate_number,
    title: e.title || null,
    vehicle: vehicleDescription(e) || null,
    unitNumber: e.unit_number || null,
    stockNumber: e.stock_number || null,
    vin: e.vin || null,
    grandTotal: Number(e.grand_total) || 0,
    state: e.customer_approved
      ? 'approved'
      : e.customer_rejected_at
        ? 'rejected'
        : validateExpiry(e.approval_token_expires_at).ok ? 'open' : 'expired',
    decidedAt: e.customer_approved_at || e.customer_rejected_at || null,
  }));

  const shown = members.find(e => !e.customer_approved && !e.customer_rejected_at) || members.find(e => e.id === main.id) || members[0];
  const [lines, { summaries: graphics }, proofs] = await Promise.all([
    loadApprovalLines(supabase, shown.id),
    loadEstimateGraphics(supabase, shown.id),
    loadEstimateProofs(supabase, shown.id, undefined),
  ]);
  // A batch's estimates carry their own proofs: the agreement names proofs
  // when any of them has some (each accept stamps its own anyway).
  const anyProofs = proofs.length > 0 || (batch && (await Promise.all(
    members.filter(e => e.id !== shown.id).map(e => loadEstimateProofs(supabase, e.id, undefined)),
  )).some(p => p.length > 0));

  if (vehicles.some(v => v.state === 'open')) {
    await recordQuoteView(supabase, {
      type: 'estimate',
      id: main.id,
      req,
      sentAt: shown.sent_for_approval_at || null,
      repIds: [shown.sent_for_approval_by, shown.created_by],
      label: `${batch ? 'Estimates' : 'Fleet order'} of ${members.length} (${members.map(e => `#${e.estimate_number}`).join(', ')})`,
      customerName: shown.customer_name || null,
    });
  }

  return NextResponse.json({
    status: 'ready',
    batch,
    anyProofs,
    customerName: shown.customer_name || null,
    title: shown.title || null,
    vehicle: vehicleDescription(shown) || null,
    vehicles,
    shown: {
      token: shown.approval_token,
      estimate: publicEstimate(shown),
      lines: publicLines(lines),
      graphics,
      proofs: publicProofs(proofs),
      downloads: await loadApprovalDownloads(supabase, shown, proofs, '', shown.approval_token),
    },
  });
}
