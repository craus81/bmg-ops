/**
 * Customer email preferences (R6-11) — which emails a company, and each
 * person at it, has agreed to receive.
 *
 * Since 2026-09-14 nothing emails a customer on a schedule; a person picks,
 * previews and sends. These preferences therefore gate the PROMPT rather
 * than a send: a customer who turned vehicle updates off does not generate
 * "tell them it's ready" nudges, and one who turned the weekly summary off
 * is not offered on Customer Notifications. A staff member who opens the
 * compose screen anyway has decided, and the send goes — a subscription is
 * about what we mail people unasked.
 *
 * `estimate_reminders` was retired with the automatic approval reminders it
 * named: quote follow-ups are now a rep pressing ✉ Follow Up, and a switch
 * that stops nothing is worse than no switch. The columns stay (migration
 * 306) so the answers are not lost if we ever offer it again.
 *
 * Two layers, resolved here so every sender agrees:
 *
 *   company (customers.*)  — the gate the automatic sends already read
 *   contact (external_contacts.*) — a NULLABLE per-person override
 *
 * NULL at the contact layer means "follow the company setting" and is a
 * real third state. A contact who has never opened the preferences page
 * has expressed no opinion; reading that as "off" would silently stop mail
 * they still want, and reading it as "on" would override a company-level
 * opt-out they never saw. Inherit is the only honest answer.
 *
 * The override can only ever be checked PER PERSON, never used to silence
 * a colleague. Nothing here fans one message out across a recipient list
 * any more — the sends that did were the automatic ones, and every
 * remaining send either resolves one contact or takes the list a staff
 * member typed into the compose screen.
 */

export type PrefKey = 'status_emails' | 'weekly_digest';

export const PREF_KEYS: PrefKey[] = ['status_emails', 'weekly_digest'];

/** Column names per layer, so a caller can't pair the wrong two. */
export const COMPANY_COLUMN: Record<PrefKey, string> = {
  status_emails: 'notify_status_emails',
  weekly_digest: 'weekly_digest',
};
export const CONTACT_COLUMN: Record<PrefKey, string> = {
  status_emails: 'notify_status_emails',
  weekly_digest: 'weekly_digest',
};

export const PREF_LABEL: Record<PrefKey, string> = {
  status_emails: 'Vehicle status updates',
  weekly_digest: 'Weekly summary',
};

export const PREF_DESCRIPTION: Record<PrefKey, string> = {
  status_emails: 'When a vehicle is finished or ships.',
  weekly_digest: 'One Monday email covering everything in progress.',
};

/** Both opt-IN since migration 171. */
export const COMPANY_DEFAULT: Record<PrefKey, boolean> = {
  status_emails: false,
  weekly_digest: false,
};

export interface PrefSource {
  /** The customers row value. undefined/null falls back to COMPANY_DEFAULT. */
  company?: boolean | null;
  /** The external_contacts override. null/undefined means inherit. */
  contact?: boolean | null;
}

/** Does this person get this email? Contact override wins; NULL inherits. */
export function resolvePref(key: PrefKey, src: PrefSource): boolean {
  if (src.contact === true || src.contact === false) return src.contact;
  if (src.company === true || src.company === false) return src.company;
  return COMPANY_DEFAULT[key];
}

/** How the preferences page describes one row's current state. */
export type PrefState = 'on' | 'off' | 'inherit_on' | 'inherit_off';

export function prefState(key: PrefKey, src: PrefSource): PrefState {
  if (src.contact === true) return 'on';
  if (src.contact === false) return 'off';
  return resolvePref(key, { company: src.company }) ? 'inherit_on' : 'inherit_off';
}

export interface ContactPrefs {
  notify_status_emails?: boolean | null;
  weekly_digest?: boolean | null;
}
export interface CompanyPrefs {
  notify_status_emails?: boolean | null;
  weekly_digest?: boolean | null;
}

export function contactValue(key: PrefKey, contact: ContactPrefs | null | undefined): boolean | null {
  if (!contact) return null;
  const v = (contact as any)[CONTACT_COLUMN[key]];
  return v === true || v === false ? v : null;
}

export function companyValue(key: PrefKey, company: CompanyPrefs | null | undefined): boolean | null {
  if (!company) return null;
  const v = (company as any)[COMPANY_COLUMN[key]];
  return v === true || v === false ? v : null;
}

/** The one call a sender makes. */
export function mayReceive(key: PrefKey, company: CompanyPrefs | null | undefined, contact: ContactPrefs | null | undefined): boolean {
  return resolvePref(key, { company: companyValue(key, company), contact: contactValue(key, contact) });
}

