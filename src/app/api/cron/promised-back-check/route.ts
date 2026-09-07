import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks, vehicleLinkFor } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { loadOpenCommitments, type OpenCommitment } from '@/lib/on-time';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const APPROACHING_DAYS = 2;

type Bucket = 'approaching' | 'due_today' | 'overdue';

const bucketOf = (daysUntil: number): Bucket | null =>
  daysUntil < 0 ? 'overdue'
  : daysUntil === 0 ? 'due_today'
  : daysUntil <= APPROACHING_DAYS ? 'approaching'
  : null;

const fmtDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const STAGE_LABELS: Record<string, string> = {
  received: 'received', checked_in: 'received', in_progress: 'in progress',
  stuck_parts: 'waiting on parts', stuck_graphics: 'waiting on graphics',
};

/**
 * Daily promised-back guardian (R4-6): every check-in captures
 * promised_back_date, but the only defenses were board chips that help
 * only if someone looks. This watches the promise itself — a heads-up to
 * the assignee and admins 2 days out, louder on the day, and a daily
 * escalation once overdue (each run re-alerts overdue vehicles; the
 * approaching/day-of nudges fire once per bucket via sync_state dedupe).
 * Mondays also send admins a "promised back this week" digest.
 *
 * The on-time scorecard (/admin/reports/on-time) measures what this cron
 * defends; both read the same lib so they can't disagree.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const commitments = await loadOpenCommitments(service);
    const watched = commitments.filter(c => bucketOf(c.daysUntil) !== null);

    // Bucket-level dedupe in this cron's sync_state row: approaching and
    // due-today alert once each; overdue escalates on every (daily) run.
    const { data: state } = await service
      .from('sync_state').select('last_result').eq('sync_type', 'promised_back_check').maybeSingle();
    const lastAlerts: Record<string, string> = ((state?.last_result as any)?.alerts as Record<string, string>) || {};

    const { data: admins } = await service
      .from('profiles').select('id')
      .or('role.eq.admin,roles.cs.{admin}')
      .eq('status', 'approved');
    const adminIds = (admins || []).map(a => a.id);

    // Assignees can be external installers whose /tracking link bounces off
    // the in_shop gate — load roles once, build each recipient a URL they
    // can open (the stuck-vehicle pattern).
    const assigneeIds = [...new Set(watched.map(v => v.assignedTo).filter(Boolean))] as string[];
    const { data: assigneeProfiles } = assigneeIds.length
      ? await service.from('profiles').select('id, role, roles').in('id', assigneeIds)
      : { data: [] as any[] };
    const assigneeRoles = new Map<string, string[]>(
      (assigneeProfiles || []).map((p: any) => [p.id, p.roles?.length ? p.roles : (p.role ? [p.role] : [])]),
    );

    let alerted = 0;
    const counts = { approaching: 0, due_today: 0, overdue: 0 };
    for (const v of watched) {
      const bucket = bucketOf(v.daysUntil)!;
      counts[bucket]++;
      if (bucket !== 'overdue' && lastAlerts[v.id] === bucket) continue;

      const stage = STAGE_LABELS[v.status] || v.status;
      const who = v.customerName ? `${v.customerName}'s ` : '';
      const daysLate = -v.daysUntil;
      const title =
        bucket === 'overdue' ? `🔴 ${v.label} is ${daysLate}d past its promised-back date`
        : bucket === 'due_today' ? `⏰ ${v.label} is promised back TODAY`
        : `⏰ ${v.label} promised back ${fmtDay(v.promised)} (${v.daysUntil}d)`;
      const body =
        bucket === 'overdue'
          ? `${who}${v.label} (VIN …${String(v.vin || '').slice(-8)}) was promised back ${fmtDay(v.promised)} — ${daysLate} day${daysLate !== 1 ? 's' : ''} ago — and is still ${stage}. Call the customer before they call you.`
          : `${who}${v.label} (VIN …${String(v.vin || '').slice(-8)}) is still ${stage} with its promised-back date ${bucket === 'due_today' ? 'today' : `${v.daysUntil} day${v.daysUntil !== 1 ? 's' : ''} out`}.`;
      const payload = { type: 'promised_back', title, body, channels: ['in_app', 'push'] as ('in_app' | 'push')[] };

      const targetUrls = new Map<string, string>();
      for (const id of adminIds) targetUrls.set(id, deepLinks.vehicle(v.id));
      if (v.assignedTo) {
        targetUrls.set(v.assignedTo, vehicleLinkFor(assigneeRoles.get(v.assignedTo), v.id, v.vin));
      }
      const byUrl = new Map<string, string[]>();
      for (const [id, url] of targetUrls) byUrl.set(url, [...(byUrl.get(url) || []), id]);
      for (const [url, ids] of byUrl) {
        await notifyMany(ids, { ...payload, url });
      }
      lastAlerts[v.id] = bucket;
      alerted++;
    }

    // Forget vehicles that left the watch set (completed, shipped, archived,
    // or the date moved out) so a future slip re-alerts from scratch.
    const activeIds = new Set(watched.map(v => v.id));
    for (const id of Object.keys(lastAlerts)) {
      if (!activeIds.has(id)) delete lastAlerts[id];
    }

    // Monday digest: everything promised back in the next 7 days, one note
    // to admins. Digest of many → the board (deep-links digest carve-out).
    let weeklyDigest = 0;
    const chicagoWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(new Date());
    if (chicagoWeekday === 'Mon' && adminIds.length > 0) {
      const thisWeek = commitments.filter(c => c.daysUntil >= 0 && c.daysUntil <= 6);
      if (thisWeek.length > 0) {
        const lines = thisWeek.map((c: OpenCommitment) =>
          `${c.label}${c.customerName ? ` (${c.customerName})` : ''} — ${fmtDay(c.promised)}, ${STAGE_LABELS[c.status] || c.status}`);
        await notifyMany(adminIds, {
          type: 'promised_back_digest',
          title: `📅 ${thisWeek.length} vehicle${thisWeek.length !== 1 ? 's' : ''} promised back this week`,
          body: lines.join(' · ').slice(0, 900),
          url: '/tracking',
          channels: ['in_app', 'push'],
        });
        weeklyDigest = thisWeek.length;
      }
    }

    const syncStateWrite = await recordHeartbeat(service, 'promised_back_check', {
      status: 'ok',
      commitments: commitments.length,
      alerted,
      ...counts,
      weekly_digest: weeklyDigest,
      alerts: lastAlerts,
    });

    return NextResponse.json({ status: 'ok', commitments: commitments.length, alerted, ...counts, weeklyDigest, syncStateWrite });
  } catch (e: any) {
    console.error('promised-back-check failed:', e);
    await recordHeartbeat(service, 'promised_back_check', { error: e.message || 'promised-back check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'promised-back check failed' }, { status: 500 });
  }
}
