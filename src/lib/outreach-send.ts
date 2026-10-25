import type { SupabaseClient } from '@supabase/supabase-js';
import { writeDraft } from './outreach-draft';
import { findCustomerDuplicates } from './customer-dupes';

/**
 * Server pieces shared by the Outreach draft and send routes and the
 * drafting cron (migrations 438/439, docs/outreach.md).
 */

export const TARGET_COLS =
  'id, source, source_id, kind, company_name, trade, street, city, state, zip, miles, phone, email, website, fleet_size, facts, rep_id, week_of, status, status_changed_at, prospect_id, contact_name, draft_subject, draft_body, draft_reasons, drafted_at, draft_error, sent_at, sent_subject, booking_token, meeting_at, meeting_contact, callback_phone, callback_when, callback_requested_at, followup_subject, followup_body, followup_drafted_at, followup_error, followup_skipped, followup_sent_at';

/** Statuses a draft can be (re)written or sent from. */
export const OPEN_STATUSES = ['new', 'draft', 'call_first', 'later'];

/** What the list's own buttons may move a row to (key), and from where. */
const MOVES: Record<string, string[]> = {
  later: ['new', 'draft', 'call_first'],
  not_fit: [...OPEN_STATUSES, 'sent', 'follow_up', 'followed_up', 'call_back'],
  new: ['later', 'not_fit'],
  replied: ['sent', 'follow_up', 'followed_up', 'call_back'],
};
export const statusMoveAllowed = (from: string, to: string): boolean => (MOVES[to] || []).includes(from);

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The rep's words as paragraphs, the Pick a time / Call me buttons,
 *  signature, then address + unsubscribe. */
export function renderOutreachHtml(message: string, signatureHtml: string, footerHtml: string, buttonsHtml = ''): string {
  const paragraphs = message.split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px;line-height:1.55;">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('');
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#1f2937;">
      ${paragraphs}
      ${buttonsHtml}
      ${signatureHtml}
      ${footerHtml}
    </div>`;
}

/**
 * Write (or rewrite) the draft for one target and save it. A company with
 * no email address found goes to Call first; the draft is still written so
 * it can be sent once the rep gets an address on the phone.
 */
export async function draftTarget(service: SupabaseClient, t: any): Promise<{ ok: boolean; error?: string; row?: any }> {
  const { data: rep } = await service.from('profiles').select('full_name').eq('id', t.rep_id).maybeSingle();
  try {
    const draft = await writeDraft({
      companyName: t.company_name,
      kind: t.kind,
      trade: t.trade,
      city: t.city,
      state: t.state,
      miles: t.miles,
      fleetSize: t.fleet_size,
      facts: t.facts || {},
      website: t.website,
      knownEmail: t.email,
      repName: (rep as any)?.full_name || 'your BMG rep',
    });
    const update = {
      draft_subject: draft.subject,
      draft_body: draft.body,
      draft_reasons: draft.reasons,
      contact_name: t.contact_name || draft.contactName,
      email: t.email || draft.email,
      drafted_at: new Date().toISOString(),
      draft_error: null,
      ...(t.status === 'new' || t.status === 'draft' || t.status === 'call_first'
        ? { status: (t.email || draft.email) ? 'draft' : 'call_first', status_changed_at: new Date().toISOString() }
        : {}),
    };
    const { data, error } = await service.from('outreach_targets').update(update).eq('id', t.id).select(TARGET_COLS).single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, row: data };
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 300);
    await service.from('outreach_targets').update({ draft_error: msg }).eq('id', t.id);
    return { ok: false, error: msg };
  }
}

/**
 * The prospect behind a target, made on its first send. A prospect that
 * already matches (someone added the company by hand since Monday) is used
 * instead of making a second one.
 */
export async function ensureProspect(service: SupabaseClient, t: any, email: string): Promise<string> {
  if (t.prospect_id) return t.prospect_id;
  const matches = await findCustomerDuplicates(service, { companyName: t.company_name, email, phone: t.phone });
  const existing = matches.find(m => m.source === 'prospects');
  if (existing) return existing.id;

  const from = t.source === 'dot' ? `DOT carrier record #${t.source_id}` : 'Google business listing';
  const { data, error } = await service.from('prospects').insert({
    company_name: t.company_name,
    contact_name: t.contact_name || null,
    email,
    phone: t.phone || null,
    address: t.street || null,
    city: t.city || null,
    state: t.state || null,
    zip: t.zip || null,
    website: t.website || null,
    notes: `Found by Outreach (${from}${t.kind === 'fleet' && t.fleet_size ? `, ${t.fleet_size} trucks` : t.trade ? `, ${t.trade}` : ''}).`,
    source: 'outreach',
    lead_source: 'Outreach',
    record_type: 'customer',
    location_count: 1,
    created_by: t.rep_id,
  }).select('id').single();
  if (error || !data) throw new Error(`Could not add ${t.company_name} to Prospects: ${error?.message || 'no row'}`);
  return data.id;
}
