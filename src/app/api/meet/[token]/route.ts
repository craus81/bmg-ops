import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { notify } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import {
  isMeetToken, meetDays, openSlots, chicagoInstant, firstName, fmtDayLong, fmtTime12, MEET_MINUTES,
  type BusyBlock,
} from '@/lib/outreach-meet';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * Outreach "Pick a time" / "Have <rep> call me" (migration 440). Public:
 * the token in the email's buttons is the credential, and all it can do is
 * put one call on its own rep's schedule or leave a call-back number for
 * that rep. Guard order is the portal standard: rate-limit, token resolve
 * (404 on miss), validate, re-check the slot, service-role write.
 */

async function resolve(token: string) {
  if (!isMeetToken(token)) return null;
  const { data } = await service.from('outreach_targets')
    .select('id, company_name, rep_id, prospect_id, status, meeting_at, meeting_contact, callback_phone, callback_when, callback_requested_at, meeting_event_id')
    .eq('booking_token', token).maybeSingle();
  if (!data || !(data as any).rep_id) return null;
  const { data: rep } = await service.from('profiles').select('id, full_name, status, deactivated').eq('id', (data as any).rep_id).maybeSingle();
  if (!rep || (rep as any).deactivated || (rep as any).status !== 'approved') return null;
  return { t: data as any, rep: rep as any };
}

async function slotsFor(repId: string) {
  const days = meetDays();
  const { data } = await service.from('calendar_events')
    .select('event_date, event_time, duration_minutes')
    .eq('user_id', repId).gte('event_date', days[0]).lte('event_date', days[days.length - 1]);
  const busy: BusyBlock[] = (data || []).map((e: any) => ({ date: e.event_date, time: e.event_time, minutes: e.duration_minutes }));
  return openSlots(days, busy).filter(d => d.times.length > 0);
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  if (!(await checkRateLimit(getRequestIp(req), 'meet_view', 60))) {
    return NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429 });
  }
  const r = await resolve(params.token);
  if (!r) return NextResponse.json({ status: 'invalid' }, { status: 404 });
  const { t, rep } = r;
  const booked = t.meeting_at && new Date(t.meeting_at).getTime() > Date.now() ? t.meeting_at : null;
  return NextResponse.json({
    status: 'ready',
    company: t.company_name,
    repName: rep.full_name || 'BMG Fleet',
    repFirst: firstName(rep.full_name),
    minutes: MEET_MINUTES,
    booked,
    callback: t.callback_requested_at ? { phone: t.callback_phone, when: t.callback_when } : null,
    slots: booked ? [] : await slotsFor(rep.id),
  });
}

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('book'),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    name: z.string().trim().max(120).optional(),
    phone: z.string().trim().min(7).max(40),
  }),
  z.object({
    action: z.literal('call'),
    name: z.string().trim().max(120).optional(),
    phone: z.string().trim().min(7).max(40),
    when: z.string().trim().max(200).optional(),
  }),
]);

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  if (!(await checkRateLimit(getRequestIp(req), 'meet_submit', 10))) {
    return NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429 });
  }
  const r = await resolve(params.token);
  if (!r) return NextResponse.json({ status: 'invalid' }, { status: 404 });
  const parsed = await validateBody(req, Body);
  if (parsed.error) return parsed.error;
  const b = parsed.data;
  const { t, rep } = r;
  const who = b.name ? `${b.name}, ${t.company_name}` : t.company_name;
  const url = t.prospect_id ? deepLinks.prospect(t.prospect_id) : deepLinks.outreach();

  if (b.action === 'book') {
    if (t.meeting_at && new Date(t.meeting_at).getTime() > Date.now()) {
      return NextResponse.json({ error: `You already have a call booked. ${firstName(rep.full_name)} will call you then.` }, { status: 409 });
    }
    const open = await slotsFor(rep.id);
    if (!open.some(d => d.day === b.day && d.times.includes(b.time))) {
      return NextResponse.json({ error: 'That time was just taken. Pick another one.' }, { status: 409 });
    }
    const when = chicagoInstant(b.day, b.time);
    const { data: ev, error } = await service.from('calendar_events').insert({
      title: `Call: ${who}`,
      description: `Booked from an Outreach email. Call ${b.phone}.`,
      event_date: b.day,
      event_time: b.time,
      duration_minutes: MEET_MINUTES,
      event_type: 'sales',
      user_id: rep.id,
      prospect_id: t.prospect_id || null,
    }).select('id').single();
    if (error || !ev) return NextResponse.json({ error: 'That didn\'t go through. Try again in a minute.' }, { status: 500 });
    await service.from('outreach_targets').update({
      status: 'booked', status_changed_at: new Date().toISOString(),
      meeting_at: when.toISOString(), meeting_event_id: (ev as any).id,
      meeting_contact: [b.name, b.phone].filter(Boolean).join(' · '),
    }).eq('id', t.id);
    const label = `${fmtDayLong(b.day)} at ${fmtTime12(b.time)}`;
    if (t.prospect_id) {
      await service.from('prospect_activities').insert({
        prospect_id: t.prospect_id, type: 'meeting', summary: `Booked a call from the Outreach email: ${label}, ${b.phone}`.slice(0, 500),
      });
    }
    await notify({
      userId: rep.id, type: 'outreach_response',
      title: `Call booked: ${t.company_name}`,
      body: `${who} booked a ${MEET_MINUTES}-minute call for ${label}. Call ${b.phone}. It's on your schedule.`,
      url,
    }).catch(() => {});
    return NextResponse.json({ success: true, booked: when.toISOString(), label });
  }

  await service.from('outreach_targets').update({
    status: 'call_back', status_changed_at: new Date().toISOString(),
    callback_phone: b.phone, callback_when: b.when || null, callback_requested_at: new Date().toISOString(),
    meeting_contact: b.name || null,
  }).eq('id', t.id);
  if (t.prospect_id) {
    await service.from('prospect_activities').insert({
      prospect_id: t.prospect_id, type: 'call', summary: `Asked for a call back from the Outreach email: ${b.phone}${b.when ? ` (${b.when})` : ''}`.slice(0, 500),
    });
  }
  await notify({
    userId: rep.id, type: 'outreach_response',
    title: `Call back: ${t.company_name}`,
    body: `${who} asked you to call ${b.phone}${b.when ? `, best time: ${b.when}` : ''}.`,
    url,
  }).catch(() => {});
  return NextResponse.json({ success: true, callback: true });
}
