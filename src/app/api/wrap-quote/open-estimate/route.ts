import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { openEstimateForWrapQuote } from '@/lib/wrap-quote-estimate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  quoteId: z.string().uuid(),
  /** The estimate the rep arrived from (?forEstimate) — a quote on no
   *  estimate yet joins it rather than getting a new draft. */
  estimateId: z.string().uuid().optional().nullable(),
  attach: z.object({
    diagram: z.boolean().optional(),
    attachments: z.boolean().optional(),
    films: z.boolean().optional(),
  }).optional(),
});

/**
 * POST /api/wrap-quote/open-estimate — "Save & open estimate" from the
 * Graphics Builder. Refreshes the quote's lines on the estimate it belongs
 * to, or creates a draft estimate for it (customer + vehicle copied over)
 * and lands the lines there. Answers with the estimate to open.
 *
 * Same audience as the builder's own save: any staff member who can price
 * graphics can start the estimate; sending it is still the estimate's job.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  try {
    const { status, body } = await openEstimateForWrapQuote(supabase, parsed.data.quoteId, auth.user?.id || null, parsed.data.attach, parsed.data.estimateId || null);
    return NextResponse.json(body, { status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
