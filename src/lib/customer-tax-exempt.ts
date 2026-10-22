/**
 * A customer's permanent tax exemption (customers.tax_exempt, migrations 184
 * and 427). Estimates, Graphics Builder and FleetSuite's own invoices all
 * leave tax off for an exempt customer; this file keeps the flag in step
 * with NetSuite (the sync, server only, is customer-tax-exempt-sync.ts)
 * and says what the customer page and the Settings list warn about.
 *
 * Owner, 2026-10-22: copy NetSuite's "Taxable off" into FleetSuite, and an
 * expired certificate only warns (a reseller stays exempt).
 */

export type TaxExemptSource = 'netsuite' | 'staff';

export interface CustomerTaxRow {
  netsuite_id: string | null;
  tax_exempt: boolean | null;
  tax_exempt_source: string | null;
  netsuite_taxable: boolean | null;
}

export interface TaxExemptPlan {
  /** NetSuite has Taxable on: netsuite_taxable becomes true. */
  toTaxable: string[];
  /** NetSuite has Taxable off: netsuite_taxable becomes false. */
  toNonTaxable: string[];
  /** Not exempt in FleetSuite, never set by staff, and NetSuite has Taxable off. */
  markExempt: string[];
}

/**
 * What the sync changes, from FleetSuite's customers and the NetSuite ids
 * with Taxable off. One way only: the sync never takes an exemption away,
 * and never touches a customer staff set either way.
 */
export function planTaxExemptSync(customers: CustomerTaxRow[], nonTaxableIds: Set<string>): TaxExemptPlan {
  const plan: TaxExemptPlan = { toTaxable: [], toNonTaxable: [], markExempt: [] };
  for (const c of customers) {
    const id = c.netsuite_id ? String(c.netsuite_id) : '';
    if (!/^\d+$/.test(id)) continue;
    const taxable = !nonTaxableIds.has(id);
    if (c.netsuite_taxable !== taxable) (taxable ? plan.toTaxable : plan.toNonTaxable).push(id);
    if (!taxable && !c.tax_exempt && c.tax_exempt_source !== 'staff') plan.markExempt.push(id);
  }
  return plan;
}

export interface CertWarning {
  level: 'expired' | 'soon';
  text: string;
}

const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
};

/**
 * The warning for an exempt customer's certificate expiry, or null. Only a
 * warning: the customer stays exempt (owner, 2026-10-22). `today` is a
 * YYYY-MM-DD date.
 */
export function certWarning(expiresAt: string | null | undefined, today: string): CertWarning | null {
  if (!expiresAt || !/^\d{4}-\d{2}-\d{2}/.test(expiresAt)) return null;
  const exp = expiresAt.slice(0, 10);
  if (exp < today) {
    return { level: 'expired', text: `Certificate expired ${shortDate(exp)}. Still tax exempt; get a new certificate on file.` };
  }
  const days = Math.round((Date.parse(`${exp}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days <= 60) return { level: 'soon', text: `Certificate expires ${shortDate(exp)} (${days} day${days === 1 ? '' : 's'}).` };
  return null;
}

export type TaxMismatch = 'netsuite_taxes' | 'netsuite_exempt' | null;

/** Where FleetSuite and NetSuite disagree about taxing the customer. */
export function taxMismatch(c: Pick<CustomerTaxRow, 'tax_exempt' | 'netsuite_taxable'>): TaxMismatch {
  if (c.netsuite_taxable === null || c.netsuite_taxable === undefined) return null;
  if (c.tax_exempt && c.netsuite_taxable) return 'netsuite_taxes';
  if (!c.tax_exempt && !c.netsuite_taxable) return 'netsuite_exempt';
  return null;
}

export const MISMATCH_TEXT: Record<Exclude<TaxMismatch, null>, string> = {
  netsuite_taxes: 'NetSuite still has Taxable on for this customer, so its invoices will charge tax. Untick Taxable on the customer in NetSuite.',
  netsuite_exempt: 'NetSuite has Taxable off for this customer, but FleetSuite charges tax (someone set it to taxed here).',
};

/** The fields a staff edit of the exemption writes. */
export function staffTaxExemptPatch(taxExempt: boolean, at: Date = new Date()) {
  return { tax_exempt: taxExempt, tax_exempt_source: 'staff' as const, tax_exempt_changed_at: at.toISOString() };
}
