import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, isAdminRole, getProfileRoles } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import {
  canActAsRep, setProofRoute, sendProofToRep, sendProofBackToArtist, recordVerbalApproval,
} from '@/lib/proof-rep-review';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('route'), route: z.enum(['customer', 'rep']), repId: z.string().uuid().optional().nullable() }),
  z.object({ action: z.literal('send_to_rep'), proofFileId: z.string().uuid(), note: z.string().trim().max(2000).optional() }),
  z.object({ action: z.literal('send_back'), reason: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal('verbal_approval'), note: z.string().trim().min(1).max(2000) }),
]);

/**
 * POST /api/graphics-jobs/[id]/rep-review
 * "Rep reviews first" proofs (src/lib/proof-rep-review.ts):
 *   route            — where proofs go (customer | rep) and who the rep is
 *   send_to_rep      — the artist sends the proof to the rep
 *   send_back        — the rep returns it to the artist with what to change
 *   verbal_approval  — the rep records the customer's verbal approval
 * send_back and verbal_approval are the rep's (or an admin's) to make.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const actorId = auth.user.id as string;

  if (body.action === 'send_back' || body.action === 'verbal_approval') {
    const { data: job } = await supabase
      .from('graphics_jobs')
      .select('proof_route, proof_rep_id, created_by')
      .eq('id', params.id)
      .maybeSingle();
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    const admin = isAdminRole(getProfileRoles(auth.profile));
    if (!canActAsRep(job, actorId, admin)) {
      return NextResponse.json({ error: 'Only the job\'s rep or an admin can do that.' }, { status: 403 });
    }
  }

  const result =
    body.action === 'route' ? await setProofRoute(supabase, params.id, { route: body.route, repId: body.repId || null, actorId })
    : body.action === 'send_to_rep' ? await sendProofToRep(supabase, params.id, { actorId, proofFileId: body.proofFileId, note: body.note || null })
    : body.action === 'send_back' ? await sendProofBackToArtist(supabase, params.id, { actorId, reason: body.reason })
    : await recordVerbalApproval(supabase, params.id, { actorId, note: body.note });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status || 500 });
  return NextResponse.json({ ok: true });
}
