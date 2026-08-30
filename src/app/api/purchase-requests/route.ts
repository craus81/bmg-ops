import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { computePartsReadiness } from '@/lib/parts-readiness';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
  neededBy: z.string().max(20).optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
  /** When set, the response carries recomputed readiness for this project —
   *  the allocations-route pattern: mutate + refresh in one round trip. */
  returnReadiness: z.boolean().optional().default(false),
});

const UpdateSchema = z.object({
  id: z.string().uuid(),
  quantity: z.number().positive().max(100000).optional(),
  vendorName: z.string().max(200).optional().nullable(),
  neededBy: z.string().max(20).optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
  cancel: z.boolean().optional().default(false),
});

/** GET /api/purchase-requests?status=pending — the purchasing queue. */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status') || 'pending';

  const { data, error } = await supabase
    .from('purchase_requests')
    .select('*, upfit_projects(id, project_name, netsuite_so_number), requester:profiles!purchase_requests_requested_by_fkey(full_name)')
    .eq('status', status)
    .order('vendor_name', { ascending: true, nullsFirst: true })
    .order('created_at')
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, requests: data || [] });
}

/**
 * POST — create requests (bulk; one call per readiness-card action).
 * Idempotent per item+project: an existing PENDING request for the same
 * item and project gets its quantity RAISED to the new ask instead of a
 * duplicate row, so double-clicks and re-requests don't inflate the queue.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CreateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

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
  // the catalog's vendor field is blank for most parts.
  const missingVendor = itemNumbers.filter(n => !catalog.get(n)?.vendor);
  const lastVendor = new Map<string, { name: string | null; id: string | null }>();
  if (missingVendor.length > 0) {
    const { data: lines } = await supabase
      .from('netsuite_vendor_po_lines')
      .select('item_number, netsuite_vendor_pos!inner(vendor_name, vendor_netsuite_id, trandate)')
      .in('item_number', missingVendor)
      .limit(400);
    // Latest purchase wins per item — PostgREST can't order the parent by an
    // embedded column, so sort here.
    const sorted = ((lines || []) as any[]).sort((a, b) =>
      String(b.netsuite_vendor_pos?.trandate || '').localeCompare(String(a.netsuite_vendor_pos?.trandate || '')));
    for (const l of sorted) {
      const key = normalizeItemNumber(l.item_number);
      if (!lastVendor.has(key) && l.netsuite_vendor_pos?.vendor_name) {
        lastVendor.set(key, { name: l.netsuite_vendor_pos.vendor_name, id: l.netsuite_vendor_pos.vendor_netsuite_id || null });
      }
    }
  }

  // Existing pending rows for idempotence.
  let dupQuery = supabase
    .from('purchase_requests')
    .select('id, item_number, quantity, source_project_id')
    .eq('status', 'pending')
    .in('item_number', itemNumbers);
  const { data: existing } = await dupQuery;
  const pendingKey = (item: string, proj: string | null) => `${item}::${proj || ''}`;
  const pendingByKey = new Map(
    (existing || [])
      .filter((r: any) => (r.source_project_id || null) === (body.projectId || null))
      .map((r: any) => [pendingKey(normalizeItemNumber(r.item_number), r.source_project_id), r]),
  );

  const created: string[] = [];
  const raised: string[] = [];
  for (const item of body.items) {
    const key = normalizeItemNumber(item.itemNumber);
    if (!key) continue;
    const cat = catalog.get(key);
    const dup: any = pendingByKey.get(pendingKey(key, body.projectId || null));
    if (dup) {
      if (Number(item.quantity) > Number(dup.quantity)) {
        await supabase.from('purchase_requests')
          .update({ quantity: item.quantity, updated_at: new Date().toISOString() })
          .eq('id', dup.id);
        raised.push(key);
      }
      continue;
    }
    const { data: row, error } = await supabase.from('purchase_requests').insert({
      item_number: key,
      netsuite_item_id: item.netsuiteItemId || cat?.netsuite_id || null,
      description: item.description || cat?.description || cat?.display_name || null,
      quantity: item.quantity,
      vendor_name: cat?.vendor || lastVendor.get(key)?.name || null,
      vendor_netsuite_id: lastVendor.get(key)?.id || null,
      source_project_id: body.projectId || null,
      needed_by: body.neededBy || null,
      note: body.note || null,
      requested_by: auth.user.id,
    }).select('id').single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    created.push(row.id);
  }

  // Purchasing (admins) hears about new asks — one digest per call.
  if (created.length > 0) {
    try {
      const { data: staff } = await supabase
        .from('profiles')
        .select('id, role, roles, status, deactivated')
        .eq('status', 'approved');
      const adminIds = (staff || [])
        .filter((p: any) => {
          if (p.deactivated || p.id === auth.user.id) return false;
          const roles = p.roles?.length ? p.roles : [p.role];
          return roles.some((r: string) => r === 'admin' || r === 'super_admin');
        })
        .map((p: any) => p.id);
      if (adminIds.length > 0) {
        let projectLabel: string | null = null;
        if (body.projectId) {
          const { data: proj } = await supabase
            .from('upfit_projects').select('project_name').eq('id', body.projectId).maybeSingle();
          projectLabel = proj?.project_name || null;
        }
        const lines = body.items.map(i => `${i.quantity}× ${normalizeItemNumber(i.itemNumber)}`).join(' · ');
        await notifyMany(adminIds, {
          type: 'purchase_request',
          title: `🛒 Parts requested${projectLabel ? ` — ${projectLabel}` : ''}`,
          body: `${lines}${body.neededBy ? ` · needed by ${body.neededBy}` : ''}`.slice(0, 900),
          url: deepLinks.purchaseRequests(created.length === 1 ? created[0] : undefined),
          channels: ['in_app', 'push'],
          forceChannels: true,
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

  return NextResponse.json({ success: true, created: created.length, raised: raised.length, readiness });
}

/** PATCH — edit quantity/vendor/date/note, or cancel. */
export async function PATCH(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { data: row } = await supabase
    .from('purchase_requests').select('id, status').eq('id', body.id).maybeSingle();
  if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  if (row.status !== 'pending') {
    return NextResponse.json({ error: `This request is already ${row.status} — only pending requests can change.` }, { status: 409 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.cancel) patch.status = 'cancelled';
  if (body.quantity !== undefined) patch.quantity = body.quantity;
  if (body.vendorName !== undefined) patch.vendor_name = body.vendorName?.trim() || null;
  if (body.neededBy !== undefined) patch.needed_by = body.neededBy || null;
  if (body.note !== undefined) patch.note = body.note || null;

  const { error } = await supabase.from('purchase_requests').update(patch).eq('id', body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
