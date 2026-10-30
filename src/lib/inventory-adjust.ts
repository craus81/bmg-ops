import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery, createInventoryAdjustment, resolveDefaultLocationId } from '@/lib/netsuite';

/**
 * Inventory Adjust button (Craig 2026-10-30): an admin corrects a part's
 * stock at O'Fallon and FleetSuite posts a real NetSuite Inventory
 * Adjustment to 52000 Inventory Adjustment. FleetSuite's on-hand numbers
 * are a copy of NetSuite's, so a FleetSuite-only edit would be overwritten
 * by the next inventory sweep; NetSuite stays the system of record and
 * Books picks the adjustment up from the GL copy like any other.
 *
 * Two ways to enter it: add/remove a number, or type what's on the shelf
 * and the difference is worked out against NetSuite's live O'Fallon count
 * (never the copy, which can be 15 minutes old). No alerts (Craig).
 */

export { ADJUST_REASONS, adjustmentChange, adjustmentMemo, type AdjustReason, type AdjustMode } from '@/lib/inventory-adjust-shared';
import { ADJUST_REASONS, adjustmentChange, adjustmentMemo, type AdjustMode } from '@/lib/inventory-adjust-shared';

const num = (v: unknown) => parseFloat(String(v ?? '0')) || 0;
const nsId = (v: unknown) => /^\d+$/.test(String(v ?? '')) ? String(v) : null;

/** NetSuite's live on hand and available for one item at one location. */
export async function liveLocationStock(itemId: string, locationId: string): Promise<{ onHand: number; available: number }> {
  const res = await suiteqlQuery(`
    SELECT quantityonhand, quantityavailable FROM inventoryitemlocations
    WHERE item = ${itemId} AND location = ${locationId}
  `);
  const row = res?.items?.[0];
  return { onHand: num(row?.quantityonhand), available: num(row?.quantityavailable) };
}

/** The O'Fallon location (or NETSUITE_DEFAULT_LOCATION_ID). */
export async function adjustLocationId(): Promise<string> {
  const id = await resolveDefaultLocationId();
  if (!id) throw new Error("Couldn't find the O'Fallon location in NetSuite.");
  return id;
}

/** 52000 Inventory Adjustment's internal id. */
async function adjustAccountId(): Promise<string> {
  const res = await suiteqlQuery(`SELECT id FROM account WHERE acctnumber = '52000'`);
  const id = res?.items?.[0]?.id;
  if (!id) throw new Error("Couldn't find account 52000 Inventory Adjustment in NetSuite.");
  return String(id);
}

/** The location's subsidiary, which a OneWorld account requires on the adjustment. */
async function locationSubsidiaryId(locationId: string): Promise<string | null> {
  if (process.env.NETSUITE_SUBSIDIARY_ID) return process.env.NETSUITE_SUBSIDIARY_ID;
  try {
    const res = await suiteqlQuery(`SELECT subsidiary FROM location WHERE id = ${locationId}`);
    return nsId(res?.items?.[0]?.subsidiary);
  } catch {
    return null; // single-subsidiary accounts don't need it
  }
}

export interface AdjustInput {
  netsuiteId: string;
  mode: AdjustMode;
  qty: number;
  reason: string;
  note?: string | null;
  userId: string;
  userName?: string | null;
}

export type AdjustResult =
  | { ok: true; adjustmentNumber: string | null; change: number; onHandBefore: number; onHand: number; available: number; warning?: string }
  | { ok: false; error: string; status: number };

export async function adjustInventory(service: SupabaseClient, input: AdjustInput): Promise<AdjustResult> {
  const itemId = nsId(input.netsuiteId);
  if (!itemId) return { ok: false, status: 400, error: 'This part has no NetSuite id.' };
  if (!(ADJUST_REASONS as readonly string[]).includes(input.reason)) return { ok: false, status: 400, error: 'Pick a reason.' };
  if (input.mode !== 'delta' && input.mode !== 'count') return { ok: false, status: 400, error: 'Unknown entry type.' };

  const { data: part } = await service
    .from('netsuite_parts')
    .select('id, netsuite_id, item_number, item_type')
    .eq('netsuite_id', itemId)
    .maybeSingle();
  if (!part) return { ok: false, status: 404, error: "That part isn't in FleetSuite's parts list." };
  if (part.item_type && part.item_type !== 'InvtPart') {
    return { ok: false, status: 400, error: `${part.item_number} isn't an inventory item in NetSuite, so it has no stock to adjust.` };
  }

  let locationId: string;
  let before: { onHand: number; available: number };
  try {
    locationId = await adjustLocationId();
    before = await liveLocationStock(itemId, locationId);
  } catch (e: any) {
    return { ok: false, status: 502, error: `Couldn't read the current count from NetSuite: ${e.message}` };
  }

  const calc = adjustmentChange(input.mode, Number(input.qty), before.onHand);
  if ('error' in calc) return { ok: false, status: 400, error: calc.error };

  let accountId: string;
  try {
    accountId = await adjustAccountId();
  } catch (e: any) {
    return { ok: false, status: 502, error: e.message };
  }
  const subsidiaryId = await locationSubsidiaryId(locationId);

  const note = (input.note || '').trim() || null;
  const created = await createInventoryAdjustment({
    itemId,
    locationId,
    accountId,
    subsidiaryId,
    adjustQtyBy: calc.change,
    memo: adjustmentMemo(input.reason, note, input.userName),
  });
  if (!created.success) return { ok: false, status: 502, error: created.error || 'NetSuite refused the adjustment.' };

  // Re-read NetSuite so the part shows its new count now, not at the next sweep.
  let after = { onHand: calc.after, available: before.available + calc.change };
  try {
    after = await liveLocationStock(itemId, locationId);
  } catch { /* the estimate above is close enough until the sweep */ }
  try {
    const res = await suiteqlQuery(`SELECT totalquantityonhand AS qty_on_hand, totalquantityavailable AS qty_available FROM item WHERE id = ${itemId}`);
    const row = res?.items?.[0];
    if (row) {
      await service.from('netsuite_parts')
        .update({ quantity_on_hand: num(row.qty_on_hand), quantity_available: num(row.qty_available), last_synced_at: new Date().toISOString() })
        .eq('netsuite_id', itemId);
    }
  } catch { /* the 15-minute sweep catches it */ }

  let warning: string | undefined;
  const { error: logErr } = await service.from('inventory_adjustments').insert({
    part_id: part.id,
    netsuite_item_id: itemId,
    item_number: part.item_number,
    location_id: locationId,
    mode: input.mode,
    entered_qty: Number(input.qty),
    change: calc.change,
    on_hand_before: before.onHand,
    reason: input.reason,
    note,
    netsuite_adjustment_id: created.adjustmentId || null,
    netsuite_adjustment_number: created.adjustmentNumber || null,
    created_by: input.userId,
    created_by_name: input.userName || null,
  });
  if (logErr) warning = `Posted in NetSuite, but FleetSuite couldn't save it to the history: ${logErr.message}`;

  return {
    ok: true,
    adjustmentNumber: created.adjustmentNumber || null,
    change: calc.change,
    onHandBefore: before.onHand,
    onHand: after.onHand,
    available: after.available,
    ...(warning ? { warning } : {}),
  };
}
