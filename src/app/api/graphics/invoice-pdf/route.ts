import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { getNetSuitePdf } from '@/lib/netsuite';
import { r2Upload } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  jobId: z.string().uuid(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * POST /api/graphics/invoice-pdf
 * Pulls the invoice PDF for a graphics job from the NetSuite RESTlet,
 * stores it in R2, and saves the public URL on the graphics job so the
 * UI can link to the stored copy instead of deep-linking into NetSuite.
 *
 * Body: { jobId: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;

  try {
    const supabase = getSupabase();

    const { data: job, error: jobErr } = await supabase
      .from('graphics_jobs')
      .select('id, netsuite_invoice_id, netsuite_invoice_number, invoice_pdf_url')
      .eq('id', jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    if (!job.netsuite_invoice_id) {
      return NextResponse.json({ error: 'This job has no invoice yet.' }, { status: 400 });
    }

    // Pull the PDF from NetSuite
    const pdf = await getNetSuitePdf('invoice', job.netsuite_invoice_id);
    if (!pdf.success || !pdf.pdfBase64) {
      return NextResponse.json({ error: pdf.error || 'Failed to fetch invoice PDF from NetSuite' }, { status: 502 });
    }

    const buffer = Buffer.from(pdf.pdfBase64, 'base64');
    const safeNum = (job.netsuite_invoice_number || job.netsuite_invoice_id)
      .toString()
      .replace(/[^a-z0-9]+/gi, '-');
    const path = `graphics-${jobId}-${safeNum}.pdf`;

    const upload = await r2Upload('invoices', path, buffer, 'application/pdf');
    if (!upload.success) {
      return NextResponse.json({ error: upload.error || 'Failed to store invoice PDF' }, { status: 502 });
    }

    await supabase
      .from('graphics_jobs')
      .update({ invoice_pdf_url: upload.publicUrl, updated_at: new Date().toISOString() })
      .eq('id', jobId);

    return NextResponse.json({ success: true, url: upload.publicUrl });
  } catch (err: any) {
    console.error('Graphics invoice-pdf error:', err);
    return NextResponse.json({ error: err.message || 'Failed to store invoice PDF' }, { status: 500 });
  }
}
