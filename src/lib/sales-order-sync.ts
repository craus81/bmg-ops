import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';

/**
 * Incremental sync of customer sales orders from NetSuite into
 * netsuite_sales_orders / netsuite_sales_order_lines, with each SO matched
 * back to its FleetSuite estimate (roadmap N3). Runs inside the 2-hour
 * netsuite-sync cron; a near-copy of vendor-po-sync so the pattern stays
 * uniform.
 *
 * Matching runs in strict precedence and records its source:
 *   1. createdfrom  — NetSuite's own Estimate→SO link (only populated when
 *                     the SO was transformed from a pushed estimate).
 *   2. otherrefnum  — convert-to-so writes the estimate number into the SO's
 *                     Reference No. Guarded to EST-* shapes: the field is
 *                     free text where customer PO numbers also live, and a
 *                     collision would attach the SO to the wrong estimate.
 *   3. memo         — "FleetSuite Estimate #X" from the convert-to-so memo.
 *                     Recorded on the mirror row for review, but NEVER
 *                     auto-written onto the estimate (weakest signal).
 */

export interface SoMatchKeys {
  createdfrom?: string | null;
  otherrefnum?: string | null;
  memo?: string | null;
}

export type SoMatch =
  | { source: 'createdfrom'; nsEstimateId: string }
  | { source: 'otherrefnum'; estimateNumber: string }
  | { source: 'memo'; estimateNumber: string }
  | null;

/** Old EST-YYMM-XXXX and new EST-YYMM-NNN shapes both match. */
const EST_NUMBER_RE = /^EST-[A-Z0-9]{2,6}-[A-Z0-9]{3,6}$/i;

export function classifySoMatch(keys: SoMatchKeys): SoMatch {
  const createdfrom = String(keys.createdfrom || '').trim();
  if (createdfrom && /^\d+$/.test(createdfrom)) {
    return { source: 'createdfrom', nsEstimateId: createdfrom };
  }
  const refnum = String(keys.otherrefnum || '').trim().toUpperCase();
  if (EST_NUMBER_RE.test(refnum)) {
    return { source: 'otherrefnum', estimateNumber: refnum };
  }
  const memoMatch = String(keys.memo || '').match(/FleetSuite Estimate #(\S+)/i);
  if (memoMatch) {
    return { source: 'memo', estimateNumber: memoMatch[1].toUpperCase() };
  }
  return null;
}

export interface SalesOrderSyncResult {
  modified: number;
  synced: number;
  lines: number;
  matched: number;
  backfilled: number;
  error?: string;
  /** Outcome of the sync_state heartbeat write — not persisted, only reported. */
  syncStateWrite?: HeartbeatResult;
}

export async function syncSalesOrders(
  service: SupabaseClient,
  opts?: { fullResync?: boolean },
): Promise<SalesOrderSyncResult> {
  let lastSynced = '2024-01-01T00:00:00Z';
  if (!opts?.fullResync) {
    const { data: syncState } = await service
      .from('sync_state')
      .select('last_synced_at')
      .eq('sync_type', 'netsuite_sales_orders')
      .maybeSingle();
    lastSynced = syncState?.last_synced_at || '2025-01-01T00:00:00Z';
  }
  const since = new Date(lastSynced);
  // Overlap one day so edits right around a sync are never missed.
  since.setDate(since.getDate() - 1);
  const sinceStr = `${since.getMonth() + 1}/${since.getDate()}/${since.getFullYear()}`;

  // BUILTIN.DF(status) and the VIN custom field are nice-to-have — retry
  // without them if the integration role's SuiteQL rejects either.
  let sos: any[];
  try {
    sos = await suiteqlQueryAll(`
      SELECT t.id, t.tranid, t.trandate, t.status, BUILTIN.DF(t.status) AS status_label,
             t.memo, t.otherrefnum, t.createdfrom, t.custbody_vin_number_ AS vin,
             t.foreigntotal AS total, t.entity AS customer_id, c.companyname AS customer_name
      FROM transaction t
      LEFT JOIN customer c ON t.entity = c.id
      WHERE t.type = 'SalesOrd'
        AND t.lastmodifieddate >= TO_DATE('${sinceStr}', 'MM/DD/YYYY')
    `);
  } catch {
    sos = await suiteqlQueryAll(`
      SELECT t.id, t.tranid, t.trandate, t.status, t.memo, t.otherrefnum, t.createdfrom,
             t.foreigntotal AS total, t.entity AS customer_id, c.companyname AS customer_name
      FROM transaction t
      LEFT JOIN customer c ON t.entity = c.id
      WHERE t.type = 'SalesOrd'
        AND t.lastmodifieddate >= TO_DATE('${sinceStr}', 'MM/DD/YYYY')
    `);
  }

  // Line detail for the modified SOs, chunked to keep SuiteQL happy.
  const linesBySo = new Map<string, any[]>();
  const soIds = sos.map(s => String(s.id));
  for (let i = 0; i < soIds.length; i += 50) {
    const chunk = soIds.slice(i, i + 50);
    const rows = await suiteqlQueryAll(`
      SELECT tl.transaction AS so_id, tl.id AS line_id, tl.item, i.itemid AS item_number,
             tl.memo AS description, tl.quantity, tl.quantitybilled, tl.rate, tl.netamount
      FROM transactionline tl
      LEFT JOIN item i ON tl.item = i.id
      WHERE tl.transaction IN (${chunk.join(', ')})
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND tl.item IS NOT NULL
    `);
    for (const row of rows) {
      const key = String(row.so_id);
      if (!linesBySo.has(key)) linesBySo.set(key, []);
      linesBySo.get(key)!.push(row);
    }
  }

  let synced = 0;
  let lineCount = 0;
  let matched = 0;
  let backfilled = 0;

  for (const so of sos) {
    const nsId = String(so.id);

    // Resolve the estimate link per the precedence above.
    const match = classifySoMatch({ createdfrom: so.createdfrom, otherrefnum: so.otherrefnum, memo: so.memo });
    let estimateId: string | null = null;
    let estimate: { id: string; netsuite_so_id: string | null } | null = null;
    if (match) {
      const q = service.from('estimates').select('id, netsuite_so_id');
      const { data: est } = match.source === 'createdfrom'
        ? await q.eq('netsuite_estimate_id', match.nsEstimateId).maybeSingle()
        : await q.ilike('estimate_number', match.estimateNumber).maybeSingle();
      if (est) {
        estimate = est;
        estimateId = est.id;
        matched++;
      }
    }

    const { data: header, error } = await service
      .from('netsuite_sales_orders')
      .upsert({
        netsuite_id: nsId,
        tranid: so.tranid || null,
        customer_netsuite_id: so.customer_id ? String(so.customer_id) : null,
        customer_name: so.customer_name || null,
        trandate: so.trandate || null,
        status: so.status || null,
        status_label: so.status_label || null,
        memo: so.memo || null,
        otherrefnum: so.otherrefnum || null,
        createdfrom_netsuite_id: so.createdfrom ? String(so.createdfrom) : null,
        vin: so.vin || null,
        total: so.total != null ? Math.abs(parseFloat(so.total)) || null : null,
        estimate_id: estimateId,
        match_source: estimateId && match ? match.source : null,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'netsuite_id' })
      .select('id')
      .single();
    if (error || !header) continue;

    // Backfill the estimate's SO link — strong matches only, never
    // overwriting a link that already exists.
    if (estimate && match && match.source !== 'memo' && !estimate.netsuite_so_id) {
      const { error: backfillErr } = await service
        .from('estimates')
        .update({ netsuite_so_id: nsId, netsuite_so_number: so.tranid || null })
        .eq('id', estimate.id)
        .is('netsuite_so_id', null);
      if (!backfillErr) backfilled++;
    }

    // Replace lines wholesale — quantities/billing move and lines get
    // deleted in NetSuite; delete+insert keeps us exact.
    const lines = (linesBySo.get(nsId) || []).map(l => ({
      so_id: header.id,
      line_id: String(l.line_id),
      item_netsuite_id: l.item ? String(l.item) : null,
      item_number: normalizeItemNumber(l.item_number),
      description: l.description || null,
      quantity: Math.abs(parseFloat(l.quantity || '0')) || 0,
      quantity_billed: Math.abs(parseFloat(l.quantitybilled || '0')) || 0,
      rate: l.rate != null ? Math.abs(parseFloat(l.rate)) || null : null,
      amount: l.netamount != null ? Math.abs(parseFloat(l.netamount)) || null : null,
    }));
    await service.from('netsuite_sales_order_lines').delete().eq('so_id', header.id);
    if (lines.length > 0) {
      await service.from('netsuite_sales_order_lines').insert(lines);
      lineCount += lines.length;
    }
    synced++;
  }

  const result = { modified: sos.length, synced, lines: lineCount, matched, backfilled };
  return { ...result, syncStateWrite: await recordHeartbeat(service, 'netsuite_sales_orders', result) };
}
