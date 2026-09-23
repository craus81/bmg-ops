import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { findSoInvoices, isFullyBilledSoStatus, stampVehicleInvoice } from '@/lib/so-invoices';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/so-invoices?soId=12345[&checkinId=<uuid>]
 *
 * The customer invoices billed FROM a sales order, straight from NetSuite —
 * so it sees invoices created in NetSuite AND ones FleetSuite raised via the
 * SO→invoice transform, with no sync lag. Drives the In-Shop record's
 * "invoice replaces the sales order once billed" behavior: an invoiced SO is
 * basically dead paper, the invoice is what staff need to open. How the
 * lookup finds them (and why it no longer trusts createdfrom alone) is in
 * src/lib/so-invoices.ts.
 *
 * With `checkinId` (the vehicle the record is open on), a fully billed SO is
 * also stamped onto that vehicle — the same ledger row and invoice number the
 * completion flow writes — so the board's Invoiced badge doesn't wait for the
 * next sync.
 *
 * Returns { invoices: [{ id, tranid, trandate, total, status }], fullyBilled,
 * vehicle: { invoiceNumber, dateInvoiced } | null }. A failed lookup is a 502
 * with the reason — never an empty list, which would read as "not invoiced".
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const soId = req.nextUrl.searchParams.get('soId')?.trim() || '';
  if (!/^\d{1,15}$/.test(soId)) {
    return NextResponse.json({ error: 'soId must be a NetSuite internal id' }, { status: 400 });
  }
  const checkinId = req.nextUrl.searchParams.get('checkinId')?.trim() || '';
  if (checkinId && !/^[0-9a-f-]{36}$/i.test(checkinId)) {
    return NextResponse.json({ error: 'checkinId must be a vehicle id' }, { status: 400 });
  }

  let lookup;
  try {
    lookup = await findSoInvoices([soId]);
  } catch (err: any) {
    console.error('SO invoice lookup error:', err);
    return NextResponse.json({ error: err?.message || 'Lookup failed' }, { status: 502 });
  }

  const invoices = lookup.invoices.get(soId) || [];
  const soStatus = lookup.soStatus.get(soId);
  const fullyBilled = invoices.length > 0 && isFullyBilledSoStatus(soStatus);

  let vehicle: { invoiceNumber: string; dateInvoiced: string | null } | null = null;
  if (checkinId && fullyBilled) {
    // Stamp only a vehicle this SO is actually linked to (join table or the
    // legacy primary column) — the query string is not trusted for that.
    const service = createServiceClient();
    const [{ data: link }, { data: checkin }] = await Promise.all([
      service.from('fleet_checkin_sales_orders').select('id')
        .eq('checkin_id', checkinId).eq('netsuite_sales_order_id', soId).maybeSingle(),
      service.from('fleet_checkins').select('id, netsuite_sales_order_id').eq('id', checkinId).maybeSingle(),
    ]);
    if (checkin && (link || String(checkin.netsuite_sales_order_id || '') === soId)) {
      try {
        const out = await stampVehicleInvoice(service, checkinId, soId, invoices, soStatus);
        if (out.invoiceNumber) vehicle = { invoiceNumber: out.invoiceNumber, dateInvoiced: out.dateInvoiced };
      } catch (err) {
        // The answer is still right; the next sync retries the stamp.
        console.warn('SO invoice stamp failed:', err);
      }
    }
  }

  return NextResponse.json({ invoices, fullyBilled, via: lookup.via, vehicle });
}
