import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';

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

/**
 * The company each purchase order is for (migration 511): NetSuite makes a
 * PO's bills and item receipts in the PO's subsidiary, which its main line
 * carries, as every transaction's does. Books keeps its own copy of a Parts
 * Mail bill or a Receive for the company whose subsidiary it is.
 */
const subsidiaryQuery = (where: string) => `
  SELECT t.id, tl.subsidiary AS subsidiary_id
  FROM transaction t
  JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T'
  WHERE t.type = 'PurchOrd'
    AND ${where}
`;

/** Each PO's subsidiary from a subsidiaryQuery read, by NetSuite's id for the PO; rows without both ids are left out. */
export function subsidiariesByPo(rows: readonly any[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const po = String(r?.id ?? '').trim();
    const subsidiary = String(r?.subsidiary_id ?? '').trim();
    if (/^\d+$/.test(po) && /^\d+$/.test(subsidiary)) out.set(po, subsidiary);
  }
  return out;
}

/** PostgREST's answer when the column isn't in its schema yet (migration 511 run, the schema not reloaded). */
const noCompanyColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST204' || /subsidiary_netsuite_id/.test(error.message ?? ''));

const why = (err: unknown) => String((err as any)?.message || err).slice(0, 200);

/**
 * The company a purchase order is for, as NetSuite's id for its subsidiary:
 * what FleetSuite's copy of the PO keeps, or, when the copy doesn't have it
 * yet (a PO made in FleetSuite since the sync last read it, or one it hasn't
 * read since migration 511), what NetSuite says, kept on the copy. Null when
 * neither says. Never throws: it only tells Books' own copy of a bill or a
 * receipt which company it's for, so it never stops the bill or the Receive.
 */
export async function poCompanyOf(
  service: SupabaseClient,
  po: { id?: string | null; netsuite_id?: string | number | null; subsidiary_netsuite_id?: string | null },
): Promise<string | null> {
  const kept = String(po.subsidiary_netsuite_id ?? '').trim();
  if (/^\d+$/.test(kept)) return kept;
  // Put in SuiteQL, so only ever a bare number.
  const id = String(po.netsuite_id ?? '').trim();
  if (!/^\d+$/.test(id)) return null;
  let subsidiary: string | null;
  try {
    subsidiary = subsidiariesByPo(await suiteqlQueryAll(subsidiaryQuery(`t.id = ${id}`))).get(id) ?? null;
  } catch (err) {
    console.warn(`vendor-po-sync: couldn't ask NetSuite which company PO ${id} is for: ${why(err)}`);
    return null;
  }
  if (subsidiary && po.id) {
    try {
      const { error } = await service
        .from('netsuite_vendor_pos')
        .update({ subsidiary_netsuite_id: subsidiary })
        .eq('id', po.id)
        .is('subsidiary_netsuite_id', null);
      if (error) throw new Error(error.message);
    } catch (err) {
      console.warn(`vendor-po-sync: the company PO ${id} is for wasn't kept on its copy: ${why(err)}`);
    }
  }
  return subsidiary;
}

export interface VendorPoSyncResult {
  modified: number;
  synced: number;
  lines: number;
  /** Header upserts that failed (those POs' mirrors are stale this run). */
  headerErrors?: number;
  /** POs served by the no-quantityshiprecv fallback — their previous
   *  received quantities were preserved rather than zeroed. */
  receivedDegraded?: number;
  /** Why the POs' subsidiaries couldn't be read this run; their copies keep
   *  the company they had (poCompanyOf asks NetSuite when one has none). */
  companyError?: string;
  error?: string;
  /** Outcome of the sync_state heartbeat write — not persisted, only reported. */
  syncStateWrite?: HeartbeatResult;
}

export async function syncVendorPos(
  service: SupabaseClient,
  opts?: { fullResync?: boolean },
): Promise<VendorPoSyncResult> {
  // A full resync ignores the incremental cursor and reaches back far enough
  // to backfill history the cursor already advanced past — the manual "Sync
  // POs" action uses it so a stuck/empty table can be repopulated in one go.
  let lastSynced = '2024-01-01T00:00:00Z';
  if (!opts?.fullResync) {
    const { data: syncState } = await service
      .from('sync_state')
      .select('last_synced_at')
      .eq('sync_type', 'netsuite_vendor_pos')
      .single();
    lastSynced = syncState?.last_synced_at || '2025-01-01T00:00:00Z';
  }
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

  // The company each PO is for. A read that fails costs only that: the copies
  // keep the company they had, and the sync goes on.
  let companies = new Map<string, string>();
  let companyError: string | undefined;
  if (pos.length > 0) {
    try {
      companies = subsidiariesByPo(await suiteqlQueryAll(subsidiaryQuery(`t.lastmodifieddate >= TO_DATE('${sinceStr}', 'MM/DD/YYYY')`)));
    } catch (err) {
      companyError = why(err);
      console.warn(`vendor-po-sync: couldn't read which company each PO is for, so their copies keep what they had: ${companyError}`);
    }
  }

  let synced = 0;
  let lineCount = 0;
  let headerErrors = 0;
  const headerErrorSamples: string[] = [];

  // Line detail for the modified POs, chunked to keep SuiteQL happy.
  // quantityshiprecv (received so far) may not exist on every account
  // version — fall back to a query without it. POs served by the fallback
  // are tracked as DEGRADED: their rows carry no received quantities, and
  // writing them as-is would zero quantity_received across the PO —
  // readiness then re-counts already-arrived parts as still on order
  // (Stage 4 finding: "a degraded fallback zeroes received quantities with
  // no flag"). Degraded POs keep their previous received values instead.
  const linesByPo = new Map<string, any[]>();
  const degradedPoIds = new Set<string>();
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
      for (const id of chunk) degradedPoIds.add(id);
    }
    for (const row of rows) {
      const key = String(row.po_id);
      if (!linesByPo.has(key)) linesByPo.set(key, []);
      linesByPo.get(key)!.push(row);
    }
  }

  // The company goes in only when it was read, so a copy never loses one; and
  // once the column turns out not to be in the API's schema yet, not again
  // this run.
  let writeCompany = true;
  const upsertHeader = (row: Record<string, unknown>) => service
    .from('netsuite_vendor_pos')
    .upsert(row, { onConflict: 'netsuite_id' })
    .select('id')
    .single();
  for (const po of pos) {
    const nsId = String(po.id);
    const row: Record<string, unknown> = {
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
    };
    const company = companies.get(nsId);
    if (company && writeCompany) row.subsidiary_netsuite_id = company;
    let { data: header, error } = await upsertHeader(row);
    if (error && 'subsidiary_netsuite_id' in row && noCompanyColumn(error)) {
      writeCompany = false;
      delete row.subsidiary_netsuite_id;
      ({ data: header, error } = await upsertHeader(row));
    }
    if (error || !header) {
      // A skipped header means this PO's mirror is silently stale — count
      // it into the heartbeat instead of burying it (Stage 4 finding:
      // "per-row sync errors are silently continued").
      headerErrors++;
      if (headerErrorSamples.length < 5) {
        headerErrorSamples.push(`${po.tranid || nsId}: ${error?.message || 'no header row returned'}`);
      }
      continue;
    }

    // Degraded read: carry the previous received quantities forward, keyed
    // by NetSuite line id, rather than zeroing them.
    let priorReceived: Map<string, number> | null = null;
    if (degradedPoIds.has(nsId)) {
      const { data: prior } = await service
        .from('netsuite_vendor_po_lines')
        .select('line_id, quantity_received')
        .eq('po_id', header.id);
      priorReceived = new Map((prior || []).map(r => [String(r.line_id), Number(r.quantity_received) || 0]));
    }

    // Replace lines wholesale — quantities move as receipts/bills post, and
    // a line can be deleted in NetSuite; delete+insert keeps us exact.
    const lines = (linesByPo.get(nsId) || []).map(l => ({
      po_id: header.id,
      line_id: String(l.line_id),
      item_netsuite_id: l.item ? String(l.item) : null,
      item_number: normalizeItemNumber(l.item_number),
      description: l.description || null,
      quantity: Math.abs(parseFloat(l.quantity || '0')) || 0,
      quantity_received: priorReceived
        ? (priorReceived.get(String(l.line_id)) ?? 0)
        : Math.abs(parseFloat(l.quantityshiprecv || '0')) || 0,
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

  const degradedSynced = [...degradedPoIds].filter(id => linesByPo.has(id)).length;
  if (degradedSynced > 0) {
    console.warn(`vendor-po-sync: quantityshiprecv unavailable for ${degradedSynced} PO(s) — previous received quantities preserved`);
  }
  const syncStateWrite = await recordHeartbeat(
    service, 'netsuite_vendor_pos', {
      modified: pos.length, synced, lines: lineCount,
      // Both surface in System Health so degraded/stale mirror data is a
      // visible condition, not a silent one.
      ...(headerErrors > 0 ? { headerErrors, headerErrorSamples } : {}),
      ...(degradedSynced > 0 ? { receivedDegraded: degradedSynced } : {}),
      ...(companyError ? { companyError } : {}),
    },
  );
  return {
    modified: pos.length, synced, lines: lineCount, headerErrors, receivedDegraded: degradedSynced,
    ...(companyError ? { companyError } : {}),
    syncStateWrite,
  };
}
