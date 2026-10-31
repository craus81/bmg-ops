import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The changes FleetSuite made to a customer's or a vendor's details in NetSuite (migration 473, detail_changes: Customer
 * Terms and Vendor Details, src/lib/customer-terms.ts and src/lib/vendor-details.ts), as both screens list them under
 * Changed before.
 */

export type DetailRecordType = 'customer' | 'vendor';

export interface DetailChange {
  id: string;
  at: string;
  /** Who made it, when FleetSuite knows their name. */
  by: string | null;
  reason: string;
  changes: string[];
  status: 'sending' | 'changed' | 'refused' | 'unsure';
  error: string | null;
}

interface ChangeRow {
  id: string;
  reason: string;
  changes: unknown;
  status: DetailChange['status'];
  error: string | null;
  created_by: string | null;
  created_at: string;
}

/** The record's twenty latest changes, newest first. */
export async function readDetailChanges(service: SupabaseClient, recordType: DetailRecordType, netsuiteId: string): Promise<DetailChange[]> {
  const { data, error } = await service.from('detail_changes')
    .select('id, reason, changes, status, error, created_by, created_at')
    .eq('record_type', recordType)
    .eq('netsuite_id', netsuiteId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ChangeRow[];
  const people = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (people.length > 0) {
    const { data: found } = await service.from('profiles').select('id, full_name').in('id', people);
    for (const p of (found ?? []) as Array<{ id: string; full_name: string | null }>) if (p.full_name) names.set(p.id, p.full_name);
  }
  return rows.map((r) => ({
    id: r.id,
    at: r.created_at,
    by: r.created_by ? names.get(r.created_by) ?? null : null,
    reason: r.reason,
    changes: Array.isArray(r.changes) ? r.changes.map(String) : [],
    status: r.status,
    error: r.error,
  }));
}
