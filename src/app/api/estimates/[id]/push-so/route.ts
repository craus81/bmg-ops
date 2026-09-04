import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { updateSalesOrderLines } from '@/lib/netsuite';
import { estimateContextMemo } from '@/lib/estimate-document';
import { buildSoLineItems, soContentHash } from '@/lib/so-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({
  /** Why the sales order is being changed — audited alongside the diff. */
  reason: z.string().trim().min(3).max(500),
});

/**
 * POST /api/estimates/[id]/push-so — push an edited estimate's lines to
 * the NetSuite sales order already created from it (migration 259).
 *
 * Admin only, with a recorded reason. Never automatic: the builder asks
 * after an accepted estimate is saved with changes, and the SO banner
 * offers it again while the estimate is out of date. Uses the SAME line
 * builder as convert-to-so, so create and update can't drift; a missing
 * labor item or an unmappable custom line is reported and BLOCKS the push
 * (a replace-all PATCH that dropped the labor line would remove revenue
 * from a live order — strictly worse than not pushing).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  const roles: string[] = auth.profile?.roles?.length > 0 ? auth.profile.roles : [auth.profile?.role];
  if (!roles.includes('admin') && !roles.includes('super_admin')) {
    return NextResponse.json({ error: 'Only an admin can push changes to a sales order.' }, { status: 403 });
  }

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: estimate, error } = await supabase
    .from('estimates')
    .select('*, estimate_line_items(*), vehicle_platforms(label)')
    .eq('id', params.id)
    .single();
  if (error || !estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (!estimate.netsuite_so_id) {
    return NextResponse.json({ error: 'This estimate has no sales order to update — convert it first.' }, { status: 400 });
  }
  (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;
  const lines = estimate.estimate_line_items || [];

  const build = await buildSoLineItems(supabase, estimate, lines);
  if (build.soLineItems.length === 0) {
    return NextResponse.json({ error: 'No line items could be mapped to NetSuite — nothing was changed on the sales order.', unmappedLines: build.unmappedLineDescriptions }, { status: 400 });
  }
  // A replace-all push must carry everything or nothing.
  if (build.laborSkipped) {
    return NextResponse.json({
      error: `The estimate has ${build.laborHours} labor hours but no NetSuite labor item is configured (Settings → NetSuite Labor Item). Pushing now would remove labor from the sales order — nothing was changed.`,
      step: 'labor_item',
    }, { status: 409 });
  }
  if (build.unmappedLineDescriptions.length > 0) {
    return NextResponse.json({
      error: `These lines can't be mapped to NetSuite (create the FS-CUSTOM placeholder item): ${build.unmappedLineDescriptions.join(', ')}. Nothing was changed.`,
      step: 'line_items',
      unmappedLines: build.unmappedLineDescriptions,
    }, { status: 409 });
  }

  const result = await updateSalesOrderLines(estimate.netsuite_so_id, {
    lineItems: build.soLineItems,
    poNumber: estimate.po_number?.trim() || estimate.estimate_number,
    memo: estimateContextMemo(estimate),
    vin: estimate.vin || null,
  });
  if (!result.success) {
    return NextResponse.json({ error: `NetSuite refused the update: ${result.error}. The sales order was not changed.`, step: 'update_so' }, { status: 502 });
  }

  const hash = soContentHash(estimate, lines);
  const now = new Date().toISOString();
  await supabase
    .from('estimates')
    .update({ so_pushed_hash: hash, so_synced_at: now, so_out_of_date: false })
    .eq('id', params.id);

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'estimates',
    recordId: params.id,
    action: 'so_push_after_edit',
    detail: {
      reason: parsed.data.reason,
      estimate_number: estimate.estimate_number,
      netsuite_so_id: estimate.netsuite_so_id,
      netsuite_so_number: estimate.netsuite_so_number,
      previous_hash: estimate.so_pushed_hash || null,
      new_hash: hash,
      lines: build.soLineItems.length,
      labor_hours: build.laborHours,
      grand_total: estimate.grand_total,
    },
  });

  return NextResponse.json({
    success: true,
    salesOrderNumber: estimate.netsuite_so_number || null,
    lines: build.soLineItems.length,
    customLines: build.customLineDescriptions,
    laborItemNumber: build.laborItemNumber,
  });
}
