import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120; // Allow up to 2 minutes for large syncs

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Determine which catalog a part belongs to.
 * 1. If ns_class contains "graphic" (case-insensitive) → graphics
 * 2. If item_number starts with "06" → graphics
 * 3. Everything else → upfit
 */
function determineCatalog(itemNumber: string, nsClass: string | null): 'upfit' | 'graphics' {
  if (nsClass && nsClass.toLowerCase().includes('graphic')) {
    return 'graphics';
  }
  if (itemNumber && itemNumber.startsWith('06')) {
    return 'graphics';
  }
  return 'upfit';
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const triggeredBy = body.userId || null;

  // Create sync log entry
  const { data: logEntry, error: logError } = await supabase
    .from('parts_sync_log')
    .insert({
      triggered_by: triggeredBy,
      status: 'running',
    })
    .select()
    .single();

  const logId = logEntry?.id;

  try {
    // Query all inventory and non-inventory items from NetSuite
    // Include: InventoryItem, NonInventoryResaleItem, NonInventoryPurchaseItem, ServiceResaleItem
    // Get sales price, purchase/cost price, quantity on hand, and class info
    const query = `
      SELECT
        i.id,
        i.itemid AS item_number,
        i.displayname AS display_name,
        i.description,
        i.itemtype,
        i.isinactive,
        i.class,
        i.department,
        i.custitem1 AS labor_hours,
        BUILTIN.DF(i.class) AS class_name,
        BUILTIN.DF(i.department) AS department_name
      FROM item i
      WHERE i.itemtype IN ('InvtPart', 'NonInvtPart', 'Service', 'Kit', 'Assembly')
      AND i.isinactive = 'F'
      ORDER BY i.itemid
    `;

    const nsItems = await suiteqlQueryAll(query);

    if (!nsItems || nsItems.length === 0) {
      // Update log
      if (logId) {
        await supabase.from('parts_sync_log').update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          parts_synced: 0,
          parts_added: 0,
          parts_updated: 0,
        }).eq('id', logId);
      }
      return NextResponse.json({ success: true, synced: 0, added: 0, updated: 0 });
    }

    // Get pricing from the pricing matrix table and cost/qty from item table
    // Try multiple approaches since NetSuite SuiteQL table names vary
    let pricingMap: Record<string, number> = {};
    let costMap: Record<string, { purchasePrice: number; quantityOnHand: number }> = {};

    // 1. Get cost and quantity from item table
    try {
      const costQuery = `
        SELECT
          i.id,
          i.baseprice,
          i.cost AS purchase_price,
          i.quantityonhand
        FROM item i
        WHERE i.itemtype IN ('InvtPart', 'NonInvtPart', 'Service', 'Kit', 'Assembly')
        AND i.isinactive = 'F'
      `;
      const costItems = await suiteqlQueryAll(costQuery);
      console.log(`[parts-sync] Fetched cost/qty for ${costItems.length} items`);
      let basePriceCount = 0;
      for (const c of costItems) {
        if (c.id) {
          const id = c.id.toString();
          const bp = parseFloat(c.baseprice || '0');
          if (bp > 0) { pricingMap[id] = bp; basePriceCount++; }
          costMap[id] = {
            purchasePrice: parseFloat(c.purchase_price || '0'),
            quantityOnHand: parseFloat(c.quantityonhand || '0'),
          };
        }
      }
      console.log(`[parts-sync] baseprice found on ${basePriceCount}/${costItems.length} items`);
    } catch (err: any) {
      console.error('[parts-sync] Cost query failed:', err.message || err);
    }

    // 2. Get sales prices from pricing matrix — try "pricing" table first, then "itemPrice"
    const pricingQueries = [
      { name: 'pricing', sql: `SELECT p.item AS item_id, p.unitprice AS sales_price FROM pricing p WHERE p.pricelevel = 1` },
      { name: 'itemPrice', sql: `SELECT ip.item AS item_id, ip.unitprice AS sales_price FROM itemPrice ip WHERE ip.pricelevel = 1` },
    ];

    for (const pq of pricingQueries) {
      try {
        const pricingItems = await suiteqlQueryAll(pq.sql);
        let count = 0;
        for (const p of pricingItems) {
          if (p.item_id) {
            const price = parseFloat(p.sales_price || '0');
            if (price > 0) {
              pricingMap[p.item_id.toString()] = price;
              count++;
            }
          }
        }
        console.log(`[parts-sync] ${pq.name} table: found ${count} prices from ${pricingItems.length} rows`);
        if (count > 0) break; // Got prices, no need to try next table
      } catch (err: any) {
        console.warn(`[parts-sync] ${pq.name} table query failed: ${err.message || err}`);
      }
    }

    const totalWithPrice = Object.values(pricingMap).filter(p => p > 0).length;
    console.log(`[parts-sync] Final pricing: ${totalWithPrice} items with non-zero prices`);

    // Build upsert batch
    let added = 0;
    let updated = 0;
    const now = new Date().toISOString();

    // Process in batches of 200
    const batchSize = 200;
    for (let i = 0; i < nsItems.length; i += batchSize) {
      const batch = nsItems.slice(i, i + batchSize);

      const upsertData = batch.map((item: any) => {
        const nsId = item.id?.toString();
        const itemNumber = item.item_number || '';
        const className = item.class_name || '';
        const catalog = determineCatalog(itemNumber, className);
        const pricing = pricingMap[nsId] || 0;
        const costInfo = costMap[nsId] || { purchasePrice: 0, quantityOnHand: 0 };

        return {
          netsuite_id: nsId,
          item_number: itemNumber,
          display_name: item.display_name || itemNumber,
          description: item.description || item.display_name || '',
          item_type: item.itemtype || '',
          catalog,
          sales_price: pricing,
          purchase_price: costInfo.purchasePrice,
          quantity_on_hand: costInfo.quantityOnHand,
          quantity_available: costInfo.quantityOnHand, // Can be refined later
          labor_hours: parseFloat(item.labor_hours || '0'),
          ns_class: className || null,
          ns_category: null,
          ns_department: item.department_name || null,
          is_active: true,
          last_synced_at: now,
          updated_at: now,
        };
      });

      const { error: upsertError } = await supabase
        .from('netsuite_parts')
        .upsert(upsertData, {
          onConflict: 'netsuite_id',
          ignoreDuplicates: false,
        });

      if (upsertError) {
        console.error('Upsert batch error:', upsertError);
        throw new Error(`Failed to upsert batch: ${upsertError.message}`);
      }
    }

    // Count adds vs updates — check which netsuite_ids existed before
    const { count: totalCount } = await supabase
      .from('netsuite_parts')
      .select('*', { count: 'exact', head: true });

    // Mark parts not in this sync as inactive (they were removed from NetSuite)
    const syncedIds = nsItems.map((item: any) => item.id?.toString());
    await supabase
      .from('netsuite_parts')
      .update({ is_active: false, updated_at: now })
      .not('netsuite_id', 'in', `(${syncedIds.join(',')})`);

    // Update sync log
    if (logId) {
      await supabase.from('parts_sync_log').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        parts_synced: nsItems.length,
        parts_added: added,
        parts_updated: updated,
      }).eq('id', logId);
    }

    const finalWithPrice = Object.values(pricingMap).filter(p => p > 0).length;
    return NextResponse.json({
      success: true,
      synced: nsItems.length,
      total: totalCount || nsItems.length,
      itemsWithPrice: finalWithPrice,
      itemsWithCost: Object.values(costMap).filter(c => c.purchasePrice > 0).length,
    });
  } catch (err: any) {
    console.error('Parts sync error:', err);

    if (logId) {
      await supabase.from('parts_sync_log').update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: err.message,
      }).eq('id', logId);
    }

    return NextResponse.json({ error: err.message || 'Sync failed' }, { status: 500 });
  }
}
