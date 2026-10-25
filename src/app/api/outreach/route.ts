import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireRole, getProfileRoles, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { weekOf, loadSalesReps, BATCH_SIZE } from '@/lib/outreach-batch';
import { hasGoogleKey } from '@/lib/outreach-sources';
import { TARGET_COLS, statusMoveAllowed } from '@/lib/outreach-send';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const isAdminProfile = (profile: any) => isAdminRole(getProfileRoles(profile));

/**
 * The Outreach list (migration 438). A rep sees their own companies; an
 * admin can look at any rep's (?rep=<id>). ?week=YYYY-MM-DD picks the week,
 * this week by default. "Saved for later" rows from earlier weeks are shown
 * too, so nothing parked gets lost, and so are earlier weeks' companies
 * waiting on the rep: follow-ups ready (migration 441) and call-backs.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;
  const admin = isAdminProfile(auth.profile);

  const url = new URL(req.url);
  const week = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('week') || '')
    ? url.searchParams.get('week')!
    : weekOf();
  const asked = url.searchParams.get('rep');
  const repId = admin && asked ? asked : auth.user.id;

  const reps = admin ? await loadSalesReps(service).catch(() => []) : [];

  const cols = TARGET_COLS;
  const [thisWeek, later, needsYou] = await Promise.all([
    service.from('outreach_targets').select(cols).eq('rep_id', repId).eq('week_of', week)
      .order('kind').order('miles').order('id'),
    service.from('outreach_targets').select(cols).eq('rep_id', repId).eq('status', 'later').neq('week_of', week)
      .order('week_of', { ascending: false }).order('id').limit(200),
    service.from('outreach_targets').select(cols).eq('rep_id', repId).in('status', ['follow_up', 'call_back']).neq('week_of', week)
      .order('status_changed_at', { ascending: false }).order('id').limit(200),
  ]);
  if (thisWeek.error) return NextResponse.json({ error: `Could not load the list: ${thisWeek.error.message}` }, { status: 500 });

  return NextResponse.json({
    weekOf: week,
    repId,
    batchSize: BATCH_SIZE,
    isAdmin: admin,
    reps,
    googleReady: hasGoogleKey(),
    me: auth.user.id,
    targets: thisWeek.data || [],
    savedForLater: later.data || [],
    needsYou: needsYou.data || [],
  });
}

const Patch = z.object({
  id: z.string().uuid(),
  status: z.enum(['new', 'later', 'not_fit', 'replied']),
});

/**
 * Save for later / Not a fit / put back / They replied. Reps change only
 * their own rows. Putting back a company that was already emailed returns
 * it to where its emails left it (Sent, Follow-up ready, Followed up), so
 * it can't get a second first email.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Patch);
  if (parsed.error) return parsed.error;
  const { id } = parsed.data;

  const { data: row } = await service.from('outreach_targets').select('id, rep_id, status, sent_at, followup_drafted_at, followup_sent_at').eq('id', id).maybeSingle();
  if (!row) return NextResponse.json({ error: 'That company is no longer on the list.' }, { status: 404 });
  if (row.rep_id !== auth.user.id && !isAdminProfile(auth.profile)) {
    return NextResponse.json({ error: 'That company is on another rep\'s list.' }, { status: 403 });
  }
  if (!statusMoveAllowed(row.status, parsed.data.status)) {
    return NextResponse.json({ error: `A company that's "${row.status.replace('_', ' ')}" can't be changed that way here.` }, { status: 409 });
  }
  const status = parsed.data.status !== 'new' ? parsed.data.status
    : row.followup_sent_at ? 'followed_up' : row.followup_drafted_at ? 'follow_up' : row.sent_at ? 'sent' : 'new';
  const { error } = await service.from('outreach_targets')
    .update({ status, status_changed_at: new Date().toISOString() }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, id, status });
}
