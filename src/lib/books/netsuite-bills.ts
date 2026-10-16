import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuiteqlError, suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { writeSyncStateCursor } from '@/lib/ledger/write';
import { isoDate } from '@/lib/financials-data';
import { compactSuiteqlError, parseSoSyncResume, type SoSyncResume } from '@/lib/sales-order-sync';
import { centsToString, toCents } from './netsuite-gl';
import {
  LINK_TABLES, depositLinksQuery, idList, linkedDocumentsQuery, linksByDocument, toSuiteqlDate,
  type CopyLink, type LinkTable,
} from './netsuite-deposits';
import type { BillType } from './bill-rule';

/**
 * NetSuite's vendor bills and bill credits, copied every two hours with
 * their lines (migration 384; owner decision 2026-10-16, thread "Replacing
 * NetSuite with FleetSuite") so the bill rule can be checked against them:
 * /api/cron/books-netsuite-bills at :39 on odd hours, and "Copy now" on the
 * invoices page's Bills switch.
 *
 * The run is shaped like the deposits copy (src/lib/books/netsuite-deposits.ts):
 * a window of documents modified since the last drained run, read newest
 * first a page at a time, with a saved cursor, so the first copy of the
 * whole history can span runs and a run cut short loses nothing. For each
 * page it also reads each document's lines (its items and expense lines,
 * not the payables line), and the documents it came from in NetSuite's
 * transaction link table: a bill's purchase order and item receipts. Once
 * the window has drained, it lists every bill and bill credit id NetSuite
 * has, and gl_netsuite_bills_finish marks the ones NetSuite no longer has
 * as gone.
 *
 * Nothing is written to NetSuite. The run is recorded in sync_state as
 * 'books_netsuite_bills' and left out of HEALTH_MONITORS, like the other
 * books jobs: the books are hidden from everyone but the owner. For the same
 * reason no amount goes in that record, in a log line or in the cron's
 * response.
 */

export const BOOKS_BILLS_SYNC = 'books_netsuite_bills';

/** Documents per SuiteQL page, and the unit of work between deadline checks. */
const PAGE_SIZE = 200;
/** Ids per line, link or name query (they ride in the SQL). */
const ID_CHUNK = 100;
/** The first run reaches back to the very first bill. */
const FIRST_RUN_SINCE = '2000-01-01T00:00:00Z';
/** A page, or the closing list of ids, is only started with this much of the budget left. */
const MIN_LEFT_MS = 20_000;
/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. */
const SUITEQL_OPTS = { retries: 2 };

type Row = Record<string, unknown>;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numericId = (v: unknown): string | null => (/^\d+$/.test(text(v)) ? text(v) : null);
const isTrue = (v: unknown): boolean => v === true || text(v).toUpperCase() === 'T';
const isRejected = (err: unknown) => isSuiteqlError(err) && err.status === 400;

// ── Queries ────────────────────────────────────────────────────────────────

/** One page of bills and bill credits modified since `sinceIso`, newest first, continuing below `beforeId`. */
export function billHeaderQuery(sinceIso: string, beforeId: string | null, withLabels: boolean): string {
  const labels = withLabels ? ', BUILTIN.DF(t.status) AS status_label, BUILTIN.DF(t.entity) AS vendor_name' : '';
  // Never trust a stored string into SQL, even one we wrote ourselves.
  const before = beforeId && /^\d+$/.test(beforeId) ? `\n        AND t.id < ${beforeId}` : '';
  return `
      SELECT t.id, t.type, t.tranid, t.trandate, t.status, t.memo, t.foreigntotal AS total, t.entity AS vendor_id${labels}
      FROM transaction t
      WHERE t.type IN ('VendBill', 'VendCred')
        AND t.lastmodifieddate >= TO_DATE('${toSuiteqlDate(sinceIso)}', 'MM/DD/YYYY')${before}
      ORDER BY t.id DESC
    `;
}

/** The documents' lines but the payables line; `withAccount` asks for each expense line's account. */
export function billLinesQuery(ids: string[], withAccount: boolean): string {
  const account = withAccount ? ' tl.expenseaccount AS account,' : '';
  return `
      SELECT tl.transaction AS bill_id, tl.id AS line_id, tl.item,${account} tl.netamount AS amount, tl.quantity, tl.memo, tl.taxline
      FROM transactionline tl
      WHERE tl.transaction IN (${idList(ids)})
        AND tl.mainline = 'F'
      ORDER BY tl.transaction, tl.id
    `;
}

/** Every bill and bill credit id NetSuite has, for marking the ones it no longer has. */
export const BILL_IDS_QUERY = `SELECT t.id FROM transaction t WHERE t.type IN ('VendBill', 'VendCred') ORDER BY t.id`;

// ── Rows ───────────────────────────────────────────────────────────────────

/** One line of a bill or bill credit, as gl_netsuite_bills_apply takes it; the amount signed as NetSuite gives it. */
export interface CopyLine {
  line_id: string;
  /** The item's NetSuite id; null on an expense line. NetSuite's own lines, a subtotal say, carry ids below 1. */
  item: string | null;
  /** The line's expense account, when NetSuite gives one. */
  account: string | null;
  /** Null when NetSuite sent an amount FleetSuite can't read. */
  amount: string | null;
  quantity: string | null;
  memo: string | null;
  tax: boolean;
}

export interface BillCopyRow {
  netsuite_id: string;
  tran_type: BillType;
  tranid: string | null;
  trandate: string;
  vendor_netsuite_id: string | null;
  vendor_name: string | null;
  total: string;
  status: string | null;
  status_label: string | null;
  voided: boolean;
  memo: string | null;
  /** Left out when the run couldn't read the document's lines: the copy then keeps the ones it has. */
  lines?: CopyLine[];
  /** Left out when the run couldn't read NetSuite's links: the copy then keeps the ones it has. */
  links?: CopyLink[];
}

/**
 * NetSuite's line rows → each document's lines, in NetSuite's order. A
 * document with a line FleetSuite can't tell apart (no line id) is named in
 * `unreadable`: its lines aren't copied, so the copy keeps the ones it has.
 */
export function linesByBill(rows: Row[]): { lines: Map<string, CopyLine[]>; unreadable: Set<string> } {
  const lines = new Map<string, CopyLine[]>();
  const unreadable = new Set<string>();
  for (const r of rows) {
    const bill = numericId(r.bill_id);
    if (!bill) continue;
    const lineId = numericId(r.line_id);
    if (!lineId) {
      unreadable.add(bill);
      continue;
    }
    let amount: string | null;
    try {
      amount = centsToString(toCents(r.amount));
    } catch {
      amount = null;
    }
    const item = /^-?\d+$/.test(text(r.item)) ? text(r.item) : null;
    const list = lines.get(bill) ?? [];
    list.push({
      line_id: lineId,
      item,
      account: numericId(r.account),
      amount,
      quantity: text(r.quantity) || null,
      memo: text(r.memo) || null,
      tax: isTrue(r.taxline),
    });
    lines.set(bill, list);
  }
  for (const list of lines.values()) list.sort((a, b) => Number(a.line_id) - Number(b.line_id));
  for (const bill of unreadable) lines.delete(bill);
  return { lines, unreadable };
}

/**
 * A page of NetSuite's headers → rows for gl_netsuite_bills_apply. A document
 * with no date or a total FleetSuite can't read is left out and named in
 * `unreadable`. `lines` or `links` null means the run couldn't read them; a
 * document missing from `lines` keeps the lines it has.
 */
export function mapBills(
  rows: Row[],
  lines: Map<string, CopyLine[]> | null,
  links: Map<string, CopyLink[]> | null,
): { rows: BillCopyRow[]; unreadable: string[] } {
  const out: BillCopyRow[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    const id = numericId(row.id);
    const type = text(row.type);
    const trandate = isoDate(row.trandate);
    let cents: number | null;
    try {
      cents = toCents(row.total);
    } catch {
      cents = null;
    }
    if (!id || (type !== 'VendBill' && type !== 'VendCred') || !trandate || cents === null) {
      unreadable.push(text(row.tranid) || `NetSuite ${text(row.id) || 'document'}`);
      continue;
    }
    const label = text(row.status_label) || null;
    const ownLines = lines?.get(id);
    out.push({
      netsuite_id: id,
      tran_type: type,
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
      ...(ownLines ? { lines: ownLines } : {}),
      ...(links ? { links: links.get(id) ?? [] } : {}),
    });
  }
  return { rows: out, unreadable };
}

// ── The run ────────────────────────────────────────────────────────────────

export interface BillCopyResult {
  /** Documents NetSuite returned this run. */
  read: number;
  added: number;
  changed: number;
  /** Documents NetSuite no longer has, marked gone this run. */
  gone?: number;
  /** Where the links came from; null when NetSuite wouldn't give them this run. */
  linkTable?: LinkTable | null;
  /** Stopped for time with more to read; the next run carries on. */
  partial?: boolean;
  /** What the run couldn't do, in plain words. */
  notes?: string[];
  error?: string;
}

export interface BillCopyDeps {
  /** The first `limit` rows of a query. */
  page?: (query: string, limit: number) => Promise<Row[]>;
  /** Every row of a query (all pages). */
  query?: (query: string) => Promise<Row[]>;
  /** Documents per page; tests use small pages to cross page boundaries. */
  pageSize?: number;
  now?: () => number;
}

export async function copyNetSuiteBills(
  service: SupabaseClient,
  opts: { deadline: number; deps?: BillCopyDeps },
): Promise<BillCopyResult & { heartbeat?: HeartbeatResult }> {
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
    .eq('sync_type', BOOKS_BILLS_SYNC)
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

  const result: BillCopyResult = { read: 0, added: 0, changed: 0 };
  const notes: string[] = [];
  const unreadable: string[] = [];
  const unreadableLines: string[] = [];
  let withLabels: boolean | null = null;
  // undefined: not tried yet this run; false: NetSuite refused it this run.
  let withAccount: boolean | undefined;
  let linesRefused = false;
  let linkTable: LinkTable | null | undefined;
  let drained = false;
  let stage = 'opening the window';

  const record = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...result };
    const said = [...notes];
    if (unreadable.length) {
      said.push(`NetSuite sent ${unreadable.length === 1 ? 'a document' : `${unreadable.length} documents`} with no date or a total `
        + `FleetSuite can't read, so ${unreadable.length === 1 ? "it isn't" : "they aren't"} copied: ${unreadable.slice(0, 10).join(', ')}`
        + `${unreadable.length > 10 ? ', …' : ''}.`);
    }
    if (unreadableLines.length) {
      said.push(`NetSuite sent a line with no line id on ${unreadableLines.length === 1 ? 'a document' : `${unreadableLines.length} documents`}, `
        + `so ${unreadableLines.length === 1 ? 'its lines aren\'t' : 'their lines aren\'t'} copied this time: ${unreadableLines.slice(0, 10).join(', ')}`
        + `${unreadableLines.length > 10 ? ', …' : ''}.`);
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
        const rows = await page(billHeaderQuery(win.since, win.beforeId, true), pageSize);
        withLabels = true;
        return rows;
      } catch (err) {
        if (!isRejected(err)) throw err;
        withLabels = false;
        notes.push("NetSuite wouldn't give the documents' status in words, so voided ones aren't marked as voided, and vendors are named from "
          + 'the copy of NetSuite\'s vendors.');
      }
    }
    return page(billHeaderQuery(win.since, win.beforeId, withLabels), pageSize);
  };

  // A page's line rows; null when NetSuite won't give the lines at all.
  const readLines = async (ids: string[]): Promise<Row[] | null> => {
    if (linesRefused) return null;
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      if (withAccount !== false) {
        try {
          rows.push(...await query(billLinesQuery(chunk, true)));
          withAccount = true;
          continue;
        } catch (err) {
          if (!isRejected(err) || withAccount === true) throw err;
        }
      }
      try {
        rows.push(...await query(billLinesQuery(chunk, false)));
      } catch (err) {
        if (!isRejected(err)) throw err;
        linesRefused = true;
        notes.push(`NetSuite wouldn't give the documents' lines (${compactSuiteqlError(err)}), so they aren't copied this time; the ones `
          + 'already copied keep theirs.');
        return null;
      }
      if (withAccount === undefined) {
        withAccount = false;
        notes.push("NetSuite wouldn't say which account each expense line goes to, so bills with expense lines can't be worked out this time.");
      }
    }
    return rows;
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
            rows.push(...await query(depositLinksQuery(table, chunk)));
            linkTable = table;
            break;
          } catch (err) {
            if (!isRejected(err)) throw err;
            refused = err;
          }
        }
        if (linkTable === undefined) {
          linkTable = null;
          notes.push(`NetSuite wouldn't list what the documents are linked to (${compactSuiteqlError(refused)}), so which bills came from `
            + 'a purchase order isn\'t copied this time.');
        }
      } else if (linkTable !== null) {
        rows.push(...await query(depositLinksQuery(linkTable, chunk)));
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
      stage = `bills ${where}`;
      const rows = await headerPage();
      if (rows.length === 0) {
        drained = true;
        break;
      }
      result.read += rows.length;
      const ids = rows.map((r) => numericId(r.id)).filter((id): id is string => id !== null);

      stage = `the lines of bills ${where}`;
      let lines: Map<string, CopyLine[]> | null = null;
      const lineRows = ids.length ? await readLines(ids) : [];
      if (lineRows) {
        const read = linesByBill(lineRows);
        lines = read.lines;
        // A document NetSuite gave no lines for has none but its payables line; one whose lines couldn't be told apart keeps its own.
        for (const id of ids) if (!lines.has(id) && !read.unreadable.has(id)) lines.set(id, []);
        for (const r of rows) {
          const id = numericId(r.id);
          if (id && read.unreadable.has(id)) unreadableLines.push(text(r.tranid) || `NetSuite ${id}`);
        }
      }

      stage = `what bills ${where} came from`;
      let links: Map<string, CopyLink[]> | null = null;
      const linkRows = ids.length ? await readLinks(ids) : [];
      if (linkRows) {
        const linked = [...new Set(linkRows.map((l) => numericId(l.previousdoc)).filter((id): id is string => id !== null))];
        links = linksByDocument(linkRows, linked.length ? await readNames(linked) : new Map());
      }

      stage = 'writing the copy';
      const mapped = mapBills(rows, lines, links);
      unreadable.push(...mapped.unreadable);
      if (mapped.rows.length) {
        const applied = await service.rpc('gl_netsuite_bills_apply', { p: { rows: mapped.rows } });
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
      await writeSyncStateCursor(service, BOOKS_BILLS_SYNC, record());
    }

    if (!drained) {
      result.partial = true;
    } else if (timeLeft() < MIN_LEFT_MS) {
      notes.push("There wasn't time left to check for documents NetSuite no longer has; the next run will.");
    } else {
      stage = 'listing every bill and bill credit';
      const ids = (await query(BILL_IDS_QUERY)).map((r) => numericId(r.id)).filter((id): id is string => id !== null);
      const finished = await service.rpc('gl_netsuite_bills_finish', { p: { netsuite_ids: ids } });
      if (finished.error) throw new Error(finished.error.message);
      const f = (finished.data ?? {}) as { listed?: number; here?: number; gone?: number; cut_short?: boolean };
      result.gone = Number(f.gone) || 0;
      if (f.cut_short) {
        notes.push(`NetSuite listed ${(Number(f.listed) || 0).toLocaleString('en-US')} bills and bill credits and FleetSuite has `
          + `${(Number(f.here) || 0).toLocaleString('en-US')}, so none were marked gone.`);
      }
    }
  } catch (err) {
    result.error = `${stage}: ${compactSuiteqlError(err)}`;
    console.error('[books] NetSuite bills copy:', result.error);
  }
  if (linkTable !== undefined) result.linkTable = linkTable;

  const recorded = record();
  const heartbeat = await recordHeartbeat(service, BOOKS_BILLS_SYNC, recorded, {
    startedAt,
    records: result.read,
    // last_synced_at moves only when a window drains, to the time it was opened.
    ...(drained ? { lastSyncedAt: win.windowStartedAt } : { touchLastSyncedAt: false }),
  });
  return { ...result, ...(recorded.notes ? { notes: recorded.notes as string[] } : {}), heartbeat };
}
