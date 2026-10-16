import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuiteqlError, suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { writeSyncStateCursor } from '@/lib/ledger/write';
import { isoDate } from '@/lib/financials-data';
import { compactSuiteqlError, parseSoSyncResume, type SoSyncResume } from '@/lib/sales-order-sync';
import { centsToString, toCents } from './netsuite-gl';
import {
  LINK_TABLES, idList, linkedDocumentsQuery, linksByDocument, toSuiteqlDate,
  type CopyLink, type LinkTable,
} from './netsuite-deposits';

/**
 * NetSuite's bill payments, copied every two hours with the bills each one
 * paid (migration 389; owner decision 2026-10-16, thread "Replacing NetSuite
 * with FleetSuite") so the bill payment rule can be checked against them:
 * /api/cron/books-netsuite-bill-payments at :21 on odd hours, and "Copy now"
 * on the invoices page's Bill payments switch.
 *
 * The run is shaped like the deposits copy (src/lib/books/netsuite-deposits.ts):
 * a window of payments modified since the last drained run, read newest
 * first a page at a time, with a saved cursor, so the first copy of the
 * whole history can span runs and a run cut short loses nothing. For each
 * page it also reads what each payment paid from NetSuite's transaction link
 * table, as the ledger mirror reads what a customer payment paid, and the
 * type and number of each document paid. A payment's lines aren't read: the
 * rule takes where the money came from and any discount from NetSuite's
 * posting of the payment, as it does for a customer payment. Once the window
 * has drained, it lists every bill payment id NetSuite has, and
 * gl_netsuite_bill_payments_finish marks the ones NetSuite no longer has as
 * gone.
 *
 * Nothing is written to NetSuite. The run is recorded in sync_state as
 * 'books_netsuite_bill_payments' and left out of HEALTH_MONITORS, like the
 * other books jobs: the books are hidden from everyone but the owner. For the
 * same reason no amount goes in that record, in a log line or in the cron's
 * response.
 */

export const BOOKS_BILL_PAYMENTS_SYNC = 'books_netsuite_bill_payments';

/** Payments per SuiteQL page, and the unit of work between deadline checks. */
const PAGE_SIZE = 200;
/** Ids per link or name query (they ride in the SQL). */
const ID_CHUNK = 100;
/** The first run reaches back to the very first bill payment. */
const FIRST_RUN_SINCE = '2000-01-01T00:00:00Z';
/** A page, or the closing list of ids, is only started with this much of the budget left. */
const MIN_LEFT_MS = 20_000;
/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. */
const SUITEQL_OPTS = { retries: 2 };

type Row = Record<string, unknown>;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numericId = (v: unknown): string | null => (/^\d+$/.test(text(v)) ? text(v) : null);
const isRejected = (err: unknown) => isSuiteqlError(err) && err.status === 400;

// ── Queries ────────────────────────────────────────────────────────────────

/** One page of bill payments modified since `sinceIso`, newest first, continuing below `beforeId`. */
export function billPaymentHeaderQuery(sinceIso: string, beforeId: string | null, withLabels: boolean): string {
  const labels = withLabels ? ', BUILTIN.DF(t.status) AS status_label, BUILTIN.DF(t.entity) AS vendor_name' : '';
  // Never trust a stored string into SQL, even one we wrote ourselves.
  const before = beforeId && /^\d+$/.test(beforeId) ? `\n        AND t.id < ${beforeId}` : '';
  return `
      SELECT t.id, t.type, t.tranid, t.trandate, t.status, t.memo, t.foreigntotal AS total, t.entity AS vendor_id${labels}
      FROM transaction t
      WHERE t.type = 'VendPymt'
        AND t.lastmodifieddate >= TO_DATE('${toSuiteqlDate(sinceIso)}', 'MM/DD/YYYY')${before}
      ORDER BY t.id DESC
    `;
}

/** What each payment paid: the documents before it in NetSuite's link table. */
export function billPaymentLinksQuery(table: LinkTable, ids: string[]): string {
  return `
      SELECT previousdoc, nextdoc, foreignamount, linktype
      FROM ${table}
      WHERE nextdoc IN (${idList(ids)})
    `;
}

/** Every bill payment id NetSuite has, for marking the ones it no longer has. */
export const BILL_PAYMENT_IDS_QUERY = `SELECT t.id FROM transaction t WHERE t.type = 'VendPymt' ORDER BY t.id`;

// ── Rows ───────────────────────────────────────────────────────────────────

export interface BillPaymentCopyRow {
  netsuite_id: string;
  tran_type: 'VendPymt';
  tranid: string | null;
  trandate: string;
  vendor_netsuite_id: string | null;
  vendor_name: string | null;
  total: string;
  status: string | null;
  status_label: string | null;
  voided: boolean;
  memo: string | null;
  /** Left out when the run couldn't read NetSuite's links: the copy then keeps the ones it has. */
  links?: CopyLink[];
}

/**
 * A page of NetSuite's headers → rows for gl_netsuite_bill_payments_apply. A
 * payment with no date or a total FleetSuite can't read is left out and
 * named in `unreadable`. `links` null means the run couldn't read them.
 */
export function mapBillPayments(rows: Row[], links: Map<string, CopyLink[]> | null): { rows: BillPaymentCopyRow[]; unreadable: string[] } {
  const out: BillPaymentCopyRow[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    const id = numericId(row.id);
    const trandate = isoDate(row.trandate);
    let cents: number | null;
    try {
      cents = toCents(row.total);
    } catch {
      cents = null;
    }
    if (!id || text(row.type) !== 'VendPymt' || !trandate || cents === null) {
      unreadable.push(text(row.tranid) || `NetSuite ${text(row.id) || 'document'}`);
      continue;
    }
    const label = text(row.status_label) || null;
    out.push({
      netsuite_id: id,
      tran_type: 'VendPymt',
      tranid: text(row.tranid) || null,
      trandate,
      vendor_netsuite_id: numericId(row.vendor_id),
      vendor_name: text(row.vendor_name) || null,
      // NetSuite signs purchase-side totals as it pleases; the copy keeps them positive.
      total: centsToString(Math.abs(cents)),
      status: text(row.status) || null,
      status_label: label,
      voided: !!label && /\bvoid/i.test(label),
      memo: text(row.memo) || null,
      ...(links ? { links: links.get(id) ?? [] } : {}),
    });
  }
  return { rows: out, unreadable };
}

// ── The run ────────────────────────────────────────────────────────────────

export interface BillPaymentCopyResult {
  /** Payments NetSuite returned this run. */
  read: number;
  added: number;
  changed: number;
  /** Payments NetSuite no longer has, marked gone this run. */
  gone?: number;
  /** Where the links came from; null when NetSuite wouldn't give them this run. */
  linkTable?: LinkTable | null;
  /** Stopped for time with more to read; the next run carries on. */
  partial?: boolean;
  /** What the run couldn't do, in plain words. */
  notes?: string[];
  error?: string;
}

export interface BillPaymentCopyDeps {
  /** The first `limit` rows of a query. */
  page?: (query: string, limit: number) => Promise<Row[]>;
  /** Every row of a query (all pages). */
  query?: (query: string) => Promise<Row[]>;
  /** Payments per page; tests use small pages to cross page boundaries. */
  pageSize?: number;
  now?: () => number;
}

export async function copyNetSuiteBillPayments(
  service: SupabaseClient,
  opts: { deadline: number; deps?: BillPaymentCopyDeps },
): Promise<BillPaymentCopyResult & { heartbeat?: HeartbeatResult }> {
  const now = opts.deps?.now ?? Date.now;
  const query = opts.deps?.query ?? ((q: string) => suiteqlQueryAll(q, 1000, SUITEQL_OPTS) as Promise<Row[]>);
  const page = opts.deps?.page ?? (async (q: string, limit: number) => ((await suiteqlQuery(q, limit, 0, SUITEQL_OPTS))?.items ?? []) as Row[]);
  const pageSize = opts.deps?.pageSize ?? PAGE_SIZE;
  const timeLeft = () => opts.deadline - now();
  const startedAt = now();

  // Open the window, or carry on with the one a run cut short.
  const { data: state } = await service
    .from('sync_state')
    .select('last_synced_at, last_result')
    .eq('sync_type', BOOKS_BILL_PAYMENTS_SYNC)
    .maybeSingle();
  const resume = parseSoSyncResume(state?.last_result);
  const win: { windowStartedAt: string; since: string; beforeId: string | null; processed: number } = resume
    ? { ...resume }
    : (() => {
        // Overlap one day so edits right around a run are never missed.
        const since = new Date(state?.last_synced_at || FIRST_RUN_SINCE);
        since.setUTCDate(since.getUTCDate() - 1);
        return { windowStartedAt: new Date(now()).toISOString(), since: since.toISOString(), beforeId: null, processed: 0 };
      })();

  const result: BillPaymentCopyResult = { read: 0, added: 0, changed: 0 };
  const notes: string[] = [];
  const unreadable: string[] = [];
  let withLabels: boolean | null = null;
  // undefined: not tried yet this run.
  let linkTable: LinkTable | null | undefined;
  let drained = false;
  let stage = 'opening the window';

  const record = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...result };
    const said = [...notes];
    if (unreadable.length) {
      said.push(`NetSuite sent ${unreadable.length === 1 ? 'a bill payment' : `${unreadable.length} bill payments`} with no date or a total `
        + `FleetSuite can't read, so ${unreadable.length === 1 ? "it isn't" : "they aren't"} copied: ${unreadable.slice(0, 10).join(', ')}`
        + `${unreadable.length > 10 ? ', …' : ''}.`);
    }
    if (said.length) out.notes = said;
    if (!drained && win.beforeId) {
      const keep: SoSyncResume = { windowStartedAt: win.windowStartedAt, since: win.since, beforeId: win.beforeId, processed: win.processed };
      out.resume = keep;
    }
    return out;
  };

  const headerPage = async (): Promise<Row[]> => {
    if (withLabels === null) {
      try {
        const rows = await page(billPaymentHeaderQuery(win.since, win.beforeId, true), pageSize);
        withLabels = true;
        return rows;
      } catch (err) {
        if (!isRejected(err)) throw err;
        withLabels = false;
        notes.push("NetSuite wouldn't give the payments' status in words, so voided ones aren't marked as voided, and vendors are named "
          + "from the copy of NetSuite's vendors.");
      }
    }
    return page(billPaymentHeaderQuery(win.since, win.beforeId, withLabels), pageSize);
  };

  // A page's link rows; null when NetSuite answers neither link table.
  const readLinks = async (ids: string[]): Promise<Row[] | null> => {
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      if (linkTable === undefined) {
        let refused: unknown = null;
        for (const table of LINK_TABLES) {
          try {
            rows.push(...await query(billPaymentLinksQuery(table, chunk)));
            linkTable = table;
            break;
          } catch (err) {
            if (!isRejected(err)) throw err;
            refused = err;
          }
        }
        if (linkTable === undefined) {
          linkTable = null;
          notes.push(`NetSuite wouldn't list what the payments are linked to (${compactSuiteqlError(refused)}), so which bills each `
            + 'one paid isn\'t copied this time.');
        }
      } else if (linkTable !== null) {
        rows.push(...await query(billPaymentLinksQuery(linkTable, chunk)));
      }
      if (linkTable === null) return null;
    }
    return rows;
  };

  const readNames = async (ids: string[]) => {
    const names = new Map<string, { type: string | null; number: string | null }>();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      for (const r of await query(linkedDocumentsQuery(ids.slice(i, i + ID_CHUNK)))) {
        const id = numericId(r.id);
        if (id) names.set(id, { type: text(r.type) || null, number: text(r.tranid) || null });
      }
    }
    return names;
  };

  try {
    for (;;) {
      if (timeLeft() < MIN_LEFT_MS) break;
      const where = win.beforeId ? `below NetSuite id ${win.beforeId}` : 'from the newest';
      stage = `bill payments ${where}`;
      const rows = await headerPage();
      if (rows.length === 0) {
        drained = true;
        break;
      }
      result.read += rows.length;
      const ids = rows.map((r) => numericId(r.id)).filter((id): id is string => id !== null);

      stage = `what bill payments ${where} paid`;
      let links: Map<string, CopyLink[]> | null = null;
      const linkRows = ids.length ? await readLinks(ids) : [];
      if (linkRows) {
        const linked = [...new Set(linkRows.map((l) => numericId(l.previousdoc)).filter((id): id is string => id !== null))];
        links = linksByDocument(linkRows, linked.length ? await readNames(linked) : new Map());
      }

      stage = 'writing the copy';
      const mapped = mapBillPayments(rows, links);
      unreadable.push(...mapped.unreadable);
      if (mapped.rows.length) {
        const applied = await service.rpc('gl_netsuite_bill_payments_apply', { p: { rows: mapped.rows } });
        if (applied.error) throw new Error(applied.error.message);
        result.added += Number((applied.data as any)?.added) || 0;
        result.changed += Number((applied.data as any)?.changed) || 0;
      }

      // Everything at or above the smallest id on this page is copied.
      if (ids.length) win.beforeId = ids.reduce((min, id) => (Number(id) < Number(min) ? id : min), ids[0]);
      win.processed += rows.length;
      if (rows.length < pageSize || !ids.length) {
        drained = true;
        break;
      }
      await writeSyncStateCursor(service, BOOKS_BILL_PAYMENTS_SYNC, record());
    }

    if (!drained) {
      result.partial = true;
    } else if (timeLeft() < MIN_LEFT_MS) {
      notes.push("There wasn't time left to check for payments NetSuite no longer has; the next run will.");
    } else {
      stage = 'listing every bill payment';
      const ids = (await query(BILL_PAYMENT_IDS_QUERY)).map((r) => numericId(r.id)).filter((id): id is string => id !== null);
      const finished = await service.rpc('gl_netsuite_bill_payments_finish', { p: { netsuite_ids: ids } });
      if (finished.error) throw new Error(finished.error.message);
      const f = (finished.data ?? {}) as { listed?: number; here?: number; gone?: number; cut_short?: boolean };
      result.gone = Number(f.gone) || 0;
      if (f.cut_short) {
        notes.push(`NetSuite listed ${(Number(f.listed) || 0).toLocaleString('en-US')} bill payments and FleetSuite has `
          + `${(Number(f.here) || 0).toLocaleString('en-US')}, so none were marked gone.`);
      }
    }
  } catch (err) {
    result.error = `${stage}: ${compactSuiteqlError(err)}`;
    console.error('[books] NetSuite bill payments copy:', result.error);
  }
  if (linkTable !== undefined) result.linkTable = linkTable;

  const recorded = record();
  const heartbeat = await recordHeartbeat(service, BOOKS_BILL_PAYMENTS_SYNC, recorded, {
    startedAt,
    records: result.read,
    // last_synced_at moves only when a window drains, to the time it was opened.
    ...(drained ? { lastSyncedAt: win.windowStartedAt } : { touchLastSyncedAt: false }),
  });
  return { ...result, ...(recorded.notes ? { notes: recorded.notes as string[] } : {}), heartbeat };
}
