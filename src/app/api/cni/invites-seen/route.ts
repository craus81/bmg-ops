import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getCniCompanyId } from '@/lib/cni-access';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  inviteIds: z.array(z.string().uuid()).min(1).max(200),
});

/**
 * POST /api/cni/invites-seen — stamp seen_at on the caller's job invites.
 *
 * Migration 253 makes cni_job_invites read-only from the browser (writes go
 * through the invite routes), which took the Available page's direct
 * "mark seen" update with it. This is that one write, scoped server-side:
 * only invites addressed to the caller (their installer id, or their
 * company) are stamped, and only when still unseen — an installer can't
 * touch another crew's invites or rewrite anything else on the row.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { inviteIds } = parsed.data;

  const companyId = await getCniCompanyId(supabase, auth.user.id);
  const scope = companyId
    ? `installer_id.eq.${auth.user.id},company_id.eq.${companyId}`
    : `installer_id.eq.${auth.user.id}`;

  const { data, error } = await supabase
    .from('cni_job_invites')
    .update({ seen_at: new Date().toISOString() })
    .in('id', inviteIds)
    .is('seen_at', null)
    .or(scope)
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, marked: (data || []).length });
}
