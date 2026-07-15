import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { verifyPoInvoiceQuantities } from '@/lib/po-invoice-verify';
import { refreshPoInvoiceLinks } from '@/lib/po-invoice-sync';

export const dynamic = 'force-dynamic';
// One SuiteQL sweep per ~100 invoices plus a per-PO update — comfortably
// inside 60s today, but well past the default ceiling on big PO books.
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/pos/verify-invoices — manual trigger for the invoiced-quantity
 * check (see verifyPoInvoiceQuantities). The netsuite-sync cron runs the
 * same check after each invoice sweep; this button exists for right-now.
 *
 * With a JSON body of { poId }, the check is scoped to that one PO and its
 * invoice links are refreshed against NetSuite first (new invoices linked,
 * deleted ones unlinked) — the "Recheck billing" button after fixing an
 * invoice in NetSuite. Returns the refreshed PO row so the client can
 * update it in place.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  let poId: string | null = null;
  try {
    const body = await req.json();
    if (body && typeof body.poId === 'string') poId = body.poId;
  } catch {
    // no body — full sweep
  }

  try {
    if (poId) {
      const links = await refreshPoInvoiceLinks(service, poId);
      const result = await verifyPoInvoiceQuantities(service, [poId]);
      const { data: po } = await service
        .from('purchase_orders')
        .select('*, po_line_items(*), po_invoices(*)')
        .eq('id', poId)
        .maybeSingle();
      return NextResponse.json({ success: true, ...result, links, po });
    }

    const result = await verifyPoInvoiceQuantities(service);
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    console.error('Verify invoices error:', err);
    return NextResponse.json({ error: err.message || 'Failed to verify invoices' }, { status: 500 });
  }
}
