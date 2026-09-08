import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  FINISHED_STATES, RINGING_STATES, parseDialpadCall, phoneDigits, verifyDialpadJwt,
} from '@/lib/dialpad';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Dialpad Event Subscription webhook (R6-3) — the caller-ID screen-pop.
 *
 * Dialpad POSTs a JWT signed with the shared secret set when the
 * subscription was created; verifyDialpadJwt is the credential check, and
 * it FAILS CLOSED (no secret configured = reject) because this route
 * writes CRM rows and fires notifications at people.
 *
 * On a ringing inbound call we match the caller against prospects by
 * phone digits — the same phone_digits columns the caller-ID search uses —
 * and notify the rep the call rang, or sales/admins when Dialpad doesn't
 * name one. The notification IS the screen-pop in this app's idiom: it
 * deep-links to the matched record so whoever answers is already looking
 * at the right customer.
 */

export async function POST(req: NextRequest) {
  const raw = await req.text();
  // Dialpad sends the JWT as the body; some configurations wrap it in JSON.
  let token = raw.trim();
  if (token.startsWith('{')) {
    try { token = JSON.parse(token)?.token || JSON.parse(token)?.jwt || ''; } catch { token = ''; }
  }
  const payload = verifyDialpadJwt(token, process.env.DIALPAD_WEBHOOK_SECRET);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const call = parseDialpadCall(payload);
  if (!call) return NextResponse.json({ ok: true, ignored: 'no call id' });

  // Match the outside party against the CRM.
  let matchedProspectId: string | null = null;
  let matchedName: string | null = null;
  if (call.externalDigits.length >= 7) {
    const { data: hit } = await service
      .from('prospects')
      .select('id, company_name')
      .like('phone_digits', `%${call.externalDigits}%`)
      .limit(1)
      .maybeSingle();
    if (hit) { matchedProspectId = hit.id; matchedName = hit.company_name; }
  }

  let targetUserId: string | null = null;
  if (call.targetEmail) {
    const { data: prof } = await service
      .from('profiles').select('id').ilike('email', call.targetEmail).maybeSingle();
    targetUserId = prof?.id || null;
  }

  // One row per provider call: a ringing → connected → hangup sequence
  // updates the same row rather than stacking three.
  const { data: existing } = await service
    .from('phone_call_events')
    .select('id')
    .eq('provider', 'dialpad')
    .eq('provider_call_id', call.providerCallId)
    .maybeSingle();

  const row = {
    provider: 'dialpad',
    provider_call_id: call.providerCallId,
    direction: call.direction,
    state: call.state,
    from_number: call.fromNumber,
    to_number: call.toNumber,
    external_digits: call.externalDigits || null,
    matched_prospect_id: matchedProspectId,
    target_user_id: targetUserId,
    started_at: call.startedAt,
    ended_at: call.endedAt,
    duration_seconds: call.durationSeconds,
    raw: payload,
    updated_at: new Date().toISOString(),
  };
  const { error } = await service
    .from('phone_call_events')
    .upsert(row, { onConflict: 'provider,provider_call_id' });
  if (error) {
    console.error('dialpad event upsert failed:', error.message);
    return NextResponse.json({ error: 'store failed' }, { status: 500 });
  }

  // Pop only once, on the first ringing/connected event for an inbound
  // call — a hangup event arriving later must not re-ring anybody.
  const shouldPop = call.direction === 'inbound'
    && !!call.state && RINGING_STATES.has(call.state)
    && !FINISHED_STATES.has(call.state)
    && !existing;

  if (shouldPop) {
    let audience: string[] = [];
    if (targetUserId) {
      audience = [targetUserId];
    } else {
      const { data: staff } = await service
        .from('profiles')
        .select('id, role, roles')
        .eq('status', 'approved')
        .or('role.in.(admin,super_admin,sales),roles.cs.{admin},roles.cs.{sales}');
      audience = (staff || []).map((p: any) => p.id);
    }
    if (audience.length > 0) {
      const pretty = call.fromNumber || call.externalDigits || 'Unknown number';
      await notifyMany(audience, {
        type: 'incoming_call',
        title: matchedName ? `📞 ${matchedName} is calling` : `📞 Incoming call — ${pretty}`,
        body: matchedName
          ? `${pretty} · open the record before you pick up.`
          : `${pretty} · no CRM match on this number.`,
        // Deep-link rule: a known caller opens their record, an unknown one
        // opens the search prefilled with the number so it is one tap to
        // create or find them — never a dead click.
        url: matchedProspectId
          ? deepLinks.prospect(matchedProspectId)
          : `/admin/prospects?q=${encodeURIComponent(call.externalDigits)}`,
        channels: ['in_app', 'push'],
      });
    }
  }

  return NextResponse.json({ ok: true, matched: !!matchedProspectId, popped: shouldPop });
}
