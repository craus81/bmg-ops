import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { draftTarget, TARGET_COLS } from '@/lib/outreach-send';
import { draftFollowUp, followUpCutoff, followUpSkipReason } from '@/lib/outreach-followup';
import { notify } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createServiceClient();

/** Drafts per run: each is a website read plus one Claude call, ~10s. */
const PER_RUN = 15;

/** Due follow-ups looked at per run (most are cheap: skip checks). */
const FOLLOWUP_LOOK = 40;

/**
 * Write email drafts for new Outreach companies (migration 439), a few per
 * run through the working day, so Monday's list has drafts waiting. Then,
 * with what's left of the run, follow-up drafts for companies that haven't
 * answered in a week (migration 441), and one alert per rep saying they're
 * ready. Drafts only: nothing is sent here. A company whose draft failed is
 * left for the rep's Rewrite button rather than retried every hour.
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
  const waiting = (rows || []).length - drafted - failed.length;

  // Follow-ups: sent a week ago or more, nothing heard, not yet drafted.
  let followUps = 0;
  let skipped = 0;
  const ready = new Map<string, { id: string; company: string }[]>();
  if (drafted + failed.length < PER_RUN) {
    const { data: due, error: dueErr } = await service.from('outreach_targets').select(TARGET_COLS)
      .eq('status', 'sent').lt('sent_at', followUpCutoff())
      .is('followup_drafted_at', null).is('followup_error', null).is('followup_skipped', null)
      .order('sent_at').order('id').limit(FOLLOWUP_LOOK);
    if (dueErr) failed.push(`Follow-ups: ${dueErr.message}`);
    for (const t of due || []) {
      if (Date.now() - startedAt > 240_000 || drafted + followUps + failed.length >= PER_RUN) break;
      const row = t as any;
      let reason: string | null;
      try {
        reason = await followUpSkipReason(service, row);
      } catch (err: any) {
        failed.push(`${row.company_name}: ${err.message}`);
        continue;
      }
      if (reason) {
        await service.from('outreach_targets').update({
          followup_skipped: reason,
          ...(reason === 'unsubscribed' ? { status: 'unsubscribed', status_changed_at: new Date().toISOString() } : {}),
        }).eq('id', row.id);
        skipped++;
        continue;
      }
      const r = await draftFollowUp(service, row);
      if (!r.ok) { failed.push(`${row.company_name} (follow-up): ${r.error}`); continue; }
      followUps++;
      if (row.rep_id) ready.set(row.rep_id, [...(ready.get(row.rep_id) || []), { id: row.id, company: row.company_name }]);
    }
  }
  for (const [repId, list] of ready) {
    await notify({
      userId: repId, type: 'outreach_followup',
      title: list.length === 1 ? `Follow-up ready: ${list[0].company}` : `${list.length} Outreach follow-ups ready`,
      body: `${list.map(l => l.company).join(', ')} ${list.length === 1 ? 'hasn\'t' : 'haven\'t'} answered in a week. Read the follow-up and tap Review & send follow-up.`,
      url: list.length === 1 ? deepLinks.outreachTarget(list[0].id) : deepLinks.outreach(),
    }).catch(() => {});
  }

  const result = { drafted, followUps, skipped, failed: failed.slice(0, 10), waiting };
  await recordHeartbeat(service, 'outreach_draft', result, { startedAt, records: drafted + followUps });
  return NextResponse.json({ success: true, ...result });
}
