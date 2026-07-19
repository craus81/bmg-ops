import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';

/**
 * Incremental sync of vendor purchase orders (BMG buying parts from Ranger
 * Design, Masterack, Legend, Meyer, Buyers, ...) from NetSuite into
 * netsuite_vendor_pos / netsuite_vendor_po_lines. Runs inside the 2-hour
 * netsuite-sync cron. Everything NetSuite stays behind this sync boundary so
 * the eventual QBO swap only has to replace this file's queries.
 */

/** NetSuite sub-item ids come back as "PARENT : CHILD" — match on the last segment. */
export function normalizeItemNumber(s: string | null | undefined): string {
  const segs = String(s || '').split(':');
  return segs[segs.length - 1].trim().toUpperCase();
}

/** PO statuses with nothing left to receive (Fully Billed / Closed / Cancelled). */
const CLOSED_PO_STATUSES = ['F', 'G', 'H'];

export function isOpenPoStatus(status: string | null | undefined): boolean {
  return !CLOSED_PO_STATUSES.includes(String(status || '').toUpperCase());
}

export interface VendorPoSyncResult {
  modified: number;
  synced: number;
  lines: number;
  error?: string;
}

export async function syncVendorPos(service: SupabaseClient): Promise<VendorPoSyncResult> {
  const { data: syncState } = await service
    .from('sync_state')
    .select('last_synced_at')
    .eq('sync_type', 'netsuite_vendor_pos')
    .single();

  const lastSynced = syncState?.last_synced_at || '2025-01-01T00:00:00Z';
  const since = new Date(lastSynced);
  // Overlap one day so edits right around a sync are never missed.
  since.setDate(since.getDate() - 1);
  const sinceStr = `${since.getMonth() + 1}/${since.getDate()}/${since.getFullYear()}`;

  // status_label via BUILTIN.DF is nice-to-have — retry without it if the
  // integration role's SuiteQL rejects it.
  let pos: any[];
  try {
    pos = await suiteqlQueryAll(`
      SELECT t.id, t.tranid, t.trandate, t.status, BUILTIN.DF(t.status) AS status_label,
             t.memo, t.foreigntotal AS total, t.entity AS vendor_id, v.companyname AS vendor_name
      FROM transaction t
      LEFT JOIN vendor v ON t.entity = v.id
      WHERE t.type = 'PurchOrd'
        AND t.lastmodifieddate >= TO_DATE('${sinceStr}', 'MM/DD/YYYY')
    `);
  } catch {
    pos = await suiteqlQueryAll(`
      SELECT t.id, t.tranid, t.trandate, t.status, t.memo,
             t.foreigntotal AS total, t.entity AS vendor_id, v.companyname AS vendor_name
      FROM transaction t
      LEFT JOIN vendor v ON t.entity = v.id
      WHERE t.type = 'PurchOrd'
        AND t.lastmodifieddate >= TO_DATE('${sinceStr}', 'MM/DD/YYYY')
    `);
  }

  let synced = 0;
  let lineCount = 0;

  // Line detail for the modified POs, chunked to keep SuiteQL happy.
  // quantityshiprecv (received so far) may not exist on every account
  // version — fall back to a query without it.
  const linesByPo = new Map<string, any[]>();
  const poIds = pos.map(p => String(p.id));
  for (let i = 0; i < poIds.length; i += 50) {
    const chunk = poIds.slice(i, i + 50);
    let rows: any[];
    try {
      rows = await suiteqlQueryAll(`
        SELECT tl.transaction AS po_id, tl.id AS line_id, tl.item, i.itemid AS item_number,
               tl.memo AS description, tl.quantity, tl.quantityshiprecv, tl.quantitybilled,
               tl.rate, tl.netamount
        FROM transactionline tl
        LEFT JOIN item i ON tl.item = i.id
        WHERE tl.transaction IN (${chunk.join(', ')})
          AND tl.mainline = 'F'
          AND tl.taxline = 'F'
          AND tl.item IS NOT NULL
      `);
    } catch {
      rows = await suiteqlQueryAll(`
        SELECT tl.transaction AS po_id, tl.id AS line_id, tl.item, i.itemid AS item_number,
               tl.memo AS description, tl.quantity, tl.quantitybilled, tl.rate, tl.netamount
        FROM transactionline tl
        LEFT JOIN item i ON tl.item = i.id
        WHERE tl.transaction IN (${chunk.join(', ')})
          AND tl.mainline = 'F'
          AND tl.taxline = 'F'
          AND tl.item IS NOT NULL
      `);
    }
    for (const row of rows) {
      const key = String(row.po_id);
      if (!linesByPo.has(key)) linesByPo.set(key, []);
      linesByPo.get(key)!.push(row);
    }
  }

  for (const po of pos) {
    const nsId = String(po.id);
    const { data: header, error } = await service
      .from('netsuite_vendor_pos')
      .upsert({
        netsuite_id: nsId,
        tranid: po.tranid || null,
        vendor_netsuite_id: po.vendor_id ? String(po.vendor_id) : null,
        vendor_name: po.vendor_name || null,
        trandate: po.trandate || null,
        status: po.status || null,
        status_label: po.status_label || null,
        memo: po.memo || null,
        total: po.total != null ? Math.abs(parseFloat(po.total)) || null : null,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'netsuite_id' })
      .select('id')
      .single();
    if (error || !header) continue;

    // Replace lines wholesale — quantities move as receipts/bills post, and
    // a line can be deleted in NetSuite; delete+insert keeps us exact.
    const lines = (linesByPo.get(nsId) || []).map(l => ({
      po_id: header.id,
      line_id: String(l.line_id),
      item_netsuite_id: l.item ? String(l.item) : null,
      item_number: normalizeItemNumber(l.item_number),
      description: l.description || null,
      quantity: Math.abs(parseFloat(l.quantity || '0')) || 0,
      quantity_received: Math.abs(parseFloat(l.quantityshiprecv || '0')) || 0,
      quantity_billed: Math.abs(parseFloat(l.quantitybilled || '0')) || 0,
      rate: l.rate != null ? Math.abs(parseFloat(l.rate)) || null : null,
      amount: l.netamount != null ? Math.abs(parseFloat(l.netamount)) || null : null,
    }));
    await service.from('netsuite_vendor_po_lines').delete().eq('po_id', header.id);
    if (lines.length > 0) {
      await service.from('netsuite_vendor_po_lines').insert(lines);
      lineCount += lines.length;
    }
    synced++;
  }

  await service.from('sync_state').upsert({
    sync_type: 'netsuite_vendor_pos',
    last_synced_at: new Date().toISOString(),
    last_result: { modified: pos.length, synced, lines: lineCount },
    updated_at: new Date().toISOString(),
  });

  return { modified: pos.length, synced, lines: lineCount };
}
