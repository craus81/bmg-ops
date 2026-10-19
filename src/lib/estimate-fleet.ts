import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Fleet orders (migration 410): one estimate per vehicle, same build, tied
 * together by estimates.fleet_group_id.
 */

export interface FleetMember {
  id: string;
  estimate_number: string;
  unit_number: string | null;
  vin: string | null;
  status: string | null;
  customer_approved: boolean | null;
  netsuite_so_id: string | null;
  netsuite_so_number: string | null;
  grand_total: number | null;
}

const MEMBER_COLUMNS = 'id, estimate_number, unit_number, vin, status, customer_approved, netsuite_so_id, netsuite_so_number, grand_total, supersedes_estimate_id, created_at';

/** Natural order on unit numbers, so 9 sorts before 10. */
export function compareUnits(a: string | null, b: string | null): number {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

/** Unit numbers compare without case or surrounding spaces. */
export function unitKey(u: string | null | undefined): string {
  return String(u || '').trim().toLowerCase();
}

/**
 * The estimates of a fleet group, one per vehicle. A revision stays in its
 * vehicle's group (src/lib/estimate-copy.ts), so the estimate it replaced
 * is left out: the group shows each vehicle's current estimate only.
 */
export async function fleetMembers(supabase: SupabaseClient, groupId: string): Promise<FleetMember[]> {
  const { data } = await supabase
    .from('estimates')
    .select(MEMBER_COLUMNS)
    .eq('fleet_group_id', groupId)
    .order('created_at')
    .order('id');
  return currentMembers((data || []) as any[]);
}

export function currentMembers(rows: Array<FleetMember & { supersedes_estimate_id?: string | null }>): FleetMember[] {
  const replaced = new Set(rows.map(r => r.supersedes_estimate_id).filter(Boolean));
  return rows
    .filter(r => !replaced.has(r.id))
    .map(({ supersedes_estimate_id: _s, created_at: _c, ...m }: any) => m as FleetMember)
    .sort((a, b) => compareUnits(a.unit_number, b.unit_number));
}

/**
 * Graphics Builder worksheets this estimate shares with its fleet group.
 * A worksheet is pinned to the one estimate it was built on
 * (wrap_quotes.estimate_id); the group's other estimates carry its lines
 * (wrap_quote_id) but not the pin. Their customer documents need the same
 * coverage picture and film list, so the loaders add these ids to the
 * pinned ones. Empty for an estimate in no group.
 */
export async function fleetWorksheetIds(supabase: SupabaseClient, estimateId: string): Promise<string[]> {
  const { data: est } = await supabase.from('estimates').select('fleet_group_id').eq('id', estimateId).maybeSingle();
  if (!est?.fleet_group_id) return [];
  const { data: lines } = await supabase
    .from('estimate_line_items')
    .select('wrap_quote_id')
    .eq('estimate_id', estimateId)
    .not('wrap_quote_id', 'is', null);
  const ids = [...new Set((lines || []).map(l => l.wrap_quote_id as string))];
  if (ids.length === 0) return [];
  const { data: quotes } = await supabase.from('wrap_quotes').select('id, estimate_id').in('id', ids);
  const pinnedTo = [...new Set((quotes || []).map(q => q.estimate_id).filter(Boolean))] as string[];
  if (pinnedTo.length === 0) return [];
  const { data: sameGroup } = await supabase
    .from('estimates')
    .select('id')
    .in('id', pinnedTo)
    .eq('fleet_group_id', est.fleet_group_id);
  const groupIds = new Set((sameGroup || []).map(e => e.id));
  return (quotes || []).filter(q => q.estimate_id !== estimateId && groupIds.has(q.estimate_id)).map(q => q.id);
}

/** PostgREST filter: worksheets pinned to the estimate, plus shared ones. */
export function worksheetFilter(estimateId: string, sharedIds: string[]): string {
  return sharedIds.length > 0
    ? `estimate_id.eq.${estimateId},id.in.(${sharedIds.join(',')})`
    : `estimate_id.eq.${estimateId}`;
}
