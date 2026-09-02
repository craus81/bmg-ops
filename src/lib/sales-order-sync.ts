import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery, suiteqlQueryAll, isSuiteqlError } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';

/**
 * Incremental sync of customer sales orders from NetSuite into
 * netsuite_sales_orders / netsuite_sales_order_lines, with each SO matched
 * back to its FleetSuite estimate (roadmap N3). Runs inside the 2-hour
 * netsuite-sync cron and behind the Purchasing page's manual "Sync sales
 * orders" button.
 *
 * Run shape — a WINDOW of SOs (lastmodifieddate >= since) drained NEWEST
 * FIRST in pages of SO_PAGE_SIZE, each page written in bulk, with a time
 * budget and a saved cursor:
 *
 *   - The first version pulled every SO modified since 2025 in one shot,
 *     one estimate lookup + upsert + delete + insert per SO, inside a cron
 *     capped at 120s that runs five other NetSuite phases first, and wrote
 *     its heartbeat only at the very end. The initial pull could never
 *     finish inside the budget, a killed run recorded nothing, so every
 *     2-hour run repeated the same doomed pull — the mirror stayed empty
 *     (or held only the oldest, long-billed orders) and the open-job demand
 *     page reported "0 open sales orders" while the shop had plenty.
 *   - Now a run stops itself before the deadline, records how far it got
 *     (sync_state.last_result.resume = the window + the id it stopped at)
 *     and the next run continues from there. Newest first means the open
 *     orders — the ones anything reading the mirror cares about — land in
 *     the first page of the first run; history backfills behind them.
 *   - last_synced_at advances only when a window fully drains, to the time
 *     the window was OPENED (not finished), so nothing modified during a
 *     long drain is skipped by the next window.
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
  /** Headers NetSuite returned this run. 0 across a full resync means the
   *  integration role can't see Sales Orders — a NetSuite permission. */
  modified: number;
  synced: number;
  lines: number;
  matched: number;
  backfilled: number;
  /** Header upserts that failed (with samples in the heartbeat) — a stale
   *  mirror is a visible System Health condition, not a silent one. */
  headerErrors: number;
  /** True when the run stopped on its time budget with more to do; the
   *  saved cursor makes the next run (cron or manual) continue. */
  partial: boolean;
  /** Headers processed in the current window so far, this run included. */
  windowProcessed: number;
  /** Optional header columns NetSuite rejected on this run's first page,
   *  so the run went without them (see OPTIONAL_HEADER_COLUMNS). */
  droppedColumns: OptionalHeaderColumn[];
  error?: string;
  /** Outcome of the sync_state heartbeat write — not persisted, only reported. */
  syncStateWrite?: HeartbeatResult;
}

export const SO_SYNC_TYPE = 'netsuite_sales_orders';

/** Headers per SuiteQL page — also the unit of work between deadline checks. */
export const SO_PAGE_SIZE = 200;
/** SO ids per line query — a page's lines come back in a couple of calls. */
const LINE_CHUNK = 100;
/** Line rows per insert. */
const LINE_INSERT_CHUNK = 500;
/** Ids per `.in()` / `.or()` filter — those ride in the request URL, and a
 *  page's worth of UUIDs in one filter overflows it. */
const FILTER_CHUNK = 100;
/** How far back a manual full resync reaches. */
const FULL_RESYNC_SINCE = '2024-01-01T00:00:00Z';
/** Where the very first incremental run starts when no cursor exists. */
const FIRST_RUN_SINCE = '2025-01-01T00:00:00Z';
/** Budget when the caller passes no deadline. */
const DEFAULT_BUDGET_MS = 45_000;
/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send; a
 *  background sync can afford two more tries before calling it a failure. */
const SUITEQL_OPTS = { retries: 2 };

/**
 * The cursor a partial run leaves in sync_state.last_result.resume. A run
 * that finds one continues that window below `beforeId` instead of opening
 * a new window.
 */
export interface SoSyncResume {
  /** Wall clock when the window was opened — becomes last_synced_at once it drains. */
  windowStartedAt: string;
  /** Lower bound on lastmodifieddate for the window (ISO). */
  since: string;
  /** Continue with NetSuite internal ids strictly below this one. */
  beforeId: string;
  /** Headers processed in the window so far. */
  processed: number;
}

export function parseSoSyncResume(lastResult: unknown): SoSyncResume | null {
  const r = (lastResult as any)?.resume;
  if (!r || typeof r !== 'object') return null;
  const { windowStartedAt, since, beforeId, processed } = r;
  if (typeof windowStartedAt !== 'string' || typeof since !== 'string') return null;
  if (typeof beforeId !== 'string' || !/^\d+$/.test(beforeId)) return null;
  if (Number.isNaN(Date.parse(windowStartedAt)) || Number.isNaN(Date.parse(since))) return null;
  return { windowStartedAt, since, beforeId, processed: Number(processed) || 0 };
}

/** SuiteQL wants MM/DD/YYYY; the window is date-granular by design. */
function toSuiteqlDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/**
 * Header columns this account's SuiteQL may refuse. Each is nice-to-have:
 *
 *   status_label — BUILTIN.DF(status); the raw code is what the open/closed
 *                  gate keys on anyway.
 *   vin          — a custom body field that may not exist.
 *   createdfrom  — header-level Created From. Filters fine in a WHERE (the
 *                  SO-invoices route does that) but SELECTing it on the
 *                  sales-order header answered 500 UNEXPECTED_ERROR on this
 *                  account (2026-09-02, the probe ladder's "header columns"
 *                  step), which kept the mirror empty. Without it the
 *                  estimate link falls back to Reference No / memo — the
 *                  signals FleetSuite's own convert-to-so writes — and only
 *                  NetSuite-side Estimate→SO transforms lose their link.
 */
export const OPTIONAL_HEADER_COLUMNS = {
  status_label: 'BUILTIN.DF(t.status) AS status_label',
  vin: 't.custbody_vin_number_ AS vin',
  createdfrom: 't.createdfrom',
} as const;
export type OptionalHeaderColumn = keyof typeof OPTIONAL_HEADER_COLUMNS;
export const ALL_OPTIONAL_HEADER_COLUMNS: readonly OptionalHeaderColumn[] = ['status_label', 'vin', 'createdfrom'];
/** Column sets a run tries on its first page, richest first; the first
 *  one NetSuite accepts is used for the rest of the run. */
export const HEADER_COLUMN_LADDER: readonly (readonly OptionalHeaderColumn[])[] = [
  ['status_label', 'vin', 'createdfrom'],
  ['status_label', 'vin'],
  ['createdfrom'],
  [],
];

/**
 * One page of SO headers, newest first. `beforeId` continues a window from
 * where the previous page (or run) stopped. `columns` adds the optional
 * header columns the account has been found to accept.
 */
export function buildSoHeaderQuery(sinceIso: string, beforeId: string | null, columns: readonly OptionalHeaderColumn[]): string {
  const extras = columns.map(c => `, ${OPTIONAL_HEADER_COLUMNS[c]}`).join('');
  // Never trust a stored string into SQL, even one we wrote ourselves.
  const before = beforeId && /^\d+$/.test(beforeId) ? `\n        AND t.id < ${beforeId}` : '';
  return `
      SELECT t.id, t.tranid, t.trandate, t.status, t.memo, t.otherrefnum,
             t.foreigntotal AS total, t.entity AS customer_id, c.companyname AS customer_name${extras}
      FROM transaction t
      LEFT JOIN customer c ON t.entity = c.id
      WHERE t.type = 'SalesOrd'
        AND t.lastmodifieddate >= TO_DATE('${toSuiteqlDate(sinceIso)}', 'MM/DD/YYYY')${before}
      ORDER BY t.id DESC
    `;
}

function buildSoLinesQuery(soIds: string[]): string {
  return `
      SELECT tl.transaction AS so_id, tl.id AS line_id, tl.item, i.itemid AS item_number,
             tl.memo AS description, tl.quantity, tl.quantitybilled, tl.rate, tl.netamount
      FROM transactionline tl
      LEFT JOIN item i ON tl.item = i.id
      WHERE tl.transaction IN (${soIds.join(', ')})
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND tl.item IS NOT NULL
    `;
}

/**
 * NetSuite's error body is a JSON blob nobody wants on a status line; keep
 * the status, the error code and the detail (which carries the Error ID
 * NetSuite support asks for).
 */
export function compactSuiteqlError(err: unknown): string {
  const message = String((err as any)?.message || err);
  const m = message.match(/^(NetSuite SuiteQL error \(\d+\)): ([\s\S]*)$/);
  if (!m) return message.slice(0, 300);
  try {
    const body = JSON.parse(m[2]);
    const detail = body?.['o:errorDetails']?.[0];
    const code = detail?.['o:errorCode'] || body?.title;
    const text = detail?.detail || body?.detail || '';
    if (code || text) return `${m[1]}: ${[code, text].filter(Boolean).join(' — ')}`.slice(0, 300);
  } catch { /* not JSON — fall through to the raw text */ }
  return message.slice(0, 300);
}

export interface SoQueryProbe {
  step: string;
  ok: boolean;
  /** A failing optional step doesn't stop the sync (it runs without those columns). */
  optional?: boolean;
  error?: string;
  rows?: number;
}

/**
 * When a sync query fails, find WHICH clause NetSuite objects to: re-run the
 * header query from its simplest shape up, one clause at a time, then the
 * line query, and stop at the first required step that fails. Cheap (each
 * probe is a count or a 5-row select) and it turns "UNEXPECTED_ERROR" into
 * a named clause — or into "every probe passes", which means the failure
 * was transient and the next run's retry will get through.
 */
export async function diagnoseSoQueries(sinceIso: string): Promise<{ probes: SoQueryProbe[]; verdict: string }> {
  const probes: SoQueryProbe[] = [];
  const sinceMdy = toSuiteqlDate(sinceIso);
  const run = async (step: string, query: string, opts?: { optional?: boolean; limit?: number }): Promise<any[] | null> => {
    try {
      const result = await suiteqlQuery(query, opts?.limit ?? 5, 0);
      const items = result?.items || [];
      probes.push({ step, ok: true, optional: opts?.optional, rows: items.length });
      return items;
    } catch (err) {
      probes.push({ step, ok: false, optional: opts?.optional, error: compactSuiteqlError(err) });
      return null;
    }
  };
  const failed = () => probes[probes.length - 1];

  const visible = await run('sales orders visible to the integration role',
    `SELECT COUNT(t.id) AS n FROM transaction t WHERE t.type = 'SalesOrd'`);
  if (!visible) return { probes, verdict: `NetSuite rejects even a count of sales orders: ${failed().error}` };
  if (!(Number(visible[0]?.n) > 0)) {
    return { probes, verdict: 'NetSuite returns no sales orders at all for the integration role — grant it "Sales Order → View" in NetSuite' };
  }

  if (!await run('lastmodifieddate filter',
    `SELECT COUNT(t.id) AS n FROM transaction t WHERE t.type = 'SalesOrd' AND t.lastmodifieddate >= TO_DATE('${sinceMdy}', 'MM/DD/YYYY')`)) {
    return { probes, verdict: `NetSuite rejects the lastmodifieddate filter: ${failed().error}` };
  }

  const from = `
      FROM transaction t
      WHERE t.type = 'SalesOrd'
        AND t.lastmodifieddate >= TO_DATE('${sinceMdy}', 'MM/DD/YYYY')`;

  if (!await run('core header columns', `SELECT t.id, t.tranid, t.trandate, t.status, t.entity AS customer_id${from}`)) {
    return { probes, verdict: `NetSuite rejects the core header columns (id, tranid, trandate, status, entity): ${failed().error}` };
  }
  // One column at a time, so the verdict names the column, not the query.
  for (const col of ['t.memo', 't.otherrefnum', 't.foreigntotal']) {
    if (!await run(`header column ${col}`, `SELECT t.id, ${col}${from}`)) {
      return { probes, verdict: `NetSuite rejects selecting ${col} on the sales-order header: ${failed().error}` };
    }
  }

  if (!await run('customer join', `
      SELECT t.id, t.entity AS customer_id, c.companyname AS customer_name
      FROM transaction t
      LEFT JOIN customer c ON t.entity = c.id
      WHERE t.type = 'SalesOrd'
        AND t.lastmodifieddate >= TO_DATE('${sinceMdy}', 'MM/DD/YYYY')`)) {
    return { probes, verdict: `NetSuite rejects the customer join: ${failed().error}` };
  }

  const ordered = await run('ORDER BY t.id DESC', buildSoHeaderQuery(sinceIso, null, []));
  if (!ordered) return { probes, verdict: `NetSuite rejects the newest-first ordering (ORDER BY t.id DESC): ${failed().error}` };

  // The optional columns, individually: a rejection here never stops the
  // sync (it runs without them), but the verdict should say so.
  const unavailable: OptionalHeaderColumn[] = [];
  for (const col of ALL_OPTIONAL_HEADER_COLUMNS) {
    const expr = OPTIONAL_HEADER_COLUMNS[col];
    if (!await run(`optional column ${col} (${expr})`, `SELECT t.id, ${expr}${from}`, { optional: true })) unavailable.push(col);
  }

  const ids = ordered.map(r => String(r.id)).filter(id => /^\d+$/.test(id));
  if (ids.length > 0) {
    if (!await run('line query', buildSoLinesQuery(ids), { limit: 50 })) {
      return { probes, verdict: `NetSuite rejects the line query: ${failed().error}` };
    }
  }

  const without = unavailable.length > 0
    ? ` (the sync runs without optional column${unavailable.length > 1 ? 's' : ''} ${unavailable.join(', ')})`
    : '';
  return { probes, verdict: `every required probe passed on re-check${without} — the failure looks transient; the next run retries from where this one stopped` };
}

export interface SalesOrderSyncOptions {
  /** Open a fresh window reaching back to FULL_RESYNC_SINCE, ignoring the
   *  incremental cursor — the manual button, for an empty/stuck mirror. */
  fullResync?: boolean;
  /** Absolute epoch ms; the run stops starting new pages once past it.
   *  Defaults to now + DEFAULT_BUDGET_MS. */
  deadline?: number;
}

interface Window {
  windowStartedAt: string;
  since: string;
  beforeId: string | null;
  processed: number;
}

async function openWindow(service: SupabaseClient, opts?: SalesOrderSyncOptions): Promise<Window> {
  const now = new Date().toISOString();
  if (opts?.fullResync) {
    return { windowStartedAt: now, since: FULL_RESYNC_SINCE, beforeId: null, processed: 0 };
  }
  const { data: state } = await service
    .from('sync_state')
    .select('last_synced_at, last_result')
    .eq('sync_type', SO_SYNC_TYPE)
    .maybeSingle();
  const resume = parseSoSyncResume(state?.last_result);
  if (resume) return { ...resume };
  // Overlap one day so edits right around a sync are never missed.
  const since = new Date(state?.last_synced_at || FIRST_RUN_SINCE);
  since.setUTCDate(since.getUTCDate() - 1);
  return { windowStartedAt: now, since: since.toISOString(), beforeId: null, processed: 0 };
}

type EstimateRef = { id: string; netsuite_so_id: string | null };

/**
 * Resolve every SO on the page to its estimate in two reads instead of one
 * per SO. A key that matches more than one estimate resolves to nothing —
 * the per-row `.maybeSingle()` this replaces behaved the same way, and
 * guessing between duplicates is how an SO gets pinned to the wrong job.
 */
async function resolveEstimates(
  service: SupabaseClient,
  matches: Map<string, SoMatch>,
): Promise<Map<string, EstimateRef>> {
  const byNsEstimateId = new Set<string>();
  const byNumber = new Set<string>();
  for (const m of matches.values()) {
    if (!m) continue;
    if (m.source === 'createdfrom') byNsEstimateId.add(m.nsEstimateId);
    else byNumber.add(m.estimateNumber);
  }

  const idHits = new Map<string, EstimateRef[]>();
  const nsIds = [...byNsEstimateId];
  for (let i = 0; i < nsIds.length; i += FILTER_CHUNK) {
    const { data } = await service
      .from('estimates')
      .select('id, netsuite_so_id, netsuite_estimate_id')
      .in('netsuite_estimate_id', nsIds.slice(i, i + FILTER_CHUNK));
    for (const e of data || []) {
      const key = String(e.netsuite_estimate_id);
      if (!idHits.has(key)) idHits.set(key, []);
      idHits.get(key)!.push({ id: e.id, netsuite_so_id: e.netsuite_so_id });
    }
  }
  const numberHits = new Map<string, EstimateRef[]>();
  const numbers = [...byNumber];
  for (let i = 0; i < numbers.length; i += FILTER_CHUNK) {
    // Case-insensitive like the ilike it replaces; EST_NUMBER_RE keeps the
    // values to [A-Z0-9-], so they're safe inside the filter string.
    const { data } = await service
      .from('estimates')
      .select('id, netsuite_so_id, estimate_number')
      .or(numbers.slice(i, i + FILTER_CHUNK).map(n => `estimate_number.ilike.${n}`).join(','));
    for (const e of data || []) {
      const key = String(e.estimate_number || '').toUpperCase();
      if (!numberHits.has(key)) numberHits.set(key, []);
      numberHits.get(key)!.push({ id: e.id, netsuite_so_id: e.netsuite_so_id });
    }
  }

  const resolved = new Map<string, EstimateRef>();
  for (const [soId, m] of matches) {
    if (!m) continue;
    const hits = m.source === 'createdfrom' ? idHits.get(m.nsEstimateId) : numberHits.get(m.estimateNumber);
    if (hits && hits.length === 1) resolved.set(soId, hits[0]);
  }
  return resolved;
}

export async function syncSalesOrders(
  service: SupabaseClient,
  opts?: SalesOrderSyncOptions,
): Promise<SalesOrderSyncResult> {
  const deadline = opts?.deadline ?? Date.now() + DEFAULT_BUDGET_MS;
  const win = await openWindow(service, opts);

  let modified = 0;
  let synced = 0;
  let lineCount = 0;
  let matched = 0;
  let backfilled = 0;
  let headerErrors = 0;
  const headerErrorSamples: string[] = [];
  let lineErrors = 0;
  const lineErrorSamples: string[] = [];
  /** Optional header columns this account accepts — settled on the first
   *  page (inside fetchHeaderPage, hence the cast: TS would otherwise
   *  narrow this to its initial null at the read below). */
  let columns = null as readonly OptionalHeaderColumn[] | null;
  let drained = false;
  let error: string | undefined;
  let lastError: unknown;

  const fetchHeaderPage = async (): Promise<any[]> => {
    // Settle the optional columns on the FIRST page, richest set first. A
    // rejected column is deterministic, so the ladder's rungs carry no retry
    // budget; only the bare core query (the last rung) does, since a failure
    // there is either transient or real. Settled once: a later page's
    // failure is a real failure and must surface with the cursor kept, not
    // get retried as a column issue.
    if (columns === null) {
      for (let i = 0; i < HEADER_COLUMN_LADDER.length; i++) {
        const set = HEADER_COLUMN_LADDER[i];
        const lastRung = i === HEADER_COLUMN_LADDER.length - 1;
        try {
          const result = await suiteqlQuery(buildSoHeaderQuery(win.since, win.beforeId, set), SO_PAGE_SIZE, 0, lastRung ? SUITEQL_OPTS : undefined);
          columns = set;
          return result?.items || [];
        } catch (err) {
          if (lastRung) throw err;
        }
      }
    }
    const result = await suiteqlQuery(buildSoHeaderQuery(win.since, win.beforeId, columns || []), SO_PAGE_SIZE, 0, SUITEQL_OPTS);
    return result?.items || [];
  };

  // Which query was in flight when something threw — the error is useless
  // on a status line without it.
  let stage = 'opening the window';
  let page = 0;

  try {
    for (;;) {
      page++;
      stage = `sales-order headers, page ${page}${win.beforeId ? ` (ids below ${win.beforeId})` : ''}`;
      const sos = await fetchHeaderPage();
      modified += sos.length;
      if (sos.length === 0) { drained = true; break; }

      // Line detail for the page, chunked to keep SuiteQL happy.
      const linesBySo = new Map<string, any[]>();
      const soIds = sos.map(s => String(s.id));
      for (let i = 0; i < soIds.length; i += LINE_CHUNK) {
        stage = `sales-order lines, page ${page} (orders ${i + 1}–${Math.min(i + LINE_CHUNK, soIds.length)})`;
        const rows = await suiteqlQueryAll(buildSoLinesQuery(soIds.slice(i, i + LINE_CHUNK)), 1000, SUITEQL_OPTS);
        for (const row of rows) {
          const key = String(row.so_id);
          if (!linesBySo.has(key)) linesBySo.set(key, []);
          linesBySo.get(key)!.push(row);
        }
      }

      stage = `writing page ${page} to the mirror`;

      // Estimate links per the precedence in classifySoMatch, resolved for
      // the whole page at once.
      const matches = new Map<string, SoMatch>();
      for (const so of sos) {
        matches.set(String(so.id), classifySoMatch({ createdfrom: so.createdfrom, otherrefnum: so.otherrefnum, memo: so.memo }));
      }
      const estimates = await resolveEstimates(service, matches);

      const syncedAt = new Date().toISOString();
      const headerRows = sos.map(so => {
        const nsId = String(so.id);
        const match = matches.get(nsId) || null;
        const estimate = estimates.get(nsId) || null;
        if (estimate) matched++;
        return {
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
          estimate_id: estimate?.id || null,
          match_source: estimate && match ? match.source : null,
          last_synced_at: syncedAt,
        };
      });

      // Headers in one upsert; if the statement fails as a whole, fall back
      // to one row at a time so a single bad SO can't sink the page, and
      // count what still fails (Stage 4: no bare `continue`).
      const idByNsId = new Map<string, string>();
      const { data: upserted, error: bulkErr } = await service
        .from('netsuite_sales_orders')
        .upsert(headerRows, { onConflict: 'netsuite_id' })
        .select('id, netsuite_id');
      if (!bulkErr && upserted) {
        for (const h of upserted) idByNsId.set(String(h.netsuite_id), h.id);
      } else {
        for (const row of headerRows) {
          const { data: h, error: rowErr } = await service
            .from('netsuite_sales_orders')
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

      // Backfill the estimate's SO link — strong matches only, never
      // overwriting a link that already exists. Rare (FleetSuite-pushed
      // SOs only), so per row is fine.
      for (const so of sos) {
        const nsId = String(so.id);
        const match = matches.get(nsId);
        const estimate = estimates.get(nsId);
        if (!idByNsId.has(nsId) || !estimate || !match || match.source === 'memo' || estimate.netsuite_so_id) continue;
        const { error: backfillErr } = await service
          .from('estimates')
          .update({ netsuite_so_id: nsId, netsuite_so_number: so.tranid || null })
          .eq('id', estimate.id)
          .is('netsuite_so_id', null);
        if (!backfillErr) backfilled++;
      }

      // Replace lines wholesale for every header that landed — quantities/
      // billing move and lines get deleted in NetSuite; delete+insert keeps
      // us exact. One delete and a few inserts per page instead of two
      // round trips per SO.
      const landedIds = [...idByNsId.values()];
      const lineRows: any[] = [];
      for (const [nsId, soRowId] of idByNsId) {
        for (const l of linesBySo.get(nsId) || []) {
          lineRows.push({
            so_id: soRowId,
            line_id: String(l.line_id),
            item_netsuite_id: l.item ? String(l.item) : null,
            item_number: normalizeItemNumber(l.item_number),
            description: l.description || null,
            quantity: Math.abs(parseFloat(l.quantity || '0')) || 0,
            quantity_billed: Math.abs(parseFloat(l.quantitybilled || '0')) || 0,
            rate: l.rate != null ? Math.abs(parseFloat(l.rate)) || null : null,
            amount: l.netamount != null ? Math.abs(parseFloat(l.netamount)) || null : null,
          });
        }
      }
      for (let i = 0; i < landedIds.length; i += FILTER_CHUNK) {
        const { error: delErr } = await service
          .from('netsuite_sales_order_lines')
          .delete()
          .in('so_id', landedIds.slice(i, i + FILTER_CHUNK));
        if (delErr) throw new Error(`Could not clear sales order lines: ${delErr.message}`);
      }
      for (let i = 0; i < lineRows.length; i += LINE_INSERT_CHUNK) {
        const chunk = lineRows.slice(i, i + LINE_INSERT_CHUNK);
        const { error: insErr } = await service.from('netsuite_sales_order_lines').insert(chunk);
        if (insErr) {
          // A header without its lines is a job the demand page can't see.
          // Count it into the heartbeat rather than losing it silently.
          lineErrors += chunk.length;
          if (lineErrorSamples.length < 5) lineErrorSamples.push(insErr.message);
          continue;
        }
        lineCount += chunk.length;
      }
      synced += idByNsId.size;

      // Cursor: everything at or above the smallest id on this page is done.
      const minId = soIds.reduce((min, id) => (Number(id) < Number(min) ? id : min), soIds[0]);
      win.beforeId = minId;
      win.processed += sos.length;

      if (sos.length < SO_PAGE_SIZE) { drained = true; break; }
      if (Date.now() >= deadline) break;
    }
  } catch (err: any) {
    lastError = err;
    error = `${stage}: ${compactSuiteqlError(err)}`;
    console.error('[sales-order-sync]', error);
  }
  // Only a NetSuite rejection is worth probing; a Supabase write failure
  // or an auth failure would just get a misleading "all probes pass".
  const probeNetSuite = !drained && isSuiteqlError(lastError) && lastError.status !== 401 && lastError.status !== 403;

  const partial = !drained && !error;
  const settled = columns;
  const droppedColumns: OptionalHeaderColumn[] = settled ? ALL_OPTIONAL_HEADER_COLUMNS.filter(c => !settled.includes(c)) : [];
  const counts = {
    modified, synced, lines: lineCount, matched, backfilled,
    ...(headerErrors > 0 ? { headerErrors, headerErrorSamples } : {}),
    ...(lineErrors > 0 ? { lineErrors, lineErrorSamples } : {}),
    // Surfaces in System Health: which nice-to-have columns this account
    // refuses, so a missing status label or estimate link isn't a mystery.
    ...(droppedColumns.length > 0 ? { droppedColumns } : {}),
  };
  // Anything short of a drained window keeps its cursor (when a page landed)
  // so the next run continues rather than starting over — that restart loop
  // is exactly what kept the mirror empty.
  const resume: SoSyncResume | null = !drained && win.beforeId
    ? { windowStartedAt: win.windowStartedAt, since: win.since, beforeId: win.beforeId, processed: win.processed }
    : null;

  const writeFailure = () => recordHeartbeat(
    service, SO_SYNC_TYPE,
    { ...counts, ...(error ? { error } : { partial: true }), ...(resume ? { resume } : {}) },
    { touchLastSyncedAt: false },
  );

  let syncStateWrite: HeartbeatResult;
  if (drained) {
    syncStateWrite = await recordHeartbeat(service, SO_SYNC_TYPE, counts, { lastSyncedAt: win.windowStartedAt });
  } else {
    // The cursor lands FIRST — the diagnosis below makes more NetSuite
    // calls, and if the platform cuts the run off during them, progress
    // must already be saved.
    syncStateWrite = await writeFailure();
    if (probeNetSuite) {
      try {
        const { verdict } = await diagnoseSoQueries(win.since);
        error = `${error} — ${verdict}`;
        syncStateWrite = await writeFailure();
      } catch (diagErr: any) {
        console.error('[sales-order-sync] diagnosis failed:', diagErr?.message || diagErr);
      }
    }
  }

  return {
    modified, synced, lines: lineCount, matched, backfilled, headerErrors,
    partial, windowProcessed: win.processed, droppedColumns,
    ...(error ? { error } : {}),
    syncStateWrite,
  };
}
