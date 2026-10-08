import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { matchCustomer } from '@/lib/customer-match';
import { nextJobNumber } from '@/lib/job-numbers';
import type { PricingRequest } from '@/lib/pricing-request';
import { PRICING_REQUEST_SELECT, loadPoNumbers, loadPriceSheets, withStage } from '@/lib/pricing-request-server';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/pricing-requests: every pricing request (migration 352), newest
 * first, each with its stage, price sheet summary and PO number.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const { data, error } = await fetchAllRows<PricingRequest>((from, to) =>
    service.from('pricing_requests').select(PRICING_REQUEST_SELECT)
      .order('created_at', { ascending: false }).order('id')
      .range(from, to) as any);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    const rows = data || [];
    const sheets = await loadPriceSheets(service, rows.map(r => r.id));
    const poNumbers = await loadPoNumbers(service, rows.map(r => r.po_id || ''));
    return NextResponse.json({
      requests: rows.map(r => withStage(r, sheets.get(r.id) || null, r.po_id ? poNumbers.get(r.po_id) || null : null)),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not load price sheets' }, { status: 500 });
  }
}

const CreateSchema = z.object({
  customer_name: z.string().trim().min(1).max(200),
  company_name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().max(200).nullable().optional(),
  contact_email: z.string().trim().email().max(254).nullable().optional().or(z.literal('')),
  received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  vehicle: z.string().trim().max(200).nullable().optional(),
  request_type: z.enum(['new', 'update']).optional(),
  /** Update requests: the existing catalog parts being repriced. */
  part_id: z.string().uuid().nullable().optional(),
  install_part_id: z.string().uuid().nullable().optional(),
  vendor_name: z.string().trim().max(200).nullable().optional(),
  vendor_cost: z.number().nonnegative().max(1_000_000).nullable().optional(),
  target_margin_pct: z.number().min(0).lt(100).nullable().optional(),
});

const fallbackNumber = () => `PRQ-${Date.now().toString(36).toUpperCase()}`;

/**
 * POST /api/pricing-requests: log a pricing request by hand (owner: manual
 * entry first, 2026-10-08). The customer resolves to its NetSuite name
 * ("Masterack" → "Masterack LLC"). The page then starts the price sheet.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CreateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const requestType = body.request_type || 'new';
  // Updated pricing names its catalog parts up front; a new product gets its
  // numbers from the PO later.
  let partNumber: string | null = null;
  let installPartNumber: string | null = null;
  if (requestType === 'update') {
    const ids = [body.part_id, body.install_part_id].filter(Boolean) as string[];
    if (ids.length === 0) {
      return NextResponse.json({ error: 'Pick the part (and its install) that is getting new pricing.' }, { status: 400 });
    }
    const { data: parts } = await service.from('netsuite_parts').select('id, item_number').in('id', ids);
    const byId = new Map((parts || []).map((p: any) => [p.id, p.item_number as string]));
    if (ids.some(id => !byId.has(id))) return NextResponse.json({ error: 'Part not found in the catalog' }, { status: 404 });
    partNumber = body.part_id ? byId.get(body.part_id) || null : null;
    installPartNumber = body.install_part_id ? byId.get(body.install_part_id) || null : null;
  }

  const match = await matchCustomer(service, body.customer_name).catch(() => null);

  let row: any = null;
  let insertErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const request_number = await nextJobNumber(service, 'PRQ', fallbackNumber);
    const res = await service.from('pricing_requests').insert({
      request_number,
      customer_name: match?.companyName || body.customer_name,
      customer_netsuite_id: match?.netsuiteId || null,
      company_name: body.company_name,
      contact_name: body.contact_name || null,
      contact_email: body.contact_email || null,
      received_date: body.received_date || new Date().toISOString().slice(0, 10),
      description: body.description || null,
      vehicle: body.vehicle || null,
      request_type: requestType,
      part_id: requestType === 'update' ? body.part_id || null : null,
      install_part_id: requestType === 'update' ? body.install_part_id || null : null,
      part_number: partNumber,
      install_part_number: installPartNumber,
      vendor_name: body.vendor_name || null,
      vendor_cost: body.vendor_cost ?? null,
      target_margin_pct: body.target_margin_pct ?? null,
      created_by: auth.user?.id || null,
    }).select(PRICING_REQUEST_SELECT).single();
    row = res.data;
    insertErr = res.error;
    if (!insertErr || insertErr.code !== '23505') break;
  }
  if (insertErr || !row) return NextResponse.json({ error: insertErr?.message || 'Could not save the request' }, { status: 500 });

  return NextResponse.json({ request: withStage(row, null, null) });
}
