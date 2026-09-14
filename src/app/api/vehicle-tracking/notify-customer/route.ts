import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { buildNotificationEmail } from '@/lib/resend';
import { getEmailSignature } from '@/lib/email-signature';
import { deepLinks } from '@/lib/deep-links';
import { notifyCustomerByName, resolveCustomerContact } from '@/lib/customer-notify';
import { mayReceive } from '@/lib/notification-prefs';
import { decideReviewAsk, reviewBlockHtml, stampReviewAsk } from '@/lib/review-request';
import { buildVehicleCustomerEmail, type VehicleEmailKind } from '@/lib/vehicle-customer-email';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  vehicleId: z.string().uuid(),
  kind: z.enum(['ready', 'shipped', 'pickup_reminder']),
  emails: z.array(z.string().email()).max(20).optional(),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  bccSelf: z.boolean().optional(),
  message: z.string().max(4000).optional(),
  preview: z.boolean().optional(),
});

/**
 * POST /api/vehicle-tracking/notify-customer — the staff-sent version of
 * the three vehicle emails ("ready", "shipped", pickup reminder), through
 * the standard compose contract (docs/customer-email-standard.md):
 * emails[] / cc / bccSelf / message / preview, Reply-To the sender.
 *
 * All three used to send themselves — two off the status change, one off
 * the pickup-nudges cron. Owner decision 2026-09-14: a customer email is a
 * person's decision. The crons and the status route now notify staff and
 * this route is what that notification asks them to press. Content comes
 * from the pure builder so the preview and the send cannot drift.
 *
 * A pickup reminder stamps the vehicle's nudge columns, which is what the
 * cron reads to decide when to prompt again — sending one by hand buys the
 * customer the same week of quiet an automatic one used to.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { vehicleId, kind, cc, bccSelf, message, preview } = parsed.data;

  const { data: vehicle } = await service
    .from('fleet_checkins')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, customer_portal_token, status, updated_at')
    .eq('id', vehicleId)
    .maybeSingle();
  if (!vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });
  if (!vehicle.customer_name) {
    return NextResponse.json({ error: 'This vehicle has no customer on it — nothing to email.' }, { status: 400 });
  }

  // Days ready, for the reminder's "ready for N days" line. The LATEST
  // transition into 'complete' (m229: a returning vehicle's earlier visit
  // must not age this one), falling back to updated_at.
  let daysReady: number | null = null;
  if (kind === 'pickup_reminder') {
    const { data: hist } = await service
      .from('vehicle_status_history')
      .select('created_at')
      .eq('vehicle_id', vehicleId)
      .eq('to_status', 'complete')
      .order('created_at', { ascending: false })
      .limit(1);
    const since = hist?.[0]?.created_at || vehicle.updated_at;
    if (since) daysReady = Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const content = buildVehicleCustomerEmail(
    { ...vehicle, daysReady },
    kind as VehicleEmailKind,
    appUrl,
  );

  // Default recipients: the same primary-contact resolution every other
  // customer touchpoint uses, so the compose screen opens on the address
  // the automatic send would have used.
  const resolved = await resolveCustomerContact(service, vehicle.customer_name);
  const composeEmails = (parsed.data.emails || []).map(e => e.trim()).filter(Boolean);
  const emailList = composeEmails.length > 0
    ? composeEmails
    : [resolved.email].filter(Boolean) as string[];

  // "How did we do?" rides along on the two completion emails exactly as it
  // did when they sent themselves (R6-13) — the decision is read-only here
  // and the suppression stamp is written only after a successful send.
  const review = (kind === 'ready' || kind === 'shipped') && resolved.customer?.id
    ? await decideReviewAsk(service, resolved.customer.id)
    : null;
  const reviewHtml = review?.ask && review.url ? reviewBlockHtml(review.url) : '';

  const signature = await getEmailSignature(service, auth.user?.id);
  const html = buildNotificationEmail(
    content.title,
    content.body,
    content.ctaUrl,
    content.ctaLabel,
    { note: message?.trim() || undefined, signature },
  ) + reviewHtml;

  if (preview) {
    // Surfaced, not enforced. The subscription governed the automatic sends
    // that used to fire here; now a person decides, and what they need is
    // to SEE that this customer asked not to get these — not to be blocked
    // when they have a reason to send one anyway.
    const optedOut = !!resolved.customer && !mayReceive('status_emails', resolved.customer, resolved.contactPrefs);
    return NextResponse.json({ preview: true, to: emailList.join(', ') || null, subject: content.subject, html, optedOut });
  }

  if (emailList.length === 0) {
    return NextResponse.json({ error: 'No email on file for this customer. Add a recipient first.' }, { status: 400 });
  }

  const senderEmail = auth.user?.email || undefined;
  const result = await notifyCustomerByName(service, vehicle.customer_name, {
    contextEntityType: 'fleet_checkin',
    contextEntityId: vehicle.id,
    threadSubject: content.threadSubject,
    emailSubject: content.subject,
    emailHtml: html,
    messageBody: content.body,
    smsBody: content.smsBody || undefined,
    // The sender chose these recipients and pressed send — a subscription
    // switch is about what we mail people unasked, and this was asked.
    respectOptOut: false,
    overrideEmails: emailList,
    cc: cc || null,
    bcc: bccSelf && senderEmail ? [senderEmail] : null,
    replyTo: senderEmail || null,
    emailKind: `vehicle_${kind}`,
    sentBy: auth.user?.id || null,
    contextUrl: deepLinks.vehicle(vehicle.id),
  });

  if (!result.emailed && !result.smsSent) {
    return NextResponse.json({ error: 'The email could not be sent. Check the address and try again.' }, { status: 502 });
  }

  if (review?.ask && result.emailed && resolved.customer?.id) {
    await stampReviewAsk(service, resolved.customer.id);
  }

  // Reset the cron's prompt clock: staff just did the chasing it would
  // otherwise ask for.
  if (kind === 'pickup_reminder') {
    const { data: current } = await service
      .from('fleet_checkins').select('pickup_nudge_count').eq('id', vehicle.id).maybeSingle();
    await service.from('fleet_checkins').update({
      pickup_nudge_sent_at: new Date().toISOString(),
      pickup_nudge_count: (current?.pickup_nudge_count || 0) + 1,
    }).eq('id', vehicle.id);
  }

  return NextResponse.json({
    ok: true,
    dispatch: { emailed: result.emailed, smsSent: result.smsSent, to: emailList },
  });
}
