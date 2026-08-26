import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { resolveCustomerNsId, deriveProposedLines, deriveWrapQuoteLines } from '@/lib/graphics-invoice';

export const dynamic = 'force-dynamic';

const Schema = z.object({ jobId: z.string().uuid() });

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * POST /api/graphics/invoice-preview
 * Read-only. Resolves the customer and the proposed per-part invoice lines
 * (quantities from the linked PO, prices from the catalog/NetSuite) so the UI
 * can show them for verification BEFORE any invoice/packing list is created.
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
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    const [customerNsId, derived, wrapQuote] = await Promise.all([
      resolveCustomerNsId(supabase, job),
      deriveProposedLines(supabase, job),
      deriveWrapQuoteLines(supabase, job),
    ]);

    // Parts on the job win; otherwise (the typical wrap-quote job, which has
    // no parts) the wrap quote's material/labor totals carry through as the
    // proposed lines so they reach the invoice.
    const usingWrapQuote = derived.lines.length === 0 && !!wrapQuote && wrapQuote.lines.length > 0;
    const lines = usingWrapQuote ? wrapQuote!.lines : derived.lines;

    return NextResponse.json({
      alreadyInvoiced: job.netsuite_invoice_id
        ? { id: job.netsuite_invoice_id, number: job.netsuite_invoice_number }
        : null,
      customer: { netsuiteId: customerNsId, name: job.customer || null },
      poNumber: job.po_number || null,
      jobQuantity: job.quantity || 1,
      lines,
      skippedParts: usingWrapQuote ? [] : derived.skippedParts,
      wrapQuote: wrapQuote
        ? {
            quoteNumber: wrapQuote.quoteNumber,
            materialsTotal: wrapQuote.materialsTotal,
            laborTotal: wrapQuote.laborTotal,
            total: wrapQuote.total,
            applied: usingWrapQuote,
          }
        : null,
      // Prefill for the "add NetSuite customer" form when the job has no
      // NetSuite customer yet — taken from the wrap quote's customer snapshot.
      customerPrefill: !customerNsId ? wrapQuote?.customerPrefill || null : null,
    });
  } catch (err: any) {
    console.error('Graphics invoice-preview error:', err);
    return NextResponse.json({ error: err.message || 'Failed to build invoice preview' }, { status: 500 });
  }
}
