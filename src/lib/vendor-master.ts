import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery } from './netsuite';

/**
 * Vendor master (R6-7). Vendor names live as free text on
 * purchase_requests and the PO mirror, so "Grimco", "GRIMCO" and
 * "Grimco Inc" are three different vendors to every report that groups by
 * them. Mirroring NetSuite's vendor list nightly gives the app real ids,
 * terms and contacts — and one canonical spelling to resolve against.
 *
 * Deliberately additive: rows are upserted on netsuite_id and inactive
 * vendors are FLAGGED rather than deleted, because a PO from two years ago
 * still needs its vendor to have a name.
 */

export interface VendorMasterRow {
  netsuite_id: string;
  entity_id: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  terms: string | null;
  is_inactive: boolean;
}

/** Normalized key for matching a free-text vendor name to the master. */
export const vendorKey = (name: string | null | undefined) =>
  String(name || '').trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');

export async function syncVendors(service: SupabaseClient): Promise<{
  fetched: number; upserted: number; error?: string;
}> {
  let rows: any[] = [];
  try {
    // terms is a joined lookup; LEFT JOIN so a vendor with no terms still
    // arrives rather than vanishing from the master.
    const q = `
      SELECT v.id, v.entityid, v.companyname, v.email, v.phone, v.isinactive, t.name AS termsname
      FROM vendor v
      LEFT JOIN term t ON t.id = v.terms
      ORDER BY COALESCE(v.companyname, v.entityid)
      FETCH FIRST 5000 ROWS ONLY`;
    const result = await suiteqlQuery(q);
    rows = result?.items || [];
  } catch (e: any) {
    // The integration role may lack the term join; fall back to the plain
    // vendor list rather than losing the whole sync over one column.
    try {
      const result = await suiteqlQuery(
        `SELECT id, entityid, companyname, email, phone, isinactive FROM vendor ORDER BY COALESCE(companyname, entityid) FETCH FIRST 5000 ROWS ONLY`,
      );
      rows = result?.items || [];
    } catch (inner: any) {
      return { fetched: 0, upserted: 0, error: String(inner?.message || e?.message || 'vendor sync failed').slice(0, 200) };
    }
  }

  const mapped: VendorMasterRow[] = rows.map((v: any) => ({
    netsuite_id: String(v.id),
    entity_id: v.entityid ? String(v.entityid) : null,
    company_name: v.companyname ? String(v.companyname) : (v.entityid ? String(v.entityid) : null),
    email: v.email ? String(v.email) : null,
    phone: v.phone ? String(v.phone) : null,
    terms: v.termsname ? String(v.termsname) : null,
    is_inactive: String(v.isinactive || 'F').toUpperCase() === 'T',
  }));
  if (mapped.length === 0) return { fetched: 0, upserted: 0 };

  let upserted = 0;
  for (let i = 0; i < mapped.length; i += 500) {
    const chunk = mapped.slice(i, i + 500).map(r => ({ ...r, synced_at: new Date().toISOString() }));
    const { error } = await service.from('netsuite_vendors').upsert(chunk, { onConflict: 'netsuite_id' });
    if (error) return { fetched: mapped.length, upserted, error: error.message };
    upserted += chunk.length;
  }
  return { fetched: mapped.length, upserted };
}

/** Resolve a free-text vendor name to its master row, if one matches. */
export function matchVendor<T extends { company_name: string | null; entity_id: string | null }>(
  name: string | null | undefined,
  master: T[],
): T | null {
  const key = vendorKey(name);
  if (!key) return null;
  const exact = master.filter(v => vendorKey(v.company_name) === key || vendorKey(v.entity_id) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = master.filter(v => {
    const c = vendorKey(v.company_name);
    return c && (c.startsWith(key) || key.startsWith(c));
  });
  return partial.length === 1 ? partial[0] : null;
}
