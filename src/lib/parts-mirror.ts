import type { SupabaseClient } from '@supabase/supabase-js';
import { findItems } from './netsuite';

export interface MirroredPart {
  id: string;
  item_number: string;
  display_name: string | null;
  billable_customer: string | null;
  vehicle_type: string | null;
  graphic_package: string | null;
  requires_po_match: boolean | null;
  is_active: boolean | null;
}

const PART_COLS = 'id, item_number, display_name, billable_customer, vehicle_type, graphic_package, requires_po_match, is_active';

/**
 * Find a part in the local netsuite_parts mirror; when it's missing (or
 * sitting deactivated) but the item EXISTS in NetSuite, mirror it in as a
 * live synced row. This is what stops a NetSuite-known part from being
 * flagged "not in catalog" on every single upload — once mirrored, every
 * search finds it. The next full parts sync re-derives catalog metadata.
 */
export async function findOrMirrorPart(
  service: SupabaseClient,
  partNumber: string,
): Promise<{ part: MirroredPart | null; mirrored: boolean; error?: string }> {
  const pn = partNumber.trim();
  if (!pn) return { part: null, mirrored: false };

  const escaped = pn.replace(/[\\%_]/g, ch => `\\${ch}`);
  const { data: local } = await service
    .from('netsuite_parts')
    .select(PART_COLS)
    .ilike('item_number', escaped)
    .limit(2);
  const exact = ((local || []) as MirroredPart[]).find(c => c.item_number.toUpperCase() === pn.toUpperCase());
  if (exact && exact.is_active !== false) return { part: exact, mirrored: false };

  // Missing locally (or stale-deactivated) — ask NetSuite itself.
  // findItems only returns active NetSuite items.
  try {
    const items = await findItems([pn]);
    const item = items[pn.toUpperCase()];
    if (!item) {
      // Not in NetSuite either; return the inactive local row if there was one.
      return { part: exact || null, mirrored: false };
    }

    if (exact) {
      // Local row exists but was deactivated by a stale sync — revive it.
      const { data: revived, error } = await service
        .from('netsuite_parts')
        .update({
          netsuite_id: String(item.id),
          is_active: true,
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', exact.id)
        .select(PART_COLS)
        .single();
      if (error || !revived) return { part: exact, mirrored: false, error: error?.message };
      return { part: revived as MirroredPart, mirrored: true };
    }

    const { data: upserted, error } = await service
      .from('netsuite_parts')
      .upsert({
        netsuite_id: String(item.id),
        item_number: item.name || pn,
        display_name: item.displayName || null,
        description: item.description || null,
        item_type: item.type || null,
        source: 'netsuite',
        is_active: true,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'netsuite_id' })
      .select(PART_COLS)
      .single();
    if (error || !upserted) return { part: null, mirrored: false, error: error?.message };
    return { part: upserted as MirroredPart, mirrored: true };
  } catch (e: any) {
    return { part: exact || null, mirrored: false, error: e?.message };
  }
}
