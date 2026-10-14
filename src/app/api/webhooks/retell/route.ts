import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  afterHoursCallSubject, buildAfterHoursCallEmail, parseRetellCall, prettyPhone, reasonLabel,
  verifyRetellSignature,
} from '@/lib/retell';
import { notifyMany } from '@/lib/notify';
import { sendEmail } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Retell AI webhook — the after-hours phone agent.
 *
 * Retell answers the main line when the office is closed and POSTs call
 * events here. We act on `call_analyzed` (the last event, carrying the
 * summary and the fields the agent took down): the call is stored in
 * phone_call_events (provider 'retell'), and everyone flagged
 * profiles.after_hours_call_emails (Craig, 2026-10-14: Valarie, Harold,
 * Zach, Craig and Jessie, whatever their role) gets the summary as its own
 * email, plus an in-app/push alert per their notification settings.
 *
 * A caller ID on the spam list (phone_spam_numbers, marked from the
 * After-hours Calls page) is still logged, flagged spam, but nobody is
 * emailed or alerted.
 *
 * verifyRetellSignature is the credential check and fails closed (no
 * RETELL_API_KEY = reject). summary_emailed_at makes Retell's retries
 * harmless: the emails go out once per call.
 */

async function summaryRecipients(): Promise<Array<{ id: string; email: string | null; full_name: string | null }>> {
  const { data } = await service
    .from('profiles')
    .select('id, email, full_name')
    .eq('after_hours_call_emails', true)
    .eq('status', 'approved')
    .or('deactivated.is.null,deactivated.eq.false')
    .order('full_name');
  return (data || []).filter((p: any) => p.id);
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyRetellSignature(raw, req.headers.get('x-retell-signature'), process.env.RETELL_API_KEY)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: Record<string, any>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  if (body?.event !== 'call_analyzed') return NextResponse.json({ ok: true, ignored: body?.event || 'no event' });

  const call = parseRetellCall(body);
  if (!call) return NextResponse.json({ ok: true, ignored: 'no call id' });

  // Caller ID on the spam list: log it under Spam, tell nobody.
  let spam = false;
  if (call.externalDigits.length >= 7) {
    const { data: blocked } = await service
      .from('phone_spam_numbers').select('digits').eq('digits', call.externalDigits).maybeSingle();
    spam = !!blocked;
  }

  // Match the caller against the CRM the same way the Dialpad caller-ID
  // webhook does, so the email can open their record.
  let matchedProspectId: string | null = null;
  let matchedName: string | null = null;
  for (const digits of [call.externalDigits, call.callbackNumber?.replace(/\D+/g, '').slice(-10) || '']) {
    if (matchedProspectId || digits.length < 7) continue;
    const { data: hit } = await service
      .from('prospects')
      .select('id, company_name')
      .like('phone_digits', `%${digits}%`)
      .limit(1)
      .maybeSingle();
    if (hit) { matchedProspectId = hit.id; matchedName = hit.company_name; }
  }
  if (!call.callerCompany && matchedName) call.callerCompany = matchedName;

  const { data: existing } = await service
    .from('phone_call_events')
    .select('id, summary_emailed_at')
    .eq('provider', 'retell')
    .eq('provider_call_id', call.callId)
    .maybeSingle();

  const { data: saved, error } = await service
    .from('phone_call_events')
    .upsert({
      provider: 'retell',
      provider_call_id: call.callId,
      direction: call.direction,
      state: 'completed',
      from_number: call.fromNumber,
      to_number: call.toNumber,
      external_digits: call.externalDigits || null,
      matched_prospect_id: matchedProspectId,
      started_at: call.startedAt,
      ended_at: call.endedAt,
      duration_seconds: call.durationSeconds,
      caller_name: call.callerName,
      caller_company: call.callerCompany,
      caller_email: call.callerEmail,
      callback_number: call.callbackNumber,
      call_reason: call.reason,
      caller_reference: call.reference,
      urgent: call.urgent,
      summary: call.summary,
      transcript: call.transcript,
      recording_url: call.recordingUrl,
      spam,
      raw: body,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'provider,provider_call_id' })
    .select('id')
    .single();
  if (error || !saved) {
    console.error('retell call upsert failed:', error?.message);
    return NextResponse.json({ error: 'store failed' }, { status: 500 });
  }
  if (existing?.summary_emailed_at) return NextResponse.json({ ok: true, duplicate: true });
  if (spam) return NextResponse.json({ ok: true, spam: true });

  // Deep-link rule: the email and alert open this call on the After-hours
  // Calls page, which links on to the customer or adds them as a lead.
  const url = deepLinks.afterHoursCall(saved.id);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com';

  const recipients = await summaryRecipients();
  const subject = afterHoursCallSubject(call);
  const html = buildAfterHoursCallEmail(call, `${appUrl}${url}`, recipients.map(r => r.full_name || r.email || '').filter(Boolean));
  const results = await Promise.allSettled(recipients
    .filter(a => a.email)
    .map(a => sendEmail(a.email!, subject, html, undefined, undefined, undefined, undefined,
      { kind: 'after_hours_call', contextUrl: url, prospectId: matchedProspectId })));
  const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;

  if (recipients.length > 0) {
    const who = [call.callerName, call.callerCompany].filter(Boolean).join(', ') || prettyPhone(call.callbackNumber) || 'Unknown caller';
    await notifyMany(recipients.map(a => a.id), {
      type: 'after_hours_call',
      title: `${call.urgent ? 'URGENT · ' : ''}After-hours call: ${who}`,
      body: `${reasonLabel(call.reason)}. ${call.summary || 'Transcript is in the email.'}`.slice(0, 400),
      url,
      channels: ['in_app', 'push'],
    });
  }

  if (sent > 0) {
    await service.from('phone_call_events')
      .update({ summary_emailed_at: new Date().toISOString() })
      .eq('id', saved.id);
  }
  return NextResponse.json({ ok: true, emailed: sent, recipients: recipients.length, matched: !!matchedProspectId });
}
