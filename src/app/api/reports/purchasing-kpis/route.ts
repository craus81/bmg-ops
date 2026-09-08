import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { computePurchasingKpis, type ReceiptRecord, type RequestRecord } from '@/lib/purchasing-kpis';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Purchasing cycle-time KPIs (R6-7). Every timestamp already existed — a
 * request raised, ordered onto a PO, received at the dock — and nothing
 * measured the gaps between them.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, z.object({ days: z.coerce.number().min(30).max(730).optional() }));
  if (q.error) return q.error;
  const days = q.data.days || 180;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const [{ data: reqs, error: reqErr }, { data: receipts, error: recErr }] = await Promise.all([
      fetchAllRows<any>((from, to) => service
        .from('purchase_requests')
        .select('id, item_number, vendor_name, created_at, ordered_at, needed_by, status, ordered_po_id')
        .gte('created_at', since)
        .order('created_at').order('id')
        .range(from, to)),
      fetchAllRows<any>((from, to) => service
        .from('po_receipts')
        .select('po_id, item_number, received_at')
        .gte('received_at', since)
        .order('received_at').order('id')
        .range(from, to)),
    ]);
    if (reqErr) return NextResponse.json({ error: reqErr.message }, { status: 500 });
    if (recErr) return NextResponse.json({ error: recErr.message }, { status: 500 });

    const requests: RequestRecord[] = (reqs || []).map((r: any) => ({
      id: r.id,
      itemNumber: r.item_number,
      vendorName: r.vendor_name,
      createdAt: r.created_at,
      orderedAt: r.ordered_at,
      neededBy: r.needed_by,
      status: r.status,
      orderedPoId: r.ordered_po_id,
    }));
    const recs: ReceiptRecord[] = (receipts || []).map((r: any) => ({
      poId: r.po_id, itemNumber: r.item_number, receivedAt: r.received_at,
    }));

    return NextResponse.json({
      days,
      ...computePurchasingKpis(requests, recs),
      // History only starts where the capture did; say so rather than
      // letting a thin window read as a fast shop.
      since,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Report failed' }, { status: 500 });
  }
}
