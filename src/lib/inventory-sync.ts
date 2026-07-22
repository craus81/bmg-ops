import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';

/**
 * Keep netsuite_parts inventory quantities fresh. The full parts sync is a
 * manual admin action and item quantities move without touching an item's
 * lastmodifieddate, so this light sweep (quantities only, changed rows
 * only) runs inside the 2-hour netsuite-sync cron. "Available" = on hand
 * minus committed — the honest number for "can we schedule this vehicle".
 */
export interface InventorySyncResult {
  items: number;
  updated: number;
  hasAvailable: boolean;
  /** Outcome of the sync_state heartbeat write — not persisted, only reported. */
  syncStateWrite?: HeartbeatResult;
}

export async function syncInventoryQuantities(service: SupabaseClient): Promise<InventorySyncResult> {
  // totalquantityavailable isn't queryable on every account version — fall
  // back to on-hand only rather than failing the sweep.
  let rows: any[];
  let hasAvailable = true;
  try {
    rows = await suiteqlQueryAll(`
      SELECT i.id, i.totalquantityonhand AS qty_on_hand, i.totalquantityavailable AS qty_available
      FROM item i
      WHERE i.itemtype = 'InvtPart' AND i.isinactive = 'F'
    `);
  } catch {
    hasAvailable = false;
    rows = await suiteqlQueryAll(`
      SELECT i.id, i.totalquantityonhand AS qty_on_hand
      FROM item i
      WHERE i.itemtype = 'InvtPart' AND i.isinactive = 'F'
    `);
  }

  const { data: existing } = await service
    .from('netsuite_parts')
    .select('netsuite_id, quantity_on_hand, quantity_available');
  const byId = new Map((existing || []).map(p => [String(p.netsuite_id), p]));

  let updated = 0;
  for (const row of rows) {
    const nsId = String(row.id ?? '');
    const part = byId.get(nsId);
    if (!part) continue; // new items land via the full parts sync
    const onHand = parseFloat(row.qty_on_hand || '0') || 0;
    const available = hasAvailable ? (parseFloat(row.qty_available || '0') || 0) : onHand;
    if (Number(part.quantity_on_hand) === onHand && Number(part.quantity_available) === available) continue;
    await service
      .from('netsuite_parts')
      .update({ quantity_on_hand: onHand, quantity_available: available, last_synced_at: new Date().toISOString() })
      .eq('netsuite_id', nsId);
    updated++;
  }

  const result = { items: rows.length, updated, hasAvailable };
  return { ...result, syncStateWrite: await recordHeartbeat(service, 'netsuite_inventory', result) };
}
