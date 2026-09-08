import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateBody, z } from '@/lib/validate';
import { checkRateLimit, getRequestIp, validateExpiry } from '@/lib/magic-link-approval';
import {
  resolveBookingToken, loadBookingSettings, generateSlots, bookingVehicleLabel,
  type BookingTarget,
} from '@/lib/booking';
import { chicagoDay } from '@/lib/exec-metrics';
import { syncShopInboundForUpfitProject } from '@/lib/shop-inbound';
import { notifyCustomerByName } from '@/lib/customer-notify';
import { buildNotificationEmail } from '@/lib/resend';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Tokenized pickup / drop-off booking (R5-17). Public, so the guard order
 * is the portal standard: rate-limit → token resolve (404, never leak
 * which part missed) → zod validate → state re-verify → service-role
 * write. The slot race is settled by the DB's partial unique index — a
 * losing racer gets 23505 and a 409, never a double booking.
 */

const fmt12h = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const fmtDay = (day: string) =>
  new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** The state gates shared by GET and POST. Returns a terminal status
 *  string, or null when booking is open. */
function gateTarget(target: BookingTarget): string | null {
  if (target.kind === 'pickup') {
    if (target.checkin.archived_at || target.checkin.status === 'shipped') return 'closed';
    return null;
  }
  if (!target.estimate.customer_approved) return 'not_approved';
  if (['cancelled', 'rejected', 'lost'].includes(target.estimate.status)) return 'closed';
  if (!validateExpiry(target.estimate.approval_token_expires_at).ok) return 'expired';
  return null;
}

const targetLabel = (target: BookingTarget): string =>
  target.kind === 'pickup'
    ? bookingVehicleLabel(target.checkin)
    : target.estimate.title || (target.estimate.estimate_number ? `Estimate #${target.estimate.estimate_number}` : 'your order');

async function activeBooking(target: BookingTarget) {
  const q = service.from('shop_appointments')
    .select('id, slot_date, slot_time, contact_name, contact_phone, notes')
    .eq('status', 'booked');
  const { data } = await (target.kind === 'pickup'
    ? q.eq('kind', 'pickup').eq('fleet_checkin_id', target.checkin.id)
    : q.eq('kind', 'dropoff').eq('estimate_id', target.estimate.id)
  ).maybeSingle();
  return data || null;
}

async function takenSlots(fromDay: string) {
  const { data } = await service.from('shop_appointments')
    .select('slot_date, slot_time')
    .eq('status', 'booked')
    .gte('slot_date', fromDay);
  return data || [];
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'booking_get', 60)) {
    return NextResponse.json({ error: 'Too many requests — try again later.' }, { status: 429 });
  }
  const target = await resolveBookingToken(service, params.token);
  if (!target) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const gate = gateTarget(target);
  const settings = await loadBookingSettings(service);
  if (gate) return NextResponse.json({ status: gate, kind: target.kind, label: targetLabel(target) });
  if (!settings.enabled) return NextResponse.json({ status: 'disabled', kind: target.kind, label: targetLabel(target) });

  const today = chicagoDay();
  const [booking, taken] = await Promise.all([activeBooking(target), takenSlots(today)]);
  const slots = generateSlots(settings, today, taken, booking);
  return NextResponse.json({
    status: 'ready',
    kind: target.kind,
    label: targetLabel(target),
    customerName: target.kind === 'pickup' ? target.checkin.customer_name : target.estimate.customer_name,
    booking: booking ? { slotDate: booking.slot_date, slotTime: String(booking.slot_time).slice(0, 5), contactName: booking.contact_name, contactPhone: booking.contact_phone, notes: booking.notes } : null,
    slots,
    slotMinutes: settings.slotMinutes,
  });
}

const BookSchema = z.union([
  z.object({
    slotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotTime: z.string().regex(/^\d{2}:\d{2}$/),
    contactName: z.string().max(80).optional(),
    contactPhone: z.string().max(30).optional(),
    notes: z.string().max(500).optional(),
  }),
  z.object({ cancel: z.literal(true) }),
]);

/** Propagate the booked (or cleared) drop-off date to the records the
 *  arrival board actually reads — the project when one exists (its PUT-path
 *  sync owns the shop_inbound row), else the estimate's sales_order inbound
 *  row directly. Returns the project id when one was written. */
async function propagateDropoff(estimateId: string, day: string | null): Promise<string | null> {
  const { data: project } = await service
    .from('upfit_projects').select('id').eq('estimate_id', estimateId).maybeSingle();
  if (project) {
    await service.from('upfit_projects')
      .update({ customer_dropoff_date: day, updated_at: new Date().toISOString() })
      .eq('id', project.id);
    try { await syncShopInboundForUpfitProject(service, project.id); } catch { /* best-effort */ }
    return project.id;
  }
  await service.from('shop_inbound')
    .update({ expected_date: day, updated_at: new Date().toISOString() })
    .eq('source_type', 'sales_order')
    .eq('source_id', estimateId)
    .eq('status', 'expected');
  return null;
}

async function propagatePickup(checkinId: string, day: string | null, time: string | null) {
  await service.from('fleet_checkins')
    .update({ pickup_scheduled_date: day, pickup_scheduled_time: time, updated_at: new Date().toISOString() })
    .eq('id', checkinId);
}

/** Approved admins (+ the vehicle's assignee) hear about customer-made
 *  bookings; type 'booking' rides default in-app + push. */
async function notifyStaff(target: BookingTarget, projectId: string | null, title: string, body: string) {
  const { data: admins } = await service
    .from('profiles')
    .select('id')
    .or('role.in.(admin,super_admin),roles.cs.{admin},roles.cs.{super_admin}')
    .eq('status', 'approved');
  const ids = new Set((admins || []).map((p: any) => p.id));
  if (target.kind === 'pickup') {
    const { data: c } = await service.from('fleet_checkins').select('assigned_to').eq('id', target.checkin.id).maybeSingle();
    if (c?.assigned_to) ids.add(c.assigned_to);
  }
  const url = target.kind === 'pickup'
    ? deepLinks.vehicle(target.checkin.id)
    : projectId ? deepLinks.upfitProject(projectId) : deepLinks.estimate(target.estimate.id);
  await notifyMany([...ids], { type: 'booking', title, body, url });
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'booking_post', 10)) {
    return NextResponse.json({ error: 'Too many requests — try again later.' }, { status: 429 });
  }
  const target = await resolveBookingToken(service, params.token);
  if (!target) return NextResponse.json({ status: 'invalid' }, { status: 404 });
  const gate = gateTarget(target);
  if (gate) return NextResponse.json({ error: 'This link can no longer book appointments.' }, { status: 409 });

  const settings = await loadBookingSettings(service);
  if (!settings.enabled) return NextResponse.json({ error: 'Online booking is currently off — please contact us.' }, { status: 409 });

  const parsed = await validateBody(req, BookSchema);
  if (parsed.error) return parsed.error;

  const label = targetLabel(target);
  const kindNoun = target.kind === 'pickup' ? 'pickup' : 'drop-off';
  const existing = await activeBooking(target);

  // ── Cancel ─────────────────────────────────────────────────────────────
  if ('cancel' in parsed.data) {
    if (!existing) return NextResponse.json({ error: 'Nothing is booked on this link.' }, { status: 409 });
    await service.from('shop_appointments')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    let projectId: string | null = null;
    if (target.kind === 'pickup') await propagatePickup(target.checkin.id, null, null);
    else projectId = await propagateDropoff(target.estimate.id, null);
    await notifyStaff(target, projectId,
      `${kindNoun === 'pickup' ? 'Pickup' : 'Drop-off'} cancelled — ${label}`,
      `The customer cancelled the ${kindNoun} booked for ${fmtDay(existing.slot_date)} ${fmt12h(String(existing.slot_time).slice(0, 5))}.`);
    return NextResponse.json({ ok: true, cancelled: true });
  }

  // ── Book / reschedule ──────────────────────────────────────────────────
  const { slotDate, slotTime, contactName, contactPhone, notes } = parsed.data;
  const today = chicagoDay();
  const taken = await takenSlots(today);
  const open = generateSlots(settings, today, taken, existing);
  if (!open.find(d => d.day === slotDate)?.times.includes(slotTime)) {
    return NextResponse.json({ error: 'That slot is no longer available — pick another.' }, { status: 409 });
  }

  const stamp = new Date().toISOString();
  const fields = {
    slot_date: slotDate,
    slot_time: `${slotTime}:00`,
    contact_name: contactName?.trim() || null,
    contact_phone: contactPhone?.trim() || null,
    notes: notes?.trim() || null,
    updated_at: stamp,
  };
  let error;
  if (existing) {
    ({ error } = await service.from('shop_appointments').update(fields).eq('id', existing.id));
  } else {
    ({ error } = await service.from('shop_appointments').insert({
      kind: target.kind,
      fleet_checkin_id: target.kind === 'pickup' ? target.checkin.id : null,
      estimate_id: target.kind === 'dropoff' ? target.estimate.id : null,
      customer_name: target.kind === 'pickup' ? target.checkin.customer_name : target.estimate.customer_name,
      booked_via: 'customer',
      ...fields,
    }));
  }
  if (error) {
    // 23505 = the slot's partial unique index — someone took it mid-flight.
    if ((error as any).code === '23505') {
      return NextResponse.json({ error: 'That slot was just taken — pick another.' }, { status: 409 });
    }
    console.error('booking write failed:', error);
    return NextResponse.json({ error: 'Booking failed — please try again.' }, { status: 500 });
  }

  let projectId: string | null = null;
  if (target.kind === 'pickup') {
    await propagatePickup(target.checkin.id, slotDate, `${slotTime}:00`);
  } else {
    projectId = await propagateDropoff(target.estimate.id, slotDate);
    if (projectId) {
      await service.from('shop_appointments').update({ upfit_project_id: projectId })
        .eq('kind', 'dropoff').eq('estimate_id', target.estimate.id).eq('status', 'booked');
    }
  }

  const when = `${fmtDay(slotDate)} at ${fmt12h(slotTime)}`;
  const verb = existing ? 'rescheduled' : 'booked';
  await notifyStaff(target, projectId,
    `${kindNoun === 'pickup' ? 'Pickup' : 'Drop-off'} ${verb} — ${label}`,
    `${target.kind === 'pickup' ? target.checkin.customer_name : target.estimate.customer_name} ${verb} a ${kindNoun} for ${when}.`);

  // Confirmation back to the customer. This is a direct response to their
  // own action (they just booked it), not an automated campaign — so it
  // bypasses the notify_status_emails opt-in the way on-demand sends do.
  const customerName = target.kind === 'pickup' ? target.checkin.customer_name : target.estimate.customer_name;
  if (customerName) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
    const bodyText = `Your ${kindNoun} for ${label} is ${verb} for ${when}. Need a different time? Use the same link to reschedule or cancel.`;
    await notifyCustomerByName(service, customerName, {
      respectOptOut: false,
      contextEntityType: target.kind === 'pickup' ? 'fleet_checkin' : 'estimate',
      contextEntityId: target.kind === 'pickup' ? target.checkin.id : target.estimate.id,
      threadSubject: `${kindNoun === 'pickup' ? 'Pickup' : 'Drop-off'} ${verb} — ${label}`,
      emailSubject: `[BMG Fleet] Your ${kindNoun} is ${verb} — ${when}`,
      emailHtml: buildNotificationEmail(`Your ${kindNoun} is ${verb}`, bodyText, `${appUrl}/book/${params.token}`, 'Manage this booking'),
      messageBody: bodyText,
      smsBody: `[BMG Fleet] Your ${kindNoun} for ${label} is ${verb}: ${when}.`,
    }).catch(e => console.error('booking confirmation failed:', e));
  }

  return NextResponse.json({ ok: true, slotDate, slotTime });
}
