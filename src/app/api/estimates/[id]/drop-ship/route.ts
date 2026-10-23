import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import {
  getSalesOrderRecord, getVendorContact, patchPurchaseOrder, patchSalesOrder,
  setPurchaseOrderNumber, suiteqlQuery, transactionUrl,
} from '@/lib/netsuite';
import {
  defaultDropShipMemo, dropShipLines, dropShipSoPatch, planDropShip, sameShipTo,
  shippingAddressBody, shipToFromRecord,
} from '@/lib/drop-ship';
import { cleanPoSuffix, withPoSuffix } from '@/lib/po-number';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Drop ship from vendor on an estimate's sales order (Craig, 2026-10-23,
 * thread "Drop-ship orders for in-stock parts"). GET lists the order's lines
 * live from NetSuite with the ship-to address and each part's last vendor and
 * cost. POST marks the picked lines Drop Ship for one vendor, which makes
 * NetSuite create the linked PO shipping to the customer, then sets that
 * PO's ship-to, memo and number ending. Admins only. Nothing is emailed: the
 * window offers the vendor email screen (drop-ship/email) and a person sends.
 * How the order is read and checked is src/lib/drop-ship.ts.
 */

const supabase = createServiceClient();

async function loadEstimate(id: string) {
  const { data, error } = await supabase
    .from('estimates')
    .select('id, estimate_number, customer_name, customer_netsuite_id, netsuite_so_id, netsuite_so_number')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as null | {
    id: string; estimate_number: string | null; customer_name: string | null; customer_netsuite_id: string | null;
    netsuite_so_id: string | null; netsuite_so_number: string | null;
  };
}

const isPendingApproval = (rec: any) => {
  const s = rec?.orderStatus ?? rec?.status;
  const id = typeof s === 'object' && s ? String(s.id ?? '') : String(s ?? '');
  const name = typeof s === 'object' && s ? String(s.refName ?? '') : '';
  return id === 'A' || /pending approval/i.test(name) || /pending approval/i.test(id);
};

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  try {
    const estimate = await loadEstimate(params.id);
    if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    if (!estimate.netsuite_so_id) return NextResponse.json({ error: 'This estimate has no sales order yet' }, { status: 409 });
    const soId = String(estimate.netsuite_so_id);

    const got = await getSalesOrderRecord(soId);
    if (!got.success) return NextResponse.json({ error: `Could not read the sales order from NetSuite: ${got.error}` }, { status: 502 });
    const lines = dropShipLines(got.record);
    const shipTo = shipToFromRecord(got.record);
    if (!shipTo.name) shipTo.name = estimate.customer_name || '';

    // Each part's last vendor (newest PO line) and catalog cost, as starting values.
    const numbers = [...new Set(lines.map(l => normalizeItemNumber(l.itemNumber)).filter(Boolean))];
    const asTyped = [...new Set(lines.map(l => l.itemNumber).filter(Boolean))];
    const lastVendor: Record<string, { id: string; name: string }> = {};
    const cost: Record<string, number> = {};
    const onHand: Record<string, number> = {};
    if (numbers.length > 0) {
      const [{ data: poLines }, { data: parts }] = await Promise.all([
        supabase
          .from('netsuite_vendor_po_lines')
          .select('item_number, rate, netsuite_vendor_pos!inner(vendor_netsuite_id, vendor_name, trandate)')
          .in('item_number', numbers)
          .order('id', { ascending: false })
          .limit(500),
        supabase
          .from('netsuite_parts')
          .select('item_number, purchase_price, quantity_available')
          .in('item_number', [...new Set([...numbers, ...asTyped])]),
      ]);
      const newest = new Map<string, any>();
      for (const l of (poLines || []) as any[]) {
        const po = l.netsuite_vendor_pos;
        if (!po?.vendor_netsuite_id) continue;
        const prev = newest.get(l.item_number);
        if (!prev || String(po.trandate || '') > String(prev.netsuite_vendor_pos.trandate || '')) newest.set(l.item_number, l);
      }
      for (const [num, l] of newest) {
        lastVendor[num] = { id: String(l.netsuite_vendor_pos.vendor_netsuite_id), name: l.netsuite_vendor_pos.vendor_name || '' };
        if (Number(l.rate) > 0) cost[num] = Number(l.rate);
      }
      for (const p of (parts || []) as any[]) {
        const num = normalizeItemNumber(p.item_number);
        if (!(num in cost) && Number(p.purchase_price) > 0) cost[num] = Number(p.purchase_price);
        onHand[num] = Number(p.quantity_available) || 0;
      }
    }

    const { data: earlier } = await supabase
      .from('drop_ship_orders')
      .select('id, purchase_order_id, purchase_order_number, vendor_name, vendor_netsuite_id, ship_to, lines, emailed_at, emailed_to, created_at')
      .eq('sales_order_id', soId)
      .order('created_at', { ascending: true });

    return NextResponse.json({
      salesOrderId: soId,
      soNumber: String(got.record?.tranId || estimate.netsuite_so_number || soId),
      customerName: String(got.record?.entity?.refName || estimate.customer_name || ''),
      pendingApproval: isPendingApproval(got.record),
      shipTo,
      lines: lines.map(l => {
        const num = normalizeItemNumber(l.itemNumber);
        return { ...l, lastVendor: lastVendor[num] || null, cost: cost[num] ?? null, onHand: onHand[num] ?? null };
      }),
      dropShips: earlier || [],
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not read the sales order' }, { status: 500 });
  }
}

const ShipToSchema = z.object({
  name: z.string().trim().max(100),
  attention: z.string().trim().max(100).default(''),
  address: z.string().trim().max(150),
  address2: z.string().trim().max(150).default(''),
  city: z.string().trim().max(60),
  state: z.string().trim().max(30),
  zip: z.string().trim().max(15),
  phone: z.string().trim().max(30).default(''),
});

const Schema = z.object({
  picks: z.array(z.object({
    line: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1_000_000).optional().nullable(),
  })).min(1).max(100),
  /** Numeric NetSuite vendor INTERNAL id (the picker's #id). */
  vendorNetsuiteId: z.string().trim().regex(/^\d+$/, 'vendorNetsuiteId must be the numeric NetSuite internal id').max(20),
  vendorName: z.string().trim().max(200).optional().nullable(),
  shipTo: ShipToSchema,
  memo: z.string().trim().max(500).optional().nullable(),
  /** Added after a dash to NetSuite's own number: PO453 → PO453-HOSEMATE. */
  poSuffix: z.string().max(40).optional().nullable(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const estimate = await loadEstimate(params.id);
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (!estimate.netsuite_so_id) return NextResponse.json({ error: 'This estimate has no sales order yet' }, { status: 409 });
  const soId = String(estimate.netsuite_so_id);

  // Plan against the order as NetSuite has it now: a line already on a PO
  // (a double click, or someone in NetSuite) is refused here.
  const before = await getSalesOrderRecord(soId);
  if (!before.success) return NextResponse.json({ error: `Could not read the sales order from NetSuite: ${before.error}` }, { status: 502 });
  if (isPendingApproval(before.record)) {
    return NextResponse.json({ error: 'The sales order is Pending Approval in NetSuite. NetSuite only makes drop ship POs for approved orders: approve it there first, then try again.' }, { status: 409 });
  }
  const shipTo = body.shipTo;
  const plan = planDropShip(dropShipLines(before.record), body.picks, shipTo);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  const soNumber = String(before.record?.tranId || estimate.netsuite_so_number || soId);
  const customerName = String(before.record?.entity?.refName || estimate.customer_name || '');

  const marked = await patchSalesOrder(soId, dropShipSoPatch(plan.lines, body.vendorNetsuiteId), { replace: false });
  if (!marked.success) {
    return NextResponse.json({
      error: `NetSuite would not mark the lines Drop Ship, so no PO was made: ${marked.error}. `
        + 'If NetSuite says the field is not valid, turn on Setup → Company → Enable Features → Items & Inventory → Drop Shipments & Special Orders, and give the FleetSuite role permission for it.',
    }, { status: 502 });
  }

  // NetSuite makes the PO when it saves the order; read back which one.
  const after = await getSalesOrderRecord(soId);
  if (!after.success) {
    return NextResponse.json({ error: `The lines were marked Drop Ship, but the sales order could not be read back: ${after.error}. Check SO ${soNumber} in NetSuite before trying again.` }, { status: 502 });
  }
  const nowLines = new Map(dropShipLines(after.record).map(l => [l.line, l]));
  const poIds = new Map<string, { id: string; number: string; lines: typeof plan.lines }>();
  const noPo: string[] = [];
  for (const l of plan.lines) {
    const po = nowLines.get(l.line)?.createdPo;
    if (!po) { noPo.push(l.itemNumber || `line ${l.line}`); continue; }
    const g = poIds.get(po.id) || { id: po.id, number: po.number, lines: [] };
    g.lines.push(l);
    poIds.set(po.id, g);
  }
  if (poIds.size === 0) {
    return NextResponse.json({
      error: `NetSuite marked ${noPo.join(', ')} Drop Ship but did not make a purchase order. `
        + `Open SO ${soNumber} in NetSuite and use the Drop Ship link on the line, or check that the vendor is set up to sell this part.`,
    }, { status: 502 });
  }

  // ── The PO exists in NetSuite from here on. Everything below is best
  // effort: problems come back as warnings, never as a failure that would
  // invite a second try. ──
  const warnings: string[] = [];
  if (noPo.length > 0) warnings.push(`No PO was made for ${noPo.join(', ')}. Check those lines on SO ${soNumber} in NetSuite.`);
  const memo = body.memo?.trim() || defaultDropShipMemo(soNumber, customerName);
  const shipToChanged = !sameShipTo(shipTo, shipToFromRecord(before.record));
  const suffix = cleanPoSuffix(body.poSuffix);
  const vendorName = body.vendorName?.trim() || null;
  const today = new Date().toISOString().slice(0, 10);
  const made: any[] = [];

  for (const g of poIds.values()) {
    if (!g.number) {
      try {
        const lookup = await suiteqlQuery(`SELECT tranid FROM transaction WHERE id = ${Number(g.id)}`);
        g.number = String(lookup?.items?.[0]?.tranid || '');
      } catch { /* the id is enough to open it */ }
    }
    const header = await patchPurchaseOrder(g.id, {
      memo,
      ...(shipToChanged ? { shippingAddress: shippingAddressBody(shipTo) } : {}),
    });
    if (!header.success) {
      warnings.push(`PO ${g.number || g.id} was made, but NetSuite would not take the ${shipToChanged ? 'ship-to address and ' : ''}memo: ${header.error}.${shipToChanged ? ' Fix the ship-to on the PO in NetSuite before it goes to the vendor.' : ''}`);
    }
    if (suffix && g.number) {
      const wanted = withPoSuffix(g.number, suffix);
      const renamed = await setPurchaseOrderNumber(g.id, wanted).catch((e: any) => ({ success: false as const, error: String(e?.message || e) }));
      if (renamed.success) g.number = wanted;
      else warnings.push(`NetSuite kept the number ${g.number} instead of ${wanted} (${renamed.error}).`);
    }

    const lines = g.lines.map(l => ({
      soLine: l.line, itemId: l.itemId, itemNumber: l.itemNumber, description: l.description, quantity: l.quantity, rate: l.rate,
    }));
    try {
      const { data: row } = await supabase.from('drop_ship_orders').insert({
        estimate_id: estimate.id,
        sales_order_id: soId,
        sales_order_number: soNumber,
        purchase_order_id: g.id,
        purchase_order_number: g.number || null,
        vendor_netsuite_id: body.vendorNetsuiteId,
        vendor_name: vendorName,
        ship_to: shipTo,
        lines,
        memo,
        created_by: auth.user.id,
      }).select('id').single();
      // Header only, flagged: the vendor PO sync fills in the lines, and the
      // flag keeps this PO out of stock on order (migration 429).
      await supabase.from('netsuite_vendor_pos').upsert({
        netsuite_id: g.id,
        tranid: g.number || null,
        vendor_netsuite_id: body.vendorNetsuiteId,
        vendor_name: vendorName,
        trandate: today,
        status: 'B',
        status_label: 'Pending Receipt',
        memo,
        drop_ship: true,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'netsuite_id' });
      made.push({
        id: row?.id || null,
        purchaseOrderId: g.id,
        purchaseOrderNumber: g.number || null,
        netsuiteUrl: transactionUrl('purchord', g.id),
        lines,
      });
    } catch (e: any) {
      warnings.push(`PO ${g.number || g.id} was made, but FleetSuite could not save its record: ${e?.message || e}.`);
      made.push({ id: null, purchaseOrderId: g.id, purchaseOrderNumber: g.number || null, netsuiteUrl: transactionUrl('purchord', g.id), lines });
    }
  }

  await logAudit(supabase, [{
    actorId: auth.user.id,
    table: 'estimates',
    recordId: estimate.id,
    action: 'drop_ship_po',
    detail: {
      salesOrderId: soId,
      salesOrderNumber: soNumber,
      vendor: vendorName || body.vendorNetsuiteId,
      purchaseOrders: made.map(m => m.purchaseOrderNumber || m.purchaseOrderId),
      lines: plan.lines.map(l => `${l.quantity}× ${l.itemNumber}`),
    },
  }]);

  let vendorEmail: string | null = null;
  try {
    const v = await getVendorContact(body.vendorNetsuiteId);
    vendorEmail = v.email || null;
  } catch { /* the email screen lets them type it */ }

  return NextResponse.json({ success: true, dropShips: made, vendorEmail, warnings });
}
