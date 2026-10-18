import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuiteqlError, suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { writeSyncStateCursor } from '@/lib/ledger/write';
import { isoDate } from '@/lib/financials-data';
import { compactSuiteqlError, parseSoSyncResume, type SoSyncResume } from '@/lib/sales-order-sync';
import type { BooksCompany } from './journal';
import { centsToString, toCents } from './netsuite-gl';
import { idList, toSuiteqlDate } from './netsuite-deposits';
import type { CountsBy } from './stock-items';

/**
 * NetSuite's stock moves, copied every two hours so FleetSuite counts each
 * item itself (migration 401; owner decision 2026-10-18, thread "Replacing
 * NetSuite with FleetSuite", "Stock by item"; docs/books.md "Stock by
 * item"): /api/cron/books-netsuite-stock at :43 on odd hours, and "Copy now"
 * on the Stock by item page.
 *
 * Each run copies the documents dated from January 1, 2025 with a line that
 * moves stock (transactionline.isinventoryaffecting) and were changed since
 * the last run, shaped like the deposits copy (netsuite-deposits.ts): a
 * window of documents modified since the last drained run, newest first a
 * page at a time, with a saved cursor, so the first copy of the whole
 * history can span runs and a run cut short loses nothing. For each page it
 * reads every line of those documents that names an item. Once the window
 * has drained, it lists every such document NetSuite has, and
 * gl_netsuite_stock_finish marks the ones it no longer has as gone; then it
 * reads where each item's count starts (its count and value at each
 * location on December 31, 2024, from NetSuite's own lines before 2025) and
 * NetSuite's own count of each item now, last, so the count is read as
 * close as it can be to the copy it's checked against.
 *
 * Nothing is written to NetSuite. The run is recorded in sync_state as
 * 'books_netsuite_stock' and left out of HEALTH_MONITORS, like the other
 * books jobs: the books are hidden from everyone but the owner. For the same
 * reason no amount goes in that record, in a log line or in the cron's
 * response.
 */

export const BOOKS_STOCK_SYNC = 'books_netsuite_stock';

/** Documents per SuiteQL page, and the unit of work between deadline checks. */
const PAGE_SIZE = 200;
/** Document ids per line query (they ride in the SQL). */
const ID_CHUNK = 100;
/** The first run reaches back to every document. */
const FIRST_RUN_SINCE = '2000-01-01T00:00:00Z';
/** A page, the closing list of ids or a read of the counts is only started with this much of the budget left. */
const MIN_LEFT_MS = 20_000;
/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. */
const SUITEQL_OPTS = { retries: 2 };

type Row = Record<string, unknown>;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numericId = (v: unknown): string | null => (/^\d+$/.test(text(v)) ? text(v) : null);
const isTrue = (v: unknown): boolean => v === true || text(v).toUpperCase() === 'T';
const isRejected = (err: unknown) => isSuiteqlError(err) && err.status === 400;

/** The day the copy starts, as SuiteQL takes it: the books' copies start on January 1, 2025 (netsuite-gl.ts COPY_FROM). */
const FROM_DATE = "TO_DATE('01/01/2025', 'MM/DD/YYYY')";

// ── Queries ────────────────────────────────────────────────────────────────

/** One page of the documents dated from 2025 with a line that moves stock, modified since `sinceIso`, newest first, below `beforeId`. */
export function stockDocumentsQuery(sinceIso: string, beforeId: string | null): string {
  // Never trust a stored string into SQL, even one we wrote ourselves.
  const before = beforeId && /^\d+$/.test(beforeId) ? `\n        AND t.id < ${beforeId}` : '';
  return `
      SELECT DISTINCT t.id, t.type, t.tranid, t.trandate
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
      WHERE tl.isinventoryaffecting = 'T'
        AND t.trandate >= ${FROM_DATE}
        AND t.lastmodifieddate >= TO_DATE('${toSuiteqlDate(sinceIso)}', 'MM/DD/YYYY')${before}
      ORDER BY t.id DESC
    `;
}

/** Every line of these documents that names an item, but their main lines and tax lines. */
export function stockLinesQuery(ids: string[]): string {
  return `
      SELECT tl.transaction AS txn_id, tl.id AS line_id, tl.item AS item_id, tl.location AS location_id,
             tl.subsidiary AS subsidiary_id, tl.quantity, tl.isinventoryaffecting AS moves_stock
      FROM transactionline tl
      WHERE tl.transaction IN (${idList(ids)})
        AND tl.item IS NOT NULL
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
      ORDER BY tl.transaction, tl.id
    `;
}

/** The id of every document dated from 2025 with a line that moves stock, for marking the ones NetSuite no longer has. */
export const STOCK_IDS_QUERY = `
      SELECT DISTINCT tl.transaction AS id
      FROM transactionline tl
      JOIN transaction t ON t.id = tl.transaction
      WHERE tl.isinventoryaffecting = 'T'
        AND t.trandate >= ${FROM_DATE}
      ORDER BY tl.transaction
    `;

/** Each item's count at each location on December 31, 2024: every line that moved it before 2025, added up. */
export const OPENING_QUANTITY_QUERY = `
      SELECT tl.subsidiary AS subsidiary_id, tl.item AS item_id, tl.location AS location_id, SUM(tl.quantity) AS quantity
      FROM transactionline tl
      JOIN transaction t ON t.id = tl.transaction
      WHERE tl.isinventoryaffecting = 'T'
        AND t.trandate < ${FROM_DATE}
      GROUP BY tl.subsidiary, tl.item, tl.location
      ORDER BY tl.subsidiary, tl.item, tl.location
    `;

/** Each item's value at each location on December 31, 2024: what NetSuite posted to the inventory accounts on its lines before 2025. */
export function openingValueQuery(accounts: string[]): string {
  return `
      SELECT tl.subsidiary AS subsidiary_id, tl.item AS item_id, tl.location AS location_id,
             SUM(NVL(tal.debit, 0)) AS debit, SUM(NVL(tal.credit, 0)) AS credit
      FROM transactionaccountingline tal
      JOIN transaction t ON t.id = tal.transaction
      JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
      WHERE tal.posting = 'T'
        AND tal.account IN (${idList(accounts)})
        AND tl.item IS NOT NULL
        AND t.trandate < ${FROM_DATE}
      GROUP BY tl.subsidiary, tl.item, tl.location
      ORDER BY tl.subsidiary, tl.item, tl.location
    `;
}

/**
 * How NetSuite's own counts are read, in the order they're tried: each
 * item's count and value at each location, its count there alone, or each
 * item's company-wide count, which the parts catalog already reads.
 */
export type CountsRead = 'location_value' | 'location' | 'item';
export const COUNTS_READS: readonly CountsRead[] = ['location_value', 'location', 'item'];

export function countsQuery(read: CountsRead): string {
  if (read === 'item') {
    return `
      SELECT i.id AS item_id, i.totalquantityonhand AS quantity
      FROM item i
      WHERE NVL(i.totalquantityonhand, 0) <> 0
      ORDER BY i.id
    `;
  }
  const value = read === 'location_value';
  return `
      SELECT ail.item AS item_id, ail.location AS location_id, ail.quantityonhand AS quantity${value ? ', ail.onhandvaluemli AS value' : ''}
      FROM aggregateitemlocation ail
      WHERE NVL(ail.quantityonhand, 0) <> 0${value ? ' OR NVL(ail.onhandvaluemli, 0) <> 0' : ''}
      ORDER BY ail.item, ail.location
    `;
}

// ── Rows ───────────────────────────────────────────────────────────────────

/** A quantity as NetSuite sends one, as a plain decimal string ('0' for none), or null when it isn't a number. */
export function quantityString(v: unknown): string | null {
  const s = text(v);
  if (s === '') return '0';
  let out: string;
  // A JS number carries float noise (0.1 + 0.2), so it rounds to 8 places;
  // NetSuite's own text is kept exactly as sent.
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    out = v.toFixed(8);
  } else if (/^-?\d+(\.\d+)?$/.test(s)) out = s;
  else if (/^-?\.\d+$/.test(s)) out = s.replace('.', '0.');
  else {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    out = n.toFixed(8);
  }
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return /^-0*$/.test(out) ? '0' : out;
}

export interface StockCopyLine {
  line_id: string;
  company: BooksCompany;
  item_id: string;
  location_id: string | null;
  quantity: string;
  moves_stock: boolean;
}

export interface StockCopyDocument {
  netsuite_id: string;
  tran_type: string;
  tranid: string | null;
  trandate: string;
  lines: StockCopyLine[];
}

/**
 * A page of NetSuite's documents and their lines → what
 * gl_netsuite_stock_apply takes. Lines of subsidiaries no company is linked
 * to are left out, and a document left with none isn't copied. A document
 * with no date, or a line whose quantity FleetSuite can't read, is left out
 * whole and named in `unreadable`, so a count is never made of part of one.
 */
export function mapStockDocuments(
  headers: Row[],
  lineRows: Row[],
  links: Map<string, BooksCompany>,
): { documents: StockCopyDocument[]; unreadable: string[] } {
  const linesOf = new Map<string, Row[]>();
  for (const r of lineRows) {
    const id = numericId(r.txn_id);
    if (!id) continue;
    const rows = linesOf.get(id) ?? [];
    rows.push(r);
    linesOf.set(id, rows);
  }
  const documents: StockCopyDocument[] = [];
  const unreadable: string[] = [];
  for (const h of headers) {
    const id = numericId(h.id);
    const trandate = isoDate(h.trandate);
    const name = text(h.tranid) || `NetSuite ${text(h.id) || 'document'}`;
    if (!id || !trandate || !text(h.type)) {
      unreadable.push(name);
      continue;
    }
    const lines: StockCopyLine[] = [];
    const seen = new Set<string>();
    let readable = true;
    for (const r of linesOf.get(id) ?? []) {
      const lineId = numericId(r.line_id);
      const item = numericId(r.item_id);
      const company = links.get(numericId(r.subsidiary_id) ?? '');
      if (!lineId || !item || !company || seen.has(lineId)) continue;
      const qty = quantityString(r.quantity);
      if (qty === null) {
        readable = false;
        break;
      }
      seen.add(lineId);
      lines.push({ line_id: lineId, company, item_id: item, location_id: numericId(r.location_id), quantity: qty, moves_stock: isTrue(r.moves_stock) });
    }
    if (!readable) {
      unreadable.push(name);
      continue;
    }
    if (!lines.length) continue;
    lines.sort((a, b) => Number(a.line_id) - Number(b.line_id));
    documents.push({ netsuite_id: id, tran_type: text(h.type), tranid: text(h.tranid) || null, trandate, lines });
  }
  return { documents, unreadable };
}

export interface OpeningRow {
  company: BooksCompany;
  item_id: string;
  location_id: string | null;
  quantity: string;
  value: string;
}

/**
 * NetSuite's sums before 2025 → each item's starting count and value at each
 * location, for gl_netsuite_stock_store_opening. Rows of subsidiaries no
 * company is linked to, or with no item or a number FleetSuite can't read,
 * are left out and counted in `skipped`.
 */
export function mapOpening(quantityRows: Row[], valueRows: Row[], links: Map<string, BooksCompany>): { rows: OpeningRow[]; skipped: number } {
  const byKey = new Map<string, OpeningRow>();
  let skipped = 0;
  const rowOf = (r: Row): OpeningRow | null => {
    const company = links.get(numericId(r.subsidiary_id) ?? '');
    const item = numericId(r.item_id);
    if (!company || !item) return null;
    const location = numericId(r.location_id);
    const key = `${company}|${item}|${location ?? ''}`;
    let row = byKey.get(key);
    if (!row) {
      row = { company, item_id: item, location_id: location, quantity: '0', value: '0.00' };
      byKey.set(key, row);
    }
    return row;
  };
  for (const r of quantityRows) {
    const qty = quantityString(r.quantity);
    const row = qty === null ? null : rowOf(r);
    if (!row || qty === null) {
      skipped++;
      continue;
    }
    row.quantity = qty;
  }
  for (const r of valueRows) {
    let value: number;
    try {
      value = toCents(r.debit ?? 0) - toCents(r.credit ?? 0);
    } catch {
      skipped++;
      continue;
    }
    const row = rowOf(r);
    if (!row) {
      skipped++;
      continue;
    }
    row.value = centsToString(value);
  }
  // Nothing on either side is no start at all.
  const rows = [...byKey.values()].filter((r) => r.quantity !== '0' || r.value !== '0.00');
  return { rows, skipped };
}

export interface CountRow {
  item_id: string;
  location_id: string | null;
  quantity: string;
  value: string | null;
}

/** NetSuite's own counts → rows for gl_netsuite_stock_store_counts, one per item and location (the later one kept). */
export function mapCounts(rows: Row[], read: CountsRead): CountRow[] {
  const byKey = new Map<string, CountRow>();
  for (const r of rows) {
    const item = numericId(r.item_id);
    const qty = quantityString(r.quantity);
    if (!item || qty === null) continue;
    const location = read === 'item' ? null : numericId(r.location_id);
    let value: string | null = null;
    if (read === 'location_value') {
      try {
        value = centsToString(toCents(r.value ?? 0));
      } catch {
        value = null;
      }
    }
    byKey.set(`${item}|${location ?? ''}`, { item_id: item, location_id: location, quantity: qty, value });
  }
  return [...byKey.values()];
}

// ── The run ────────────────────────────────────────────────────────────────

export interface StockCopyResult {
  /** Documents NetSuite returned this run. */
  read: number;
  added: number;
  changed: number;
  unchanged: number;
  lines: number;
  /** Documents NetSuite no longer has, marked gone this run. */
  gone?: number;
  /** Items and locations whose starting count was stored. */
  opening?: number;
  /** NetSuite's counts stored this run, and how it gave them. */
  counts?: number;
  countsBy?: CountsBy;
  /** Stopped for time with more to read; the next run carries on. */
  partial?: boolean;
  /** What the run couldn't do, in plain words. */
  notes?: string[];
  error?: string;
}

export interface StockCopyDeps {
  /** The first `limit` rows of a query. */
  page?: (query: string, limit: number) => Promise<Row[]>;
  /** Every row of a query (all pages). */
  query?: (query: string) => Promise<Row[]>;
  /** Documents per page; tests use small pages to cross page boundaries. */
  pageSize?: number;
  now?: () => number;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export async function copyNetSuiteStock(
  service: SupabaseClient,
  opts: { deadline: number; deps?: StockCopyDeps },
): Promise<StockCopyResult & { heartbeat?: HeartbeatResult }> {
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
    .eq('sync_type', BOOKS_STOCK_SYNC)
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

  const result: StockCopyResult = { read: 0, added: 0, changed: 0, unchanged: 0, lines: 0 };
  const notes: string[] = [];
  const unreadable: string[] = [];
  let drained = false;
  let stage = 'opening the window';

  const record = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...result };
    const said = [...notes];
    if (unreadable.length) {
      said.push(`NetSuite sent ${unreadable.length === 1 ? 'a document' : `${unreadable.length} documents`} with no date or a quantity `
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

  try {
    const { data: companyRows, error: companyErr } = await service.from('gl_companies').select('code, name, netsuite_subsidiary_id');
    if (companyErr) throw new Error(companyErr.message);
    const links = new Map<string, BooksCompany>();
    for (const c of (companyRows || []) as Array<{ code: BooksCompany; name: string; netsuite_subsidiary_id: string | null }>) {
      if (c.netsuite_subsidiary_id) links.set(String(c.netsuite_subsidiary_id), c.code);
    }
    if (links.size === 0) throw new Error('No company is linked to a NetSuite subsidiary yet.');

    for (;;) {
      if (timeLeft() < MIN_LEFT_MS) break;
      stage = `stock documents ${win.beforeId ? `below NetSuite id ${win.beforeId}` : 'from the newest'}`;
      let headers: Row[];
      try {
        headers = await page(stockDocumentsQuery(win.since, win.beforeId), pageSize);
      } catch (err) {
        if (isRejected(err) && /isinventoryaffecting/i.test(String((err as any)?.message || err))) {
          throw new Error(`NetSuite won't say which lines move stock (transactionline.isinventoryaffecting), so nothing was copied: ${compactSuiteqlError(err)}`);
        }
        throw err;
      }
      if (headers.length === 0) {
        drained = true;
        break;
      }
      result.read += headers.length;
      const ids = headers.map((r) => numericId(r.id)).filter((id): id is string => id !== null);

      stage = `the lines of stock documents ${win.beforeId ? `below NetSuite id ${win.beforeId}` : 'from the newest'}`;
      const lineRows: Row[] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) lineRows.push(...await query(stockLinesQuery(ids.slice(i, i + ID_CHUNK))));

      stage = 'writing the copy';
      const mapped = mapStockDocuments(headers, lineRows, links);
      unreadable.push(...mapped.unreadable);
      if (mapped.documents.length) {
        const applied = await service.rpc('gl_netsuite_stock_apply', { p: { documents: mapped.documents } });
        if (applied.error) throw new Error(applied.error.message);
        const a = (applied.data ?? {}) as { added?: number; changed?: number; unchanged?: number; lines?: number };
        result.added += Number(a.added) || 0;
        result.changed += Number(a.changed) || 0;
        result.unchanged += Number(a.unchanged) || 0;
        result.lines += Number(a.lines) || 0;
      }

      // Everything at or above the smallest id on this page is copied.
      if (ids.length) win.beforeId = ids.reduce((min, id) => (Number(id) < Number(min) ? id : min), ids[0]);
      win.processed += headers.length;
      if (headers.length < pageSize || !ids.length) {
        drained = true;
        break;
      }
      await writeSyncStateCursor(service, BOOKS_STOCK_SYNC, record());
    }

    if (!drained) {
      result.partial = true;
    } else {
      // What NetSuite no longer has, where each count starts, then NetSuite's own counts, each only with time to finish it.
      const later = (what: string) => notes.push(`There wasn't time left to ${what}; the next run will.`);
      if (timeLeft() < MIN_LEFT_MS) {
        later("check for documents NetSuite no longer has, or read NetSuite's counts");
      } else {
        stage = 'listing every stock document';
        const listed = (await query(STOCK_IDS_QUERY)).map((r) => numericId(r.id)).filter((id): id is string => id !== null);
        const finished = await service.rpc('gl_netsuite_stock_finish', { p: { netsuite_ids: listed } });
        if (finished.error) throw new Error(finished.error.message);
        const f = (finished.data ?? {}) as { listed?: number; here?: number; gone?: number; cut_short?: boolean };
        result.gone = Number(f.gone) || 0;
        if (f.cut_short) {
          notes.push(`NetSuite listed ${plural(Number(f.listed) || 0, 'stock document', 'stock documents')} and FleetSuite has `
            + `${(Number(f.here) || 0).toLocaleString('en-US')}, so none were marked gone.`);
        }

        if (timeLeft() < MIN_LEFT_MS) {
          later("read where each item's count starts, or NetSuite's counts");
        } else {
          stage = "reading where each item's count starts";
          const accountsRead = await service.rpc('gl_stock_inventory_accounts');
          if (accountsRead.error) throw new Error(accountsRead.error.message);
          const accounts = ((accountsRead.data ?? []) as unknown[]).map((a) => numericId(a)).filter((a): a is string => a !== null);
          const quantities = await query(OPENING_QUANTITY_QUERY);
          let values: Row[] = [];
          if (accounts.length) values = await query(openingValueQuery(accounts));
          else notes.push("The copy of NetSuite's items names no inventory account yet, so every item's value starts at nothing.");
          const opening = mapOpening(quantities, values, links);
          const stored = await service.rpc('gl_netsuite_stock_store_opening', { p: { rows: opening.rows } });
          if (stored.error) throw new Error(stored.error.message);
          result.opening = opening.rows.length;

          if (timeLeft() < MIN_LEFT_MS) {
            later("read NetSuite's counts");
          } else {
            stage = "reading NetSuite's counts";
            let counted: { read: CountsRead; rows: Row[] } | null = null;
            let refused: unknown = null;
            for (const read of COUNTS_READS) {
              try {
                counted = { read, rows: await query(countsQuery(read)) };
                break;
              } catch (err) {
                if (!isRejected(err)) throw err;
                refused = err;
              }
            }
            if (!counted) {
              notes.push(`NetSuite wouldn't give its own counts (${compactSuiteqlError(refused)}), so the last ones read are kept.`);
            } else {
              if (counted.read === 'location') notes.push("NetSuite wouldn't give each item's value at each location, so only counts are compared.");
              if (counted.read === 'item') {
                notes.push("NetSuite wouldn't give each item's count at each location, so each item is compared company-wide, without its value.");
              }
              const rows = mapCounts(counted.rows, counted.read);
              const storedCounts = await service.rpc('gl_netsuite_stock_store_counts', { p: { rows } });
              if (storedCounts.error) throw new Error(storedCounts.error.message);
              result.counts = rows.length;
              result.countsBy = counted.read === 'item' ? 'item' : 'location';
            }
          }
        }
      }
    }
  } catch (err) {
    result.error = `${stage}: ${compactSuiteqlError(err)}`;
    console.error('[books] NetSuite stock copy:', result.error);
  }

  const recorded = record();
  const heartbeat = await recordHeartbeat(service, BOOKS_STOCK_SYNC, recorded, {
    startedAt,
    records: result.read,
    // last_synced_at moves only when a window drains, to the time it was opened; the steps after it run again every time.
    ...(drained ? { lastSyncedAt: win.windowStartedAt } : { touchLastSyncedAt: false }),
  });
  return { ...result, ...(recorded.notes ? { notes: recorded.notes as string[] } : {}), heartbeat };
}
