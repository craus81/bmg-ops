import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { fetchAllRows } from '@/lib/fetch-all';
import { planTaxExemptSync, type CustomerTaxRow } from '@/lib/customer-tax-exempt';

/**
 * Copies NetSuite's customer Taxable box into FleetSuite (migration 427):
 * netsuite_taxable for every customer, and tax_exempt for a customer
 * NetSuite doesn't tax, by the one-way rule in planTaxExemptSync.
 */

export const NON_TAXABLE_QUERY = `SELECT c.id FROM customer c WHERE c.taxable = 'F'`;
const IN_CHUNK = 200;

export interface TaxExemptSyncResult {
  nonTaxableInNetSuite: number;
  taxableFlagsUpdated: number;
  markedExempt: number;
}

/**
 * Runs from the netsuite-sync cron as its own step. A failed NetSuite read
 * throws before anything is written, so a hiccup never flips a flag.
 */
export async function syncNetsuiteTaxExempt(service: SupabaseClient, at: Date = new Date()): Promise<TaxExemptSyncResult> {
  const rows = await suiteqlQueryAll(NON_TAXABLE_QUERY);
  const nonTaxable = new Set(
    (rows as Array<{ id: unknown }>).map((r) => String(r.id ?? '')).filter((id) => /^\d+$/.test(id)),
  );

  const { data: customers, error } = await fetchAllRows<CustomerTaxRow>((from, to) =>
    service.from('customers')
      .select('netsuite_id, tax_exempt, tax_exempt_source, netsuite_taxable')
      .not('netsuite_id', 'is', null)
      .order('id')
      .range(from, to));
  if (error) throw new Error(error.message);

  const plan = planTaxExemptSync(customers, nonTaxable);
  const result: TaxExemptSyncResult = { nonTaxableInNetSuite: nonTaxable.size, taxableFlagsUpdated: 0, markedExempt: 0 };

  for (const [ids, value] of [[plan.toTaxable, true], [plan.toNonTaxable, false]] as const) {
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const res = await service.from('customers').update({ netsuite_taxable: value }).in('netsuite_id', chunk);
      if (res.error) throw new Error(res.error.message);
      result.taxableFlagsUpdated += chunk.length;
    }
  }

  // Filters repeat the plan's rule, so a staff edit made since the read wins.
  for (let i = 0; i < plan.markExempt.length; i += IN_CHUNK) {
    const chunk = plan.markExempt.slice(i, i + IN_CHUNK);
    const res = await service.from('customers')
      .update({ tax_exempt: true, tax_exempt_source: 'netsuite', tax_exempt_changed_at: at.toISOString() })
      .in('netsuite_id', chunk)
      .eq('tax_exempt', false)
      .or('tax_exempt_source.is.null,tax_exempt_source.neq.staff')
      .select('id');
    if (res.error) throw new Error(res.error.message);
    result.markedExempt += (res.data ?? []).length;
  }
  return result;
}
