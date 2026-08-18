/**
 * Billable customers — the short list of companies BMG invoices for install
 * work, as picked by field techs and CNI installers when they start a shift.
 * Distinct from the full synced NetSuite `customers` table (every customer
 * ever); this is the handful the scan flow offers as big buttons.
 *
 * Why the tech picks instead of the system inferring: Reading Truck and
 * Masterack graphics get installed in the SAME buildings while the two
 * companies merge, so the work location can no longer imply who's paying —
 * the old locationBillingOverride ("any Masterack location bills Masterack")
 * would silently mis-bill Reading work. An explicit per-shift choice wins
 * over every inferred source.
 *
 * The list lives in the `billable_customers` table (migration 210) so adding
 * a customer is an insert, not a deploy; DEFAULT_BILLABLE_CUSTOMERS doubles
 * as the fallback when the table is empty or unreadable (e.g. offline-cached
 * sessions before the migration runs).
 *
 * `requiresPo` drives the Waiting-for-PO gate: Masterack cuts POs up front,
 * so their scans wait for a PO match (per-part requires_po_match still
 * applies). Reading is invoice-first — BMG sends the invoice and they cut a
 * PO after, except in rare pre-PO'd cases — so Reading scans go straight to
 * Ready, and when a Reading PO does exist the auto-matcher still attaches it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface BillableCustomer {
  /**
   * Canonical NetSuite company name — what gets stamped on scans and what
   * findCustomer/matchCustomer resolve when invoicing. Must match the
   * NetSuite customer record's company name.
   */
  name: string;
  /** Short label for tech-facing buttons ("Reading Truck", "Masterack"). */
  label: string;
  /** false = invoice-first: scans never wait for a PO match. */
  requiresPo: boolean;
  /** Other names the same customer appears under in part tags / old scans. */
  aliases: string[];
}

export const DEFAULT_BILLABLE_CUSTOMERS: BillableCustomer[] = [
  { name: 'Masterack LLC', label: 'Masterack', requiresPo: true, aliases: ['Masterack'] },
  {
    name: 'Reading Equipment and Distribution',
    label: 'Reading Truck',
    requiresPo: false,
    aliases: ['Reading Truck', 'Reading'],
  },
  { name: 'Designs That Stick', label: 'Designs That Stick', requiresPo: true, aliases: [] },
];

// "Masterack, LLC" / "Masterack LLC" / "masterack llc" all compare equal;
// "&" and the word "and" are dropped so "Reading Equipment & Distribution"
// matches the canonical "Reading Equipment and Distribution".
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w && w !== 'and')
    .join(' ');

// Equal after normalization, or one is a leading-words prefix of the other —
// so a part tagged "Masterack" matches the customer "Masterack LLC".
const namesMatch = (a: string, b: string) =>
  a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');

/**
 * Does a free-text customer string (part tag, old scan stamp, PO name) refer
 * to this billable customer?
 */
export function matchesBillableCustomer(
  customer: BillableCustomer,
  raw: string | null | undefined,
): boolean {
  const r = norm(raw || '');
  if (!r) return false;
  return [customer.name, customer.label, ...customer.aliases].some(n => namesMatch(norm(n), r));
}

/** Find the list entry a free-text customer string refers to, if any. */
export function findBillableCustomer(
  list: BillableCustomer[],
  raw: string | null | undefined,
): BillableCustomer | null {
  return list.find(c => matchesBillableCustomer(c, raw)) || null;
}

/**
 * Does a scan for this customer need a PO before it's Ready to Export?
 * Unknown or unstamped customers keep the pre-existing behavior (PO
 * required, subject to the part-level requires_po_match flag) — only an
 * explicit invoice-first customer waives the gate.
 */
export function customerRequiresPo(
  raw: string | null | undefined,
  list: BillableCustomer[],
): boolean {
  return findBillableCustomer(list, raw)?.requiresPo ?? true;
}

/**
 * Load the list from billable_customers, falling back to the defaults when
 * the table is missing, empty, or unreadable. Works with both browser and
 * service-role clients.
 */
export async function loadBillableCustomers(
  supabase: SupabaseClient,
): Promise<BillableCustomer[]> {
  try {
    const { data, error } = await supabase
      .from('billable_customers')
      .select('name, display_label, requires_po, aliases')
      .eq('active', true)
      .order('sort_order')
      .order('name');
    if (error || !data || data.length === 0) return DEFAULT_BILLABLE_CUSTOMERS;
    return data.map((r: any) => ({
      name: r.name as string,
      label: (r.display_label as string) || (r.name as string),
      requiresPo: r.requires_po !== false,
      aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
    }));
  } catch {
    return DEFAULT_BILLABLE_CUSTOMERS;
  }
}
