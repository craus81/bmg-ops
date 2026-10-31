/**
 * A customer's terms and credit limit changed in FleetSuite and sent on to
 * NetSuite (Books part 41, migration 473, docs/books.md "Customer and vendor
 * details changed in FleetSuite"; owner decisions 2026-10-31, thread
 * "Replacing NetSuite with FleetSuite": from January 1, 2027 the team works
 * only in FleetSuite, apart from payments, deposits and banking).
 *
 * From More → Sales → Customer Terms, or Change beside the terms on a
 * customer's page: its terms, from NetSuite's list of them (the copy,
 * gl_netsuite_lists), what its new invoices default to and FleetSuite's own
 * invoices are due by; and its credit limit, or none. Its name, email,
 * phone and address are changed on its page already (updateCustomer).
 *
 * Pure, so the page and the route agree on what changes and what NetSuite is
 * sent.
 */

import { centsOf, formatCents } from '@/lib/credit-memo';
import type { TermsOption } from '@/lib/vendor-details';

export { formatCents };
export type { TermsOption };

export const REASON_MAX = 300;
/** A credit limit this much at most. */
export const MAX_CREDIT_LIMIT = 100_000_000;

export interface TermsCustomer {
  id: string;
  name: string;
  entityId: string;
  inactive: boolean;
  termsId: string | null;
  termsName: string | null;
  /** Null when it has none. */
  creditLimitCents: number | null;
  /** What it owes now, when NetSuite says. */
  balanceCents: number | null;
}

/** What the page sends: only what was changed. */
export interface CustomerTermsEdit {
  reason: string;
  termsId?: string;
  /** Dollars; null takes the limit off. */
  creditLimit?: number | null;
}

export interface CustomerTermsPlan {
  /** What NetSuite is sent. */
  body: Record<string, unknown>;
  changes: string[];
  problems: string[];
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v).trim());
const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? centsOf(n) : null;
};

/** The customer's record as NetSuite's REST GET gives it. */
export function parseTermsCustomer(record: any): TermsCustomer {
  const r = record ?? {};
  const person = [text(r.firstName), text(r.lastName)].filter(Boolean).join(' ');
  const termsId = /^\d+$/.test(String(r.terms?.id ?? '')) ? String(r.terms.id) : null;
  return {
    id: text(r.id),
    name: text(r.companyName) || person || text(r.entityId) || `Customer ${text(r.id)}`,
    entityId: text(r.entityId),
    inactive: r.isInactive === true || r.isInactive === 'T',
    termsId,
    termsName: termsId && r.terms.refName ? String(r.terms.refName) : null,
    creditLimitCents: money(r.creditLimit),
    balanceCents: money(r.balance),
  };
}

/** What a change of the customer is worked out from, in a line: anything different means it changed in NetSuite. */
export function customerFacts(c: TermsCustomer): string {
  return JSON.stringify([c.id, c.name, c.termsId, c.creditLimitCents]);
}

const places = (n: number, p: number) => Math.abs(n * 10 ** p - Math.round(n * 10 ** p)) < 1e-6;
const limitText = (cents: number | null) => (cents === null ? 'no limit' : formatCents(cents));

/** Works out what changes and what NetSuite is sent, or what's in the way. */
export function planCustomerTerms(
  customer: TermsCustomer,
  edit: CustomerTermsEdit,
  facts: { terms: ReadonlyMap<string, TermsOption> },
): CustomerTermsPlan {
  const body: Record<string, unknown> = {};
  const changes: string[] = [];
  const problems: string[] = [];

  if (edit.termsId !== undefined && edit.termsId !== (customer.termsId ?? '')) {
    const terms = facts.terms.get(edit.termsId);
    if (!edit.termsId) problems.push("Terms can't be taken off here: pick the terms it should have.");
    else if (!terms) problems.push("Pick terms from NetSuite's list of them.");
    else {
      body.terms = { id: terms.id };
      const was = customer.termsId ? customer.termsName || facts.terms.get(customer.termsId)?.name || `Terms ${customer.termsId}` : '(none)';
      changes.push(`Terms ${was} → ${terms.name}`);
    }
  }

  if (edit.creditLimit !== undefined) {
    const v = edit.creditLimit;
    if (v === null) {
      if (customer.creditLimitCents !== null) {
        body.creditLimit = null;
        changes.push(`Credit limit ${limitText(customer.creditLimitCents)} → no limit`);
      }
    } else if (!Number.isFinite(v)) problems.push('Enter the credit limit, or leave it blank for no limit.');
    else if (v < 0) problems.push("A credit limit can't be less than $0.");
    else if (v > MAX_CREDIT_LIMIT) problems.push(`A credit limit can be ${formatCents(MAX_CREDIT_LIMIT * 100)} at most.`);
    else if (!places(v, 2)) problems.push('The credit limit goes to the cent.');
    else if (centsOf(v) !== customer.creditLimitCents) {
      body.creditLimit = centsOf(v) / 100;
      changes.push(`Credit limit ${limitText(customer.creditLimitCents)} → ${limitText(centsOf(v))}`);
    }
  }

  const reason = edit.reason.trim();
  if (!reason) problems.push("Say why it's being changed.");
  else if (reason.length > REASON_MAX) problems.push(`Why it's being changed takes ${REASON_MAX} characters at most.`);
  if (changes.length === 0 && problems.length === 0) problems.push('Nothing has changed yet.');

  return { body, changes, problems };
}
