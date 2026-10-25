import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireRole, getProfileRoles, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { weekOf, loadSalesReps, BATCH_SIZE } from '@/lib/outreach-batch';
import { hasGoogleKey } from '@/lib/outreach-sources';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const isAdminProfile = (profile: any) => isAdminRole(getProfileRoles(profile));

/**
 * The Outreach list (migration 438). A rep sees their own companies; an
 * admin can look at any rep's (?rep=<id>). ?week=YYYY-MM-DD picks the week,
 * this week by default. "Saved for later" rows from earlier weeks are shown
 * too, so nothing parked gets lost.
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

  const cols = 'id, source, source_id, kind, company_name, trade, street, city, state, zip, miles, phone, email, website, fleet_size, facts, rep_id, week_of, status, status_changed_at, prospect_id';
  const [thisWeek, later] = await Promise.all([
    service.from('outreach_targets').select(cols).eq('rep_id', repId).eq('week_of', week)
      .order('kind').order('miles').order('id'),
    service.from('outreach_targets').select(cols).eq('rep_id', repId).eq('status', 'later').neq('week_of', week)
      .order('week_of', { ascending: false }).order('id').limit(200),
  ]);
  if (thisWeek.error) return NextResponse.json({ error: `Could not load the list: ${thisWeek.error.message}` }, { status: 500 });

  return NextResponse.json({
    weekOf: week,
    repId,
    batchSize: BATCH_SIZE,
    isAdmin: admin,
    reps,
    googleReady: hasGoogleKey(),
    targets: thisWeek.data || [],
    savedForLater: later.data || [],
  });
}

const Patch = z.object({
  id: z.string().uuid(),
  status: z.enum(['new', 'later', 'not_fit']),
});

/** Save for later / Not a fit / put back. Reps change only their own rows. */
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Patch);
  if (parsed.error) return parsed.error;
  const { id, status } = parsed.data;

  const { data: row } = await service.from('outreach_targets').select('id, rep_id, status').eq('id', id).maybeSingle();
  if (!row) return NextResponse.json({ error: 'That company is no longer on the list.' }, { status: 404 });
  if (row.rep_id !== auth.user.id && !isAdminProfile(auth.profile)) {
    return NextResponse.json({ error: 'That company is on another rep\'s list.' }, { status: 403 });
  }
  if (!['new', 'later', 'not_fit'].includes(row.status)) {
    return NextResponse.json({ error: 'This one has already been emailed, so it can\'t be changed here.' }, { status: 409 });
  }
  const { error } = await service.from('outreach_targets')
    .update({ status, status_changed_at: new Date().toISOString() }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, id, status });
}
