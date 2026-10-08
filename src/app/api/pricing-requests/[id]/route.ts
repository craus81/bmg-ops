import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import type { PricingRequest } from '@/lib/pricing-request';
import { PRICING_REQUEST_SELECT, customerForNetsuiteId, loadPoNumbers, loadPriceSheets, withStage } from '@/lib/pricing-request-server';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadOne(id: string) {
  const { data: row, error } = await service.from('pricing_requests').select(PRICING_REQUEST_SELECT).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;
  const r = row as unknown as PricingRequest;
  const sheets = await loadPriceSheets(service, [r.id], { withLines: true });
  const poNumbers = await loadPoNumbers(service, r.po_id ? [r.po_id] : []);
  return withStage(r, sheets.get(r.id) || null, r.po_id ? poNumbers.get(r.po_id) || null : null);
}

/**
 * GET /api/pricing-requests/[id]: one request with its price sheet (lines
 * included), internal notes, PO number, the catalog parts it became, and the
 * customer's local id (the price sheet's customer).
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  try {
    const request = await loadOne(params.id);
    if (!request) return NextResponse.json({ error: 'Pricing request not found' }, { status: 404 });

    const [{ data: notes }, customer, { data: parts }] = await Promise.all([
      service.from('pricing_request_notes')
        .select('id, body, created_at, author:profiles!pricing_request_notes_author_id_fkey(full_name)')
        .eq('pricing_request_id', params.id)
        .order('created_at', { ascending: true }).order('id'),
      customerForNetsuiteId(service, request.customer_netsuite_id),
      service.from('netsuite_parts')
        .select('id, item_number, netsuite_id, sales_price')
        .in('id', [request.part_id, request.install_part_id].filter(Boolean) as string[]),
    ]);

    return NextResponse.json({
      request,
      customer_id: customer?.id || null,
      customer_tax_exempt: customer?.tax_exempt || false,
      parts: parts || [],
      notes: (notes || []).map((n: any) => ({ id: n.id, body: n.body, created_at: n.created_at, author_name: n.author?.full_name || null })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not load the request' }, { status: 500 });
  }
}

const PatchSchema = z.object({
  company_name: z.string().trim().min(1).max(200).optional(),
  contact_name: z.string().trim().max(200).nullable().optional(),
  contact_email: z.string().trim().email().max(254).nullable().optional().or(z.literal('')),
  received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  vehicle: z.string().trim().max(200).nullable().optional(),
  status: z.enum(['open', 'declined', 'closed']).optional(),
  /** Mark this estimate as the request's price sheet. */
  estimate_id: z.string().uuid().optional(),
});

/**
 * PATCH /api/pricing-requests/[id]: edit the request, set Declined / Closed
 * (or reopen), or attach the price sheet the page just created.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { estimate_id, ...fields } = parsed.data;

  const { data: existing } = await service.from('pricing_requests').select('id').eq('id', params.id).maybeSingle();
  if (!existing) return NextResponse.json({ error: 'Pricing request not found' }, { status: 404 });

  if (estimate_id) {
    const { data: est } = await service.from('estimates')
      .select('id, pricing_request_id, netsuite_estimate_id, netsuite_so_id')
      .eq('id', estimate_id).maybeSingle();
    if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    if (est.pricing_request_id && est.pricing_request_id !== params.id) {
      return NextResponse.json({ error: 'That estimate already prices another request.' }, { status: 409 });
    }
    // A price sheet never reaches NetSuite; one that already did can't become one.
    if (est.netsuite_estimate_id || est.netsuite_so_id) {
      return NextResponse.json({ error: 'That estimate is already in NetSuite, so it can\'t be a price sheet.' }, { status: 409 });
    }
    const { error } = await service.from('estimates').update({ pricing_request_id: params.id }).eq('id', estimate_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    update[k] = v === '' ? null : v;
  }
  if (Object.keys(update).length > 0) {
    update.updated_at = new Date().toISOString();
    const { error } = await service.from('pricing_requests').update(update).eq('id', params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  try {
    return NextResponse.json({ request: await loadOne(params.id) });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Saved, but could not reload the request' }, { status: 500 });
  }
}
