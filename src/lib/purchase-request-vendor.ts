import type { SupabaseClient } from '@supabase/supabase-js';
import { matchVendor, vendorKey } from './vendor-master';

/**
 * A purchase request's vendor is typed as a name (the part's Vendor field,
 * the queue's Vendor button), but Create PO needs NetSuite's vendor id. This
 * resolves typed names against the nightly NetSuite vendor mirror
 * (netsuite_vendors) so the Purchasing group already knows its PO vendor
 * instead of asking for it again. A name with no single clear match stays
 * unresolved — guessing would put a PO on the wrong vendor.
 */

export interface VendorRef { id: string; name: string }

type MasterRow = { netsuite_id: string; company_name: string | null; entity_id: string | null };

/** Every active vendor in the mirror (paged: PostgREST caps a read at 1000). */
export async function loadVendorMaster(supabase: SupabaseClient): Promise<MasterRow[]> {
  const out: MasterRow[] = [];
  for (let from = 0; from < 10000; from += 1000) {
    const { data, error } = await supabase
      .from('netsuite_vendors')
      .select('netsuite_id, company_name, entity_id')
      .eq('is_inactive', false)
      .order('netsuite_id')
      .range(from, from + 999);
    if (error || !data) break;
    out.push(...(data as MasterRow[]));
    if (data.length < 1000) break;
  }
  return out;
}

/** Typed name → NetSuite vendor, from an already-loaded master. */
export function resolveVendorName(name: string | null | undefined, master: MasterRow[]): VendorRef | null {
  const hit = matchVendor(name, master);
  if (!hit) return null;
  return { id: hit.netsuite_id, name: hit.company_name || hit.entity_id || String(name || '').trim() };
}

/** Resolve many names in one master read; keyed by vendorKey(name). */
export async function resolveVendorNames(
  supabase: SupabaseClient,
  names: (string | null | undefined)[],
): Promise<Map<string, VendorRef>> {
  const out = new Map<string, VendorRef>();
  const wanted = [...new Set(names.map(vendorKey).filter(Boolean))];
  if (wanted.length === 0) return out;
  const master = await loadVendorMaster(supabase);
  if (master.length === 0) return out;
  for (const key of wanted) {
    const hit = resolveVendorName(key, master);
    if (hit) out.set(key, hit);
  }
  return out;
}

export { vendorKey };
