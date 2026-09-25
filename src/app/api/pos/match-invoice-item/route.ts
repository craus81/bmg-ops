import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { normPart, verifyPoInvoiceQuantities } from '@/lib/po-invoice-verify';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  poId: z.string().uuid(),
  invoiceItem: z.string().trim().min(1).max(200),
  /** The PO line to count the invoice item against; null removes the match. */
  poLineItemId: z.string().uuid().nullable(),
  note: z.string().trim().max(500).optional(),
});

/**
 * POST /api/pos/match-invoice-item — admin manual match for the billing
 * check (migrations/327). Points an invoice item the check couldn't pair
 * with a PO line (flagged "not on this PO") at the line it actually billed,
 * or removes that match when poLineItemId is null. Audit-logged, then the
 * PO's billing check re-runs so the response carries the fresh verdict.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { poId, poLineItemId, note } = parsed.data;
  const invoiceItem = normPart(parsed.data.invoiceItem);

  const { data: po } = await service
    .from('purchase_orders')
    .select('id, po_number, po_line_items(id, part_number)')
    .eq('id', poId)
    .maybeSingle();
  if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 });

  const { data: existing } = await service
    .from('po_invoice_item_matches')
    .select('po_line_item_id, note')
    .eq('purchase_order_id', poId)
    .eq('invoice_item', invoiceItem)
    .maybeSingle();

  // requireAdmin's profile carries roles only — fetch the display name.
  const { data: me } = auth.user?.id
    ? await service.from('profiles').select('full_name, email').eq('id', auth.user.id).maybeSingle()
    : { data: null };
  const actorName = me?.full_name || me?.email || null;

  if (poLineItemId) {
    const line = ((po as any).po_line_items || []).find((l: any) => l.id === poLineItemId);
    if (!line) return NextResponse.json({ error: 'That line is not on this PO' }, { status: 400 });
    if (normPart(line.part_number) === invoiceItem) {
      return NextResponse.json({ error: 'That line already has this part number — no match needed' }, { status: 400 });
    }
    const { error } = await service.from('po_invoice_item_matches').upsert({
      purchase_order_id: poId,
      invoice_item: invoiceItem,
      po_line_item_id: poLineItemId,
      note: note || null,
      matched_by: auth.user?.id ?? null,
      matched_by_name: actorName,
      matched_at: new Date().toISOString(),
    }, { onConflict: 'purchase_order_id,invoice_item' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logAudit(service, {
      actorId: auth.user?.id ?? null,
      table: 'purchase_orders',
      recordId: poId,
      action: 'invoice_item_matched',
      detail: {
        po_number: po.po_number,
        invoice_item: invoiceItem,
        po_line_item_id: poLineItemId,
        po_line_part: line.part_number,
        note: note || null,
        previous: existing || null,
      },
    });
  } else {
    if (!existing) return NextResponse.json({ error: 'No match to remove' }, { status: 404 });
    const { error } = await service
      .from('po_invoice_item_matches')
      .delete()
      .eq('purchase_order_id', poId)
      .eq('invoice_item', invoiceItem);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logAudit(service, {
      actorId: auth.user?.id ?? null,
      table: 'purchase_orders',
      recordId: poId,
      action: 'invoice_item_unmatched',
      detail: { po_number: po.po_number, invoice_item: invoiceItem, removed: existing },
    });
  }

  try {
    await verifyPoInvoiceQuantities(service, [poId]);
  } catch (err: any) {
    // The match is saved either way; the next sweep or Recheck picks it up.
    console.error('match-invoice-item recheck failed:', err);
    return NextResponse.json({ success: true, recheckError: err?.message || 'Recheck failed' });
  }
  const { data: fresh } = await service
    .from('purchase_orders')
    .select('*, po_line_items(*), po_invoices(*)')
    .eq('id', poId)
    .maybeSingle();
  return NextResponse.json({ success: true, po: fresh });
}
