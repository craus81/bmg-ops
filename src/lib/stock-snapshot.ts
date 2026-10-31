import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';

/**
 * On hand / available / on order for a handful of parts, read from the
 * mirrors (netsuite_parts, refreshed by the inventory sweep; open vendor PO
 * lines). Shown wherever someone asks for parts to be ordered, so they can
 * see what's on the shelf and already coming before they ask (Craig,
 * 2026-10-30). Server-only: callers pass a service-role client.
 */
export interface StockSnapshot {
  /** NetSuite on hand: what's on the shelf. */
  on_hand: number;
  /** NetSuite available: on hand less what other orders have committed. */
  available: number;
  /** Still to receive on open, non-drop-ship vendor POs. */
  on_order: number;
}

export async function loadStockSnapshot(
  service: SupabaseClient,
  itemNumbers: string[],
): Promise<Map<string, StockSnapshot>> {
  const out = new Map<string, StockSnapshot>();
  const names = [...new Set(itemNumbers.filter(Boolean))];
  if (names.length === 0) return out;

  for (let i = 0; i < names.length; i += 200) {
    const { data } = await service
      .from('netsuite_parts')
      .select('item_number, quantity_on_hand, quantity_available')
      .in('item_number', names.slice(i, i + 200));
    for (const p of (data || []) as any[]) {
      const onHand = Math.max(0, Number(p.quantity_on_hand) || 0);
      const avail = p.quantity_available != null ? Math.max(0, Number(p.quantity_available) || 0) : onHand;
      out.set(normalizeItemNumber(p.item_number), { on_hand: onHand, available: avail, on_order: 0 });
    }
  }

  for (let i = 0; i < names.length; i += 200) {
    const { data: lines } = await fetchAllRows<any>((from, to) => service
      .from('netsuite_vendor_po_lines')
      .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(status)')
      .eq('netsuite_vendor_pos.drop_ship', false) // drop ship POs never come in (migration 429)
      .in('item_number', names.slice(i, i + 200))
      .order('id')
      .range(from, to));
    for (const l of lines || []) {
      if (!isOpenPoStatus(l.netsuite_vendor_pos?.status)) continue;
      const remaining = Math.max(0, (Number(l.quantity) || 0) - (Number(l.quantity_received) || 0));
      if (remaining <= 0) continue;
      const key = normalizeItemNumber(l.item_number);
      const row = out.get(key) || { on_hand: 0, available: 0, on_order: 0 };
      row.on_order += remaining;
      out.set(key, row);
    }
  }
  return out;
}

/** When the inventory sweep last ran (sync_state), so the screen can say how
 *  old the counts are. netsuite_parts.last_synced_at only moves when a
 *  quantity changes, so it can't answer that. */
export async function loadInventorySyncedAt(service: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await service
      .from('sync_state')
      .select('last_synced_at')
      .eq('sync_type', 'netsuite_inventory')
      .maybeSingle();
    return (data as any)?.last_synced_at || null;
  } catch {
    return null;
  }
}
