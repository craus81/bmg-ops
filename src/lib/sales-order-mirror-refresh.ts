import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { buildSoLinesQuery } from '@/lib/sales-order-sync';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';

/**
 * Bring ONE sales order's mirror row (migration 196) up to date right after
 * it is edited on the sales order page, so parts demand, Jobs waiting on
 * parts and search don't show the old lines until the next 2-hour sync.
 * Same columns and line shape as syncSalesOrders. Only updates an order the
 * mirror already has; a new one is left to the sync, which also matches it
 * to its estimate.
 */
export async function refreshSalesOrderMirror(
  service: SupabaseClient,
  soNetsuiteId: string,
): Promise<{ ok: true; lines: number } | { ok: false; error: string }> {
  if (!/^\d{1,15}$/.test(soNetsuiteId)) return { ok: false, error: 'bad id' };

  const { data: row, error: rowErr } = await service
    .from('netsuite_sales_orders').select('id').eq('netsuite_id', soNetsuiteId).maybeSingle();
  if (rowErr) return { ok: false, error: rowErr.message };
  if (!row) return { ok: true, lines: 0 };

  const [headers, lines] = await Promise.all([
    suiteqlQueryAll(`
      SELECT t.id, t.tranid, t.status, t.memo, t.otherrefnum, t.foreigntotal AS total
      FROM transaction t
      WHERE t.id = ${soNetsuiteId} AND t.type = 'SalesOrd'
    `),
    suiteqlQueryAll(buildSoLinesQuery([soNetsuiteId])),
  ]);
  const h = headers[0];
  if (!h) return { ok: false, error: 'NetSuite returned no header' };

  const { error: upErr } = await service.from('netsuite_sales_orders').update({
    tranid: h.tranid || null,
    status: h.status != null ? String(h.status) : null,
    memo: h.memo || null,
    otherrefnum: h.otherrefnum || null,
    total: h.total != null ? Math.abs(parseFloat(h.total)) || 0 : null,
    last_synced_at: new Date().toISOString(),
  }).eq('id', row.id);
  if (upErr) return { ok: false, error: upErr.message };

  const lineRows = lines.map((l: any) => ({
    so_id: row.id,
    line_id: String(l.line_id),
    item_netsuite_id: l.item ? String(l.item) : null,
    item_number: normalizeItemNumber(l.item_number),
    description: l.description || null,
    quantity: Math.abs(parseFloat(l.quantity || '0')) || 0,
    quantity_billed: Math.abs(parseFloat(l.quantitybilled || '0')) || 0,
    rate: l.rate != null ? Math.abs(parseFloat(l.rate)) || null : null,
    amount: l.netamount != null ? Math.abs(parseFloat(l.netamount)) || null : null,
  }));
  const { error: delErr } = await service.from('netsuite_sales_order_lines').delete().eq('so_id', row.id);
  if (delErr) return { ok: false, error: delErr.message };
  if (lineRows.length > 0) {
    const { error: insErr } = await service.from('netsuite_sales_order_lines').insert(lineRows);
    if (insErr) return { ok: false, error: insErr.message };
  }
  return { ok: true, lines: lineRows.length };
}
