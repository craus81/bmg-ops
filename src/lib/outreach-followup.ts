import type { SupabaseClient } from '@supabase/supabase-js';
import { callAnthropicWithRetry } from './anthropic';
import { LEGAL } from './legal';
import { OUTREACH_MODEL } from './outreach-draft';
import { TARGET_COLS } from './outreach-send';
import { loadUnsubscribed } from './email-unsubscribe';

/**
 * Outreach follow-ups (migration 441). A week after the first email, if the
 * company hasn't answered in any way FleetSuite can see, Claude writes a
 * short follow-up and the rep reviews and sends it from the compose screen,
 * same as the first one. Nothing sends itself (CLAUDE.md).
 *
 * Replies land in the rep's own mailbox (Reply-To is the rep), so
 * FleetSuite can't see an email answer: the rep taps "They replied". A
 * booking or call-back moves the row off 'sent' on its own, and a call,
 * meeting or note logged on the prospect since the send counts as talking.
 */

export const FOLLOWUP_AFTER_DAYS = 7;

/** Prospect activity that means someone at BMG has already talked to them. */
const TALKED_TYPES = ['call', 'meeting', 'note', 'quote_sent'];

/** Sent before this instant → due a follow-up. */
export function followUpCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - FOLLOWUP_AFTER_DAYS * 86_400_000).toISOString();
}

/** "Re: <first subject>", without stacking a second "Re:". */
export function followUpSubject(sent: string | null | undefined): string {
  const s = String(sent || '').trim();
  if (!s) return 'Following up';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export interface FollowUpInput {
  companyName: string;
  repName: string;
  contactName: string | null;
  firstSubject: string | null;
  firstBody: string | null;
  sentAt: string | null;
}

export function buildFollowUpPrompt(input: FollowUpInput): string {
  const days = input.sentAt
    ? Math.max(FOLLOWUP_AFTER_DAYS, Math.round((Date.now() - new Date(input.sentAt).getTime()) / 86_400_000))
    : FOLLOWUP_AFTER_DAYS;
  return `You write short sales follow-up emails for ${LEGAL.entityName} ("BMG Fleet"), a fleet upfitter in O'Fallon, Missouri.

About ${days} days ago ${input.repName} sent ${input.companyName} this first email and has heard nothing back:
Subject: ${input.firstSubject || '(none)'}
"""
${input.firstBody || '(not saved)'}
"""

Write the follow-up from ${input.repName}:
- 40 to 80 words. Plain and friendly, no guilt, no "just checking in", no "bumping this", no exclamation marks, no em dashes.
- Don't repeat the first email. Add one short, different reason to talk that follows from what the first email said about them, or offer something small and useful (a quote on one vehicle, a look at what they run now).
- Never invent facts about the company.
- Greet ${input.contactName ? `${input.contactName.split(' ')[0]} by first name` : 'with "Hi there,"'}.
- The same two buttons are added under your text automatically ("Pick a time to talk" and "Have ${input.repName.split(' ')[0]} call me"); say they can use them or just reply. No signature, phone number or links.

Reply with ONLY a JSON object: {"body": "..."}`;
}

/** Bare JSON, or JSON inside fences or with a sentence around it. */
export function parseFollowUpJson(text: string): string | null {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const body = String(JSON.parse(m[0]).body || '').trim().replace(/\r\n/g, '\n');
    return body.length >= 30 ? body : null;
  } catch {
    return null;
  }
}

export async function writeFollowUp(input: FollowUpInput): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Follow-up drafts need the Claude key (ANTHROPIC_API_KEY in Vercel)');
  const res = await callAnthropicWithRetry({
    model: OUTREACH_MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: buildFollowUpPrompt(input) }],
  }, apiKey);
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error(`Claude couldn't write this follow-up: ${data?.error?.message || `status ${res.status}`}`);
  const text = (data.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const body = parseFollowUpJson(text);
  if (!body) throw new Error('Claude\'s follow-up came back in a shape FleetSuite couldn\'t read. Try Rewrite.');
  return body;
}

/** Why a due row should get no follow-up, or null when it should get one. */
export async function followUpSkipReason(service: SupabaseClient, t: any): Promise<string | null> {
  if (t.email) {
    const unsub = await loadUnsubscribed(service, [t.email]);
    if (unsub.size > 0) return 'unsubscribed';
  }
  if (t.prospect_id && t.sent_at) {
    const { data, error } = await service.from('prospect_activities').select('id')
      .eq('prospect_id', t.prospect_id).in('type', TALKED_TYPES).gt('created_at', t.sent_at).limit(1);
    if (error) throw new Error(error.message);
    if ((data || []).length > 0) return 'talked';
  }
  return null;
}

/**
 * Write (or rewrite) one follow-up and save it. A first write moves the row
 * from 'sent' to 'follow_up' (Follow-up ready).
 */
export async function draftFollowUp(service: SupabaseClient, t: any): Promise<{ ok: boolean; error?: string; row?: any }> {
  const { data: rep } = await service.from('profiles').select('full_name').eq('id', t.rep_id).maybeSingle();
  try {
    const body = await writeFollowUp({
      companyName: t.company_name,
      repName: (rep as any)?.full_name || 'your BMG rep',
      contactName: t.contact_name,
      firstSubject: t.sent_subject || t.draft_subject,
      firstBody: t.draft_body,
      sentAt: t.sent_at,
    });
    const { data, error } = await service.from('outreach_targets').update({
      followup_subject: followUpSubject(t.sent_subject || t.draft_subject),
      followup_body: body,
      followup_drafted_at: new Date().toISOString(),
      followup_error: null,
      ...(t.status === 'sent' ? { status: 'follow_up', status_changed_at: new Date().toISOString() } : {}),
    }).eq('id', t.id).select(TARGET_COLS).single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, row: data };
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 300);
    await service.from('outreach_targets').update({ followup_error: msg }).eq('id', t.id);
    return { ok: false, error: msg };
  }
}
