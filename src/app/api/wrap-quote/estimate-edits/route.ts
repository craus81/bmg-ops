import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, outsideStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { wrapQuoteEstimateEdits } from '@/lib/wrap-quote-estimate';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const Schema = z.object({
  quoteId: z.string().uuid(),
  estimateId: z.string().uuid(),
});

/**
 * POST /api/wrap-quote/estimate-edits — asked by the Graphics Builder just
 * before it saves: were this worksheet's lines changed on the estimate since
 * the last save wrote them? Answers { edits: [{ summary }] }; empty = the
 * save can rewrite them without losing anything.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'graphics_builder');
  if (auth.error) return auth.error;
  const outside = outsideStaff(auth);
  if (outside) return outside;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  try {
    const edits = await wrapQuoteEstimateEdits(supabase, parsed.data.quoteId, parsed.data.estimateId);
    return NextResponse.json({ edits });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
