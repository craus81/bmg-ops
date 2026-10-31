import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuiteqlError, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { isoDate } from '@/lib/financials-data';
import { compactSuiteqlError } from '@/lib/sales-order-sync';
import { centsToString, toCents } from './netsuite-gl';

/**
 * NetSuite's open invoices, credit memos, bills and bill credits, each with
 * what's still open on it and when it's due, copied whole every two hours
 * (migration 458; the NetSuite Exit Checklist's "AR and AP agings", thread
 * "Replacing NetSuite with FleetSuite", 2026-10-31) for NetSuite's side of
 * the agings: /api/cron/books-netsuite-open-items at :29 on odd hours, and
 * "Copy now" on the agings page.
 *
 * One query reads every document NetSuite has open (status A), with
 * NetSuite's own open amount (foreignamountunpaid, as Financials reads it),
 * its due date, and the name and subsidiary of its main line, the
 * receivable or payable line. There are only as many as are open, so the
 * copy is replaced whole each run (gl_netsuite_store_open_items) rather
 * than kept from a window of what changed: a payment applied to an invoice
 * changes what's open on it, and whether NetSuite counts that as a change to
 * the invoice isn't something the copy should have to rely on. A run that
 * fails keeps the last copy, and so does one that finds nothing open while
 * the copy holds documents, since that is more likely a SuiteQL role that
 * sees less than a NetSuite with nothing owed.
 *
 * Nothing is written to NetSuite. The run is recorded in sync_state as
 * 'books_netsuite_open_items' and left out of HEALTH_MONITORS, like the
 * other books jobs: the books are hidden from everyone but the owner. For
 * the same reason no amount goes in that record, in a log line or in the
 * cron's response.
 */

export const BOOKS_OPEN_ITEMS_SYNC = 'books_netsuite_open_items';

/** The types copied, and the sign each one's open amount takes on its receivable or payable account (debit positive). */
export const OPEN_TYPES = { CustInvc: 1, CustCred: -1, VendBill: -1, VendCred: 1 } as const;
export type OpenType = keyof typeof OPEN_TYPES;

const isOpenType = (v: string): v is OpenType => Object.prototype.hasOwnProperty.call(OPEN_TYPES, v);

/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. */
const SUITEQL_OPTS = { retries: 2 };

type Row = Record<string, unknown>;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numericId = (v: unknown): string | null => (/^\d+$/.test(text(v)) ? text(v) : null);

/**
 * Every document NetSuite has open, with what's open on it, its due date,
 * and its main line's name and subsidiary, in NetSuite's id order so the
 * pages of the read never skip or repeat one.
 */
export const OPEN_ITEMS_QUERY = `
      SELECT t.id, t.type, t.tranid, t.trandate, t.duedate, t.foreignamountunpaid AS unpaid,
             tl.entity AS line_entity_id, t.entity AS txn_entity_id, tl.subsidiary AS subsidiary_id
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T'
      WHERE t.type IN ('CustInvc', 'CustCred', 'VendBill', 'VendCred')
        AND t.status = 'A'
      ORDER BY t.id
    `;

/** One open document, as gl_netsuite_store_open_items takes it. */
export interface OpenItem {
  netsuite_id: string;
  tran_type: OpenType;
  tranid: string | null;
  trandate: string;
  due_date: string | null;
  /** NetSuite's id for the main line's name, else the document's; '' for none. */
  entity_id: string;
  subsidiary_id: string | null;
  /** What's open on it, as it sits on the receivable or payable account: debit positive. */
  amount_open: string;
}

/**
 * NetSuite's rows → the copy's. NetSuite signs purchase-side amounts as it
 * pleases, so each open amount is taken whole and signed by its type. A
 * document with nothing open is left out quietly; one with no date or an
 * open amount FleetSuite can't read is left out and named in `unreadable`.
 * A document NetSuite sends twice (two main lines) is copied once.
 */
export function mapOpenItems(rows: Row[]): { items: OpenItem[]; unreadable: string[]; noSubsidiary: number } {
  const items: OpenItem[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  let noSubsidiary = 0;
  for (const row of rows) {
    const id = numericId(row.id);
    const type = text(row.type);
    const trandate = isoDate(row.trandate);
    let cents: number | null;
    try {
      cents = text(row.unpaid) === '' ? null : Math.abs(toCents(row.unpaid));
    } catch {
      cents = null;
    }
    if (!id || !isOpenType(type) || !trandate || cents === null) {
      unreadable.push(text(row.tranid) || `NetSuite ${text(row.id) || 'document'}`);
      continue;
    }
    if (cents === 0 || seen.has(id)) continue;
    seen.add(id);
    const subsidiary = numericId(row.subsidiary_id);
    if (!subsidiary) noSubsidiary += 1;
    items.push({
      netsuite_id: id,
      tran_type: type,
      tranid: text(row.tranid) || null,
      trandate,
      due_date: isoDate(row.duedate),
      entity_id: numericId(row.line_entity_id) ?? numericId(row.txn_entity_id) ?? '',
      subsidiary_id: subsidiary,
      amount_open: centsToString(OPEN_TYPES[type] * cents),
    });
  }
  return { items, unreadable, noSubsidiary };
}

// ── The run ────────────────────────────────────────────────────────────────

export interface OpenItemsCopyResult {
  /** Rows NetSuite returned this run. */
  read: number;
  /** Open documents the copy holds after it. */
  copied: number;
  /** NetSuite found nothing open while the copy held documents, so the copy kept them. */
  kept?: boolean;
  /** What the run couldn't do, in plain words. */
  notes?: string[];
  error?: string;
}

export interface OpenItemsCopyDeps {
  /** Every row of a query (all pages). */
  query?: (query: string) => Promise<Row[]>;
}

export async function copyNetSuiteOpenItems(
  service: SupabaseClient,
  opts: { deps?: OpenItemsCopyDeps } = {},
): Promise<OpenItemsCopyResult & { heartbeat?: HeartbeatResult }> {
  const query = opts.deps?.query ?? ((q: string) => suiteqlQueryAll(q, 1000, SUITEQL_OPTS) as Promise<Row[]>);
  const startedAt = Date.now();
  const result: OpenItemsCopyResult = { read: 0, copied: 0 };
  const notes: string[] = [];
  let stage = "reading NetSuite's open invoices and bills";

  try {
    let rows: Row[];
    try {
      rows = await query(OPEN_ITEMS_QUERY);
    } catch (err) {
      if (isSuiteqlError(err) && err.status === 400) {
        throw new Error(`NetSuite wouldn't give its open invoices and bills with what's still open on each (${compactSuiteqlError(err)})`);
      }
      throw err;
    }
    result.read = rows.length;
    const mapped = mapOpenItems(rows);
    if (mapped.unreadable.length) {
      const n = mapped.unreadable.length;
      notes.push(`NetSuite sent ${n === 1 ? 'a document' : `${n} documents`} with no date or an open amount FleetSuite can't read, `
        + `so ${n === 1 ? "it isn't" : "they aren't"} copied: ${mapped.unreadable.slice(0, 10).join(', ')}${n > 10 ? ', …' : ''}.`);
    }
    if (mapped.noSubsidiary) {
      notes.push(`NetSuite named no subsidiary on ${mapped.noSubsidiary === 1 ? 'an open document' : `${mapped.noSubsidiary} open documents`}, `
        + `so ${mapped.noSubsidiary === 1 ? "it's" : "they're"} in neither company's agings.`);
    }

    stage = 'writing the copy';
    if (!mapped.items.length) {
      const held = await service.from('gl_netsuite_open_items').select('netsuite_id', { count: 'exact', head: true });
      if (held.error) throw new Error(held.error.message);
      if ((held.count ?? 0) > 0) {
        result.kept = true;
        result.copied = held.count ?? 0;
        notes.push('NetSuite gave no open invoice or bill at all, so the copy keeps the last one: a SuiteQL role that sees less '
          + 'is likelier than nothing owed.');
      }
    }
    if (!result.kept) {
      const stored = await service.rpc('gl_netsuite_store_open_items', { p: { items: mapped.items } });
      if (stored.error) throw new Error(stored.error.message);
      result.copied = Number(stored.data) || 0;
    }
  } catch (err) {
    result.error = `${stage}: ${compactSuiteqlError(err)}`;
    console.error('[books] NetSuite open items copy:', result.error);
  }

  const recorded: Record<string, unknown> = { ...result, ...(notes.length ? { notes } : {}) };
  const heartbeat = await recordHeartbeat(service, BOOKS_OPEN_ITEMS_SYNC, recorded, {
    startedAt,
    records: result.read,
    // last_synced_at is when the copy last took what NetSuite has open; a failed or kept run leaves it.
    ...(result.error || result.kept ? { touchLastSyncedAt: false } : {}),
  });
  return { ...result, ...(notes.length ? { notes } : {}), heartbeat };
}
