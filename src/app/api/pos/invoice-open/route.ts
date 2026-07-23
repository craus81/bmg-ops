import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createDirectInvoice, findCustomer, findItems } from '@/lib/netsuite';
import { resolveLocationWithOverride } from '@/lib/invoice-location';
import { recomputePoFulfillment } from '@/lib/scan-match';
import { normPart, distributeInstalled } from '@/lib/po-invoice-verify';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({
  poId: z.string().uuid(),
  // PO line id -> quantity to bill on that line. Keyed by line, NOT part
  // number: a part can appear on several PO lines (split price/schedule), and
  // keying by part collapses those lines into one — the quantity can't exceed
  // that specific line's open (quantity − installed) amount.
  quantities: z.record(z.string().uuid(), z.number().int().min(1).max(100000)),
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
  const auth = await requireAdmin(req);
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

    // Validate each requested line against ITS OWN open cap. Quantities are
    // keyed by PO line id: a part can appear on several PO lines, so summing
    // per part and checking against a single line's open would reject a
    // correct total that's spread across lines (the "exceeds the open
    // quantity" bug this flow used to hit).
    const lines = (po.po_line_items || []) as { id: string; part_number: string; description: string | null; quantity: number; installed: number | null; unit_price: number }[];
    const lineById = new Map(lines.map(l => [l.id, l]));
    const problems: string[] = [];
    let hasUnknownLine = false;
    const toBill: { lineId: string; partNumber: string; quantity: number; rate: number; description: string }[] = [];
    for (const [lineId, qty] of Object.entries(quantities)) {
      const line = lineById.get(lineId);
      if (!line) {
        hasUnknownLine = true;
        continue;
      }
      const open = (line.quantity || 0) - (line.installed || 0);
      if (qty > open) {
        problems.push(`${line.part_number}: ${qty} exceeds the open quantity (${Math.max(open, 0)})`);
        continue;
      }
      toBill.push({
        lineId: line.id,
        partNumber: line.part_number,
        quantity: qty,
        rate: Number(line.unit_price) || 0,
        description: line.description || line.part_number,
      });
    }
    if (hasUnknownLine) {
      problems.push('Some lines are no longer on this PO — refresh the page and try again.');
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

    // Resolve NetSuite items for the billed parts; refuse unmatched ones. A
    // part can span several billed lines, so resolve/report each part once.
    const billedParts = [...new Set(toBill.map(l => l.partNumber))];
    const nsItems = await findItems(billedParts);
    const unmatched = billedParts.filter(p => !nsItems[p.toUpperCase()]);
    if (unmatched.length > 0) {
      return NextResponse.json({
        error: `No NetSuite item found for: ${unmatched.join(', ')}`,
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

    // Collapse billed lines into invoice lines by (item, rate): a part split
    // across several PO lines at the same price bills as ONE clean invoice
    // line (e.g. 200 + 100 + 101 → 401), while lines of the same part at
    // different prices stay separate so each rate is billed as agreed.
    const invoiceLines = new Map<string, { itemId: string | number; quantity: number; rate: number; description: string }>();
    for (const l of toBill) {
      const itemId = nsItems[l.partNumber.toUpperCase()].id;
      const key = `${itemId}|${l.rate}`;
      const existing = invoiceLines.get(key);
      if (existing) existing.quantity += l.quantity;
      else invoiceLines.set(key, { itemId, quantity: l.quantity, rate: l.rate, description: l.description });
    }

    const invoiceResult = await createDirectInvoice({
      customerId,
      locationId,
      memo: `Invoice from BMG FleetSuite — PO #${po.po_number} (open quantities)`,
      otherrefnum: po.po_number,
      lineItems: [...invoiceLines.values()],
    });

    if (!invoiceResult.success) {
      return NextResponse.json({ error: invoiceResult.error || 'NetSuite invoice failed' }, { status: 502 });
    }

    // Bookkeeping, matching the SO-based flow: legacy field + po_invoices row.
    const totalQty = toBill.reduce((s, l) => s + l.quantity, 0);
    const invoiceLineCount = invoiceLines.size;
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
      line_count: invoiceLineCount,
      total_qty: totalQty,
      memo: `PO #${po.po_number} — open quantities, ${totalQty} unit${totalQty !== 1 ? 's' : ''} across ${invoiceLineCount} line${invoiceLineCount !== 1 ? 's' : ''}`,
    });

    // Billed units consume the open quantity right away — the open cap above
    // then makes a repeat invoice for the same units impossible, without
    // waiting for the invoice verify sweep.
    //
    // A part can span several PO lines, and this is a DIRECT NetSuite invoice
    // that carries no PO-line identity — so the verify sweep can only take a
    // part's invoiced TOTAL and redistribute it across the part's lines in
    // order, only ever RAISING installed. We must consume identically here or
    // the two writes diverge and stack: if we marked the exact line the user
    // billed, the sweep would later raise a DIFFERENT line for the same units,
    // pushing installed above what was billed — which prematurely completes the
    // PO and strands genuinely-open units. So aggregate the billed units per
    // part and front-fill that part's lines in the same deterministic (id)
    // order the sweep uses, to the part's new consumed total. installed is only
    // raised (physical scans past billing are preserved).
    const billedByPart = new Map<string, number>();
    for (const l of toBill) {
      const key = normPart(l.partNumber);
      billedByPart.set(key, (billedByPart.get(key) || 0) + l.quantity);
    }
    for (const [key, billed] of billedByPart) {
      const partLines = lines.filter(l => normPart(l.part_number) === key);
      // Target = what's already installed on this part's lines + the units just
      // billed. distributeInstalled front-fills to that target and only raises,
      // so a later verify sweep (which targets the part's cumulative invoiced
      // total the same way) reproduces the exact same per-line installed instead
      // of stacking on top of it.
      const alreadyInstalled = partLines.reduce((s, l) => s + (l.installed || 0), 0);
      for (const u of distributeInstalled(partLines, alreadyInstalled + billed)) {
        await service.from('po_line_items').update({ installed: u.installed }).eq('id', u.id);
      }
    }
    await recomputePoFulfillment(service, [po.id]);

    return NextResponse.json({
      success: true,
      invoiceId: invoiceResult.invoiceId,
      invoiceNumber: invoiceResult.invoiceNumber,
      totalQty,
      lineCount: invoiceLineCount,
    });
  } catch (err: any) {
    console.error('Invoice open quantities error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create invoice' }, { status: 500 });
  }
}
