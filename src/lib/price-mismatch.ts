/**
 * Prices that don't match (migration 513, owner ask 2026-11-03): FleetSuite
 * and NetSuite must show the same selling price. FleetSuite is where prices
 * change, and each change is sent to NetSuite; this finds the parts where
 * NetSuite still differs (a price someone changed in NetSuite, or one NetSuite
 * refused) and keeps them in part_price_mismatches for Admin → Update Prices.
 *
 * Server-only (reads NetSuite through the parts sync's price reader).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { fetchSalesPrices } from '@/lib/parts-sync';
import { isRealNetsuiteId } from '@/lib/part-netsuite-write';
import { sameMoney } from '@/lib/price-update-import';

export const PRICE_MISMATCH_SYNC = 'price_mismatch_check';

export interface PricedPart {
  id: string;
  netsuite_id: string | null;
  item_number: string;
  is_active: boolean;
  sales_price: number | string | null;
}

export interface Mismatch {
  part_id: string;
  item_number: string;
  fleetsuite_price: number;
  netsuite_price: number | null;
}

/**
 * Parts whose FleetSuite price differs from NetSuite's. Only active parts
 * that are real NetSuite items and have a FleetSuite price count: a part with
 * no FleetSuite price takes NetSuite's on the next sync, so it can't differ
 * for long. NetSuite with no price at all (missing from `netsuitePrices`) is a
 * difference. When several rows share one NetSuite item, the first active row
 * by part number stands for it.
 */
export function findMismatches(parts: PricedPart[], netsuitePrices: Record<string, number>): Mismatch[] {
  const seen = new Set<string>();
  const out: Mismatch[] = [];
  for (const p of [...parts].sort((a, b) => a.item_number.localeCompare(b.item_number) || a.id.localeCompare(b.id))) {
    if (!p.is_active || !isRealNetsuiteId(p.netsuite_id)) continue;
    if (seen.has(p.netsuite_id)) continue;
    seen.add(p.netsuite_id);
    const fs = Number(p.sales_price) || 0;
    if (fs <= 0) continue;
    const ns = p.netsuite_id in netsuitePrices ? netsuitePrices[p.netsuite_id] : null;
    if (ns !== null && sameMoney(fs, ns)) continue;
    out.push({ part_id: p.id, item_number: p.item_number, fleetsuite_price: Math.round(fs * 100) / 100, netsuite_price: ns === null ? null : Math.round(ns * 100) / 100 });
  }
  return out;
}

/**
 * Compare every part with NetSuite and refresh part_price_mismatches: new
 * differences are added (first_seen_at now), ones still there keep their
 * first_seen_at and reason, and ones that now match are removed. Returns what
 * it found and which are new since the last look.
 */
export async function runPriceMismatchCheck(service: SupabaseClient): Promise<{ checked: number; mismatches: number; added: Mismatch[] }> {
  const { data: parts, error } = await fetchAllRows<PricedPart>((from, to) =>
    service.from('netsuite_parts')
      .select('id, netsuite_id, item_number, is_active, sales_price')
      .eq('is_active', true)
      .order('item_number').order('id')
      .range(from, to),
  );
  if (error) throw new Error(`Couldn't read the parts catalog: ${error.message}`);
  const real = parts.filter(p => isRealNetsuiteId(p.netsuite_id));
  const nsIds = [...new Set(real.map(p => p.netsuite_id as string))];
  const prices = await fetchSalesPrices(null, nsIds);
  const found = findMismatches(real, prices);

  const { data: before, error: readErr } = await fetchAllRows<{ part_id: string }>((from, to) =>
    service.from('part_price_mismatches').select('part_id').order('part_id').range(from, to),
  );
  if (readErr) throw new Error(`Couldn't read the last check: ${readErr.message}`);
  const had = new Set(before.map(r => r.part_id));
  const now = new Date().toISOString();

  for (let i = 0; i < found.length; i += 200) {
    const chunk = found.slice(i, i + 200).map(m => ({ ...m, checked_at: now }));
    const { error: upErr } = await service.from('part_price_mismatches').upsert(chunk, { onConflict: 'part_id' });
    if (upErr) throw new Error(`Couldn't save the differences: ${upErr.message}`);
  }
  const foundIds = new Set(found.map(m => m.part_id));
  const gone = [...had].filter(id => !foundIds.has(id));
  for (let i = 0; i < gone.length; i += 200) {
    await service.from('part_price_mismatches').delete().in('part_id', gone.slice(i, i + 200));
  }

  return { checked: nsIds.length, mismatches: found.length, added: found.filter(m => !had.has(m.part_id)) };
}

/** Note a part NetSuite didn't take a price for, so it shows on the list now. Never throws. */
export async function noteRefusedPrice(
  service: SupabaseClient,
  m: { part_id: string; item_number: string; fleetsuite_price: number; netsuite_price?: number | null; reason: string },
): Promise<void> {
  try {
    await service.from('part_price_mismatches').upsert({
      part_id: m.part_id,
      item_number: m.item_number,
      fleetsuite_price: m.fleetsuite_price,
      netsuite_price: m.netsuite_price ?? null,
      reason: m.reason,
      checked_at: new Date().toISOString(),
    }, { onConflict: 'part_id' });
  } catch (e: any) {
    console.error(`[price-mismatch] couldn't note ${m.item_number}: ${e?.message || e}`);
  }
}

/** A part's price now matches: take it off the list. Never throws. */
export async function clearMismatch(service: SupabaseClient, partIds: string[]): Promise<void> {
  if (partIds.length === 0) return;
  try {
    await service.from('part_price_mismatches').delete().in('part_id', partIds);
  } catch (e: any) {
    console.error(`[price-mismatch] couldn't clear: ${e?.message || e}`);
  }
}
