import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { INSTALL_PREFIX, PART_PREFIX } from '@/lib/po-install-parts';
import { newPartPairs, quotedPrices, type PoLineForLink, type PricingRequest } from '@/lib/pricing-request';
import { PRICING_REQUEST_SELECT, loadPriceSheets, withStage } from '@/lib/pricing-request-server';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/pricing-requests/link-po?poId=: what the PO page needs to offer
 * "Link pricing request" (migration 352). Returns the PO's new 02 / 06 lines
 * (not yet real NetSuite items) paired by suffix, the requests already
 * linked to this PO, and the open requests that could be linked, each with
 * its quoted graphic and install prices. Admin only, like the PO page.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const poId = req.nextUrl.searchParams.get('poId') || '';
  if (!UUID_RE.test(poId)) return NextResponse.json({ error: 'poId required' }, { status: 400 });

  const { data: lineRows, error: lineErr } = await service.from('po_line_items')
    .select('id, part_number, description, unit_price, part_id, part:netsuite_parts(netsuite_id)')
    .eq('po_id', poId)
    .order('line_no', { ascending: true, nullsFirst: false }).order('id');
  if (lineErr) return NextResponse.json({ error: lineErr.message }, { status: 500 });

  const lines: PoLineForLink[] = (lineRows || []).map((l: any) => ({
    id: l.id,
    part_number: l.part_number,
    description: l.description,
    unit_price: l.unit_price == null ? null : Number(l.unit_price),
    part_id: l.part_id,
    part_netsuite_id: l.part?.netsuite_id || null,
  }));

  const { data: all, error } = await fetchAllRows<PricingRequest>((from, to) =>
    service.from('pricing_requests').select(PRICING_REQUEST_SELECT)
      .or(`po_id.is.null,po_id.eq.${poId}`)
      .neq('status', 'declined')
      .order('created_at', { ascending: false }).order('id')
      .range(from, to) as any);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    const rows = all || [];
    const sheets = await loadPriceSheets(service, rows.map(r => r.id), { withLines: true });
    const shaped = rows.map(r => {
      const sheet = sheets.get(r.id) || null;
      return { ...withStage(r, sheet, null), quoted: quotedPrices(sheet?.lines || []) };
    });
    const linked = shaped.filter(r => r.po_id === poId);
    const linkedNumbers = linked.flatMap(r => [r.part_number, r.install_part_number]).filter(Boolean) as string[];
    return NextResponse.json({
      pairs: newPartPairs(lines, linkedNumbers),
      linked,
      candidates: shaped.filter(r => !r.po_id && r.status === 'open'),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not load pricing requests' }, { status: 500 });
  }
}

const LinkSchema = z.object({
  requestId: z.string().uuid(),
  poId: z.string().uuid(),
  partLineId: z.string().uuid().nullable().optional(),
  installLineId: z.string().uuid().nullable().optional(),
  /** Catalog rows for the two numbers (the page creates the NetSuite items
   *  through /api/netsuite/create-item first). */
  partId: z.string().uuid().nullable().optional(),
  installPartId: z.string().uuid().nullable().optional(),
  partPrice: z.number().nonnegative().nullable().optional(),
  installPrice: z.number().nonnegative().nullable().optional(),
});

/**
 * POST /api/pricing-requests/link-po: tie a request to the PO it became.
 * Points the PO lines at the catalog parts, fills the parts' end customer
 * and vehicle when blank (the same fields PO import sets), and records the
 * numbers, prices and PO on the request (which then reads On PO).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, LinkSchema);
  if (parsed.error) return parsed.error;
  const b = parsed.data;
  if (!b.partLineId && !b.installLineId) {
    return NextResponse.json({ error: 'Pick the 02 line, the 06 line, or both.' }, { status: 400 });
  }

  const { data: request } = await service.from('pricing_requests')
    .select('id, po_id, company_name, vehicle, status')
    .eq('id', b.requestId).maybeSingle();
  if (!request) return NextResponse.json({ error: 'Pricing request not found' }, { status: 404 });
  if (request.po_id && request.po_id !== b.poId) {
    return NextResponse.json({ error: 'That request is already linked to another PO.' }, { status: 409 });
  }

  const lineIds = [b.partLineId, b.installLineId].filter(Boolean) as string[];
  const { data: lines } = await service.from('po_line_items')
    .select('id, po_id, part_number').in('id', lineIds);
  const byId = new Map((lines || []).map((l: any) => [l.id, l]));
  for (const [lineId, prefix] of [[b.partLineId, PART_PREFIX], [b.installLineId, INSTALL_PREFIX]] as const) {
    if (!lineId) continue;
    const line = byId.get(lineId);
    if (!line || line.po_id !== b.poId) return NextResponse.json({ error: 'That line is not on this PO.' }, { status: 400 });
    if (!String(line.part_number || '').toUpperCase().startsWith(prefix)) {
      return NextResponse.json({ error: `${line.part_number} doesn't start with ${prefix}.` }, { status: 400 });
    }
  }

  // PO lines → catalog parts.
  for (const [lineId, partId] of [[b.partLineId, b.partId], [b.installLineId, b.installPartId]] as const) {
    if (!lineId || !partId) continue;
    const { error } = await service.from('po_line_items').update({ part_id: partId }).eq('id', lineId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Fill the catalog fields PO import would have asked for, never overwriting.
  const partIds = [b.partId, b.installPartId].filter(Boolean) as string[];
  if (partIds.length > 0) {
    const { data: parts } = await service.from('netsuite_parts')
      .select('id, billable_customer, vehicle_type, graphic_package').in('id', partIds);
    for (const p of parts || []) {
      const fill: Record<string, string> = {};
      if (!p.billable_customer) fill.billable_customer = request.company_name;
      if (!p.vehicle_type && request.vehicle) fill.vehicle_type = request.vehicle;
      if (!p.graphic_package) fill.graphic_package = request.company_name;
      if (Object.keys(fill).length > 0) await service.from('netsuite_parts').update(fill).eq('id', p.id);
    }
  }

  const now = new Date().toISOString();
  const { error: upErr } = await service.from('pricing_requests').update({
    po_id: b.poId,
    part_number: b.partLineId ? byId.get(b.partLineId)?.part_number || null : null,
    install_part_number: b.installLineId ? byId.get(b.installLineId)?.part_number || null : null,
    part_id: b.partId || null,
    install_part_id: b.installPartId || null,
    part_price: b.partPrice ?? null,
    install_price: b.installPrice ?? null,
    linked_at: now,
    linked_by: auth.user?.id || null,
    updated_at: now,
  }).eq('id', b.requestId);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
