import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { sendProofApproval } from '@/lib/proof-approval-send';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  proofFileId: z.string().uuid().optional().nullable(),
  email: z.string().email().max(254).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  expiryDays: z.number().int().positive().max(365).optional(),
});

/**
 * POST /api/graphics-jobs/[id]/send-for-approval
 * Mints a 30-day token + dispatches the proof approval link via email +
 * SMS. Body: { proofFileId, email?, phone?, expiryDays? }. The heavy
 * lifting lives in src/lib/proof-approval-send.ts, shared with the daily
 * reminder cron.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const result = await sendProofApproval(supabase, params.id, {
    actorId: auth.user.id,
    email: body.email || null,
    phone: body.phone || null,
    proofFileId: body.proofFileId ?? null,
    expiryDays: body.expiryDays,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status || 500 });

  return NextResponse.json({
    status: 'sent',
    token: result.token,
    expiresAt: result.expiresAt,
    approvalUrl: result.approvalUrl,
    dispatch: result.dispatch,
  });
}
