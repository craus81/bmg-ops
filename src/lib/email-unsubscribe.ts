import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { LEGAL } from './legal';

/**
 * Unsubscribe links on marketing email (migration 437) — the segment blast
 * today, outreach drafts next. Commercial email must carry the sender's
 * postal address and a working opt-out (CAN-SPAM), and Gmail and Yahoo want
 * a one-click List-Unsubscribe header (RFC 8058) on anything sent in bulk.
 *
 * Each address gets ONE token, minted the first time we send it marketing
 * email and reused after that, so the link in a months-old email still
 * works. Stored, not signed: nothing to rotate, and a token can't outlive
 * its row.
 *
 * Opting out is about marketing only. Estimates, invoices and other mail
 * about the customer's own orders don't check this.
 */

const TOKEN_RE = /^[a-f0-9]{48}$/;

export const normalizeEmail = (email: string | null | undefined): string =>
  String(email || '').trim().toLowerCase();

export const isUnsubscribeToken = (token: string): boolean => TOKEN_RE.test(token);

const baseUrl = (): string =>
  (process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com').replace(/\/$/, '');

/** The page a person opens from the footer link: one button to confirm.
 *  A GET never unsubscribes, because mail scanners open every link. */
export const unsubscribePageUrl = (token: string): string => `${baseUrl()}/unsubscribe/${token}`;

/** Where a mail client POSTs "List-Unsubscribe=One-Click". */
export const unsubscribeOneClickUrl = (token: string): string => `${baseUrl()}/api/unsubscribe/${token}`;

export function listUnsubscribeHeaders(token: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeOneClickUrl(token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Address + unsubscribe line under the signature. */
export function marketingFooterHtml(token: string): string {
  return `
    <div style="margin-top:22px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280;">
      ${escapeHtml(LEGAL.entityName)} · ${escapeHtml(LEGAL.address)}<br />
      Don't want these emails? <a href="${escapeHtml(unsubscribePageUrl(token))}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>.
    </div>`;
}

export function marketingFooterText(token: string): string {
  return `\n\n--\n${LEGAL.entityName} · ${LEGAL.address}\nUnsubscribe: ${unsubscribePageUrl(token)}`;
}

/** Of these addresses, the ones that have unsubscribed. */
export async function loadUnsubscribed(service: SupabaseClient, emails: string[]): Promise<Set<string>> {
  const list = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  const out = new Set<string>();
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await service.from('email_unsubscribes')
      .select('email')
      .in('email', list.slice(i, i + 200))
      .not('unsubscribed_at', 'is', null);
    // Fail closed: if we can't tell who opted out, nobody gets marketing mail.
    if (error) throw new Error(`Could not check unsubscribes: ${error.message}`);
    for (const r of data || []) out.add((r as any).email);
  }
  return out;
}

/** The address's unsubscribe token, minted on first use. */
export async function unsubscribeTokenFor(service: SupabaseClient, email: string): Promise<string> {
  const addr = normalizeEmail(email);
  if (!addr) throw new Error('No email address');
  const existing = await service.from('email_unsubscribes').select('token').eq('email', addr).maybeSingle();
  if (existing.data?.token) return existing.data.token;

  const token = randomBytes(24).toString('hex');
  const { error } = await service.from('email_unsubscribes')
    .upsert({ email: addr, token }, { onConflict: 'email', ignoreDuplicates: true });
  if (error) throw new Error(`Could not make an unsubscribe link: ${error.message}`);
  // A racing send may have minted first; whichever row stands is the token.
  const again = await service.from('email_unsubscribes').select('token').eq('email', addr).maybeSingle();
  if (!again.data?.token) throw new Error('Could not make an unsubscribe link');
  return again.data.token;
}

export interface UnsubscribeRow {
  email: string;
  token: string;
  unsubscribed_at: string | null;
}

export async function findUnsubscribeToken(service: SupabaseClient, token: string): Promise<UnsubscribeRow | null> {
  if (!isUnsubscribeToken(token)) return null;
  const { data } = await service.from('email_unsubscribes')
    .select('email, token, unsubscribed_at').eq('token', token).maybeSingle();
  return (data as UnsubscribeRow) || null;
}

/** "dana@acme.com" → "d•••@acme.com": enough for the person to know it's
 *  theirs, without the page handing out the address to whoever has the link. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  return `${user.slice(0, 1)}•••@${domain}`;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, c => `\\${c}`);

/**
 * Opt the token's address out. Also untick the marketing checkbox on every
 * prospect with that address and note it on their timeline, so the rep sees
 * why they dropped out of the next segment. Saying yes twice is fine.
 */
export async function recordUnsubscribe(
  service: SupabaseClient, row: UnsubscribeRow, via: 'page' | 'one_click',
): Promise<void> {
  if (row.unsubscribed_at) return;
  const { error } = await service.from('email_unsubscribes')
    .update({ unsubscribed_at: new Date().toISOString(), unsubscribed_via: via })
    .eq('token', row.token)
    .is('unsubscribed_at', null);
  if (error) throw new Error(error.message);

  const { data: prospects } = await service.from('prospects')
    .select('id').ilike('email', escapeLike(row.email));
  const ids = (prospects || []).map((p: any) => p.id as string);
  if (ids.length === 0) return;
  await service.from('prospects').update({ email_campaign: false }).in('id', ids);
  await service.from('prospect_activities').insert(ids.map(id => ({
    prospect_id: id,
    type: 'status_change',
    summary: `Unsubscribed from BMG marketing email (${row.email})`,
  })));
}
