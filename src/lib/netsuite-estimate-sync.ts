import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';
import { compactSuiteqlError, parseSoSyncResume, type SoSyncResume } from '@/lib/sales-order-sync';

/**
 * Copies every NetSuite estimate into netsuite_estimates /
 * netsuite_estimate_lines (migration 372), every two hours from
 * /api/cron/netsuite-estimates.
 *
 * Owner ask 2026-10-14: "est526" found nothing in the top bar because the
 * estimate was made in NetSuite, and FleetSuite only knew the estimates it
 * had pushed there. Craig wants every transaction in FleetSuite for the
 * NetSuite replacement, so this copies all of them, from the first one.
 *
 * Run shape is the sales order copy's (src/lib/sales-order-sync.ts, which
 * explains why at length): a window of estimates modified since the last
 * drained run, read NEWEST FIRST in pages, each page written in bulk, with a
 * time budget and a saved cursor (sync_state.last_result.resume) so the first
 * pull of the whole history spreads over as many runs as it needs and a
 * killed run loses nothing. last_synced_at moves only when a window drains,
 * to the time it was opened.
 *
 * NetSuite is the only place these change. Nothing here writes back, and
 * nothing here touches FleetSuite's own estimates: estimate_id only records
 * which FleetSuite estimate was pushed into a NetSuite one, so search can
 * leave those to the FleetSuite row.
 */

export const NS_ESTIMATE_SYNC_TYPE = 'netsuite_estimates';

/** Headers per SuiteQL page — also the unit of work between deadline checks. */
export const NS_ESTIMATE_PAGE_SIZE = 200;
/** Estimate ids per line query. */
const LINE_CHUNK = 100;
/** Line rows per insert. */
const LINE_INSERT_CHUNK = 500;
/** Ids per `.in()` filter (they ride in the request URL). */
const FILTER_CHUNK = 100;
/** The first run reaches back to the very first estimate. */
const FIRST_RUN_SINCE = '2000-01-01T00:00:00Z';
const DEFAULT_BUDGET_MS = 45_000;
const SUITEQL_OPTS = { retries: 2 };

/**
 * Header columns this account's SuiteQL may refuse; a run tries the richest
 * set first and keeps the first one NetSuite accepts (as the SO copy does).
 */
export const OPTIONAL_ESTIMATE_COLUMNS = {
  status_label: 'BUILTIN.DF(t.status) AS status_label',
  vin: 't.custbody_vin_number_ AS vin',
} as const;
export type OptionalEstimateColumn = keyof typeof OPTIONAL_ESTIMATE_COLUMNS;
export const ESTIMATE_COLUMN_LADDER: readonly (readonly OptionalEstimateColumn[])[] = [
  ['status_label', 'vin'],
  ['status_label'],
  [],
];
const ALL_OPTIONAL: readonly OptionalEstimateColumn[] = ['status_label', 'vin'];

function toSuiteqlDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/** One page of estimate headers, newest first, continuing below `beforeId`. */
export function buildEstimateHeaderQuery(sinceIso: string, beforeId: string | null, columns: readonly OptionalEstimateColumn[]): string {
  const extras = columns.map(c => `, ${OPTIONAL_ESTIMATE_COLUMNS[c]}`).join('');
  // Never trust a stored string into SQL, even one we wrote ourselves.
  const before = beforeId && /^\d+$/.test(beforeId) ? `\n        AND t.id < ${beforeId}` : '';
  return `
      SELECT t.id, t.tranid, t.trandate, t.status, t.memo, t.otherrefnum,
             t.foreigntotal AS total, t.entity AS customer_id, c.companyname AS customer_name${extras}
      FROM transaction t
      LEFT JOIN customer c ON t.entity = c.id
      WHERE t.type = 'Estimate'
        AND t.lastmodifieddate >= TO_DATE('${toSuiteqlDate(sinceIso)}', 'MM/DD/YYYY')${before}
      ORDER BY t.id DESC
    `;
}

export function buildEstimateLinesQuery(ids: string[]): string {
  const safe = ids.filter(id => /^\d+$/.test(id));
  return `
      SELECT tl.transaction AS estimate_id, tl.id AS line_id, tl.item, i.itemid AS item_number,
             tl.memo AS description, tl.quantity, tl.rate, tl.netamount
      FROM transactionline tl
      LEFT JOIN item i ON tl.item = i.id
      WHERE tl.transaction IN (${safe.join(', ')})
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND tl.item IS NOT NULL
    `;
}

/** NetSuite stores sales amounts negative on some lines; the copy keeps them positive, as the SO copy does. */
const amount = (v: unknown): number | null => (v != null && v !== '' ? Math.abs(parseFloat(String(v))) || null : null);

export interface EstimateSyncResult {
  /** Headers NetSuite returned this run. */
  modified: number;
  synced: number;
  lines: number;
  /** Rows linked to the FleetSuite estimate that was pushed into them. */
  linked: number;
  headerErrors: number;
  /** Stopped on its time budget with more to do; the next run continues. */
  partial: boolean;
  windowProcessed: number;
  droppedColumns: OptionalEstimateColumn[];
  error?: string;
  syncStateWrite?: HeartbeatResult;
}

export interface EstimateSyncOptions {
  /** Absolute epoch ms; no new page starts after it. */
  deadline?: number;
}

export async function syncNetsuiteEstimates(
  service: SupabaseClient,
  opts?: EstimateSyncOptions,
): Promise<EstimateSyncResult> {
  const startedAt = Date.now();
  const deadline = opts?.deadline ?? startedAt + DEFAULT_BUDGET_MS;

  // Open (or continue) the window.
  const { data: state } = await service
    .from('sync_state')
    .select('last_synced_at, last_result')
    .eq('sync_type', NS_ESTIMATE_SYNC_TYPE)
    .maybeSingle();
  const resume = parseSoSyncResume(state?.last_result);
  const win: { windowStartedAt: string; since: string; beforeId: string | null; processed: number } = resume
    ? { ...resume }
    : (() => {
        // Overlap one day so edits right around a sync are never missed.
        const since = new Date(state?.last_synced_at || FIRST_RUN_SINCE);
        since.setUTCDate(since.getUTCDate() - 1);
        return { windowStartedAt: new Date().toISOString(), since: since.toISOString(), beforeId: null, processed: 0 };
      })();

  let modified = 0;
  let synced = 0;
  let lineCount = 0;
  let linked = 0;
  let headerErrors = 0;
  const headerErrorSamples: string[] = [];
  let lineErrors = 0;
  const lineErrorSamples: string[] = [];
  let columns = null as readonly OptionalEstimateColumn[] | null;
  let drained = false;
  let error: string | undefined;
  let stage = 'opening the window';
  let page = 0;

  const fetchHeaderPage = async (): Promise<any[]> => {
    if (columns === null) {
      for (let i = 0; i < ESTIMATE_COLUMN_LADDER.length; i++) {
        const set = ESTIMATE_COLUMN_LADDER[i];
        const lastRung = i === ESTIMATE_COLUMN_LADDER.length - 1;
        try {
          const result = await suiteqlQuery(buildEstimateHeaderQuery(win.since, win.beforeId, set), NS_ESTIMATE_PAGE_SIZE, 0, lastRung ? SUITEQL_OPTS : undefined);
          columns = set;
          return result?.items || [];
        } catch (err) {
          if (lastRung) throw err;
        }
      }
    }
    const result = await suiteqlQuery(buildEstimateHeaderQuery(win.since, win.beforeId, columns || []), NS_ESTIMATE_PAGE_SIZE, 0, SUITEQL_OPTS);
    return result?.items || [];
  };

  try {
    for (;;) {
      page++;
      stage = `estimate headers, page ${page}${win.beforeId ? ` (ids below ${win.beforeId})` : ''}`;
      const ests = await fetchHeaderPage();
      modified += ests.length;
      if (ests.length === 0) { drained = true; break; }
      const nsIds = ests.map(e => String(e.id));

      const linesByEstimate = new Map<string, any[]>();
      for (let i = 0; i < nsIds.length; i += LINE_CHUNK) {
        stage = `estimate lines, page ${page} (estimates ${i + 1}–${Math.min(i + LINE_CHUNK, nsIds.length)})`;
        const rows = await suiteqlQueryAll(buildEstimateLinesQuery(nsIds.slice(i, i + LINE_CHUNK)), 1000, SUITEQL_OPTS);
        for (const row of rows) {
          const key = String(row.estimate_id);
          if (!linesByEstimate.has(key)) linesByEstimate.set(key, []);
          linesByEstimate.get(key)!.push(row);
        }
      }

      stage = `writing page ${page}`;

      // Which FleetSuite estimate was pushed into each NetSuite one. A
      // NetSuite id claimed by two FleetSuite estimates links to neither.
      const pushedBy = new Map<string, string[]>();
      for (let i = 0; i < nsIds.length; i += FILTER_CHUNK) {
        const { data } = await service
          .from('estimates')
          .select('id, netsuite_estimate_id')
          .in('netsuite_estimate_id', nsIds.slice(i, i + FILTER_CHUNK));
        for (const e of data || []) {
          const key = String(e.netsuite_estimate_id);
          if (!pushedBy.has(key)) pushedBy.set(key, []);
          pushedBy.get(key)!.push(e.id);
        }
      }

      const syncedAt = new Date().toISOString();
      const headerRows = ests.map(e => {
        const nsId = String(e.id);
        const fs = pushedBy.get(nsId);
        const estimateId = fs && fs.length === 1 ? fs[0] : null;
        if (estimateId) linked++;
        return {
          netsuite_id: nsId,
          tranid: e.tranid || null,
          customer_netsuite_id: e.customer_id ? String(e.customer_id) : null,
          customer_name: e.customer_name || null,
          trandate: e.trandate || null,
          status: e.status || null,
          status_label: e.status_label || null,
          memo: e.memo || null,
          otherrefnum: e.otherrefnum || null,
          vin: e.vin || null,
          total: amount(e.total),
          estimate_id: estimateId,
          last_synced_at: syncedAt,
        };
      });

      // One upsert per page; if it fails as a whole, one row at a time so a
      // single bad estimate can't sink the page.
      const idByNsId = new Map<string, string>();
      const { data: upserted, error: bulkErr } = await service
        .from('netsuite_estimates')
        .upsert(headerRows, { onConflict: 'netsuite_id' })
        .select('id, netsuite_id');
      if (!bulkErr && upserted) {
        for (const h of upserted) idByNsId.set(String(h.netsuite_id), h.id);
      } else {
        for (const row of headerRows) {
          const { data: h, error: rowErr } = await service
            .from('netsuite_estimates')
            .upsert(row, { onConflict: 'netsuite_id' })
            .select('id, netsuite_id')
            .single();
          if (rowErr || !h) {
            headerErrors++;
            if (headerErrorSamples.length < 5) {
              headerErrorSamples.push(`${row.tranid || row.netsuite_id}: ${rowErr?.message || bulkErr?.message || 'no header row returned'}`);
            }
            continue;
          }
          idByNsId.set(String(h.netsuite_id), h.id);
        }
      }

      // Lines are replaced wholesale for every header that landed: lines get
      // edited and deleted in NetSuite, and delete + insert keeps us exact.
      const landedIds = [...idByNsId.values()];
      const lineRows: any[] = [];
      for (const [nsId, rowId] of idByNsId) {
        for (const l of linesByEstimate.get(nsId) || []) {
          lineRows.push({
            ns_estimate_id: rowId,
            line_id: String(l.line_id),
            item_netsuite_id: l.item ? String(l.item) : null,
            item_number: normalizeItemNumber(l.item_number),
            description: l.description || null,
            quantity: Math.abs(parseFloat(l.quantity || '0')) || 0,
            rate: amount(l.rate),
            amount: amount(l.netamount),
          });
        }
      }
      for (let i = 0; i < landedIds.length; i += FILTER_CHUNK) {
        const { error: delErr } = await service
          .from('netsuite_estimate_lines')
          .delete()
          .in('ns_estimate_id', landedIds.slice(i, i + FILTER_CHUNK));
        if (delErr) throw new Error(`Could not clear estimate lines: ${delErr.message}`);
      }
      for (let i = 0; i < lineRows.length; i += LINE_INSERT_CHUNK) {
        const chunk = lineRows.slice(i, i + LINE_INSERT_CHUNK);
        const { error: insErr } = await service.from('netsuite_estimate_lines').insert(chunk);
        if (insErr) {
          lineErrors += chunk.length;
          if (lineErrorSamples.length < 5) lineErrorSamples.push(insErr.message);
          continue;
        }
        lineCount += chunk.length;
      }
      synced += idByNsId.size;

      // Cursor: everything at or above the smallest id on this page is done.
      win.beforeId = nsIds.reduce((min, id) => (Number(id) < Number(min) ? id : min), nsIds[0]);
      win.processed += ests.length;

      if (ests.length < NS_ESTIMATE_PAGE_SIZE) { drained = true; break; }
      if (Date.now() >= deadline) break;
    }
  } catch (err: any) {
    error = `${stage}: ${compactSuiteqlError(err)}`;
    console.error('[netsuite-estimate-sync]', error);
  }

  const partial = !drained && !error;
  const settled = columns;
  const droppedColumns: OptionalEstimateColumn[] = settled ? ALL_OPTIONAL.filter(c => !settled.includes(c)) : [];
  const counts = {
    modified, synced, lines: lineCount, linked,
    ...(headerErrors > 0 ? { headerErrors, headerErrorSamples } : {}),
    ...(lineErrors > 0 ? { lineErrors, lineErrorSamples } : {}),
    ...(droppedColumns.length > 0 ? { droppedColumns } : {}),
  };

  let syncStateWrite: HeartbeatResult;
  if (drained) {
    syncStateWrite = await recordHeartbeat(service, NS_ESTIMATE_SYNC_TYPE, counts, {
      lastSyncedAt: win.windowStartedAt, startedAt, records: synced,
    });
  } else {
    // Keep the cursor so the next run continues rather than starting over.
    const keep: SoSyncResume | null = win.beforeId
      ? { windowStartedAt: win.windowStartedAt, since: win.since, beforeId: win.beforeId, processed: win.processed }
      : null;
    syncStateWrite = await recordHeartbeat(
      service, NS_ESTIMATE_SYNC_TYPE,
      { ...counts, ...(error ? { error } : { partial: true }), ...(keep ? { resume: keep } : {}) },
      { touchLastSyncedAt: false, startedAt, records: synced },
    );
  }

  return {
    modified, synced, lines: lineCount, linked, headerErrors,
    partial, windowProcessed: win.processed, droppedColumns,
    ...(error ? { error } : {}),
    syncStateWrite,
  };
}
