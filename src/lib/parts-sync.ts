import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { runCategorySweep } from '@/lib/part-category-sweep';

/**
 * Parts-catalog sync against NetSuite (K11).
 *
 * Two paths share this module:
 *  - the manual full rebuild (`POST /api/parts/sync`, admin button) — pulls
 *    every item and diffs the whole catalog, and
 *  - the hourly incremental cron (`GET /api/cron/parts-sync`) — pulls only
 *    items whose lastmodifieddate moved since the last run, so a part
 *    created or repriced in NetSuite shows up in FleetSuite within the hour
 *    instead of whenever someone remembers the button. Before this cron the
 *    catalog was stale except where FleetSuite itself created the item —
 *    the source of the "part not in catalog" field bugs.
 *
 * The classification heuristic and the manual-row promote step live here so
 * the two paths cannot drift.
 *
 * Quantities are NOT this module's job alone: item quantities move without
 * bumping lastmodifieddate, so the 2-hour inventory sweep
 * (`src/lib/inventory-sync.ts`) stays the freshness authority for on-hand/
 * available. The incremental sync still writes quantities for the items it
 * touches (new items need a starting value).
 */

/**
 * Determine which catalog a part belongs to.
 * 1. If ns_class contains "graphic" (case-insensitive) → graphics
 * 2. If item_number starts with "06" → graphics
 * 3. Everything else → upfit
 * (Known mis-file: prefix "06" catches the Verizon RFID part — the roadmap's
 * S1/product_line work replaces this heuristic with Ashley's category list.)
 */
export function determineCatalog(itemNumber: string, nsClass: string | null): 'upfit' | 'graphics' {
  if (nsClass && nsClass.toLowerCase().includes('graphic')) {
    return 'graphics';
  }
  if (itemNumber && itemNumber.startsWith('06')) {
    return 'graphics';
  }
  return 'upfit';
}

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * Fold manual rows into their new NetSuite twin ("promote").
 * Graphics-only parts (source='manual', netsuite_id NULL) were folded in
 * from the old proof catalog. If NetSuite later gains a real item with the
 * same item number, the sync upsert inserts a SEPARATE synced row, leaving
 * two rows for one part. Promote the manual row into the synced one:
 * preserve its graphics metadata, move its proofs + line/estimate/schedule
 * references onto the synced row, then delete the manual row.
 *
 * `syncedItems` is whatever set the caller just upserted — the full catalog
 * for the manual rebuild, the modified subset for the incremental cron
 * (a twin can only appear when its NetSuite item was just created/modified,
 * so the subset is sufficient there).
 */
export async function promoteManualTwins(
  service: SupabaseClient,
  syncedItems: { item_number?: string | null }[],
): Promise<number> {
  const now = new Date().toISOString();
  const syncedLower = new Set(
    syncedItems.map((it) => (it.item_number || '').toLowerCase()).filter(Boolean)
  );
  if (syncedLower.size === 0) return 0;

  // Manual rows are the bounded legacy set (old proof catalog) — paginate
  // anyway per CLAUDE.md, ordered for a deterministic walk.
  const manualRows: any[] = [];
  let page = 0;
  let hasMore = true;
  while (hasMore) {
    const { data: batch } = await service
      .from('netsuite_parts')
      .select('id, item_number, vehicle_type, graphic_package, customer, proof_pages, billable_customer')
      .eq('source', 'manual')
      .order('id')
      .range(page * 1000, (page + 1) * 1000 - 1);
    manualRows.push(...(batch || []));
    hasMore = (batch || []).length === 1000;
    page++;
  }

  const colliding = manualRows.filter(
    (m: any) => m.item_number && syncedLower.has(m.item_number.toLowerCase())
  );

  let promoted = 0;
  for (const m of colliding) {
    // The freshly-synced twin (source='netsuite', same item number).
    const { data: twins } = await service
      .from('netsuite_parts')
      .select('id, vehicle_type, graphic_package, customer, proof_pages, billable_customer')
      .eq('source', 'netsuite')
      .ilike('item_number', m.item_number)
      .limit(1);
    const twin = twins?.[0];
    if (!twin || twin.id === m.id) continue;

    // 1) Keep the graphics metadata the synced row doesn't already carry.
    await service.from('netsuite_parts').update({
      vehicle_type: twin.vehicle_type ?? m.vehicle_type,
      graphic_package: twin.graphic_package ?? m.graphic_package,
      customer: twin.customer ?? m.customer,
      proof_pages: twin.proof_pages ?? m.proof_pages,
      billable_customer: (twin.billable_customer && twin.billable_customer !== '')
        ? twin.billable_customer : m.billable_customer,
      catalog: 'graphics',
      updated_at: now,
    }).eq('id', twin.id);

    // 2) Move proofs + every FK reference onto the twin. part_files cascades
    //    on delete, so this MUST happen before the manual row is removed.
    await service.from('part_files').update({ part_id: twin.id }).eq('part_id', m.id);
    await service.from('po_line_items').update({ part_id: twin.id }).eq('part_id', m.id);
    await service.from('estimate_line_items').update({ part_id: twin.id }).eq('part_id', m.id);
    // schedule_assignments only exists in some environments — error ignored.
    await service.from('schedule_assignments').update({ part_id: twin.id }).eq('part_id', m.id);

    // 3) Remove the absorbed manual row.
    await service.from('netsuite_parts').delete().eq('id', m.id);
    promoted++;
  }

  return promoted;
}

export interface PartsIncrementalResult {
  modified: number;
  upserted: number;
  deactivated: number;
  promoted: number;
  itemsWithPrice: number;
  /** Parts re-categorized by the tagging rules (migration 209). */
  categorized?: number;
  error?: string;
  /** Outcome of the sync_state heartbeat write — not persisted, only reported. */
  syncStateWrite?: HeartbeatResult;
}

/**
 * Incremental parts sync: items modified in NetSuite since the last
 * successful run. Unlike the full rebuild, this also SELECTS inactive items
 * — deactivating an item bumps its lastmodifieddate, so the incremental
 * path retires it from the catalog within the hour rather than at the next
 * manual full sync.
 */
export async function syncPartsIncremental(service: SupabaseClient): Promise<PartsIncrementalResult> {
  // Watermark from the last successful run. TO_DATE is day-granular, so
  // runs re-process the current day's items — idempotent upserts make that
  // harmless (same pattern as the customer sync).
  const { data: syncState } = await service
    .from('sync_state')
    .select('last_synced_at')
    .eq('sync_type', 'netsuite_parts')
    .maybeSingle();
  const since = new Date(syncState?.last_synced_at || '2020-01-01T00:00:00Z');
  const sinceStr = `${since.getMonth() + 1}/${since.getDate()}/${since.getFullYear()}`;

  const nsItems = await suiteqlQueryAll(`
    SELECT
      i.id,
      i.itemid AS item_number,
      i.displayname AS display_name,
      i.description,
      i.itemtype,
      i.isinactive,
      i.cost AS purchase_price,
      i.custitem1 AS labor_hours,
      BUILTIN.DF(i.class) AS class_name,
      BUILTIN.DF(i.department) AS department_name,
      BUILTIN.DF(i.vendor) AS vendor_name
    FROM item i
    WHERE i.itemtype IN ('InvtPart', 'NonInvtPart', 'Service', 'Kit', 'Assembly')
      AND i.lastmodifieddate >= TO_DATE('${sinceStr}', 'MM/DD/YYYY')
    ORDER BY i.id
  `);

  const active = nsItems.filter((it: any) => it.isinactive !== 'T');
  const inactive = nsItems.filter((it: any) => it.isinactive === 'T');
  const activeIds = active.map((it: any) => it.id?.toString()).filter(Boolean);

  // ── Deactivations: NetSuite-sourced rows only — manual graphics parts
  // are not managed by the sync and must survive it.
  let deactivated = 0;
  for (const ids of chunk(inactive.map((it: any) => it.id?.toString()).filter(Boolean), 200)) {
    const { data: rows } = await service
      .from('netsuite_parts')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('source', 'netsuite')
      .in('netsuite_id', ids)
      .select('id');
    deactivated += (rows || []).length;
  }

  if (active.length === 0) {
    const result = { modified: nsItems.length, upserted: 0, deactivated, promoted: 0, itemsWithPrice: 0 };
    return { ...result, syncStateWrite: await recordHeartbeat(service, 'netsuite_parts', result) };
  }

  // ── Sales prices, scoped to the modified items. Same two-table fallback
  // as the full sync — SuiteQL pricing table names vary by account.
  const pricingMap: Record<string, number> = {};
  for (const table of [
    { name: 'pricing', sql: (ids: string) => `SELECT p.item AS item_id, p.unitprice AS sales_price FROM pricing p WHERE p.pricelevel = 1 AND p.item IN (${ids})` },
    { name: 'itemPrice', sql: (ids: string) => `SELECT ip.item AS item_id, ip.unitprice AS sales_price FROM itemPrice ip WHERE ip.pricelevel = 1 AND ip.item IN (${ids})` },
  ]) {
    try {
      for (const ids of chunk(activeIds, 500)) {
        const rows = await suiteqlQueryAll(table.sql(ids.join(',')));
        for (const p of rows) {
          const price = parseFloat(p.sales_price || '0');
          if (p.item_id && price > 0) pricingMap[p.item_id.toString()] = price;
        }
      }
      if (Object.keys(pricingMap).length > 0) break;
    } catch {
      // try the next table name
    }
  }

  // ── Quantities for the modified inventory items. If the lookup fails
  // entirely, omit quantity fields from the upsert rather than writing 0s
  // over the inventory sweep's good data.
  let qtyMap: Record<string, { onHand: number; available: number }> | null = {};
  const invtIds = active
    .filter((it: any) => it.itemtype === 'InvtPart')
    .map((it: any) => it.id?.toString())
    .filter(Boolean);
  try {
    for (const ids of chunk(invtIds, 500)) {
      let rows: any[];
      try {
        rows = await suiteqlQueryAll(`SELECT i.id, i.totalquantityonhand AS qty_on_hand, i.totalquantityavailable AS qty_available FROM item i WHERE i.id IN (${ids.join(',')})`);
      } catch {
        rows = (await suiteqlQueryAll(`SELECT i.id, i.totalquantityonhand AS qty_on_hand FROM item i WHERE i.id IN (${ids.join(',')})`))
          .map((r: any) => ({ ...r, qty_available: r.qty_on_hand }));
      }
      for (const r of rows) {
        if (r.id) {
          qtyMap![r.id.toString()] = {
            onHand: parseFloat(r.qty_on_hand || '0') || 0,
            available: parseFloat(r.qty_available || '0') || 0,
          };
        }
      }
    }
  } catch {
    qtyMap = null;
  }

  // ── Manual catalog re-files (Parts page "Move to … Catalog") win over the
  // derived classification, otherwise the sync would undo the move. Same
  // idea for vendors assigned by the vendor-asset import: NetSuite's
  // item-record vendor wins when it exists, but a locally assigned vendor
  // survives while NetSuite's field is blank (which it almost always is).
  const catalogOverrides: Record<string, 'upfit' | 'graphics'> = {};
  const localVendors: Record<string, string> = {};
  for (const ids of chunk(activeIds, 200)) {
    const { data: rows } = await service
      .from('netsuite_parts')
      .select('netsuite_id, catalog_override, vendor')
      .in('netsuite_id', ids);
    for (const r of rows || []) {
      if (r.netsuite_id && (r.catalog_override === 'upfit' || r.catalog_override === 'graphics')) {
        catalogOverrides[String(r.netsuite_id)] = r.catalog_override;
      }
      if (r.netsuite_id && r.vendor) localVendors[String(r.netsuite_id)] = r.vendor;
    }
  }

  // ── Upsert, batches of 200, same row shape as the full sync.
  // The fixed column list below is ALSO the protection for FleetSuite-owned
  // columns (image_path, marketing_description, product_url,
  // product_category_id, and the migration-213 dims: width_in/depth_in/
  // height_in/weight_lb/mount_type/dims_source) — an upsert only writes the
  // keys it names, so never add those columns here.
  const now = new Date().toISOString();
  let upserted = 0;
  for (const batch of chunk(active, 200)) {
    const upsertData = batch.map((item: any) => {
      const nsId = item.id?.toString();
      const itemNumber = item.item_number || '';
      const className = item.class_name || '';
      const qty = qtyMap ? (qtyMap[nsId] || { onHand: 0, available: 0 }) : null;
      return {
        netsuite_id: nsId,
        item_number: itemNumber,
        display_name: item.display_name || itemNumber,
        description: item.description || item.display_name || '',
        item_type: item.itemtype || '',
        catalog: catalogOverrides[nsId] || determineCatalog(itemNumber, className),
        sales_price: pricingMap[nsId] || 0,
        purchase_price: parseFloat(item.purchase_price || '0') || 0,
        ...(qty ? { quantity_on_hand: qty.onHand, quantity_available: qty.available } : {}),
        labor_hours: parseFloat(item.labor_hours || '0'),
        ns_class: className || null,
        ns_department: item.department_name || null,
        vendor: item.vendor_name || localVendors[nsId] || null,
        is_active: true,
        last_synced_at: now,
        updated_at: now,
      };
    });

    const { error } = await service
      .from('netsuite_parts')
      .upsert(upsertData, { onConflict: 'netsuite_id', ignoreDuplicates: false });
    if (error) throw new Error(`Failed to upsert batch: ${error.message}`);
    upserted += upsertData.length;
  }

  const promoted = await promoteManualTwins(service, active);

  // Newly synced parts arrive uncategorized, so run the tagging rules
  // (migration 209) behind every sync — otherwise a rule only ever covers
  // the catalog as it stood the last time someone opened the admin page.
  // Non-fatal: a sweep failure must not fail the sync that already landed.
  let categorized = 0;
  try {
    categorized = (await runCategorySweep(service)).applied;
  } catch (err: any) {
    console.error('[parts-sync] category rule sweep failed:', err?.message || err);
  }

  const result = {
    modified: nsItems.length,
    upserted,
    deactivated,
    promoted,
    categorized,
    itemsWithPrice: Object.keys(pricingMap).length,
  };
  return { ...result, syncStateWrite: await recordHeartbeat(service, 'netsuite_parts', result) };
}
