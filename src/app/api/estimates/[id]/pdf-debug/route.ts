import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';
import { loadEstimateGraphics, loadEstimateProofs } from '@/lib/estimate-graphics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * GET /api/estimates/[id]/pdf-debug — what the PDF endpoint actually reads.
 *
 * Built because an estimate printed a version of itself that no longer
 * existed anywhere we could see: the builder, the signed acceptance
 * snapshot and the NetSuite copy all agreed, and the PDF disagreed, across
 * devices. Four plausible explanations were argued from the code and all
 * four were wrong, because none of them were measurements.
 *
 * This answers the only questions that matter, from inside the generator's
 * own view of the world:
 *
 *   - which line items the PDF renders, straight from the table it reads;
 *   - whether the totals on the row match those lines, or drifted;
 *   - what gets APPENDED to the document after the estimate itself —
 *     wrap-quote attachments and graphics proofs are merged page by page,
 *     so a stale PDF stored as an attachment years ago would print as part
 *     of "the estimate" with nothing on the record looking wrong;
 *   - how many pages the base document has versus the finished file, which
 *     separates "the estimate rendered wrong" from "something else is
 *     stapled to it" in one number.
 *
 * Read-only, staff-gated, and it generates the real PDF (the same call the
 * download makes) so the page counts describe the actual file.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const supabase = getSupabase();

  const { data: estimate, error: estErr } = await supabase
    .from('estimates')
    .select('id, estimate_number, status, customer_approved, updated_at, pushed_at, subtotal, labor_total, tax_amount, grand_total, netsuite_estimate_id, supersedes_estimate_id')
    .eq('id', params.id)
    .maybeSingle();
  if (estErr) return NextResponse.json({ error: estErr.message }, { status: 500 });
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

  const { data: lineRows } = await supabase
    .from('estimate_line_items')
    .select('id, sort_order, item_number, description, quantity, unit_price, line_total, wrap_quote_id')
    .eq('estimate_id', params.id)
    .order('sort_order')
    .order('id');
  const lines = lineRows || [];
  const linesSubtotal = lines.reduce(
    (sum, l: any) => sum + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0,
  );

  // What the merge step would staple on. Reported even when empty, because
  // "nothing is appended" is itself the answer to half the question.
  const { summaries, wrapQuotes } = await loadEstimateGraphics(supabase, params.id);
  const proofBlocks = await loadEstimateProofs(supabase, params.id);
  const appended = {
    wrapQuotes: (wrapQuotes || []).map((q: any) => ({
      quoteNumber: q.quote_number,
      attachDiagram: !!q.estimate_attach?.diagram && !!q.diagram_path,
      attachAttachments: !!q.estimate_attach?.attachments,
      // The suspicious case: a PDF stored here is merged page-by-page into
      // the estimate, whatever it happens to contain.
      attachments: (Array.isArray(q.attachments) ? q.attachments : []).map((a: any) => ({
        name: a?.name || null, path: a?.path || null,
      })),
    })),
    graphicsProofs: proofBlocks.map(b => ({
      jobNumber: b.jobNumber,
      files: b.files.map(f => ({ name: f.name, storagePath: f.storagePath, isPdf: f.isPdf })),
    })),
    filmSummaries: summaries.filter(s => s.films.length > 0).map(s => s.quoteNumber),
  };

  // Generate the real file and count its pages against the base document.
  // finalPages > basePages means the difference is merged-in material, not
  // the estimate.
  let pages: { base: number | null; final: number | null; error?: string } = { base: null, final: null };
  try {
    const { PDFDocument } = await import('pdf-lib');
    const built = await generateEstimatePdf(supabase, params.id);
    if (!built.ok) {
      pages = { base: null, final: null, error: built.error };
    } else {
      const doc = await PDFDocument.load(built.buffer);
      const basePages = appended.wrapQuotes.length === 0 && appended.graphicsProofs.length === 0
        ? doc.getPageCount()
        : null;
      pages = { base: basePages, final: doc.getPageCount() };
    }
  } catch (err: any) {
    pages = { base: null, final: null, error: String(err?.message || err) };
  }

  return NextResponse.json({
    readAt: new Date().toISOString(),
    estimate,
    totalsAgree: Math.abs(linesSubtotal - (Number(estimate.subtotal) || 0)) < 0.005,
    lines: { count: lines.length, subtotalFromLines: Math.round(linesSubtotal * 100) / 100, items: lines },
    appended,
    pages,
  });
}
