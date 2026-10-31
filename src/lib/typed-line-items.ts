/**
 * The catalog side of the typed-lines screens, New invoice (/api/invoices/new)
 * and New sales order (/api/sales-orders/new): finding an item for a line and
 * reading back the items a form sent, as the catalog has them. Any active
 * NetSuite item can be a line except layout lines and groups.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { partNumberRegex } from '@/lib/loose-search';
import { NOT_BILLABLE_TYPES, type NewInvoiceItem } from '@/lib/new-invoice';

const ITEM_COLUMNS = 'netsuite_id, item_number, display_name, description, sales_price, item_type, taxable_override';

type PartRow = {
  netsuite_id: string | number; item_number: string | null; display_name: string | null; description: string | null;
  sales_price: number | null; item_type: string | null; taxable_override: boolean | null;
};

const toItem = (p: PartRow): NewInvoiceItem => ({
  itemId: String(p.netsuite_id),
  itemNumber: p.item_number || '',
  description: p.description || p.display_name || '',
  itemType: p.item_type ?? null,
  price: p.sales_price != null ? Number(p.sales_price) : null,
  taxableOverride: p.taxable_override ?? null,
});

/** Up to 25 items matching what was typed (part number, name or description); none under 2 characters. */
export async function searchTypedItems(service: SupabaseClient, typed: string): Promise<{ items: NewInvoiceItem[]; error?: string }> {
  const q = typed.trim().replace(/[%,()]/g, ' ').slice(0, 60);
  if (q.length < 2) return { items: [] };
  const like = `%${q}%`;
  // Part numbers also match with their dashes ignored ("ar2000" → AR-2000).
  const re = partNumberRegex(q);
  const { data, error } = await service
    .from('netsuite_parts')
    .select(ITEM_COLUMNS)
    .eq('is_active', true)
    .not('netsuite_id', 'is', null)
    .or(`item_number.ilike.${like},display_name.ilike.${like},description.ilike.${like}${re ? `,item_number.imatch."${re}"` : ''}`)
    .order('item_number')
    .limit(30);
  if (error) return { items: [], error: error.message };
  const items = ((data || []) as PartRow[]).filter(p => !NOT_BILLABLE_TYPES.has(String(p.item_type || ''))).map(toItem);
  return { items: items.slice(0, 25) };
}

/** The items a form's lines name, by NetSuite id, and the ids the catalog doesn't have. */
export async function loadTypedItems(
  service: SupabaseClient, ids: string[],
): Promise<{ byId: Map<string, NewInvoiceItem>; missing: string[]; error?: string }> {
  const unique = [...new Set(ids)];
  const { data, error } = await service.from('netsuite_parts').select(ITEM_COLUMNS).in('netsuite_id', unique);
  if (error) return { byId: new Map(), missing: [], error: error.message };
  const byId = new Map(((data || []) as PartRow[]).map(p => [String(p.netsuite_id), toItem(p)]));
  return { byId, missing: unique.filter(id => !byId.has(id)) };
}
