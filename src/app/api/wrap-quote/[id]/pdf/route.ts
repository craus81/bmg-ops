import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { r2GetBytes } from '@/lib/r2';
import { buildQuoteDocPdf, type QuoteDocPdfImage } from '@/lib/quote-doc-pdf';
import { wrapQuoteDocModel } from '@/lib/wrap-quote-document';

export const dynamic = 'force-dynamic';

const MAX_LOGO_BYTES = 3 * 1024 * 1024;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * GET /api/wrap-quote/[id]/pdf — the FleetSuite copy of a wrap quote as a
 * PDF, built from the shared quote-document model (the same rows the
 * customer's email and the signed snapshot render), so the Transactions
 * list on a customer record can hand out the FleetSuite document next to
 * NetSuite's own PDF.
 *
 *   ?print=1    → autoPrint: the browser's PDF viewer opens its print dialog
 *   ?download=1 → attachment disposition instead of inline
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const supabase = getSupabase();
  const { data: quote, error } = await supabase
    .from('wrap_quotes')
    .select('*')
    .eq('id', params.id)
    .single();
  if (error || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // Letterhead — the same settings singleton the emailed quote uses.
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || null;
  let logo: QuoteDocPdfImage | null = null;
  if (company?.logo_path) {
    const got = await r2GetBytes('vehicle-templates', company.logo_path, MAX_LOGO_BYTES);
    const format = got?.contentType.includes('png') ? 'PNG'
      : (got?.contentType.includes('jpeg') || got?.contentType.includes('jpg')) ? 'JPEG'
        : null;
    if (got && format) {
      logo = {
        dataUrl: `data:${format === 'PNG' ? 'image/png' : 'image/jpeg'};base64,${got.bytes.toString('base64')}`,
        format,
      };
    }
  }

  // The internal copy always prices the quote; hide_line_items is the
  // sender's customer-facing choice and is honored here too, so what staff
  // hand over matches what the customer was shown. The coverage diagram is
  // an emails-only element (a mutable R2 object) and stays out.
  const doc = buildQuoteDocPdf(
    wrapQuoteDocModel(quote, { pricing: true, lineItems: !quote.hide_line_items }),
    { company, logo },
  );
  if (req.nextUrl.searchParams.get('print') === '1') doc.autoPrint();

  const download = req.nextUrl.searchParams.get('download') === '1';
  const filename = `Wrap-Quote-${String(quote.quote_number || params.id).replace(/[^\w-]+/g, '_')}.pdf`;

  return new NextResponse(new Uint8Array(doc.output('arraybuffer')), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
