import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuiteqlError, suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { writeSyncStateCursor } from '@/lib/ledger/write';
import { isoDate } from '@/lib/financials-data';
import { compactSuiteqlError, parseSoSyncResume, type SoSyncResume } from '@/lib/sales-order-sync';
import { centsToString, toCents } from './netsuite-gl';
import type { DepositType } from './deposit-rule';

/**
 * NetSuite's customer deposits and deposit applications, copied every two
 * hours (migration 382; owner decision 2026-10-15, thread "Replacing
 * NetSuite with FleetSuite") so the deposit rule can be checked against
 * them: /api/cron/books-netsuite-deposits at :16 on odd hours, and "Copy
 * now" on the invoices page's Deposits switch.
 *
 * The run is shaped like the estimates copy (src/lib/netsuite-estimate-sync.ts):
 * a window of documents modified since the last drained run, read newest
 * first a page at a time, with a saved cursor, so the first copy of the
 * whole history can span runs and a run cut short loses nothing. For each
 * page it also reads what each document applies from NetSuite's
 * transaction link table, as the ledger mirror reads what a payment paid,
 * and the type and number of each document linked. Once the window has
 * drained, it lists every deposit and application id NetSuite has, and
 * gl_netsuite_deposits_finish marks the ones NetSuite no longer has as gone.
 *
 * Nothing is written to NetSuite. The run is recorded in sync_state as
 * 'books_netsuite_deposits' and left out of HEALTH_MONITORS, like the other
 * books jobs: the books are hidden from everyone but the owner. For the same
 * reason no amount goes in that record, in a log line or in the cron's
 * response.
 */

export const BOOKS_DEPOSITS_SYNC = 'books_netsuite_deposits';

/** Documents per SuiteQL page, and the unit of work between deadline checks. */
const PAGE_SIZE = 200;
/** Ids per link or name query (they ride in the SQL). */
const ID_CHUNK = 100;
/** The first run reaches back to the very first deposit. */
const FIRST_RUN_SINCE = '2000-01-01T00:00:00Z';
/** A page, or the closing list of ids, is only started with this much of the budget left. */
const MIN_LEFT_MS = 20_000;
/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. */
const SUITEQL_OPTS = { retries: 2 };

type Row = Record<string, unknown>;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numericId = (v: unknown): string | null => (/^\d+$/.test(text(v)) ? text(v) : null);
const isRejected = (err: unknown) => isSuiteqlError(err) && err.status === 400;

/** NetSuite's two link tables; this account may answer one and not the other (the ledger mirror probes the same pair). */
export type LinkTable = 'nexttransactionlinelink' | 'previoustransactionlinelink';
export const LINK_TABLES: readonly LinkTable[] = ['nexttransactionlinelink', 'previoustransactionlinelink'];

// ── Queries ────────────────────────────────────────────────────────────────

/** SuiteQL wants MM/DD/YYYY; the window is date-granular by design. */
export function toSuiteqlDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

export const idList = (ids: string[]) => {
  const safe = ids.filter((id) => /^\d+$/.test(id));
  if (!safe.length) throw new Error('No NetSuite ids to read');
  return safe.join(', ');
};

/** One page of deposits and applications modified since `sinceIso`, newest first, continuing below `beforeId`. */
export function depositHeaderQuery(sinceIso: string, beforeId: string | null, withLabel: boolean): string {
  const label = withLabel ? ', BUILTIN.DF(t.status) AS status_label' : '';
  // Never trust a stored string into SQL, even one we wrote ourselves.
  const before = beforeId && /^\d+$/.test(beforeId) ? `\n        AND t.id < ${beforeId}` : '';
  return `
      SELECT t.id, t.type, t.tranid, t.trandate, t.status, t.memo, t.foreigntotal AS total,
             t.entity AS customer_id, c.companyname AS customer_name, c.entityid AS customer_entity_id${label}
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.type IN ('CustDep', 'DepAppl')
        AND t.lastmodifieddate >= TO_DATE('${toSuiteqlDate(sinceIso)}', 'MM/DD/YYYY')${before}
      ORDER BY t.id DESC
    `;
}

/** What each document applies: the documents before it in NetSuite's link table. */
export function depositLinksQuery(table: LinkTable, ids: string[]): string {
  return `
      SELECT previousdoc, nextdoc, foreignamount, linktype
      FROM ${table}
      WHERE nextdoc IN (${idList(ids)})
    `;
}

/** The type and number of the documents linked. */
export function linkedDocumentsQuery(ids: string[]): string {
  return `
      SELECT t.id, t.type, t.tranid
      FROM transaction t
      WHERE t.id IN (${idList(ids)})
    `;
}

/** Every deposit and application id NetSuite has, for marking the ones it no longer has. */
export const DEPOSIT_IDS_QUERY = `SELECT t.id FROM transaction t WHERE t.type IN ('CustDep', 'DepAppl') ORDER BY t.id`;

// ── Rows ───────────────────────────────────────────────────────────────────

/** A document a deposit or application applies, as gl_netsuite_deposits_apply takes it; the amount positive. */
export interface CopyLink {
  netsuite_id: string;
  type: string | null;
  number: string | null;
  amount: string | null;
  link_type: string | null;
  /** The linking document's own lines the link is on, by NetSuite line id, when the run read them: a bill's lines that came from its purchase order, say. */
  lines?: string[];
}

export interface DepositCopyRow {
  netsuite_id: string;
  tran_type: DepositType;
  tranid: string | null;
  trandate: string;
  customer_netsuite_id: string | null;
  customer_name: string | null;
  total: string;
  status: string | null;
  status_label: string | null;
  voided: boolean;
  memo: string | null;
  /** Left out when the run couldn't read NetSuite's links: the copy then keeps the ones it has. */
  links?: CopyLink[];
}

/**
 * NetSuite's link rows → what each document applies, by document. Two rows
 * linking the same pair of documents (one per line, say) are one link, their
 * amounts added up, so the result doesn't depend on the order NetSuite
 * lists them in. With `opts.lines`, the rows carry `nextline` and each link
 * says which of the document's own lines it's on.
 */
export function linksByDocument(
  rows: Row[],
  names: Map<string, { type: string | null; number: string | null }>,
  opts: { lines?: boolean } = {},
): Map<string, CopyLink[]> {
  const cents = new Map<string, Map<string, { cents: number | null; linkType: string | null; lines: Set<string> }>>();
  for (const r of rows) {
    const next = numericId(r.nextdoc);
    const previous = numericId(r.previousdoc);
    if (!next || !previous || next === previous) continue;
    let amount: number | null = null;
    if (text(r.foreignamount) !== '') {
      try {
        amount = Math.abs(toCents(r.foreignamount));
      } catch {
        amount = null;
      }
    }
    const byPrevious = cents.get(next) ?? new Map();
    const was = byPrevious.get(previous);
    const lines = was?.lines ?? new Set<string>();
    const line = numericId(r.nextline);
    if (line) lines.add(line);
    byPrevious.set(previous, {
      cents: was ? (was.cents === null || amount === null ? null : was.cents + amount) : amount,
      linkType: was?.linkType ?? (text(r.linktype) || null),
      lines,
    });
    cents.set(next, byPrevious);
  }
  const out = new Map<string, CopyLink[]>();
  for (const [next, byPrevious] of cents) {
    out.set(next, [...byPrevious]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([id, l]) => ({
        netsuite_id: id,
        type: names.get(id)?.type ?? null,
        number: names.get(id)?.number ?? null,
        amount: l.cents === null ? null : centsToString(l.cents),
        link_type: l.linkType,
        ...(opts.lines ? { lines: [...l.lines].sort((a, b) => Number(a) - Number(b)) } : {}),
      })));
  }
  return out;
}

/**
 * A page of NetSuite's headers → rows for gl_netsuite_deposits_apply. A
 * document with no date or an amount FleetSuite can't read is left out and
 * named in `unreadable`. `links` null means the run couldn't read them.
 */
export function mapDeposits(rows: Row[], links: Map<string, CopyLink[]> | null): { rows: DepositCopyRow[]; unreadable: string[] } {
  const out: DepositCopyRow[] = [];
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
    if (!id || (type !== 'CustDep' && type !== 'DepAppl') || !trandate || cents === null) {
      unreadable.push(text(row.tranid) || `NetSuite ${text(row.id) || 'document'}`);
      continue;
    }
    const label = text(row.status_label) || null;
    const customer = numericId(row.customer_id);
    out.push({
      netsuite_id: id,
      tran_type: type,
      tranid: text(row.tranid) || null,
      trandate,
      customer_netsuite_id: customer,
      // As the ledger mirror names a customer (nsPartyName): company name, then entity id, then NetSuite id.
      customer_name: text(row.customer_name) || text(row.customer_entity_id) || (customer ? `Customer ${customer}` : null),
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

export interface DepositCopyResult {
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

export interface DepositCopyDeps {
  /** The first `limit` rows of a query. */
  page?: (query: string, limit: number) => Promise<Row[]>;
  /** Every row of a query (all pages). */
  query?: (query: string) => Promise<Row[]>;
  /** Documents per page; tests use small pages to cross page boundaries. */
  pageSize?: number;
  now?: () => number;
}

export async function copyNetSuiteDeposits(
  service: SupabaseClient,
  opts: { deadline: number; deps?: DepositCopyDeps },
): Promise<DepositCopyResult & { heartbeat?: HeartbeatResult }> {
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
    .eq('sync_type', BOOKS_DEPOSITS_SYNC)
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

  const result: DepositCopyResult = { read: 0, added: 0, changed: 0 };
  const notes: string[] = [];
  const unreadable: string[] = [];
  let withLabel: boolean | null = null;
  // undefined: not tried yet this run.
  let linkTable: LinkTable | null | undefined;
  let drained = false;
  let stage = 'opening the window';

  const record = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...result };
    const said = [...notes];
    if (unreadable.length) {
      said.push(`NetSuite sent ${unreadable.length === 1 ? 'a document' : `${unreadable.length} documents`} with no date or an amount `
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
    if (withLabel === null) {
      try {
        const rows = await page(depositHeaderQuery(win.since, win.beforeId, true), pageSize);
        withLabel = true;
        return rows;
      } catch (err) {
        if (!isRejected(err)) throw err;
        withLabel = false;
        notes.push("NetSuite wouldn't give the documents' status in words, so voided ones aren't marked as voided.");
      }
    }
    return page(depositHeaderQuery(win.since, win.beforeId, withLabel), pageSize);
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
          notes.push(`NetSuite wouldn't list what the documents are linked to (${compactSuiteqlError(refused)}), so what each deposit `
            + 'application applies isn\'t copied this time.');
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
      stage = `deposits ${win.beforeId ? `below NetSuite id ${win.beforeId}` : 'from the newest'}`;
      const rows = await headerPage();
      if (rows.length === 0) {
        drained = true;
        break;
      }
      result.read += rows.length;
      const ids = rows.map((r) => numericId(r.id)).filter((id): id is string => id !== null);

      stage = `what deposits ${win.beforeId ? `below NetSuite id ${win.beforeId}` : 'from the newest'} apply`;
      let links: Map<string, CopyLink[]> | null = null;
      const linkRows = ids.length ? await readLinks(ids) : [];
      if (linkRows) {
        const linked = [...new Set(linkRows.map((l) => numericId(l.previousdoc)).filter((id): id is string => id !== null))];
        links = linksByDocument(linkRows, linked.length ? await readNames(linked) : new Map());
      }

      stage = 'writing the copy';
      const mapped = mapDeposits(rows, links);
      unreadable.push(...mapped.unreadable);
      if (mapped.rows.length) {
        const applied = await service.rpc('gl_netsuite_deposits_apply', { p: { rows: mapped.rows } });
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
      await writeSyncStateCursor(service, BOOKS_DEPOSITS_SYNC, record());
    }

    if (!drained) {
      result.partial = true;
    } else if (timeLeft() < MIN_LEFT_MS) {
      notes.push("There wasn't time left to check for documents NetSuite no longer has; the next run will.");
    } else {
      stage = 'listing every deposit and application';
      const ids = (await query(DEPOSIT_IDS_QUERY)).map((r) => numericId(r.id)).filter((id): id is string => id !== null);
      const finished = await service.rpc('gl_netsuite_deposits_finish', { p: { netsuite_ids: ids } });
      if (finished.error) throw new Error(finished.error.message);
      const f = (finished.data ?? {}) as { listed?: number; here?: number; gone?: number; cut_short?: boolean };
      result.gone = Number(f.gone) || 0;
      if (f.cut_short) {
        notes.push(`NetSuite listed ${(Number(f.listed) || 0).toLocaleString('en-US')} deposits and applications and FleetSuite has `
          + `${(Number(f.here) || 0).toLocaleString('en-US')}, so none were marked gone.`);
      }
    }
  } catch (err) {
    result.error = `${stage}: ${compactSuiteqlError(err)}`;
    console.error('[books] NetSuite deposits copy:', result.error);
  }
  if (linkTable !== undefined) result.linkTable = linkTable;

  const recorded = record();
  const heartbeat = await recordHeartbeat(service, BOOKS_DEPOSITS_SYNC, recorded, {
    startedAt,
    records: result.read,
    // last_synced_at moves only when a window drains, to the time it was opened.
    ...(drained ? { lastSyncedAt: win.windowStartedAt } : { touchLastSyncedAt: false }),
  });
  return { ...result, ...(recorded.notes ? { notes: recorded.notes as string[] } : {}), heartbeat };
}
