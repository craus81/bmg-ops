import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { draftTarget, TARGET_COLS } from '@/lib/outreach-send';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createServiceClient();

/** Drafts per run: each is a website read plus one Claude call, ~10s. */
const PER_RUN = 15;

/**
 * Write email drafts for new Outreach companies (migration 439), a few per
 * run through the working day, so Monday's list has drafts waiting. Drafts
 * only: nothing is sent here. A company whose draft failed is left for the
 * rep's Rewrite button rather than retried every hour.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const startedAt = Date.now();
  const { data: rows, error } = await service.from('outreach_targets').select(TARGET_COLS)
    .eq('status', 'new').is('drafted_at', null).is('draft_error', null)
    .order('week_of', { ascending: false }).order('miles').order('id').limit(PER_RUN);
  if (error) {
    await recordHeartbeat(service, 'outreach_draft', { error: error.message }, { startedAt, touchLastSyncedAt: false });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let drafted = 0;
  const failed: string[] = [];
  for (const t of rows || []) {
    if (Date.now() - startedAt > 240_000) break;
    const r = await draftTarget(service, t);
    if (r.ok) drafted++;
    else failed.push(`${(t as any).company_name}: ${r.error}`);
  }
  const result = { drafted, failed: failed.slice(0, 10), waiting: (rows || []).length - drafted - failed.length };
  await recordHeartbeat(service, 'outreach_draft', result, { startedAt, records: drafted });
  return NextResponse.json({ success: true, ...result });
}
