/**
 * Writing a catalog part's fields back to NetSuite (item RESTlet) — the rules
 * shared by the one-part edit (/api/parts/[id]) and Update Prices
 * (/api/parts/update-prices, /api/parts/price-mismatches).
 */

import { updateItemFields } from '@/lib/netsuite';

// Maps a local netsuite_parts column to the NetSuite field name(s) the RESTlet
// reports back in `fieldsSet`, so we can confirm the write actually landed.
export const NS_FIELD: Record<string, string[]> = {
  item_number: ['itemid'],
  display_name: ['displayname'],
  sales_price: ['baseprice'],
  purchase_price: ['cost'],
  description: ['salesdescription', 'purchasedescription'],
};

// Columns whose local value now SURVIVES the parts sync, so an edit to them
// sticks in FleetSuite even when the write-back to NetSuite doesn't land.
// sales_price is the only one: FleetSuite is the pricing authority and the
// sync fills sales_price only where this catalog has none (resolveSalesPrice
// in src/lib/parts-sync.ts). Every other column here is rewritten from
// NetSuite on the next run, so a local-only edit to those would silently
// revert — they stay all-or-nothing, exactly as before.
export const SYNC_DURABLE = new Set(['sales_price']);

// A real NetSuite-synced part has a numeric internal id, not a local placeholder
// (manual parts have a NULL id; create-item mirrors use a `bmg-`/`LOCAL-` stub).
export const isRealNetsuiteId = (id: string | null | undefined): id is string => !!id && !/^(LOCAL-|bmg-)/i.test(id);

export interface PriceWriteOutcome {
  /** The columns asked for that did not reach NetSuite. */
  notInNetsuite: ('sales_price' | 'purchase_price')[];
  /** Why, in plain words, when any didn't. */
  reason: string | null;
}

/**
 * Send a part's selling price and/or cost to NetSuite and say which landed.
 * Never throws.
 */
export async function writePricesToNetsuite(
  netsuiteId: string,
  fields: { sales_price?: number; purchase_price?: number },
): Promise<PriceWriteOutcome> {
  const asked = (Object.keys(fields) as ('sales_price' | 'purchase_price')[]).filter(k => fields[k] !== undefined);
  if (asked.length === 0) return { notInNetsuite: [], reason: null };
  let res: Awaited<ReturnType<typeof updateItemFields>>;
  try {
    res = await updateItemFields(netsuiteId, { salesPrice: fields.sales_price, purchasePrice: fields.purchase_price });
  } catch (e: any) {
    res = { success: false, error: e?.message || String(e) };
  }
  const set = res.success ? res.fieldsSet || [] : [];
  const notInNetsuite = asked.filter(col => !(NS_FIELD[col] || []).some(f => set.includes(f)));
  if (notInNetsuite.length === 0) return { notInNetsuite, reason: null };
  return {
    notInNetsuite,
    reason: res.success
      ? 'NetSuite did not apply the change. The item script in NetSuite may need to be uploaded again (scripts/netsuite-item-restlet.js).'
      : `NetSuite update failed: ${res.error}`,
  };
}
