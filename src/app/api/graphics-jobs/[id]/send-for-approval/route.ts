import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { sendProofApproval } from '@/lib/proof-approval-send';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
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
    actorEmail: auth.user.email || null,
    email: body.email || null,
    phone: body.phone || null,
    proofFileId: body.proofFileId ?? null,
    expiryDays: body.expiryDays,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status || 500 });

  // Internal FYI + timeline entry. Lives here rather than in the shared
  // sendProofApproval lib on purpose — the daily reminder cron uses the same
  // lib and must not fire a "sent" notification on every auto-nudge.
  // proof_approved / revision-requested / stale already notify; "sent" was
  // the one lifecycle event nobody but the clicker ever saw.
  try {
    const { data: job } = await supabase
      .from('graphics_jobs')
      .select('id, job_number, title, customer, status, created_by, assigned_to')
      .eq('id', params.id)
      .maybeSingle();
    if (job) {
      const label = job.title || `Job #${job.job_number}`;
      const sentTo = [
        result.dispatch?.email?.ok ? result.dispatch.email.target : null,
        result.dispatch?.sms?.ok ? result.dispatch.sms.target : null,
      ].filter(Boolean).join(', ');

      // Same-status note row so the job timeline shows the send.
      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: job.status,
        to_status: job.status,
        note: `Proof sent to customer for approval${sentTo ? ` (${sentTo})` : ''}`,
        changed_by: auth.user.id,
      });

      // Creator + assignee, minus whoever clicked Send. type 'proof_sent'
      // deliberately avoids the preference-gated substrings in notify.ts
      // (new/flagged/status/ready/shipped) so it default-allows in-app+push.
      const targetIds = [job.created_by, job.assigned_to]
        .filter((uid: string | null): uid is string => !!uid && uid !== auth.user.id);
      if (targetIds.length > 0) {
        await notifyMany([...new Set(targetIds)], {
          type: 'proof_sent',
          title: `Proof sent: ${label}`,
          body: `Proof for ${job.customer || 'customer'} is out for approval${sentTo ? ` (${sentTo})` : ''}.`,
          url: deepLinks.graphicsJob(job.id),
        });
      }
    }
  } catch (err) {
    // The customer send already succeeded — never fail the request over
    // the internal FYI.
    console.error('proof_sent notification failed:', err);
  }

  return NextResponse.json({
    status: 'sent',
    token: result.token,
    expiresAt: result.expiresAt,
    approvalUrl: result.approvalUrl,
    dispatch: result.dispatch,
  });
}
