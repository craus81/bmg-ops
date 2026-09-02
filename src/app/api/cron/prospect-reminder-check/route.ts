import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Daily delivery of prospect follow-up reminders (audit Stage 1: reminders
 * were written by the voice-note parser and the record page's manual form,
 * displayed on the record and the Schedule calendar, but nothing ever fired
 * them — they only surfaced if someone happened to open the page).
 *
 * "Due" is calendar-day: anything with due_at before the end of today (UTC)
 * notifies on today's run, so a "call them today at 3pm" reminder lands in
 * the morning sweep rather than tomorrow's. Each reminder notifies once
 * (notified_at stamp — both the Vercel cron and the GitHub fallback may run,
 * minutes apart); after that the record page's overdue-in-red state carries
 * it. Recipient is the reminder's creator; reminders with no usable creator
 * (voice-note rows can have created_by null, or the creator has since been
 * deactivated) fall back to admins so nothing goes unwatched.
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
    // End of today, UTC — see the calendar-day note above.
    const endOfToday = new Date().toISOString().slice(0, 10) + 'T23:59:59.999Z';

    const { data: due } = await service
      .from('prospect_reminders')
      .select('id, prospect_id, title, description, due_at, created_by, prospects(company_name)')
      .is('completed_at', null)
      .is('notified_at', null)
      .lte('due_at', endOfToday)
      .order('due_at')
      .limit(200);

    let notified = 0;
    let retired = 0;
    if (due && due.length > 0) {
      // One profiles read covers creator eligibility and the admin fallback.
      // Same roles[]-with-scalar-fallback rule as profileRoles() in
      // src/lib/api-auth.ts, so the audience can't drift from authz.
      const { data: staff } = await service
        .from('profiles')
        .select('id, role, roles, status, deactivated')
        .eq('status', 'approved');
      const eligible = new Set(
        (staff || []).filter((p: any) => !p.deactivated).map((p: any) => p.id),
      );
      const adminIds = (staff || [])
        .filter((p: any) => {
          if (p.deactivated) return false;
          const roles = p.roles?.length ? p.roles : [p.role];
          return roles.some((r: string) => r === 'admin' || r === 'super_admin');
        })
        .map((p: any) => p.id);

      // First-run guard: reminders have accumulated un-fired since the
      // feature shipped, so day one would otherwise blast months-old
      // reminders as fresh pushes. Anything overdue by 30+ days is stale —
      // retire it silently; the record page already shows it in red.
      const staleCutoff = Date.now() - 30 * 86_400_000;

      for (const r of due) {
        const company = (r as any).prospects?.company_name || 'a customer';
        const isStale = new Date(r.due_at).getTime() < staleCutoff;
        const targets = r.created_by && eligible.has(r.created_by) ? [r.created_by] : adminIds;
        if (!isStale && targets.length > 0) {
          await notifyMany(targets, {
            type: 'prospect_reminder',
            title: `⏰ Reminder: ${r.title}`,
            body: r.description
              ? `${company} — ${r.description}`.slice(0, 900)
              : `You asked to be reminded today about ${company}.`,
            url: deepLinks.prospect(r.prospect_id),
            channels: ['in_app', 'push'],
          });
          notified++;
        } else {
          retired++;
        }
        // Stamp even when there was nobody to notify — an undeliverable
        // reminder must not retry forever, and the double-scheduler needs
        // the row retired either way.
        await service.from('prospect_reminders')
          .update({ notified_at: new Date().toISOString() })
          .eq('id', r.id);
      }
    }

    const syncStateWrite = await recordHeartbeat(
      service, 'prospect_reminder_check', { status: 'ok', due: due?.length || 0, notified, retired },
    );

    return NextResponse.json({ status: 'ok', due: due?.length || 0, notified, retired, syncStateWrite });
  } catch (e: any) {
    console.error('prospect-reminder-check failed:', e);
    await recordHeartbeat(service, 'prospect_reminder_check', { error: e.message || 'prospect reminder check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'prospect reminder check failed' }, { status: 500 });
  }
}
