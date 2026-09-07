import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { z } from '@/lib/validate';
import { loadThreeWayMatchForPo } from '@/lib/three-way-match';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/parts-mail/bill-match?invoiceId= (R4-8) — the three-way match
 * for one captured vendor invoice against its linked PO, so the Parts Mail
 * card can show the verdict BEFORE anyone clicks Create Bill. Same guard
 * as create-bill, which recomputes the match server-side on the click —
 * this endpoint is display, not enforcement.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'finance']);
  if (auth.error) return auth.error;

  const invoiceId = new URL(req.url).searchParams.get('invoiceId') || '';
  if (!z.string().uuid().safeParse(invoiceId).success) {
    return NextResponse.json({ error: 'Invalid invoiceId' }, { status: 400 });
  }

  try {
    const { data: invoice } = await service
      .from('vendor_parts_invoices')
      .select('id, total, matched_po_id, status')
      .eq('id', invoiceId)
      .maybeSingle();
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    if (!invoice.matched_po_id) return NextResponse.json({ match: null, needsPo: true });

    const { match, poTranid } = await loadThreeWayMatchForPo(
      service, invoice.matched_po_id, invoice.total != null ? Number(invoice.total) : null, invoice.id,
    );
    return NextResponse.json({ match, poTranid });
  } catch (err: any) {
    console.error('bill-match failed:', err);
    return NextResponse.json({ error: err?.message || 'Match failed' }, { status: 500 });
  }
}
