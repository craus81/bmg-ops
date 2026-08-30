import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { suiteqlQuery, createItemReceiptFromPo } from '@/lib/netsuite';
import { mapReceiptLines, type NsPoLine } from '@/lib/po-receiving';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * PO receipts (audit item 17C) — parts arriving at the dock get checked in
 * against the vendor PO from /admin/receiving. POST records the receipt
 * rows AND attempts the NetSuite item receipt in the same call
 * (purchaseOrder → itemReceipt transform, mapped via po-receiving.ts);
 * when the transform can't run or fails, the rows land as
 * ns_status='manual_needed' — the page's "enter in NetSuite by hand"
 * worklist — instead of blocking the dock. The mirror's
 * quantity_received is bumped only on a POSTED receipt, so readiness math
 * stays aligned with NetSuite truth (the 2-hourly sync then confirms it).
 */

const ReceiveSchema = z.object({
  poId: z.string().uuid(),
  lines: z.array(z.object({
    /** The mirror line's line_id (NetSuite tl.id, or prov-N right after
     *  create-po) — mapped to the transform's orderLine server-side. */
    lineId: z.string().min(1).max(40),
    itemNumber: z.string().trim().min(1).max(80),
    itemNetsuiteId: z.string().max(40).optional().nullable(),
    quantity: z.number().positive().max(100000),
  })).min(1).max(100),
  note: z.string().max(1000).optional().nullable(),
});

const ManualDoneSchema = z.object({
  id: z.string().uuid(),
  markManualDone: z.literal(true),
});

/** GET — ?poId= for one PO's receipts, ?manual=1 for the hand-entry
 *  worklist, else the recent feed. All with the PO header joined. */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const poId = searchParams.get('poId');
  const manual = searchParams.get('manual');

  let query = supabase
    .from('po_receipts')
    .select('*, po:netsuite_vendor_pos(tranid, vendor_name), receiver:profiles!po_receipts_received_by_fkey(full_name)')
    .order('received_at', { ascending: false });
  if (poId) query = query.eq('po_id', poId).limit(200);
  else if (manual) query = query.eq('ns_status', 'manual_needed').limit(200);
  else query = query.limit(50);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, receipts: data || [] });
}

/** POST — receive quantities against a PO's lines. */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ReceiveSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { data: po } = await supabase
    .from('netsuite_vendor_pos')
    .select('id, netsuite_id, tranid, vendor_name, status')
    .eq('id', body.poId)
    .maybeSingle();
  if (!po) return NextResponse.json({ error: 'PO not found' }, { status: 404 });
  if (!isOpenPoStatus(po.status)) {
    return NextResponse.json({ error: `PO ${po.tranid || ''} is ${po.status === 'H' ? 'closed' : 'fully billed/closed'} in NetSuite — nothing left to receive.` }, { status: 409 });
  }

  const { data: mirrorLines } = await supabase
    .from('netsuite_vendor_po_lines')
    .select('line_id, item_netsuite_id, item_number, description, quantity, quantity_received')
    .eq('po_id', po.id);
  const mirrorByLineId = new Map((mirrorLines || []).map((l: any) => [l.line_id as string, l]));

  // Asks must reference lines the mirror knows, one ask per line, within
  // the mirror's open quantity (NetSuite's own open quantity is enforced
  // again in the mapper below for the posted path).
  const seen = new Set<string>();
  for (const ask of body.lines) {
    if (seen.has(ask.lineId)) {
      return NextResponse.json({ error: `Duplicate line in the request (${ask.itemNumber}) — refresh and try again.` }, { status: 422 });
    }
    seen.add(ask.lineId);
    const mirror: any = mirrorByLineId.get(ask.lineId);
    if (!mirror) {
      return NextResponse.json({ error: `${ask.itemNumber}: this PO line is no longer on the synced PO — refresh the page.` }, { status: 422 });
    }
    const open = (Number(mirror.quantity) || 0) - (Number(mirror.quantity_received) || 0);
    if (ask.quantity > open + 1e-9) {
      return NextResponse.json({ error: `${ask.itemNumber}: receiving ${ask.quantity} but only ${Math.max(0, open)} is still open.` }, { status: 422 });
    }
  }

  // ── NetSuite item receipt attempt — failure is a worklist row, never a
  // blocked dock. ──
  const today = new Date().toISOString().slice(0, 10);
  let nsError: string | null = null;
  let nsPosted = false;
  let receiptId: string | null = null;
  let receiptNumber: string | null = null;
  if (po.netsuite_id && /^\d+$/.test(String(po.netsuite_id))) {
    try {
      const linesResult = await suiteqlQuery(`
        SELECT tl.id, tl.linesequencenumber, tl.item, tl.quantity, tl.quantityshiprecv
        FROM transactionline tl
        WHERE tl.transaction = ${po.netsuite_id}
          AND tl.mainline = 'F'
          AND tl.taxline = 'F'
          AND tl.item IS NOT NULL
        ORDER BY tl.linesequencenumber
      `);
      const nsLines: NsPoLine[] = (linesResult?.items || []).map((l: any) => ({
        lineId: String(l.id),
        lineSeq: parseInt(l.linesequencenumber, 10),
        itemId: l.item != null ? String(l.item) : null,
        quantity: Math.abs(parseFloat(l.quantity || '0')) || 0,
        received: Math.abs(parseFloat(l.quantityshiprecv || '0')) || 0,
      })).filter((l: NsPoLine) => Number.isFinite(l.lineSeq));
      const mapped = mapReceiptLines(nsLines, body.lines.map(a => ({
        lineId: a.lineId,
        itemNetsuiteId: a.itemNetsuiteId || mirrorByLineId.get(a.lineId)?.item_netsuite_id || null,
        itemNumber: a.itemNumber,
        quantity: a.quantity,
      })));
      if (!mapped.ok) {
        nsError = mapped.reason;
      } else {
        const result = await createItemReceiptFromPo({
          purchaseOrderId: String(po.netsuite_id),
          receiveLines: mapped.receiveLines,
          excludeOrderLines: mapped.excludeOrderLines,
          memo: `Received via FleetSuite${body.note ? ` — ${body.note}` : ''}`.slice(0, 300),
          tranDate: today,
        });
        if (result.success) {
          // Success alone means NetSuite HAS the receipt — even in the
          // unlikely case the id couldn't be read back, treating it as
          // manual_needed would invite a hand-keyed second receipt.
          nsPosted = true;
          receiptId = result.receiptId || null;
          receiptNumber = result.receiptNumber || null;
        } else {
          nsError = result.error || 'NetSuite rejected the item receipt.';
        }
      }
    } catch (err: any) {
      nsError = String(err?.message || err).slice(0, 300);
    }
  } else {
    nsError = 'The synced PO has no numeric NetSuite id.';
  }
  const posted = nsPosted;

  // ── Local truth: one receipt row per line received. ──
  const now = new Date().toISOString();
  const rows = body.lines.map(ask => {
    const mirror: any = mirrorByLineId.get(ask.lineId);
    return {
      po_id: po.id,
      po_netsuite_id: po.netsuite_id || null,
      line_id: ask.lineId,
      item_netsuite_id: ask.itemNetsuiteId || mirror?.item_netsuite_id || null,
      item_number: normalizeItemNumber(ask.itemNumber),
      description: mirror?.description || null,
      quantity: ask.quantity,
      note: body.note || null,
      ns_status: posted ? 'posted' : 'manual_needed',
      ns_receipt_id: receiptId,
      ns_receipt_number: receiptNumber,
      received_by: auth.user.id,
      received_at: now,
    };
  });
  const { error: insertErr } = await supabase.from('po_receipts').insert(rows);
  if (insertErr) {
    // The NetSuite receipt (if posted) exists regardless — say so instead
    // of inviting a retry that would double-receive.
    return NextResponse.json({
      error: `${posted ? `Item receipt ${receiptNumber || receiptId} posted to NetSuite, but the` : 'The'} local receipt record failed: ${insertErr.message}`,
    }, { status: 500 });
  }

  // Posted receipts bump the mirror now so readiness and the receiving page
  // agree with NetSuite immediately; the 2-hourly sync then confirms the
  // same numbers. manual_needed receipts deliberately don't — NetSuite is
  // still the open-quantity truth until someone keys the receipt in.
  if (posted) {
    for (const ask of body.lines) {
      const mirror: any = mirrorByLineId.get(ask.lineId);
      if (!mirror) continue;
      await supabase
        .from('netsuite_vendor_po_lines')
        .update({ quantity_received: (Number(mirror.quantity_received) || 0) + ask.quantity })
        .eq('po_id', po.id)
        .eq('line_id', ask.lineId);
    }
  }

  // Whoever asked for these parts hears they arrived. One PO = one record →
  // everyone deep-links to this PO on the receiving page.
  try {
    const receivedItems = new Set(rows.map(r => r.item_number));
    const { data: reqs } = await supabase
      .from('purchase_requests')
      .select('requested_by, item_number')
      .eq('ordered_po_id', po.id)
      .eq('status', 'ordered');
    const requesterIds = [...new Set((reqs || [])
      .filter((r: any) => r.requested_by && r.requested_by !== auth.user.id && receivedItems.has(normalizeItemNumber(r.item_number)))
      .map((r: any) => r.requested_by))] as string[];
    if (requesterIds.length > 0) {
      const summary = body.lines.map(l => `${l.quantity}× ${normalizeItemNumber(l.itemNumber)}`).join(' · ');
      await notifyMany(requesterIds, {
        type: 'po_received',
        title: `📬 Arrived — PO ${po.tranid || ''}${po.vendor_name ? ` (${po.vendor_name})` : ''}`.trim(),
        body: summary.slice(0, 900),
        url: deepLinks.receiving(po.id),
        channels: ['in_app', 'push'],
        forceChannels: true,
      });
    }
  } catch (err) {
    console.error('po-receipts: arrival notify failed:', err);
  }

  return NextResponse.json({
    success: true,
    received: rows.length,
    nsStatus: posted ? 'posted' : 'manual_needed',
    receiptId,
    receiptNumber,
    nsError,
  });
}

/** PATCH — dismiss a manual-entry worklist row once it's keyed into NetSuite. */
export async function PATCH(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ManualDoneSchema);
  if (parsed.error) return parsed.error;

  const { data: row } = await supabase
    .from('po_receipts').select('id, ns_status').eq('id', parsed.data.id).maybeSingle();
  if (!row) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
  if (row.ns_status !== 'manual_needed') {
    return NextResponse.json({ error: `This receipt is already ${row.ns_status}.` }, { status: 409 });
  }

  const { error } = await supabase
    .from('po_receipts')
    .update({ ns_status: 'manual_done', updated_at: new Date().toISOString() })
    .eq('id', parsed.data.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
