import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { ensureScheduleToken, scheduleFeedUrl, webcalFeedUrl } from '@/lib/cni-schedule-feed';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/cni/schedule-link?companyId=… — the company's current link state,
 * WITHOUT minting one. Read-only on purpose: opening a company record should
 * never quietly create a standing credential for it.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;
  const q = validateSearchParams(req, z.object({ companyId: z.string().uuid() }));
  if (q.error) return q.error;

  const { data: company } = await service
    .from('companies')
    .select('id, schedule_token, schedule_token_created_at, schedule_last_fetched_at')
    .eq('id', q.data.companyId)
    .maybeSingle();
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  return NextResponse.json({
    token: company.schedule_token || null,
    url: company.schedule_token ? scheduleFeedUrl(company.schedule_token) : null,
    webcalUrl: company.schedule_token ? webcalFeedUrl(company.schedule_token) : null,
    createdAt: company.schedule_token_created_at || null,
    lastFetchedAt: company.schedule_last_fetched_at || null,
  });
}

const Schema = z.object({
  companyId: z.string().uuid(),
  /** create: issue a link if none exists (idempotent). regenerate: replace it
   *  (every existing subscription goes dead). revoke: clear it. */
  action: z.enum(['create', 'regenerate', 'revoke']),
});

/**
 * POST /api/cni/schedule-link — issue, regenerate or revoke a CNI company's
 * install-calendar subscription link (R6-8, migration 300) from the company
 * record. Every change is audited: the link is a standing credential, so who
 * handed one out and who killed it has to be answerable later.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { companyId, action } = parsed.data;

  const { data: company } = await service
    .from('companies')
    .select('id, name, schedule_token, schedule_token_created_at, schedule_last_fetched_at')
    .eq('id', companyId)
    .maybeSingle();
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  if (action === 'revoke') {
    await service
      .from('companies')
      .update({ schedule_token: null, schedule_token_created_at: null })
      .eq('id', companyId);
    await logAudit(service, {
      actorId: auth.user.id, table: 'companies', recordId: companyId,
      action: 'cni_schedule_link_revoked',
      detail: { company: company.name, previous_token_created_at: company.schedule_token_created_at || null },
    });
    return NextResponse.json({ success: true, token: null, url: null, webcalUrl: null });
  }

  const result = await ensureScheduleToken(service, company, { regenerate: action === 'regenerate' });
  if (result.changed) {
    await logAudit(service, {
      actorId: auth.user.id, table: 'companies', recordId: companyId,
      action: action === 'regenerate' ? 'cni_schedule_link_regenerated' : 'cni_schedule_link_created',
      detail: { company: company.name },
    });
  }
  return NextResponse.json({
    success: true,
    token: result.token,
    url: scheduleFeedUrl(result.token),
    webcalUrl: webcalFeedUrl(result.token),
    createdAt: result.createdAt,
    // Null here is the honest answer to "is anyone actually subscribed?" —
    // a link that exists but was never fetched is a link nobody is using.
    lastFetchedAt: company.schedule_last_fetched_at || null,
  });
}
