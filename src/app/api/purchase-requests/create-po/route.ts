import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { createPurchaseOrder, resolveDefaultLocationId, transactionUrl } from '@/lib/netsuite';

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
 * matching against the PO number.
 */

const Schema = z.object({
  requestIds: z.array(z.string().uuid()).min(1).max(100),
  /** Numeric NetSuite vendor INTERNAL id (the picker's #id). An entity
   *  name here fails the create — the same trap as CNI vendor bills. */
  vendorNetsuiteId: z.string().trim().regex(/^\d+$/, 'vendorNetsuiteId must be the numeric NetSuite internal id').max(20),
  vendorName: z.string().max(200).optional().nullable(),
  memo: z.string().max(500).optional().nullable(),
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
  const releaseClaim = async () => {
    try {
      await supabase.from('purchase_requests')
        .update({ ordered_by: null })
        .in('id', requestIds)
        .eq('ordered_by', admin.user.id)
        .eq('status', 'pending');
    } catch (err) {
      console.error('create-po: claim release failed:', err);
    }
  };
  if ((claimed || []).length !== requestIds.length) {
    await releaseClaim();
    return NextResponse.json({ error: 'Another PO is already being created for some of these requests — refresh the queue.' }, { status: 409 });
  }

  // Cost each line from the catalog where we can; lines without a known
  // purchase price go rate-less and NetSuite sources the item's default.
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
    line.quantity += Number(r.quantity) || 0;
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

  const locationId = await resolveDefaultLocationId();
  const po = await createPurchaseOrder({
    vendorId: body.vendorNetsuiteId,
    locationId: locationId || undefined,
    tranDate: today,
    memo,
    lineItems: lines.map(l => ({
      itemId: l.itemId, quantity: l.quantity, rate: l.rate, description: l.description,
    })),
  });
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
    const { error: stampErr } = await supabase
      .from('purchase_requests')
      .update({
        status: 'ordered',
        ordered_po_id: mirrorRowId,
        ordered_at: now,
        ordered_by: admin.user.id,
        vendor_netsuite_id: body.vendorNetsuiteId,
        ...(vendorName ? { vendor_name: vendorName } : {}),
        updated_at: now,
      })
      .in('id', requestIds);
    stamped = !stampErr;
    if (stampErr) console.error('create-po: request stamp failed:', stampErr);
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
          parts_ordered_date: today,
        }).in('id', unstamped);
      }
    } catch (err) {
      console.error('create-po: project stamp failed:', err);
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
        forceChannels: true,
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
