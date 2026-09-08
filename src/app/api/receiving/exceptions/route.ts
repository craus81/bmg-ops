import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { summarizeExceptions, type DockException } from '@/lib/dock-exceptions';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * The discrepancies queue (R6-7): every short, damaged or wrong-item line
 * flagged at the dock, with an explicit way to close it. Same
 * parts_ordering gate as receiving itself — the people who find the
 * problem are the people who chase it.
 */

const toException = (r: any): DockException => ({
  id: r.id,
  poId: r.po_id,
  poTranid: r.po?.tranid || null,
  vendorName: r.po?.vendor_name || null,
  itemNumber: r.item_number,
  kind: r.kind,
  quantity: r.quantity != null ? Number(r.quantity) : null,
  note: r.note,
  status: r.status,
  resolution: r.resolution,
  createdAt: r.created_at,
});

export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const includeResolved = req.nextUrl.searchParams.get('all') === '1';
  let query = supabase
    .from('po_receipt_exceptions')
    .select('id, po_id, item_number, kind, quantity, note, photo_path, status, resolution, resolution_note, created_at, resolved_at, po:netsuite_vendor_pos(tranid, vendor_name)')
    .order('created_at', { ascending: false })
    .limit(300);
  if (!includeResolved) query = query.eq('status', 'open');

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const exceptions = (data || []).map(toException);
  return NextResponse.json({
    exceptions,
    raw: data || [],
    summary: summarizeExceptions(exceptions),
  });
}

const ResolveSchema = z.object({
  id: z.string().uuid(),
  resolution: z.enum(['vendor_credit', 'replacement_po', 'written_off']),
  note: z.string().max(500).optional(),
});

/** Close a claim. The database also refuses a resolved row with no
 *  resolution, so the queue can never quietly lose one. */
export async function PATCH(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ResolveSchema);
  if (parsed.error) return parsed.error;
  const { id, resolution, note } = parsed.data;

  const { data: before } = await supabase
    .from('po_receipt_exceptions').select('id, status, item_number, kind').eq('id', id).maybeSingle();
  if (!before) return NextResponse.json({ error: 'Discrepancy not found' }, { status: 404 });
  if (before.status === 'resolved') return NextResponse.json({ error: 'Already resolved.' }, { status: 409 });

  const { error } = await supabase.from('po_receipt_exceptions').update({
    status: 'resolved',
    resolution,
    resolution_note: note?.trim() || null,
    resolved_by: auth.user.id,
    resolved_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'open');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Money leaves the building on a written-off claim, so it joins the
  // exceptions digest's audit trail like every other override.
  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'po_receipt_exceptions',
    recordId: id,
    action: 'dock_exception_resolved',
    detail: { item: before.item_number, kind: before.kind, resolution, note: note || null },
  });
  return NextResponse.json({ ok: true });
}
