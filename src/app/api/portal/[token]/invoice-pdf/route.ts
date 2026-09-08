import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { resolvePortalCustomer } from '@/lib/portal-token';
import { invoiceBelongsToCustomer } from '@/lib/portal-billing';
import { getNetSuitePdf } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/portal/[token]/invoice-pdf?id=<netsuite internal id> (R5-14):
 * streams one invoice PDF to the token's customer. NetSuite invoice PDFs
 * come from the RESTlet as base64 (they are not R2 objects like the
 * portal's PO files), so this is the token-guarded streaming route the
 * audit doc anticipated. The id is verified against the customer's own
 * open-invoice set BEFORE any fetch — an id belonging to another customer
 * 404s identically to a bogus one.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'po_portal_invoice_pdf', 30)) {
    return NextResponse.json({ error: 'Too many requests — try again shortly.' }, { status: 429 });
  }

  const customer = await resolvePortalCustomer(service, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const id = (req.nextUrl.searchParams.get('id') || '').trim();
  if (!/^\d{1,15}$/.test(id)) {
    return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });
  }

  try {
    if (!await invoiceBelongsToCustomer(customer.netsuite_id, id)) {
      return NextResponse.json({ status: 'invalid' }, { status: 404 });
    }
    const pdf = await getNetSuitePdf('invoice', id);
    if (!pdf.success || !pdf.pdfBase64) {
      return NextResponse.json({ error: 'The invoice PDF is temporarily unavailable — try again shortly.' }, { status: 502 });
    }
    const buffer = Buffer.from(pdf.pdfBase64, 'base64');
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${(pdf.filename || `Invoice_${id}.pdf`).replace(/[^\w.\- ]+/g, '')}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e: any) {
    console.error('portal invoice pdf failed:', e);
    return NextResponse.json({ error: 'The invoice PDF is temporarily unavailable — try again shortly.' }, { status: 502 });
  }
}
