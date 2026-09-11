/**
 * Customer email preferences (R6-11) — which automatic emails a company,
 * and each person at it, has agreed to receive.
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
 * a colleague: unsubscribing removes YOU from the recipient list, which is
 * why `filterRecipients` drops addresses rather than skipping the send.
 */

export type PrefKey = 'status_emails' | 'weekly_digest' | 'estimate_reminders';

export const PREF_KEYS: PrefKey[] = ['status_emails', 'weekly_digest', 'estimate_reminders'];

/** Column names per layer, so a caller can't pair the wrong two. */
export const COMPANY_COLUMN: Record<PrefKey, string> = {
  status_emails: 'notify_status_emails',
  weekly_digest: 'weekly_digest',
  estimate_reminders: 'notify_estimate_reminders',
};
export const CONTACT_COLUMN: Record<PrefKey, string> = {
  status_emails: 'notify_status_emails',
  weekly_digest: 'weekly_digest',
  estimate_reminders: 'notify_estimate_reminders',
};

export const PREF_LABEL: Record<PrefKey, string> = {
  status_emails: 'Vehicle status updates',
  weekly_digest: 'Weekly summary',
  estimate_reminders: 'Estimate approval reminders',
};

export const PREF_DESCRIPTION: Record<PrefKey, string> = {
  status_emails: 'When a vehicle is finished or ships.',
  weekly_digest: 'One Monday email covering everything in progress.',
  estimate_reminders: 'A nudge while an estimate is still waiting on your approval.',
};

/**
 * Company defaults differ per key, and the difference is deliberate:
 * status emails and the weekly digest are opt-IN (migration 171), while
 * estimate reminders were unconditional before migration 306 and stay on
 * unless someone turns them off.
 */
export const COMPANY_DEFAULT: Record<PrefKey, boolean> = {
  status_emails: false,
  weekly_digest: false,
  estimate_reminders: true,
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
  notify_estimate_reminders?: boolean | null;
}
export interface CompanyPrefs {
  notify_status_emails?: boolean | null;
  weekly_digest?: boolean | null;
  notify_estimate_reminders?: boolean | null;
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

/**
 * Drop the addresses belonging to people who opted out of THIS email,
 * leaving everyone else on it. An address with no matching contact row is
 * kept: we have no opinion on file for it, and dropping a recipient on the
 * strength of a missing record would silence someone who never asked to be.
 */
export function filterRecipients(
  key: PrefKey,
  emails: string[],
  company: CompanyPrefs | null | undefined,
  contactsByEmail: Map<string, ContactPrefs>,
): string[] {
  return emails.filter(raw => {
    const address = String(raw || '').trim();
    if (!address) return false;
    const contact = contactsByEmail.get(address.toLowerCase());
    if (!contact) return true;
    return mayReceive(key, company, contact);
  });
}

/** Lowercased email → contact prefs, for filterRecipients. */
export function indexContactsByEmail(
  rows: Array<{ email?: string | null } & ContactPrefs>,
): Map<string, ContactPrefs> {
  const map = new Map<string, ContactPrefs>();
  for (const row of rows || []) {
    const address = String(row.email || '').trim().toLowerCase();
    if (!address) continue;
    // First row wins — a duplicate contact record must not let a later,
    // emptier row erase an opt-out the first one carries.
    if (!map.has(address)) map.set(address, row);
  }
  return map;
}
