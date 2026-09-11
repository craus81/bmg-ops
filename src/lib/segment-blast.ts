/**
 * Segment email blast (R6-9) — turning a filtered CRM list into one
 * individually-addressed send per recipient.
 *
 * Two rules do most of the work here.
 *
 * CONSENT IS NOT A FILTER SETTING. `prospects.email_campaign` is the
 * marketing opt-in, and it gates the send whether or not the sender happened
 * to tick the campaign filter. A record that never opted in is dropped, and
 * the compose screen names how many and why — quietly including them would
 * put the sender's name on mail the recipient never agreed to.
 *
 * A MERGE FIELD WITH NO VALUE IS A BLOCKER, NOT A BLANK. "Hi ," is worse
 * than not sending: it is visibly machine-generated and it tells the reader
 * exactly how little we know about them. A recipient missing a field the
 * template uses is skipped and listed, so the sender can fix the record or
 * drop the field.
 */

/** One send per recipient, sequential — this bounds a run inside the route's
 *  time budget. Past it the sender splits the segment. */
export const MAX_RECIPIENTS = 100;

export interface MergeField {
  token: string;
  label: string;
  /** Null when this recipient has no value for it. */
  resolve: (r: BlastRecipientSource) => string | null;
}

export interface BlastRecipientSource {
  id: string;
  company_name?: string | null;
  contact_name?: string | null;
  email?: string | null;
  email_campaign?: boolean | null;
}

const firstName = (full?: string | null): string | null => {
  const t = String(full || '').trim();
  if (!t) return null;
  return t.split(/\s+/)[0] || null;
};

export const MERGE_FIELDS: MergeField[] = [
  { token: '{{company}}', label: 'Company name', resolve: r => (r.company_name || '').trim() || null },
  { token: '{{contact_name}}', label: 'Contact full name', resolve: r => (r.contact_name || '').trim() || null },
  { token: '{{contact_first_name}}', label: 'Contact first name', resolve: r => firstName(r.contact_name) },
];

/** Which known merge tokens a template actually uses. */
export function usedMergeFields(template: string): MergeField[] {
  const t = String(template || '');
  return MERGE_FIELDS.filter(f => t.includes(f.token));
}

/**
 * Tokens that look like merge fields but are not ones we know. Reported
 * rather than silently sent: `{{frist_name}}` reaching a customer verbatim
 * is the failure this catches.
 */
export function unknownMergeTokens(template: string): string[] {
  const known = new Set(MERGE_FIELDS.map(f => f.token));
  const found = String(template || '').match(/\{\{[^}\n]{1,60}\}\}/g) || [];
  return [...new Set(found.filter(t => !known.has(t)))];
}

export function applyMerge(template: string, recipient: BlastRecipientSource): string {
  let out = String(template || '');
  for (const f of MERGE_FIELDS) {
    const value = f.resolve(recipient);
    if (value == null) continue;
    out = out.split(f.token).join(value);
  }
  return out;
}

export type SkipReason = 'no_email' | 'not_opted_in' | 'duplicate_email' | 'missing_merge_field';

export interface BlastRecipient {
  id: string;
  email: string;
  companyName: string;
  contactName: string | null;
}

export interface SkippedRecipient {
  id: string;
  companyName: string;
  email: string | null;
  reason: SkipReason;
  /** Which merge field it was missing, when that is the reason. */
  detail?: string;
}

export interface BlastAudience {
  sendable: BlastRecipient[];
  skipped: SkippedRecipient[];
  /** True when the segment is larger than one run can send. */
  overCap: boolean;
}

/**
 * Split a segment into who can be sent to and who cannot, with a reason for
 * every exclusion. Order is preserved so the caller's sort survives.
 */
export function buildAudience(rows: BlastRecipientSource[], template: string): BlastAudience {
  const used = usedMergeFields(template);
  const seen = new Set<string>();
  const sendable: BlastRecipient[] = [];
  const skipped: SkippedRecipient[] = [];

  for (const r of rows || []) {
    const companyName = (r.company_name || '').trim() || '—';
    const email = (r.email || '').trim().toLowerCase();

    if (!email) {
      skipped.push({ id: r.id, companyName, email: null, reason: 'no_email' });
      continue;
    }
    if (!r.email_campaign) {
      skipped.push({ id: r.id, companyName, email, reason: 'not_opted_in' });
      continue;
    }
    if (seen.has(email)) {
      // Two records sharing an address: one send, not two. The second is a
      // duplicate of the first, not a second customer.
      skipped.push({ id: r.id, companyName, email, reason: 'duplicate_email' });
      continue;
    }
    const missing = used.find(f => f.resolve(r) == null);
    if (missing) {
      skipped.push({ id: r.id, companyName, email, reason: 'missing_merge_field', detail: missing.label });
      continue;
    }

    seen.add(email);
    sendable.push({ id: r.id, email, companyName, contactName: (r.contact_name || '').trim() || null });
  }

  return { sendable, skipped, overCap: sendable.length > MAX_RECIPIENTS };
}

export const SKIP_LABEL: Record<SkipReason, string> = {
  no_email: 'No email address on the record',
  not_opted_in: 'Not opted in to campaign email',
  duplicate_email: 'Same address as another record in this segment',
  missing_merge_field: 'Missing a field the message fills in',
};
