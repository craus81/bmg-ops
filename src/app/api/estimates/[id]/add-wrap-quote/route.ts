import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { addWrapQuoteToEstimate } from '@/lib/wrap-quote-estimate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  wrapQuoteId: z.string().uuid(),
  /** Estimator checkboxes: what this quote contributes to the estimate's
   *  customer PDF (wrap_quotes.estimate_attach — see migration 223).
   *  Omitted = keep whatever was stored (legacy adds stay lines-only). */
  attach: z.object({
    diagram: z.boolean().optional(),
    attachments: z.boolean().optional(),
    films: z.boolean().optional(),
  }).optional(),
});

/**
 * POST /api/estimates/[id]/add-wrap-quote — fold a saved wrap quote into
 * an upfit estimate as line items (the "Add Graphics" round trip).
 *
 * Lines mirror the wrap quote's own NetSuite mapping exactly — materials
 * on WRAP_VINYL_ITEM (kit-split like the NS push), labor on
 * WRAP_LABOR_ITEM — resolved to real NS item ids up front, so the
 * estimate stays pushable with no manual matching. Replace semantics:
 * existing lines from this quote are deleted first, so edit-quote →
 * re-add updates in place instead of duplicating. Estimate totals are
 * recomputed server-side (the builder reloads the record on return).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { wrapQuoteId, attach } = parsed.data;

  try {
    const { status, body } = await addWrapQuoteToEstimate(supabase, params.id, wrapQuoteId, attach);
    return NextResponse.json(body, { status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
