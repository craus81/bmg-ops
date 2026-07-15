import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createDirectInvoice, findCustomer, findItems } from '@/lib/netsuite';
import { resolveLocationWithOverride } from '@/lib/invoice-location';
import { recomputePoFulfillment } from '@/lib/scan-match';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({
  poId: z.string().uuid(),
  // Part number -> quantity to bill. Every part must be a line on the PO and
  // the quantity can't exceed that line's open (quantity − installed) amount.
  quantities: z.record(z.string().min(1).max(120), z.number().int().min(1).max(100000)),
});

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/pos/invoice-open — invoice a PO's open quantities DIRECTLY in
 * NetSuite, no sales order needed (FleetSuite deliberately bypasses SOs).
 *
 * Rates come from the PO's own line prices — that's the agreed price with the
 * customer. Server re-checks the open-quantity cap so a stale client can't
 * bill units the installed-quantity flow already covered, and refuses parts
 * that don't resolve to a NetSuite item instead of silently dropping lines.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { poId, quantities } = parsed.data;

  try {
    const { data: po } = await service
      .from('purchase_orders')
      .select('id, po_number, customer, customer_netsuite_id, ship_to, po_line_items(id, part_number, description, quantity, installed, unit_price)')
      .eq('id', poId)
      .maybeSingle();
    if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 });

    // Validate every requested part against the PO's lines and its open cap.
    const lines = (po.po_line_items || []) as { id: string; part_number: string; description: string | null; quantity: number; installed: number | null; unit_price: number }[];
    const lineByPart = new Map(lines.map(l => [String(l.part_number || '').toUpperCase(), l]));
    const problems: string[] = [];
    const toBill: { partNumber: string; quantity: number; rate: number; description: string }[] = [];
    for (const [partNumber, qty] of Object.entries(quantities)) {
      const line = lineByPart.get(partNumber.toUpperCase());
      if (!line) {
        problems.push(`${partNumber} is not a line on this PO`);
        continue;
      }
      const open = (line.quantity || 0) - (line.installed || 0);
      if (qty > open) {
        problems.push(`${partNumber}: ${qty} exceeds the open quantity (${Math.max(open, 0)})`);
        continue;
      }
      toBill.push({
        partNumber: line.part_number,
        quantity: qty,
        rate: Number(line.unit_price) || 0,
        description: line.description || line.part_number,
      });
    }
    if (problems.length > 0) {
      return NextResponse.json({ error: problems.join('; ') }, { status: 400 });
    }
    if (toBill.length === 0) {
      return NextResponse.json({ error: 'Nothing to invoice' }, { status: 400 });
    }

    // Resolve the NetSuite customer — the canonical id stored on the PO when
    // available, otherwise by name.
    let customerId: string | number | null = (po as any).customer_netsuite_id || null;
    if (!customerId) {
      const customerResult = await findCustomer(po.customer);
      if (!customerResult.found || customerResult.customers.length === 0) {
        return NextResponse.json({ error: `Customer "${po.customer}" not found in NetSuite` }, { status: 400 });
      }
      customerId = customerResult.customers[0].id;
    }

    // Resolve NetSuite items for the billed parts; refuse unmatched ones.
    const nsItems = await findItems(toBill.map(l => l.partNumber));
    const unmatched = toBill.filter(l => !nsItems[l.partNumber.toUpperCase()]);
    if (unmatched.length > 0) {
      return NextResponse.json({
        error: `No NetSuite item found for: ${unmatched.map(l => l.partNumber).join(', ')}`,
      }, { status: 400 });
    }

    // Location from the same PO rules the other invoice flows use.
    const shipTo = (po.ship_to || {}) as { city?: string; name?: string };
    const { id: locationId } = await resolveLocationWithOverride(service, po.po_number, {
      customerName: po.customer,
      city: shipTo.city,
      name: shipTo.name,
    });
    if (!locationId) {
      return NextResponse.json({ error: 'Could not resolve a NetSuite location for this invoice' }, { status: 400 });
    }

    const invoiceResult = await createDirectInvoice({
      customerId,
      locationId,
      memo: `Invoice from BMG FleetSuite — PO #${po.po_number} (open quantities)`,
      otherrefnum: po.po_number,
      lineItems: toBill.map(l => ({
        itemId: nsItems[l.partNumber.toUpperCase()].id,
        quantity: l.quantity,
        rate: l.rate,
        description: l.description,
      })),
    });

    if (!invoiceResult.success) {
      return NextResponse.json({ error: invoiceResult.error || 'NetSuite invoice failed' }, { status: 502 });
    }

    // Bookkeeping, matching the SO-based flow: legacy field + po_invoices row.
    const totalQty = toBill.reduce((s, l) => s + l.quantity, 0);
    await service
      .from('purchase_orders')
      .update({
        netsuite_invoice_id: invoiceResult.invoiceId,
        netsuite_invoice_number: invoiceResult.invoiceNumber,
      })
      .eq('id', po.id);
    await service.from('po_invoices').insert({
      purchase_order_id: po.id,
      netsuite_invoice_id: invoiceResult.invoiceId,
      netsuite_invoice_number: invoiceResult.invoiceNumber,
      line_count: toBill.length,
      total_qty: totalQty,
      memo: `PO #${po.po_number} — open quantities, ${totalQty} unit${totalQty !== 1 ? 's' : ''} across ${toBill.length} line${toBill.length !== 1 ? 's' : ''}`,
    });

    // Billed units consume the open quantity right away — the open cap above
    // then makes a repeat invoice for the same units impossible, without
    // waiting for the invoice verify sweep (which does the same for invoices
    // entered directly in NetSuite). A fully billed PO flips to 'complete'.
    for (const l of toBill) {
      const line = lineByPart.get(l.partNumber.toUpperCase());
      if (!line) continue;
      await service.from('po_line_items').update({
        installed: Math.min((line.installed || 0) + l.quantity, line.quantity || 0),
      }).eq('id', line.id);
    }
    await recomputePoFulfillment(service, [po.id]);

    return NextResponse.json({
      success: true,
      invoiceId: invoiceResult.invoiceId,
      invoiceNumber: invoiceResult.invoiceNumber,
      totalQty,
      lineCount: toBill.length,
    });
  } catch (err: any) {
    console.error('Invoice open quantities error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create invoice' }, { status: 500 });
  }
}
