import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { loadReadyForPickup, decideNudges } from '@/lib/ready-pickup';
import { loadBookingSettings } from '@/lib/booking';
import { notifyCustomerByName } from '@/lib/customer-notify';
import { buildNotificationEmail } from '@/lib/resend';
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
 * with no booked pickup get an automated customer reminder carrying the
 * booking link — weekly repeats, and these ARE automated sends, so the
 * customer's notify_status_emails opt-in gates them (unlike the booking
 * confirmation, which answers the customer's own action). At 2N days the
 * sales rep (source estimate's creator, else the admins) hears about it
 * once. Quiet when nothing qualifies.
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
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';

    let nudged = 0;
    let optedOut = 0;
    for (const v of plan.nudges) {
      if (!v.customerName || !v.portalToken) continue;
      const bookUrl = `${appUrl}/book/${v.portalToken}`;
      const bodyText = `Your ${v.label} has been ready for pickup for ${v.daysReady} day${v.daysReady !== 1 ? 's' : ''}. Book a time that works and we'll have it waiting.`;
      const result = await notifyCustomerByName(service, v.customerName, {
        contextEntityType: 'fleet_checkin',
        contextEntityId: v.id,
        threadSubject: `${v.label} ready for pickup`,
        emailSubject: `[BMG Fleet] Reminder — your ${v.label} is ready for pickup`,
        emailHtml: buildNotificationEmail(`Your ${v.label} is ready`, bodyText, bookUrl, 'Book your pickup time'),
        messageBody: bodyText,
        smsBody: `[BMG Fleet] Reminder: your ${v.label} is ready for pickup. Book a time: ${bookUrl}`,
      }).catch(e => { console.error('pickup nudge failed:', v.id, e); return null; });
      if (result?.skipped === 'opted_out') { optedOut++; continue; }
      if (!result || (!result.emailed && !result.smsSent)) continue; // nothing reached them — don't stamp
      nudged++;
      await service.from('fleet_checkins').update({
        pickup_nudge_sent_at: new Date().toISOString(),
        pickup_nudge_count: v.nudgeCount + 1,
      }).eq('id', v.id);
    }

    let escalated = 0;
    for (const v of plan.escalations) {
      const title = `Still in the lot: ${v.label}`;
      const body = `${v.customerName || 'The customer'} hasn't booked a pickup — complete for ${v.daysReady} days. Worth a call.`;
      const url = deepLinks.vehicle(v.id);
      if (v.salesRepId) {
        await notify({ userId: v.salesRepId, type: 'booking', title, body, url });
      } else {
        const { data: admins } = await service
          .from('profiles').select('id')
          .or('role.in.(admin,super_admin),roles.cs.{admin},roles.cs.{super_admin}')
          .eq('status', 'approved');
        await notifyMany((admins || []).map((p: any) => p.id), { type: 'booking', title, body, url });
      }
      escalated++;
      await service.from('fleet_checkins').update({ pickup_escalated_at: new Date().toISOString() }).eq('id', v.id);
    }

    const result = {
      ready: vehicles.length,
      unbooked: vehicles.filter(v => !v.hasBooking).length,
      nudged,
      optedOut,
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
