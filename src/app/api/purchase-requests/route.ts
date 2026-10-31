import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany, getAlertOwnerIds } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { computePartsReadiness } from '@/lib/parts-readiness';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';
import { resolveVendorNames, vendorKey } from '@/lib/purchase-request-vendor';
import { genericLineKey } from '@/lib/generic-lines';
import { loadGenericItems } from '@/lib/generic-lines-server';
import { loadStockSnapshot, loadInventorySyncedAt } from '@/lib/stock-snapshot';

const supabase = createServiceClient();

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Purchase requests (audit item 17A) — the missing bridge between the
 * readiness card's "✗ N parts short — don't schedule yet" and the vendor
 * PO placed in NetSuite by hand. A request is one "we need N of this
 * part": raised from a short readiness row (or the queue directly),
 * enriched server-side with the catalog's NetSuite item id, cost and
 * vendor, and grouped by vendor at /admin/purchasing where phase 17B
 * turns a group into a real NetSuite PO.
 */

const CreateSchema = z.object({
  items: z.array(z.object({
    itemNumber: z.string().trim().min(1).max(80),
    quantity: z.number().positive().max(100000),
    description: z.string().max(500).optional().nullable(),
    netsuiteItemId: z.string().max(40).optional().nullable(),
  })).min(1).max(100),
  projectId: z.string().uuid().optional().nullable(),
  /** Raised from an estimate's stock banner (migration 335). When the
   *  estimate already has an upfit project, the request is tied to that
   *  too, so the project card counts it as requested. */
  estimateId: z.string().uuid().optional().nullable(),
  neededBy: z.string().max(20).optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
  /** When set, the response carries recomputed readiness for this project —
   *  the allocations-route pattern: mutate + refresh in one round trip. */
  returnReadiness: z.boolean().optional().default(false),
  /** The New vendor PO form: always new rows (never folded into a pending
   *  ask for the same part), and no "parts requested" alert, because the
   *  PO is created right after. */
  fresh: z.boolean().optional().default(false),
});

const UpdateSchema = z.object({
  id: z.string().uuid().optional(),
  /** A vendor picked on a whole Purchasing group lands on every row in it,
   *  so the pick survives a reload. Only the vendor fields go with `ids`. */
  ids: z.array(z.string().uuid()).min(1).max(500).optional(),
  quantity: z.number().positive().max(100000).optional(),
  vendorName: z.string().max(200).optional().nullable(),
  /** The NetSuite vendor picked from the list. Left out with a typed
   *  vendorName, the name is matched against the NetSuite vendor mirror. */
  vendorNetsuiteId: z.string().regex(/^\d+$/).optional().nullable(),
  neededBy: z.string().max(20).optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
  cancel: z.boolean().optional().default(false),
}).refine(b => !!b.id !== !!b.ids, { message: 'id or ids is required' });

const ORDERED_PO_SELECT = 'id, netsuite_id, tranid, vendor_name, status, status_label, trandate, eta_date, tracking_number, carrier';

/** GET /api/purchase-requests?status=pending — the purchasing queue.
 *  ?id=<uuid> instead returns that one request whatever its status (with
 *  its PO, if ordered) — the ?req= deep-link landing needs the row's fate
 *  even after it left the pending queue. */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }
    const { data, error } = await supabase
      .from('purchase_requests')
      .select(`*, upfit_projects(id, project_name, netsuite_so_number, customer_name), estimates(id, estimate_number, customer_name), requester:profiles!purchase_requests_requested_by_fkey(full_name), ordered_po:netsuite_vendor_pos(${ORDERED_PO_SELECT})`)
      .eq('id', id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, requests: data ? [data] : [] });
  }

  // ?view=on_order — requests ordered (by Create PO or matched to a NetSuite
  // PO) whose PO still has parts to arrive, with the PO's ETA and tracking
  // from the Parts Mail scan. Drops off once the PO is fully received.
  if (searchParams.get('view') === 'on_order') {
    const { data, error } = await supabase
      .from('purchase_requests')
      .select(`*, upfit_projects(id, project_name, netsuite_so_number, customer_name), estimates(id, estimate_number, customer_name), requester:profiles!purchase_requests_requested_by_fkey(full_name), ordered_po:netsuite_vendor_pos(${ORDERED_PO_SELECT})`)
      .eq('status', 'ordered')
      .is('received_at', null) // "Got it" on the job card: it's here
      .order('ordered_at', { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const onOrder = ((data || []) as any[]).filter(r => !r.ordered_po || isOpenPoStatus(r.ordered_po.status));
    return NextResponse.json({ success: true, requests: onOrder });
  }

  const status = searchParams.get('status') || 'pending';

  const { data, error } = await supabase
    .from('purchase_requests')
    .select('*, upfit_projects(id, project_name, netsuite_so_number, customer_name), estimates(id, estimate_number, customer_name), requester:profiles!purchase_requests_requested_by_fkey(full_name)')
    .eq('status', status)
    .order('vendor_name', { ascending: true, nullsFirst: true })
    .order('created_at')
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data || []) as any[];
  // Rows saved with a vendor name but no NetSuite id (typed before the
  // match existed, or the mirror lacked the vendor then) get matched now
  // and saved, so their group already knows its PO vendor.
  if (status === 'pending') {
    const unresolved = rows.filter(r => r.vendor_name && !r.vendor_netsuite_id);
    if (unresolved.length > 0) {
      const resolved = await resolveVendorNames(supabase, unresolved.map(r => r.vendor_name));
      for (const r of unresolved) {
        const hit = resolved.get(vendorKey(r.vendor_name));
        if (!hit) continue;
        const { error: upErr } = await supabase.from('purchase_requests')
          .update({ vendor_name: hit.name, vendor_netsuite_id: hit.id })
          .eq('id', r.id).eq('status', 'pending').is('vendor_netsuite_id', null);
        if (!upErr) { r.vendor_name = hit.name; r.vendor_netsuite_id = hit.id; }
      }
    }
  }
  // The Create PO review screen starts each line at the catalog's purchase
  // price (the same price create-po uses when nobody edits it).
  if (status === 'pending' && rows.length > 0) {
    const items = [...new Set(rows.map(r => r.item_number as string))];
    const cost = new Map<string, number>();
    for (let i = 0; i < items.length; i += 200) {
      const { data: parts } = await supabase
        .from('netsuite_parts')
        .select('item_number, purchase_price')
        .in('item_number', items.slice(i, i + 200));
      for (const p of (parts || []) as any[]) {
        const price = Number(p.purchase_price) || 0;
        if (price > 0) cost.set(p.item_number, price);
      }
    }
    for (const r of rows) r.catalog_cost = cost.get(r.item_number) ?? null;
  }
  // On hand / available / on order beside each pending row, so whoever
  // orders sees what's on the shelf and already coming (Craig, 2026-10-30).
  // ?stockItem= adds one more part, for the Order this part window.
  if (status === 'pending') {
    const stockItem = (searchParams.get('stockItem') || '').trim();
    const stock = await loadStockSnapshot(supabase, [...rows.map(r => r.item_number as string), ...(stockItem ? [stockItem] : [])]);
    // A generic part (Misc) has no meaningful shelf count, so it shows none.
    let genericItems = new Set<string>();
    try { genericItems = await loadGenericItems(supabase, rows.map(r => r.item_number as string)); } catch { /* show stock for all */ }
    for (const r of rows) {
      const key = normalizeItemNumber(r.item_number);
      r.stock = genericItems.has(key) ? null : stock.get(key) ?? null;
    }
    return NextResponse.json({
      success: true, requests: rows,
      inventorySyncedAt: await loadInventorySyncedAt(supabase),
      ...(stockItem ? { stockItem: stock.get(normalizeItemNumber(stockItem)) ?? null } : {}),
    });
  }
  return NextResponse.json({ success: true, requests: rows });
}

/**
 * POST — create requests (bulk; one call per readiness-card action).
 * Idempotent per item+project: an existing PENDING request for the same
 * item and project gets its quantity RAISED to the new ask instead of a
 * duplicate row, so double-clicks and re-requests don't inflate the queue.
 * Estimate requests are the exception: their quantity is the remainder
 * still uncovered, so it is ADDED to the open row (see below).
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CreateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  // An estimate's request belongs to its upfit project as well, once it has
  // one: the conversion carries earlier rows over (ensureUpfitProjectForSo),
  // and this covers asks made after it.
  let estimateLabel: string | null = null;
  if (body.estimateId) {
    const { data: est } = await supabase
      .from('estimates').select('id, estimate_number, customer_name').eq('id', body.estimateId).maybeSingle();
    if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    estimateLabel = [`Estimate ${est.estimate_number}`, est.customer_name].filter(Boolean).join(' — ');
    if (!body.projectId) {
      const { data: proj } = await supabase
        .from('upfit_projects').select('id').eq('estimate_id', body.estimateId).maybeSingle();
      if (proj) body.projectId = proj.id;
    }
  }

  const itemNumbers = body.items.map(i => normalizeItemNumber(i.itemNumber)).filter(Boolean);

  // Catalog enrichment: NetSuite item id + description + the free-text
  // vendor name (netsuite_parts.vendor — a name, not an id; see the
  // migration-052 note). Exact-normalized match.
  const { data: catalogRows } = await supabase
    .from('netsuite_parts')
    .select('item_number, netsuite_id, description, display_name, vendor')
    .in('item_number', itemNumbers);
  const catalog = new Map((catalogRows || []).map((c: any) => [normalizeItemNumber(c.item_number), c]));

  // Vendor fallback: who we LAST bought each item from (the PO mirror) —
  // the catalog's vendor field is blank for most parts. POs first, newest
  // first, then their lines: the old shape read an UNORDERED 400-line
  // slice and sorted that, so "latest purchase wins" was only true when
  // the latest purchase happened to be in the arbitrary slice (Round 3
  // finding) — wrong vendors got stamped on requests.
  const missingVendor = itemNumbers.filter(n => !catalog.get(n)?.vendor);
  const lastVendor = new Map<string, { name: string | null; id: string | null }>();
  if (missingVendor.length > 0) {
    const { data: recentPos } = await supabase
      .from('netsuite_vendor_pos')
      .select('id, vendor_name, vendor_netsuite_id')
      .order('trandate', { ascending: false, nullsFirst: false })
      .order('id')
      .limit(80);
    const poOrder = (recentPos || []).map((p: any) => p.id as string);
    const poById = new Map((recentPos || []).map((p: any) => [p.id as string, p]));
    if (poOrder.length > 0) {
      const { data: lines } = await supabase
        .from('netsuite_vendor_po_lines')
        .select('item_number, po_id')
        .in('po_id', poOrder)
        .in('item_number', missingVendor)
        .limit(1000);
      const rank = new Map(poOrder.map((id, i) => [id, i]));
      const sorted = ((lines || []) as any[]).sort((a, b) =>
        (rank.get(a.po_id) ?? 999) - (rank.get(b.po_id) ?? 999));
      for (const l of sorted) {
        const key = normalizeItemNumber(l.item_number);
        const po: any = poById.get(l.po_id);
        if (!lastVendor.has(key) && po?.vendor_name) {
          lastVendor.set(key, { name: po.vendor_name, id: po.vendor_netsuite_id || null });
        }
      }
    }
  }

  // A catalog vendor is only a name; match it to a NetSuite vendor so the
  // request carries the id Create PO needs (the last-PO fallback has one).
  const typedVendors = itemNumbers
    .map(n => catalog.get(n)?.vendor as string | undefined)
    .filter((v): v is string => !!v);
  const resolvedVendors = await resolveVendorNames(supabase, typedVendors);

  // Existing pending rows for idempotence.
  let dupQuery = supabase
    .from('purchase_requests')
    .select('id, item_number, description, quantity, source_project_id, source_estimate_id')
    .eq('status', 'pending')
    .in('item_number', itemNumbers);
  const { data: existing } = await dupQuery;
  // Same source = same job: the estimate or its project (either one, since
  // a converted estimate's rows carry both), else the project, else a
  // sourceless stock ask.
  const sameSource = (r: any) => body.estimateId
    ? r.source_estimate_id === body.estimateId || (!!body.projectId && r.source_project_id === body.projectId)
    : body.projectId
      ? r.source_project_id === body.projectId
      : !r.source_project_id && !r.source_estimate_id;
  // A generic part (Misc) is one request per line description, so two
  // different Misc lines never fold into one ask (Craig, 2026-10-31).
  let genericItems = new Set<string>();
  try {
    genericItems = await loadGenericItems(supabase, itemNumbers);
  } catch (e) {
    console.error('purchase-requests: generic parts lookup failed', e);
  }
  const dupKey = (item: string, desc: string | null | undefined) =>
    genericItems.has(item) ? genericLineKey(item, desc) : item;
  const pendingByItem = new Map(
    (existing || [])
      .filter(sameSource)
      .map((r: any) => [dupKey(normalizeItemNumber(r.item_number), r.description), r]),
  );

  const created: string[] = [];
  const raised: string[] = [];
  for (const item of body.items) {
    const key = normalizeItemNumber(item.itemNumber);
    if (!key) continue;
    const cat = catalog.get(key);
    const generic = genericItems.has(key);
    const dup: any = body.fresh ? undefined : pendingByItem.get(dupKey(key, item.description));
    if (dup) {
      // The estimate's button asks for what is still uncovered AFTER its
      // pending requests, so its quantity adds to the open row. Every other
      // caller sends the whole need, which raises it.
      const target = body.estimateId
        ? Number(dup.quantity) + Number(item.quantity)
        : Number(item.quantity);
      if (target > Number(dup.quantity)) {
        await supabase.from('purchase_requests')
          .update({ quantity: target, updated_at: new Date().toISOString() })
          .eq('id', dup.id);
        raised.push(key);
      }
      continue;
    }
    const { data: row, error } = await supabase.from('purchase_requests').insert({
      item_number: key,
      netsuite_item_id: item.netsuiteItemId || cat?.netsuite_id || null,
      // A generic line keeps its own words: the catalog's "Miscellaneous"
      // tells purchasing nothing.
      description: generic ? (item.description?.trim() || null) : (item.description || cat?.description || cat?.display_name || null),
      quantity: item.quantity,
      vendor_name: (cat?.vendor && resolvedVendors.get(vendorKey(cat.vendor))?.name) || cat?.vendor || lastVendor.get(key)?.name || null,
      vendor_netsuite_id: (cat?.vendor ? resolvedVendors.get(vendorKey(cat.vendor))?.id : lastVendor.get(key)?.id) || null,
      source_project_id: body.projectId || null,
      source_estimate_id: body.estimateId || null,
      needed_by: body.neededBy || null,
      note: body.note || null,
      requested_by: auth.user.id,
    }).select('id').single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    created.push(row.id);
  }

  // Purchasing hears about new asks — one digest per call. Purchasing is
  // whoever has it in their Dashboard focus (was every admin until
  // 2026-10-24), never the person asking.
  if (created.length > 0 && !body.fresh) {
    try {
      const adminIds = await getAlertOwnerIds('purchasing', auth.user.id);
      if (adminIds.length > 0) {
        let projectLabel: string | null = estimateLabel;
        if (!projectLabel && body.projectId) {
          const { data: proj } = await supabase
            .from('upfit_projects').select('project_name').eq('id', body.projectId).maybeSingle();
          projectLabel = proj?.project_name || null;
        }
        const lines = body.items.map(i => `${i.quantity}× ${normalizeItemNumber(i.itemNumber)}`).join(' · ');
        await notifyMany(adminIds, {
          type: 'purchase_request',
          title: `🛒 Parts requested${projectLabel ? ` — ${projectLabel}` : ''}`,
          body: `${lines}${body.neededBy ? ` · needed by ${body.neededBy}` : ''}`.slice(0, 900),
          // A batch lands on exactly the rows it is about, not a bare list
          // the reader then has to search (R6-7 buy list raises dozens).
          url: deepLinks.purchaseRequestBatch(created),
          channels: ['in_app', 'push'],
        });
      }
    } catch (err) {
      console.error('purchase_request notify failed:', err);
    }
  }

  let readiness = null;
  if (body.returnReadiness && body.projectId) {
    readiness = await computePartsReadiness(supabase, body.projectId);
  }

  // createdIds so a batch caller can flash exactly what it made; `created`
  // stays the count every existing caller already reads.
  return NextResponse.json({
    success: true, created: created.length, createdIds: created,
    raised: raised.length, readiness,
  });
}

/** PATCH — edit quantity/vendor/date/note, or cancel. With `ids`, sets
 *  the vendor on every pending row of a Purchasing group. */
export async function PATCH(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  // Vendor fields: a picked NetSuite vendor is taken as is; a typed name is
  // matched against the vendor mirror, and a name with no match clears the
  // old id (it belonged to whatever vendor was there before).
  const vendorPatch: Record<string, unknown> = {};
  if (body.vendorName !== undefined) {
    const typed = body.vendorName?.trim() || null;
    if (body.vendorNetsuiteId) {
      vendorPatch.vendor_name = typed;
      vendorPatch.vendor_netsuite_id = body.vendorNetsuiteId;
    } else if (typed) {
      const hit = (await resolveVendorNames(supabase, [typed])).get(vendorKey(typed));
      vendorPatch.vendor_name = hit?.name || typed;
      vendorPatch.vendor_netsuite_id = hit?.id || null;
    } else {
      vendorPatch.vendor_name = null;
      vendorPatch.vendor_netsuite_id = null;
    }
  }

  if (body.ids) {
    if (body.vendorName === undefined) {
      return NextResponse.json({ error: 'Only the vendor can be set on several requests at once' }, { status: 400 });
    }
    const { data: updated, error } = await supabase.from('purchase_requests')
      .update({ ...vendorPatch, updated_at: new Date().toISOString() })
      .in('id', body.ids).eq('status', 'pending')
      .select('id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, updated: (updated || []).length, vendor: vendorPatch });
  }

  const { data: row } = await supabase
    .from('purchase_requests').select('id, status').eq('id', body.id!).maybeSingle();
  if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  if (row.status !== 'pending') {
    return NextResponse.json({ error: `This request is already ${row.status} — only pending requests can change.` }, { status: 409 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), ...vendorPatch };
  if (body.cancel) patch.status = 'cancelled';
  if (body.quantity !== undefined) patch.quantity = body.quantity;
  if (body.neededBy !== undefined) patch.needed_by = body.neededBy || null;
  if (body.note !== undefined) patch.note = body.note || null;

  const { error } = await supabase.from('purchase_requests').update(patch).eq('id', body.id!);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, vendor: vendorPatch });
}
