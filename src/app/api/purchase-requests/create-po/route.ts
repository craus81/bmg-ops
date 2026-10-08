import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { createPurchaseOrder, resolveDefaultLocationId, transactionUrl } from '@/lib/netsuite';
import { locationIdForName } from '@/lib/invoice-location';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/purchase-requests/create-po — turn a vendor group of pending
 * purchase requests into a REAL NetSuite purchase order (audit item 17B).
 *
 * Doubly guarded: the feature gate satisfies this directory's
 * api-auth-guard contract, and requireAdmin holds the money path to
 * admins — sales/shop techs raise requests, purchasing places POs.
 *
 * On success the PO is mirrored into netsuite_vendor_pos/_lines
 * immediately (status B "Pending Receipt", provisional prov-N line ids)
 * so readiness cards flip short→waiting without waiting for the 2-hourly
 * sync, which later replaces the provisional lines with NetSuite's real
 * line ids. Source projects get their never-before-written
 * netsuite_vendor_po_id/_number/parts_ordered_date stamped (first PO wins
 * — they're single columns), which also lights up parts-email-scan's ETA
 * matching against the PO number. EVERY source project additionally gets
 * an upfit_project_pos row for this PO (migration 267) — the multi-PO
 * link the single columns can't hold.
 */

const Schema = z.object({
  requestIds: z.array(z.string().uuid()).min(1).max(100),
  /** Numeric NetSuite vendor INTERNAL id (the picker's #id). An entity
   *  name here fails the create — the same trap as CNI vendor bills. */
  vendorNetsuiteId: z.string().trim().regex(/^\d+$/, 'vendorNetsuiteId must be the numeric NetSuite internal id').max(20),
  vendorName: z.string().max(200).optional().nullable(),
  memo: z.string().max(500).optional().nullable(),
  /** The review screen's edits, per request. A quantity below the request's
   *  splits it: the ordered part goes on the PO, the rest stays pending. A
   *  rate prices that request's item line (same item = same line = one rate). */
  lines: z.array(z.object({
    requestId: z.string().uuid(),
    quantity: z.number().positive().max(100000),
    rate: z.number().min(0).max(1000000).optional().nullable(),
  })).max(100).optional(),
  /** Which plant the PO is for — one PO is always one location. Omitted =
   *  the default location. */
  locationName: z.enum(["O'Fallon", 'Wentzville', 'Kansas City', 'Social Circle']).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;
  const admin = await requireAdmin(req);
  if (admin.error) return admin.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const requestIds = [...new Set(body.requestIds)];
  const edits = new Map((body.lines || []).map(l => [l.requestId, l]));
  if ([...edits.keys()].some(id => !requestIds.includes(id))) {
    return NextResponse.json({ error: 'A reviewed line isn’t one of the requests being ordered — refresh the queue.' }, { status: 400 });
  }
  const { data: requests, error: loadErr } = await supabase
    .from('purchase_requests')
    .select('*')
    .in('id', requestIds);
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!requests || requests.length !== requestIds.length) {
    return NextResponse.json({ error: 'Some requests no longer exist — refresh the queue.' }, { status: 404 });
  }
  const notPending = (requests as any[]).filter(r => r.status !== 'pending');
  if (notPending.length > 0) {
    return NextResponse.json({
      error: `Already ${notPending[0].status}: ${notPending.map(r => r.item_number).join(', ')} — refresh the queue.`,
    }, { status: 409 });
  }
  const noItemId = (requests as any[]).filter(r => !r.netsuite_item_id);
  if (noItemId.length > 0) {
    return NextResponse.json({
      error: `No NetSuite item id for: ${noItemId.map(r => r.item_number).join(', ')}. Match them in the parts catalog (or cancel those rows) first — a PO line needs the item's internal id.`,
    }, { status: 422 });
  }

  // Claim before the NetSuite write: two admins racing the same rows would
  // both pass the pending check above and place two REAL POs. ordered_by is
  // never set while a row is pending, so it doubles as the claim token — a
  // lost race 409s instead of double-ordering, and a NetSuite failure
  // releases the claim so the rows stay orderable.
  const now = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('purchase_requests')
    .update({ ordered_by: admin.user.id, updated_at: now })
    .in('id', requestIds)
    .eq('status', 'pending')
    .is('ordered_by', null)
    .select('id');
  if (claimErr) return NextResponse.json({ error: claimErr.message }, { status: 500 });
  // Release ONLY the rows THIS request claimed. Filtering by ordered_by
  // matched the rows a concurrent request by the SAME admin was still
  // holding while it talked to NetSuite — the loser's release un-claimed
  // the winner's rows, reopening the double-order window (Round 3 finding).
  const claimedIds = (claimed || []).map((r: any) => r.id as string);
  const releaseClaim = async () => {
    if (claimedIds.length === 0) return;
    try {
      await supabase.from('purchase_requests')
        .update({ ordered_by: null })
        .in('id', claimedIds)
        .eq('status', 'pending');
    } catch (err) {
      console.error('create-po: claim release failed:', err);
    }
  };
  if (claimedIds.length !== requestIds.length) {
    await releaseClaim();
    return NextResponse.json({ error: 'Another PO is already being created for some of these requests — refresh the queue.' }, { status: 409 });
  }

  // What each request orders: the reviewed quantity when the review screen
  // sent one, else the whole request.
  const orderQty = new Map((requests as any[]).map(r => [r.id as string, edits.get(r.id)?.quantity ?? (Number(r.quantity) || 0)]));

  // Cost each line from the review screen's price, else the catalog; lines
  // with neither go rate-less and NetSuite sources the item's default.
  const itemNumbers = [...new Set((requests as any[]).map(r => r.item_number))];
  const { data: priceRows } = await supabase
    .from('netsuite_parts')
    .select('item_number, purchase_price')
    .in('item_number', itemNumbers);
  const priceByItem = new Map((priceRows || []).map((p: any) => [p.item_number as string, Number(p.purchase_price) || 0]));

  // One PO line per NetSuite item — the same part asked for by two
  // projects merges into a single line.
  const byItem = new Map<string, { itemId: string; item_number: string; description: string | null; quantity: number; rate: number | null }>();
  for (const r of requests as any[]) {
    const price = priceByItem.get(r.item_number) || 0;
    const line = byItem.get(r.netsuite_item_id) || {
      itemId: r.netsuite_item_id, item_number: r.item_number,
      description: r.description || null, quantity: 0,
      rate: price > 0 ? price : null,
    };
    // A reviewed line's price wins, and a blank one means "NetSuite's own".
    const edit = edits.get(r.id);
    if (edit && edit.rate !== undefined) line.rate = edit.rate != null && edit.rate > 0 ? edit.rate : null;
    line.quantity += orderQty.get(r.id) || 0;
    if (!line.description && r.description) line.description = r.description;
    byItem.set(r.netsuite_item_id, line);
  }
  const lines = [...byItem.values()].sort((a, b) => a.item_number.localeCompare(b.item_number));

  // Distinct source projects — for the memo's SO list and the stamps below.
  const projectIds = [...new Set((requests as any[]).map(r => r.source_project_id).filter(Boolean))] as string[];
  let projects: any[] = [];
  if (projectIds.length > 0) {
    const { data } = await supabase
      .from('upfit_projects')
      .select('id, project_name, netsuite_so_number, netsuite_vendor_po_id')
      .in('id', projectIds);
    projects = data || [];
  }
  const soList = projects.map(p => p.netsuite_so_number).filter(Boolean).join(', ');

  const vendorName = body.vendorName?.trim() || (requests as any[]).find(r => r.vendor_name)?.vendor_name || null;
  const today = new Date().toISOString().slice(0, 10);
  const memo = body.memo?.trim() || `FleetSuite purchase requests${soList ? ` — for SO ${soList}` : ''}`;

  // Anything thrown between claim and PO left rows permanently "being
  // ordered" with no unclaim lever (resolveDefaultLocationId throws on any
  // SuiteQL error — Round 3 finding). From here to the NetSuite verdict,
  // every exit releases the claim.
  let po: Awaited<ReturnType<typeof createPurchaseOrder>>;
  try {
    const locationId = body.locationName
      ? await locationIdForName(body.locationName)
      : await resolveDefaultLocationId();
    po = await createPurchaseOrder({
      vendorId: body.vendorNetsuiteId,
      locationId: locationId || undefined,
      tranDate: today,
      memo,
      lineItems: lines.map(l => ({
        itemId: l.itemId, quantity: l.quantity, rate: l.rate, description: l.description,
      })),
    });
  } catch (err: any) {
    await releaseClaim();
    return NextResponse.json({ error: `NetSuite call failed before the PO was created: ${String(err?.message || err).slice(0, 300)}` }, { status: 502 });
  }
  if (!po.success) {
    await releaseClaim();
    return NextResponse.json({ error: po.error || 'NetSuite rejected the purchase order.' }, { status: 502 });
  }

  // ── The PO exists in NetSuite from here on. Everything below is
  // best-effort bookkeeping, and the response stays success so the UI
  // can't invite a retry that would place a second PO. ──
  let mirrorRowId: string | null = null;
  let stamped = false;

  if (po.purchaseOrderId) {
    try {
      const total = lines.every(l => l.rate != null)
        ? +(lines.reduce((s, l) => s + (l.rate! * l.quantity), 0).toFixed(2))
        : null;
      const { data: header } = await supabase
        .from('netsuite_vendor_pos')
        .upsert({
          netsuite_id: po.purchaseOrderId,
          tranid: po.purchaseOrderNumber || null,
          vendor_netsuite_id: body.vendorNetsuiteId,
          vendor_name: vendorName,
          trandate: today,
          status: 'B',
          status_label: 'Pending Receipt',
          memo,
          total,
          last_synced_at: now,
        }, { onConflict: 'netsuite_id' })
        .select('id')
        .single();
      if (header) {
        mirrorRowId = header.id;
        await supabase.from('netsuite_vendor_po_lines').delete().eq('po_id', header.id);
        await supabase.from('netsuite_vendor_po_lines').insert(lines.map((l, i) => ({
          po_id: header.id,
          line_id: `prov-${i + 1}`,
          item_netsuite_id: l.itemId,
          item_number: l.item_number,
          description: l.description,
          quantity: l.quantity,
          quantity_received: 0,
          quantity_billed: 0,
          rate: l.rate,
          amount: l.rate != null ? +((l.rate * l.quantity).toFixed(2)) : null,
        })));
      }
    } catch (err) {
      console.error('create-po: local mirror failed (sync will catch up):', err);
    }
  }

  try {
    const stamp = {
      status: 'ordered',
      ordered_po_id: mirrorRowId,
      ordered_at: now,
      ordered_by: admin.user.id,
      vendor_netsuite_id: body.vendorNetsuiteId,
      ...(vendorName ? { vendor_name: vendorName } : {}),
      updated_at: now,
    };
    const unchanged = (requests as any[]).filter(r => orderQty.get(r.id) === Number(r.quantity)).map(r => r.id as string);
    const changed = (requests as any[]).filter(r => orderQty.get(r.id) !== Number(r.quantity));
    let ok = true;
    if (unchanged.length > 0) {
      const { error: stampErr } = await supabase.from('purchase_requests').update(stamp).in('id', unchanged);
      if (stampErr) { ok = false; console.error('create-po: request stamp failed:', stampErr); }
    }
    for (const r of changed) {
      const qty = orderQty.get(r.id)!;
      const { error: stampErr } = await supabase.from('purchase_requests').update({ ...stamp, quantity: qty }).eq('id', r.id);
      if (stampErr) { ok = false; console.error('create-po: request stamp failed:', stampErr); continue; }
      // Ordered fewer than asked: the rest stays in the queue as its own row,
      // the same split the NetSuite auto-match makes.
      const remainder = +((Number(r.quantity) - qty).toFixed(2));
      if (remainder > 0) {
        const { error: splitErr } = await supabase.from('purchase_requests').insert({
          item_number: r.item_number,
          netsuite_item_id: r.netsuite_item_id,
          description: r.description,
          vendor_name: r.vendor_name,
          vendor_netsuite_id: r.vendor_netsuite_id,
          source_project_id: r.source_project_id,
          source_estimate_id: r.source_estimate_id ?? null,
          needed_by: r.needed_by,
          note: r.note,
          requested_by: r.requested_by,
          source: r.source,
          created_at: r.created_at,
          split_from_id: r.split_from_id || r.id,
          auto_match_blocked_po_ids: r.auto_match_blocked_po_ids || [],
          quantity: remainder,
          status: 'pending',
          updated_at: now,
        });
        if (splitErr) { ok = false; console.error('create-po: remainder split failed:', splitErr); }
      }
    }
    stamped = ok;
  } catch (err) {
    console.error('create-po: request stamp failed:', err);
  }

  // First PO wins the project's single-column PO link (075's columns had
  // no writer until now); parts-email-scan matches vendor ETA emails
  // against netsuite_vendor_po_number, so this stamp lights that up too.
  if (po.purchaseOrderId && projects.length > 0) {
    try {
      const unstamped = projects.filter(p => !p.netsuite_vendor_po_id).map(p => p.id);
      if (unstamped.length > 0) {
        await supabase.from('upfit_projects').update({
          netsuite_vendor_po_id: po.purchaseOrderId,
          netsuite_vendor_po_number: po.purchaseOrderNumber || null,
        }).in('id', unstamped);
        // Separate write: a human-entered parts_ordered_date must not be
        // overwritten by a later PO (Round 3 finding).
        await supabase.from('upfit_projects')
          .update({ parts_ordered_date: today })
          .in('id', unstamped)
          .is('parts_ordered_date', null);
      }
    } catch (err) {
      console.error('create-po: project stamp failed:', err);
    }
  }

  // Every source project gets a join row for THIS PO (migration 267) —
  // the second and later POs the first-wins scalars above drop. Best
  // effort like the rest of this section: the migration's backfill plus
  // the manual link route cover a miss, and a duplicate pair is ignored.
  if (mirrorRowId && projects.length > 0) {
    try {
      await supabase.from('upfit_project_pos').upsert(
        projects.map(p => ({
          project_id: p.id,
          po_id: mirrorRowId,
          po_number: po.purchaseOrderNumber || null,
          source: 'request_queue',
          created_by: admin.user.id,
        })),
        { onConflict: 'project_id,po_id', ignoreDuplicates: true },
      );
    } catch (err) {
      console.error('create-po: project PO link failed:', err);
    }
  }

  // Requesters hear their ask landed on a real PO. A requester with ONE
  // request in this PO gets a link to that exact record (?req= — the queue
  // page explains its fate even though it left the pending list); several
  // requests make it a true digest, which links to the queue.
  try {
    const byRequester = new Map<string, any[]>();
    for (const r of requests as any[]) {
      if (!r.requested_by || r.requested_by === admin.user.id) continue;
      byRequester.set(r.requested_by, [...(byRequester.get(r.requested_by) || []), r]);
    }
    if (byRequester.size > 0) {
      const label = po.purchaseOrderNumber || (po.purchaseOrderId ? `#${po.purchaseOrderId}` : '');
      const summary = lines.map(l => `${l.quantity}× ${l.item_number}`).join(' · ');
      const payload = (url: string) => ({
        type: 'purchase_request_ordered',
        title: `📦 Ordered — PO ${label}${vendorName ? ` (${vendorName})` : ''}`.trim(),
        body: summary.slice(0, 900),
        url,
        channels: ['in_app', 'push'] as ('in_app' | 'push')[],
      });
      const digestIds: string[] = [];
      for (const [uid, theirs] of [...byRequester.entries()]) {
        if (theirs.length === 1) await notifyMany([uid], payload(deepLinks.purchaseRequests(theirs[0].id)));
        else digestIds.push(uid);
      }
      if (digestIds.length > 0) await notifyMany(digestIds, payload(deepLinks.purchaseRequests()));
    }
  } catch (err) {
    console.error('create-po: requester notify failed:', err);
  }

  return NextResponse.json({
    success: true,
    poId: po.purchaseOrderId || null,
    poNumber: po.purchaseOrderNumber || null,
    netsuiteUrl: po.purchaseOrderId ? transactionUrl('purchord', po.purchaseOrderId) : null,
    mirrored: !!mirrorRowId,
    stamped,
    lines: lines.length,
  });
}
