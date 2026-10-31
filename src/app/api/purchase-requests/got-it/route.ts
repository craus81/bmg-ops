import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { computePartsReadiness } from '@/lib/parts-readiness';
import { afterReservationChange } from '@/lib/job-schedule-alerts';

const supabase = createServiceClient();

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({
  projectId: z.string().uuid(),
  /** The row's line_key from the readiness card (item::description). */
  lineKey: z.string().min(1).max(2200),
  undo: z.boolean().optional().default(false),
});

/**
 * POST /api/purchase-requests/got-it — "Got it" on a generic part's line
 * (Misc) on the job's Parts Readiness card: it's here, for things bought at
 * the counter or on a card with no PO (Craig, 2026-10-31, option C;
 * migration 460). Marks the line's requests received; with none behind it,
 * adds one already received, so the line is covered. Undo puts it back.
 *
 * Only generic lines: a real part is received at Receiving against its PO.
 * Returns the recomputed readiness, so the card repaints in one round trip.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { projectId, lineKey, undo } = parsed.data;

  const before = await computePartsReadiness(supabase, projectId);
  if (!before.available) {
    return NextResponse.json({ error: before.reason === 'no_sales_order' ? 'Link a sales order first.' : (before.error || 'Parts readiness is unavailable right now.') }, { status: 422 });
  }
  const row = (before.parts || []).find(p => p.line_key === lineKey);
  if (!row) return NextResponse.json({ error: 'That line isn’t on this job’s sales order any more. Refresh the card.' }, { status: 404 });
  if (!row.generic) return NextResponse.json({ error: `${row.item_number} isn’t a generic part. Receive it at Receiving against its PO.` }, { status: 422 });

  const now = new Date().toISOString();
  const ids = row.request_ids || [];
  if (undo) {
    if (ids.length > 0) {
      // A "Got it" row with nothing else behind it goes away. A request
      // that was still in the Purchasing queue (ordered by Got it, no PO)
      // goes back there; one ordered on a PO just loses its received mark.
      const { data: reqs, error: readErr } = await supabase.from('purchase_requests')
        .select('id, source, ordered_po_id, ordered_po_number, ordered_match')
        .in('id', ids).not('received_at', 'is', null);
      if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
      for (const r of reqs || []) {
        const update = r.source === 'got_it'
          ? { status: 'cancelled', received_at: null, received_by: null, updated_at: now }
          : !r.ordered_po_id && !r.ordered_po_number && !r.ordered_match
            ? { status: 'pending', ordered_at: null, ordered_by: null, received_at: null, received_by: null, updated_at: now }
            : { received_at: null, received_by: null, updated_at: now };
        const { error } = await supabase.from('purchase_requests').update(update).eq('id', r.id);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  } else if (ids.length > 0) {
    // Pending asks leave the Purchasing queue: nothing left to buy.
    const { error } = await supabase.from('purchase_requests')
      .update({ received_at: now, received_by: auth.user!.id, updated_at: now })
      .in('id', ids).neq('status', 'pending');
    const { error: pendErr } = await supabase.from('purchase_requests')
      .update({ status: 'ordered', ordered_at: now, ordered_by: auth.user!.id, received_at: now, received_by: auth.user!.id, updated_at: now })
      .in('id', ids).eq('status', 'pending');
    const err = error || pendErr;
    if (err) return NextResponse.json({ error: err.message }, { status: 500 });
    // Requests covering less than the line (or none): the rest arrived too.
    const covered = (row.received || 0) + row.on_order + row.requested;
    if (covered < row.needed) {
      const { error: insErr } = await supabase.from('purchase_requests').insert({
        item_number: row.item_number,
        netsuite_item_id: row.netsuite_item_id,
        description: row.description,
        quantity: row.needed - covered,
        status: 'ordered', source: 'got_it',
        ordered_at: now, ordered_by: auth.user!.id,
        received_at: now, received_by: auth.user!.id,
        source_project_id: projectId,
        requested_by: auth.user!.id,
      });
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  } else {
    const { error } = await supabase.from('purchase_requests').insert({
      item_number: row.item_number,
      netsuite_item_id: row.netsuite_item_id,
      description: row.description,
      quantity: row.needed,
      status: 'ordered', source: 'got_it',
      ordered_at: now, ordered_by: auth.user!.id,
      received_at: now, received_by: auth.user!.id,
      source_project_id: projectId,
      requested_by: auth.user!.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const readiness = await computePartsReadiness(supabase, projectId);
  // The last line in can make the job ready to schedule (migration 450).
  if (readiness.available) await afterReservationChange(supabase, projectId, readiness.summary?.verdict);
  return NextResponse.json(readiness);
}
