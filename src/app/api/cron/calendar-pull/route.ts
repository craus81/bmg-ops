import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { listCalendarChanges } from '@/lib/google';
import { pushGraphicsJobToCalendar } from '@/lib/graphics-calendar';
import { syncShopInboundForGraphicsJob } from '@/lib/shop-inbound';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const SYNC_TYPE = 'google_calendar_pull';

function service() {
  return createServiceClient();
}

/** All-day events carry start.date; timed events carry start.dateTime. */
function eventDate(ev: any): string | null {
  if (ev.start?.date) return ev.start.date;
  if (ev.start?.dateTime) return ev.start.dateTime.slice(0, 10);
  return null;
}

/**
 * GET/POST /api/cron/calendar-pull
 *
 * The read half of the two-way Google Calendar sync. Incrementally pulls
 * changes from the shared Graphics Install Calendar and reconciles them:
 *
 * - Event moved on Google → the linked graphics job's install date (or a
 *   fleet check-in's upfit date) follows, and the shop arrival board is
 *   re-derived.
 * - Event deleted on Google → the linked job is unscheduled (audited in
 *   its status history).
 * - Event created directly on Google → imported as a calendar_events row
 *   (source 'google') so it shows on the FleetSuite schedule.
 *
 * Pushes stay where they always were (sync-graphics / sync-upfit /
 * sync-event on save), so the pull only ever writes when values differ —
 * no ping-pong loops.
 */
export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const supabase = service();
  // ?full=1 ignores the stored cursor and re-sweeps the whole window —
  // the recovery lever after a misconfigured run consumed the syncToken.
  const forceFull = req.nextUrl.searchParams.get('full') === '1';

  try {
    const { data: state } = await supabase
      .from('sync_state')
      .select('last_result')
      .eq('sync_type', SYNC_TYPE)
      .maybeSingle();
    const storedToken: string | null = forceFull ? null : (state?.last_result?.syncToken || null);

    let pull = await listCalendarChanges(storedToken);
    if (pull.fullResyncNeeded) pull = await listCalendarChanges(null);

    const stats = { processed: pull.events.length, jobsUpdated: 0, checkinsUpdated: 0, imported: 0, importsUpdated: 0, removed: 0 };
    // DB write failures must surface — a silent failure here would advance
    // the sync cursor past events that never landed.
    const writeErrors: string[] = [];
    // Per-event outcomes so a manual run can explain "why only N imported":
    // events already linked to a FleetSuite job aren't imports, they're the
    // push side working.
    const sample: { title: string; date: string | null; outcome: string }[] = [];
    const note = (ev: any, date: string | null, outcome: string) => {
      if (sample.length < 50) sample.push({ title: ev.summary || '(untitled)', date, outcome });
    };

    if (pull.events.length > 0) {
      const ids = pull.events.map(ev => ev.id).filter(Boolean);

      // Everything a pulled event could correspond to, in one round trip each.
      const [{ data: jobs }, { data: checkins }, { data: manualRows }] = await Promise.all([
        supabase.from('graphics_jobs')
          .select('id, calendar_event_id, scheduled_install_date, status')
          .in('calendar_event_id', ids),
        supabase.from('fleet_checkins')
          .select('id, calendar_event_id, scheduled_upfit_date')
          .in('calendar_event_id', ids),
        supabase.from('calendar_events')
          .select('id, google_event_id, title, description, event_date')
          .in('google_event_id', ids),
      ]);
      const jobByEvent = new Map((jobs || []).map(j => [j.calendar_event_id, j]));
      const checkinByEvent = new Map((checkins || []).map(c => [c.calendar_event_id, c]));
      const manualByEvent = new Map((manualRows || []).map(m => [m.google_event_id, m]));

      for (const ev of pull.events) {
        if (!ev.id) continue;
        const job = jobByEvent.get(ev.id);
        const checkin = checkinByEvent.get(ev.id);
        const manual = manualByEvent.get(ev.id);
        const date = eventDate(ev);

        if (ev.status === 'cancelled') {
          if (job) {
            await supabase.from('graphics_jobs')
              .update({ scheduled_install_date: null, calendar_event_id: null, updated_at: new Date().toISOString() })
              .eq('id', job.id);
            await supabase.from('graphics_status_history').insert({
              job_id: job.id, from_status: job.status, to_status: job.status,
              changed_by: null, note: 'Install date removed — event deleted on Google Calendar',
            });
            await syncShopInboundForGraphicsJob(supabase, job.id);
            stats.jobsUpdated++;
          }
          if (checkin) {
            await supabase.from('fleet_checkins')
              .update({ scheduled_upfit_date: null, calendar_event_id: null })
              .eq('id', checkin.id);
            stats.checkinsUpdated++;
          }
          if (manual) {
            const { error } = await supabase.from('calendar_events').delete().eq('id', manual.id);
            if (error) writeErrors.push(`delete ${ev.id}: ${error.message}`);
            else stats.removed++;
          }
          note(ev, date, 'deleted on Google');
          continue;
        }

        if (!date) { note(ev, null, 'skipped — no start date'); continue; }

        if (job) {
          note(ev, date, 'already linked to a FleetSuite graphics job');
          if (job.scheduled_install_date?.slice(0, 10) !== date) {
            await supabase.from('graphics_jobs')
              .update({ scheduled_install_date: date, updated_at: new Date().toISOString() })
              .eq('id', job.id);
            await supabase.from('graphics_status_history').insert({
              job_id: job.id, from_status: job.status, to_status: job.status,
              changed_by: null, note: `Install date moved to ${date} on Google Calendar`,
            });
            await syncShopInboundForGraphicsJob(supabase, job.id);
            stats.jobsUpdated++;
          }
        } else if (checkin) {
          note(ev, date, 'already linked to a fleet check-in');
          if (checkin.scheduled_upfit_date?.slice(0, 10) !== date) {
            await supabase.from('fleet_checkins')
              .update({ scheduled_upfit_date: date })
              .eq('id', checkin.id);
            stats.checkinsUpdated++;
          }
        } else if (manual) {
          note(ev, date, 'already imported earlier');
          const title = ev.summary || 'Untitled event';
          if (manual.event_date?.slice(0, 10) !== date || manual.title !== title || (manual.description || '') !== (ev.description || '')) {
            const { error } = await supabase.from('calendar_events')
              .update({ title, description: ev.description || null, event_date: date })
              .eq('id', manual.id);
            if (error) writeErrors.push(`update ${ev.id}: ${error.message}`);
            else stats.importsUpdated++;
          }
        } else {
          // Created directly on Google — surface it on the FleetSuite schedule.
          const { error } = await supabase.from('calendar_events').upsert({
            title: ev.summary || 'Untitled event',
            description: ev.description || null,
            event_date: date,
            event_time: ev.start?.dateTime ? ev.start.dateTime.slice(11, 19) : null,
            event_type: 'other',
            user_id: null,
            source: 'google',
            google_event_id: ev.id,
          }, { onConflict: 'google_event_id' });
          if (error) writeErrors.push(`import ${ev.id}: ${error.message}`);
          else { stats.imported++; note(ev, date, 'imported to FleetSuite schedule'); }
        }
      }
    }

    // ── Push reconciliation ──
    // A job whose original push failed (Calendar API down, env missing at
    // the time) has an install date but no calendar_event_id, and nothing
    // retries until someone re-saves it. Sweep those here every cycle so
    // both directions self-heal. Recent-or-future dates only — no point
    // spraying long-finished installs onto the calendar.
    let pushed = 0;
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const { data: unsynced } = await supabase
      .from('graphics_jobs')
      .select('id')
      .not('scheduled_install_date', 'is', null)
      .is('calendar_event_id', null)
      .neq('status', 'cancelled')
      .gte('scheduled_install_date', weekAgo)
      .limit(25);
    for (const j of unsynced || []) {
      const r = await pushGraphicsJobToCalendar(supabase, j.id);
      if (r.synced) pushed++;
    }
    (stats as any).pushed = pushed;

    // Keep the OLD cursor when any write failed, so the next run (after the
    // schema/config problem is fixed) re-pulls the same events instead of
    // skipping past them forever.
    const syncStateWrite = await recordHeartbeat(supabase, SYNC_TYPE, {
      syncToken: writeErrors.length > 0 ? storedToken : pull.nextSyncToken,
      ...stats,
      writeErrors: writeErrors.slice(0, 10),
    });
    (stats as any).syncStateWrite = syncStateWrite;

    // Surface what actually happened — an "empty success" almost always
    // means the env points at the wrong calendar or the migration is
    // missing, so say which calendar was polled.
    const diagnostics = {
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary (GOOGLE_CALENDAR_ID not set!)',
      incremental: !!storedToken,
    };
    if (writeErrors.length > 0) {
      return NextResponse.json(
        { success: false, ...stats, ...diagnostics, writeErrors: writeErrors.slice(0, 10), hint: 'DB writes failed — has migration 170 been applied (npm run migrate)? Cursor not advanced; rerun after fixing.' },
        { status: 500 },
      );
    }
    // Manual (admin-session) runs get the per-event breakdown; scheduled
    // cron runs keep the response lean.
    return NextResponse.json({ success: true, ...stats, ...diagnostics, ...(isCron ? {} : { events: sample }) });
  } catch (err: any) {
    if (err?.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ success: false, error: 'Google account not connected — visit the Google auth flow first.' }, { status: 200 });
    }
    console.error('calendar-pull error:', err);
    // Keep last_synced_at (the pull cursor) untouched on a failed run.
    await recordHeartbeat(supabase, SYNC_TYPE, { error: err.message || 'unknown' }, { touchLastSyncedAt: false });
    return NextResponse.json({ success: false, error: err.message || 'Calendar pull failed' }, { status: 500 });
  }
}
