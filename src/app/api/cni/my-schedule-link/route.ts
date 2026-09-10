import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { ensureScheduleToken, scheduleFeedUrl, webcalFeedUrl } from '@/lib/cni-schedule-feed';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/cni/my-schedule-link — an installer asking for their OWN company's
 * calendar subscription link (R6-8). Self-serve on purpose: a feature whose
 * only path runs through emailing a coordinator is a feature nobody uses.
 *
 * Deliberately create-only. Regenerate and revoke kill every colleague's
 * subscription at once, which is a coordinator's call, not something one
 * installer should be able to do to the rest of their crew — those live on
 * the company record behind cni_admin.
 *
 * POST rather than GET because the first call mints a token: this writes.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['installer']);
  if (auth.error) return auth.error;

  const { data: profile } = await service
    .from('profiles')
    .select('company_id')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (!profile?.company_id) {
    return NextResponse.json({
      error: 'Your account is not attached to an installation company yet, so there is no company schedule to subscribe to. Ask your BMG coordinator to set that up.',
    }, { status: 400 });
  }

  const { data: company } = await service
    .from('companies')
    .select('id, name, schedule_token, schedule_token_created_at')
    .eq('id', profile.company_id)
    .maybeSingle();
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  const result = await ensureScheduleToken(service, company);
  return NextResponse.json({
    success: true,
    companyName: company.name,
    url: scheduleFeedUrl(result.token),
    webcalUrl: webcalFeedUrl(result.token),
  });
}
