import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';
import type { GenericPoLine, GenericRequest } from '@/lib/generic-lines';

/**
 * Which of these items are ticked "Generic part" on the Parts page
 * (netsuite_parts.is_generic). Normalized keys in, normalized keys out.
 * Batched at 200 like every other catalog `.in()` read.
 */
export async function loadGenericItems(service: SupabaseClient, itemNumbers: Iterable<string>): Promise<Set<string>> {
  const names = [...new Set([...itemNumbers].filter(Boolean))];
  const out = new Set<string>();
  for (let i = 0; i < names.length; i += 200) {
    const { data, error } = await service
      .from('netsuite_parts')
      .select('item_number')
      .eq('is_generic', true)
      .in('item_number', names.slice(i, i + 200));
    if (error) throw new Error(`Generic parts lookup failed: ${error.message}`);
    for (const r of data || []) out.add(normalizeItemNumber(r.item_number));
  }
  return out;
}

/**
 * The requests and PO lines a set of generic items' state is read from:
 * every non-cancelled request for those items raised from this estimate or
 * its job, and the lines of the POs they were ordered on.
 */
export async function loadGenericRequests(
  service: SupabaseClient,
  scope: { estimateId?: string | null; projectId?: string | null },
  itemNames: string[],
): Promise<{ requests: GenericRequest[]; poLines: GenericPoLine[] }> {
  const ors = [
    scope.estimateId ? `source_estimate_id.eq.${scope.estimateId}` : null,
    scope.projectId ? `source_project_id.eq.${scope.projectId}` : null,
  ].filter(Boolean);
  if (ors.length === 0 || itemNames.length === 0) return { requests: [], poLines: [] };
  const { data: reqs, error } = await service
    .from('purchase_requests')
    .select('id, item_number, description, quantity, status, received_at, ordered_po_id')
    .neq('status', 'cancelled')
    .or(ors.join(','))
    .in('item_number', itemNames);
  if (error) throw new Error(`Purchase requests lookup failed: ${error.message}`);
  const requests = ((reqs || []) as any[]).map(r => ({ ...r, item_number: normalizeItemNumber(r.item_number) })) as GenericRequest[];
  const poIds = [...new Set(requests.map(r => r.ordered_po_id).filter((v): v is string => !!v))];
  if (poIds.length === 0) return { requests, poLines: [] };
  const { data: lines } = await service
    .from('netsuite_vendor_po_lines')
    .select('po_id, item_number, description, quantity_received')
    .in('po_id', poIds);
  const poLines = ((lines || []) as any[]).map(l => ({ ...l, item_number: normalizeItemNumber(l.item_number) })) as GenericPoLine[];
  return { requests, poLines };
}
