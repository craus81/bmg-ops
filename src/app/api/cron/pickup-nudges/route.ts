import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { loadReadyForPickup, decideNudges } from '@/lib/ready-pickup';
import { loadBookingSettings } from '@/lib/booking';
import { notify, notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Daily ready-for-pickup sweep (R5-17 part 2). Vehicles complete N+ days
 * with no booked pickup need chasing: the customer has to book a slot or
 * the van just sits in the lot.
 *
 * THIS CRON DOES NOT EMAIL CUSTOMERS. It used to send the reminder itself,
 * weekly, with the booking link. Owner decision 2026-09-14: every
 * customer-facing send is a person's decision, so the same weekly policy
 * now decides when to PROMPT the rep (or the admins) — they send it from
 * the vehicle's Email Customer button, and that send stamps the same nudge
 * columns, so pressing it buys the customer the same week of quiet the
 * automatic one did. At 2N days the second, louder alert still fires.
 * Quiet when nothing qualifies.
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
    const [vehicles, settings] = await Promise.all([
      loadReadyForPickup(service),
      loadBookingSettings(service),
    ]);
    const plan = decideNudges(vehicles, settings.nudgeDays, Date.now());

    // Vehicles with no sales rep fall back to the admins so nothing goes
    // unwatched. Loaded once and shared by both passes.
    let adminIdsCache: string[] | null = null;
    const adminIds = async (): Promise<string[]> => {
      if (adminIdsCache) return adminIdsCache;
      const { data: admins } = await service
        .from('profiles').select('id')
        .or('role.in.(admin,super_admin),roles.cs.{admin},roles.cs.{super_admin}')
        .eq('status', 'approved');
      adminIdsCache = (admins || []).map((p: any) => p.id);
      return adminIdsCache;
    };

    // Prompt, don't send — and stamp, because pickup_nudge_sent_at is the
    // repeat clock decideNudges reads. Without a stamp every unbooked
    // vehicle would prompt EVERY DAY instead of weekly, which is how a rep
    // learns to ignore the whole notification type. The stamp now means
    // "last chased, by a prompt or a send"; pickup_nudge_count still counts
    // only what the customer actually received, and only the staff send in
    // /api/vehicle-tracking/notify-customer increments it.
    let nudged = 0;
    for (const v of plan.nudges) {
      if (!v.customerName) continue;
      const waited = `ready for ${v.daysReady} day${v.daysReady !== 1 ? 's' : ''}`;
      const targets = v.salesRepId ? [v.salesRepId] : await adminIds();
      if (targets.length === 0) continue;
      await notifyMany(targets, {
        type: 'booking',
        title: `Remind ${v.customerName}: ${v.label}`,
        body: `${v.label} has been ${waited} with no pickup booked, and nothing has gone to the customer.`
          + ' Open the vehicle and use Email Customer to send them the booking link.',
        url: deepLinks.vehicle(v.id),
        channels: ['in_app', 'push', 'email'],
      });
      nudged++;
      await service.from('fleet_checkins')
        .update({ pickup_nudge_sent_at: new Date().toISOString() })
        .eq('id', v.id);
    }

    let escalated = 0;
    for (const v of plan.escalations) {
      const title = `Still in the lot: ${v.label}`;
      const body = `${v.customerName || 'The customer'} hasn't booked a pickup — complete for ${v.daysReady} days. Worth a call.`;
      const url = deepLinks.vehicle(v.id);
      if (v.salesRepId) {
        await notify({ userId: v.salesRepId, type: 'booking', title, body, url });
      } else {
        await notifyMany(await adminIds(), { type: 'booking', title, body, url });
      }
      escalated++;
      await service.from('fleet_checkins').update({ pickup_escalated_at: new Date().toISOString() }).eq('id', v.id);
    }

    const result = {
      ready: vehicles.length,
      unbooked: vehicles.filter(v => !v.hasBooking).length,
      nudged,
      escalated,
      oldestDays: vehicles[0]?.daysReady ?? 0,
    };
    await recordHeartbeat(service, 'pickup_nudges', result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('pickup-nudges cron failed:', e);
    await recordHeartbeat(service, 'pickup_nudges', { error: e?.message || 'failed' }, { touchLastSyncedAt: false }).catch(() => {});
    return NextResponse.json({ error: e?.message || 'sweep failed' }, { status: 500 });
  }
}
