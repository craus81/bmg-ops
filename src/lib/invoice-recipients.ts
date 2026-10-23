/**
 * Who an invoice email can go to, for EmailInvoicesModal (Craig, 2026-10-23:
 * "the customer email doesn't populate or give me any options to add other
 * than typing the full email"). Every invoice email screen uses that modal,
 * so this feeds all of them: Fulfill & Invoice, the Invoicing page, the
 * customer PO page, In-Shop completion, graphics jobs, the customer record.
 *
 * Pure: the modal loads the sources, this ranks and dedupes them.
 */

export type RecipientKind = 'billing' | 'contact' | 'recent';

export interface RecipientSuggestion {
  email: string;
  /** What the chip says beside the address: a person's name, "Billing", "Sent before". */
  label: string;
  kind: RecipientKind;
}

export interface RecipientSources {
  /** Addresses invoices for this customer were sent to and saved (prospects.billing_emails). */
  billingEmails?: (string | null | undefined)[];
  /** The customer profile's AP inbox and billing contact (customers, migration 080). */
  apEmail?: string | null;
  billingContactEmail?: string | null;
  /** The customer's people, as /api/external-contacts returns them. */
  contacts?: { name?: string | null; email?: string | null; title?: string | null; is_primary?: boolean | null }[];
  /** Recipients of this customer's earlier invoice emails, newest first (invoice_emails). */
  recent?: (string | null | undefined)[];
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clean = (e: string | null | undefined): string | null => {
  const v = (e || '').trim().toLowerCase();
  return EMAIL.test(v) ? v : null;
};

/**
 * The To line to start with, and the chips to tap. Prefill is the billing
 * addresses when there are any (where invoices already go), else the primary
 * contact, else whoever last got an invoice — so the box is filled whenever
 * FleetSuite knows anyone. Chips list everyone known, billing first.
 */
export function invoiceRecipients(src: RecipientSources): { prefill: string[]; suggestions: RecipientSuggestion[] } {
  const seen = new Map<string, RecipientSuggestion>();
  const add = (email: string | null, label: string, kind: RecipientKind) => {
    if (!email || seen.has(email)) return;
    seen.set(email, { email, label, kind });
  };

  const billing = [
    ...(src.billingEmails || []).map(clean),
    clean(src.apEmail),
    clean(src.billingContactEmail),
  ].filter((e): e is string => !!e);
  for (const e of billing) add(e, e === clean(src.apEmail) ? 'AP' : 'Billing', 'billing');

  const contacts = [...(src.contacts || [])].sort((a, b) => Number(!!b.is_primary) - Number(!!a.is_primary));
  for (const c of contacts) {
    const e = clean(c.email);
    const name = (c.name || '').trim();
    add(e, [name && name.toLowerCase() !== e ? name : '', c.title?.trim(), c.is_primary ? 'primary' : ''].filter(Boolean).join(' · ') || 'Contact', 'contact');
  }

  const recent = (src.recent || []).map(clean).filter((e): e is string => !!e);
  for (const e of recent) add(e, 'Sent before', 'recent');

  const uniqueBilling = [...new Set(billing)];
  const primary = contacts.find(c => c.is_primary && clean(c.email));
  const prefill = uniqueBilling.length > 0
    ? uniqueBilling
    : primary
      ? [clean(primary.email)!]
      : recent.length > 0
        ? [recent[0]]
        : contacts.length === 1 && clean(contacts[0].email)
          ? [clean(contacts[0].email)!]
          : [];

  return { prefill, suggestions: [...seen.values()] };
}
