import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { sanitizePhotoProofs } from '@/lib/coverage-proof';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * What a linked wrap quote puts on its estimate, changeable AFTER the fact.
 *
 * `wrap_quotes.estimate_attach` (migration 223) decides whether the coverage
 * proof, the quote's files, and the vinyl details ride on the estimate's
 * customer PDF and approval email. Until now it was written in exactly ONE
 * place — /api/estimates/[id]/add-wrap-quote, from the wrap estimator's
 * Add-to-Estimate checkboxes — which made it a snapshot taken the moment the
 * graphics were added. A rep who drew the coverage proof afterwards, or who
 * left the box unticked, had no way to put the proof on the estimate short
 * of going back to the wrap-quote screen and re-adding the whole quote.
 *
 * So the flags are read and written here too, and the estimate's own edit
 * view drives them. Nothing is copied onto the estimate: the estimate keeps
 * pointing at the quote, and the surfaces read the quote's CURRENT proofs
 * through loadEstimateGraphics — so redrawing a proof updates what the
 * customer sees without re-adding anything.
 */

const PatchSchema = z.object({
  wrapQuoteId: z.string().uuid(),
  attach: z.object({
    diagram: z.boolean().optional(),
    attachments: z.boolean().optional(),
    films: z.boolean().optional(),
  }),
});

const QUOTE_COLUMNS =
  'id, quote_number, vehicle_description, diagram_path, photo_path, photo_boxes, photo_proofs, attachments, measurements, estimate_attach, total_area_sqft';

/** What the edit view needs to describe one linked quote's proof. */
function describeQuote(q: any) {
  const proofs = sanitizePhotoProofs(q.photo_proofs, { path: q.photo_path, boxes: q.photo_boxes });
  const withPictures = proofs.filter(p => p.diagram_path);
  const files = Array.isArray(q.attachments) ? q.attachments : [];
  const measurements = Array.isArray(q.measurements) ? q.measurements : [];
  return {
    id: q.id,
    quoteNumber: q.quote_number,
    vehicle: q.vehicle_description || null,
    // A coverage proof exists if any photo proof has a flattened picture, or
    // the quote has a template diagram. Both land in the same PDF pages.
    proofCount: withPictures.length || (q.diagram_path ? 1 : 0),
    proofLabels: withPictures.map((p, i) => String(p.label || '').trim() || `Photo ${i + 1}`),
    hasDiagram: withPictures.length > 0 || !!q.diagram_path,
    fileCount: files.length,
    filmCount: new Set(measurements.map((m: any) => m?.substrate_id).filter(Boolean)).size,
    totalSqft: parseFloat(q.total_area_sqft) || 0,
    // null = a legacy lines-only add (pre-migration-223 semantics), which
    // the edit view shows as everything switched off rather than hiding.
    attach: q.estimate_attach || null,
  };
}

/**
 * GET /api/estimates/[id]/graphics-attach — the wrap quotes feeding this
 * estimate, what each one HAS to offer, and what is currently switched on.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const { data, error } = await supabase
    .from('wrap_quotes')
    .select(QUOTE_COLUMNS)
    .eq('estimate_id', params.id)
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ quotes: (data || []).map(describeQuote) });
}

/**
 * PATCH /api/estimates/[id]/graphics-attach — switch a linked quote's
 * contributions on or off from the estimate's edit view.
 *
 * Carries the same locks add-wrap-quote has: what a customer already
 * approved, or what became a Sales Order, is frozen — and changing which
 * proof rides on the estimate changes exactly what they approved.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { wrapQuoteId, attach } = parsed.data;

  const { data: estimate } = await supabase
    .from('estimates')
    .select('id, customer_approved, status, netsuite_so_id')
    .eq('id', params.id)
    .maybeSingle();
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (estimate.netsuite_so_id) {
    return NextResponse.json({ error: 'This estimate was already converted to a Sales Order — its contents are locked.' }, { status: 409 });
  }
  if (estimate.customer_approved || estimate.status === 'accepted') {
    return NextResponse.json({ error: 'This estimate was accepted by the customer — what they approved is locked. Start a new estimate instead.' }, { status: 409 });
  }

  const { data: quote } = await supabase
    .from('wrap_quotes')
    .select('id, estimate_id, estimate_attach')
    .eq('id', wrapQuoteId)
    .maybeSingle();
  if (!quote || quote.estimate_id !== params.id) {
    return NextResponse.json({ error: 'That wrap quote is not linked to this estimate.' }, { status: 404 });
  }

  // Merge, don't replace: the edit view sends the one toggle that moved, and
  // a legacy null starts from everything off.
  const next = { ...(quote.estimate_attach || {}), ...attach };

  const { error } = await supabase
    .from('wrap_quotes')
    .update({ estimate_attach: next, updated_at: new Date().toISOString() })
    .eq('id', wrapQuoteId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: fresh } = await supabase
    .from('wrap_quotes')
    .select(QUOTE_COLUMNS)
    .eq('id', wrapQuoteId)
    .maybeSingle();

  return NextResponse.json({ success: true, quote: fresh ? describeQuote(fresh) : null });
}
