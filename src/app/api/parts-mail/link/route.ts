import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { findPoByNumber, applyEmailToPo } from '@/lib/parts-email-scan';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const LinkSchema = z.object({
  emailId: z.string().uuid(),
  // Empty poNumber = dismiss the email to 'ignored'.
  poNumber: z.string().trim().max(60).optional().nullable(),
});

/**
 * POST /api/parts-mail/link — resolve a review-queue email: link it to a
 * vendor PO by PO number (applying its ETA/tracking), or dismiss it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, LinkSchema);
  if (parsed.error) return parsed.error;
  const { emailId, poNumber } = parsed.data;

  const { data: email } = await service
    .from('vendor_shipment_emails')
    .select('*')
    .eq('id', emailId)
    .maybeSingle();
  if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 });

  if (!poNumber) {
    await service.from('vendor_shipment_emails')
      .update({ classification: 'ignored' })
      .eq('id', emailId);
    return NextResponse.json({ classification: 'ignored' });
  }

  const po = await findPoByNumber(service, poNumber);
  if (!po) return NextResponse.json({ error: `No synced vendor PO matches "${poNumber}"` }, { status: 404 });

  const outcome = await applyEmailToPo(
    service,
    {
      vendor_name: email.vendor_name,
      po_number: poNumber,
      ship_date: email.ship_date,
      eta_date: email.eta_date,
      tracking_number: email.tracking_number,
      carrier: email.carrier,
    },
    po,
    email.subject?.slice(0, 120) || 'manually linked email',
  );

  await service.from('vendor_shipment_emails')
    .update({ classification: outcome, matched_po_id: po.id, po_number: poNumber })
    .eq('id', emailId);

  return NextResponse.json({ classification: outcome, po: { tranid: po.tranid, vendor_name: po.vendor_name } });
}
