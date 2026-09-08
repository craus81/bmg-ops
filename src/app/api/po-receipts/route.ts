import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { suiteqlQuery, createItemReceiptFromPo } from '@/lib/netsuite';
import { mapReceiptLines, type NsPoLine } from '@/lib/po-receiving';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';
import { computePartsReadiness } from '@/lib/parts-readiness';

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
    // R6-7: what was WRONG with this line, flagged at the dock — the only
    // moment anyone can actually see it.
    exception: z.object({
      kind: z.enum(['short', 'damaged', 'wrong_item']),
      quantity: z.number().min(0).max(100000).optional().nullable(),
      note: z.string().max(500).optional().nullable(),
      photoPath: z.string().max(500).optional().nullable(),
    }).optional().nullable(),
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
    return NextResponse.json({ error: `PO ${po.tranid || ''} is ${po.status === 'H' ? 'cancelled' : 'fully billed/closed'} in NetSuite — nothing left to receive.` }, { status: 409 });
  }

  const { data: mirrorLines } = await supabase
    .from('netsuite_vendor_po_lines')
    .select('line_id, item_netsuite_id, item_number, description, quantity, quantity_received')
    .eq('po_id', po.id);
  const mirrorByLineId = new Map((mirrorLines || []).map((l: any) => [l.line_id as string, l]));

  // Receipts sitting on the manual worklist are real arrivals NetSuite
  // doesn't know about yet — without counting them, a part received into
  // the worklist still showed fully open and invited a double receipt
  // (Round 3 finding). Keyed by line_id; rows whose line_id no longer
  // exists in the (resynced) mirror fall back to their item number.
  const { data: manualRows } = await supabase
    .from('po_receipts')
    .select('line_id, item_number, quantity')
    .eq('po_id', po.id)
    .eq('ns_status', 'manual_needed');
  const manualByLine = new Map<string, number>();
  const manualByItem = new Map<string, number>();
  for (const m of (manualRows || []) as any[]) {
    const qty = Number(m.quantity) || 0;
    if (m.line_id && mirrorByLineId.has(m.line_id)) {
      manualByLine.set(m.line_id, (manualByLine.get(m.line_id) || 0) + qty);
    } else {
      const key = normalizeItemNumber(m.item_number);
      manualByItem.set(key, (manualByItem.get(key) || 0) + qty);
    }
  }

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
    const manualHeld = (manualByLine.get(ask.lineId) || 0)
      + (manualByItem.get(normalizeItemNumber(ask.itemNumber)) || 0);
    const open = (Number(mirror.quantity) || 0) - (Number(mirror.quantity_received) || 0) - manualHeld;
    if (ask.quantity > open + 1e-9) {
      return NextResponse.json({
        error: `${ask.itemNumber}: receiving ${ask.quantity} but only ${Math.max(0, open)} is still open${manualHeld > 0 ? ` (${manualHeld} already received onto the manual NetSuite-entry worklist)` : ''}.`,
      }, { status: 422 });
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
  const { data: insertedReceipts, error: insertErr } = await supabase
    .from('po_receipts').insert(rows).select('id, item_number');
  if (insertErr) {
    // The NetSuite receipt (if posted) exists regardless — say so instead
    // of inviting a retry that would double-receive.
    return NextResponse.json({
      error: `${posted ? `Item receipt ${receiptNumber || receiptId} posted to NetSuite, but the` : 'The'} local receipt record failed: ${insertErr.message}`,
    }, { status: 500 });
  }

  // ── R6-7: structured dock exceptions ────────────────────────────────
  // Short / damaged / wrong-item flags become their own rows so open
  // vendor claims are a list somebody can work, not a sentence buried in a
  // receipt note. Never fatal: the goods arrived either way, and losing a
  // posted receipt over a failed flag would be the worse trade.
  const flagged = body.lines.filter(l => l.exception);
  if (flagged.length > 0) {
    const receiptByItem = new Map((insertedReceipts || []).map((r: any) => [r.item_number, r.id]));
    const { error: exErr } = await supabase.from('po_receipt_exceptions').insert(
      flagged.map(l => ({
        receipt_id: receiptByItem.get(l.itemNumber) || null,
        po_id: po.id,
        item_number: l.itemNumber,
        kind: l.exception!.kind,
        quantity: l.exception!.quantity ?? null,
        note: l.exception!.note?.trim() || null,
        photo_path: l.exception!.photoPath || null,
        flagged_by: auth.user.id,
      })),
    );
    if (exErr) console.error('dock exception insert failed:', exErr.message);
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

  // ── R3-13: received parts land RESERVED for the project that asked. ──
  // Receipts used to drop everything into free stock, and the project that
  // raised the request had to re-reserve by hand (or lose the parts to the
  // next allocate-all). Follow each received item back through its ordered
  // purchase request to the source project and reserve it there — capped by
  // the live readiness math at what the project still needs AND what's
  // actually free (allocatable), and by the request's own quantity when a
  // line has to split across projects. Posted receipts only: a
  // manual_needed receipt hasn't relieved NetSuite, so the availability the
  // cap reads doesn't hold those parts yet. Non-fatal throughout.
  const autoReserved: { projectId: string; projectName: string | null; itemNumber: string; quantity: number }[] = [];
  if (posted) {
    try {
      const receivedRemaining = new Map<string, number>();
      for (const l of body.lines) {
        const key = normalizeItemNumber(l.itemNumber);
        receivedRemaining.set(key, (receivedRemaining.get(key) || 0) + l.quantity);
      }
      const { data: projReqs } = await supabase
        .from('purchase_requests')
        .select('id, item_number, quantity, source_project_id, created_at')
        .eq('ordered_po_id', po.id)
        .eq('status', 'ordered')
        .not('source_project_id', 'is', null)
        .order('created_at');
      const wanting = (projReqs || []).filter((r: any) =>
        receivedRemaining.has(normalizeItemNumber(r.item_number)));
      const projectIds = [...new Set(wanting.map((r: any) => r.source_project_id))] as string[];
      for (const projectId of projectIds) {
        const readiness = await computePartsReadiness(supabase, projectId);
        if (!readiness.available) continue;
        let projectName: string | null = null;
        for (const r of wanting.filter((x: any) => x.source_project_id === projectId)) {
          const item = normalizeItemNumber(r.item_number);
          const remaining = receivedRemaining.get(item) || 0;
          if (remaining <= 0) continue;
          const row = readiness.parts?.find(p => p.item_number === item);
          if (!row || row.allocatable <= 0) continue;
          const add = Math.min(remaining, row.allocatable, Number(r.quantity) || 0);
          if (add <= 0) continue;
          await supabase.from('part_allocations').upsert({
            project_id: projectId,
            item_number: item,
            quantity: row.allocated + add,
            status: 'reserved',
            released_at: null,
            created_by: auth.user.id,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'project_id,item_number' });
          row.allocated += add;
          row.allocatable -= add;
          receivedRemaining.set(item, remaining - add);
          if (projectName === null) {
            const { data: proj } = await supabase
              .from('upfit_projects').select('project_name').eq('id', projectId).maybeSingle();
            projectName = proj?.project_name || null;
          }
          autoReserved.push({ projectId, projectName, itemNumber: item, quantity: add });
        }
      }
      // One attributable timeline note per project.
      const byProject = new Map<string, typeof autoReserved>();
      for (const a of autoReserved) {
        byProject.set(a.projectId, [...(byProject.get(a.projectId) || []), a]);
      }
      for (const [projectId, allocs] of byProject) {
        await supabase.from('upfit_project_notes').insert({
          project_id: projectId,
          note_type: 'parts_order',
          content: `Received on PO ${po.tranid || ''} and reserved to this project: ${allocs.map(a => `${a.quantity}× ${a.itemNumber}`).join(', ')}`.slice(0, 500),
          created_by: auth.user.id,
        });
      }
    } catch (err) {
      console.error('po-receipts: auto-allocation failed:', err);
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
      const reservedNote = autoReserved.length > 0
        ? ` — reserved to ${[...new Set(autoReserved.map(a => a.projectName || 'the requesting project'))].join(', ')}`
        : '';
      await notifyMany(requesterIds, {
        type: 'po_received',
        title: `📬 Arrived — PO ${po.tranid || ''}${po.vendor_name ? ` (${po.vendor_name})` : ''}`.trim(),
        body: `${summary}${reservedNote}`.slice(0, 900),
        url: deepLinks.receiving(po.id),
        channels: ['in_app', 'push'],
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
    autoReserved: autoReserved.length > 0 ? autoReserved : undefined,
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
