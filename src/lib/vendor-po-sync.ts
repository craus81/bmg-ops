import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuiteqlError, suiteqlQueryAll } from '@/lib/netsuite';
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

// ── A PO's other lines (migration 515) ──────────────────────────────────────
//
// A PO's Expenses tab (freight, say) has lines with an account and no item.
// They're kept apart from the item lines, in netsuite_vendor_po_expense_lines,
// so nothing that reads the item lines (Receiving, what's on order, parts
// readiness) changes. A bill NetSuite makes from the PO takes each one no bill
// has yet, so each is kept with the bills NetSuite shows it on, from its link
// table. What NetSuite won't say is kept as not known, never as none.

/** NetSuite's two link tables; this account may answer one and not the other (as in src/lib/books/netsuite-deposits.ts). */
const LINK_TABLES = ['nexttransactionlinelink', 'previoustransactionlinelink'] as const;
type LinkTable = typeof LINK_TABLES[number];
/** How the sync asks which bills have a PO's lines: the link table, and by line or by PO. */
type LinkRead = { table: LinkTable; withLines: boolean };

/** POs per SuiteQL read and write, as the item lines are read. */
const EXPENSE_CHUNK = 50;
/** Copies per "not read" mark. */
const UNREAD_CHUNK = 100;
/** Copies whose other lines the sync has never read, besides the POs NetSuite changed: read each run, newest first. */
export const EXPENSE_BACKFILL = 100;
/** The other lines' share of a run, which the cron shares with a dozen other jobs: no read starts after this long, but the first. */
export const EXPENSE_BUDGET_MS = 10_000;

const isRejected = (err: unknown) => isSuiteqlError(err) && err.status === 400;

/**
 * The POs' lines, but the main and tax lines: the other lines are those with no item, and the item lines come along
 * only for their amounts, which say which way round NetSuite signs the PO's lines. `level` 0 asks for each line's
 * account name and whether it's closed, 1 only whether it's closed, 2 neither, for an account whose SuiteQL refuses
 * them. Each asks for the account, which a bill can't do without.
 */
export function expenseLinesQuery(ids: string[], level: 0 | 1 | 2): string {
  const name = level === 0 ? ' BUILTIN.DF(tl.expenseaccount) AS account_name,' : '';
  const closed = level <= 1 ? ' tl.isclosed,' : '';
  return `
        SELECT tl.transaction AS po_id, tl.id AS line_id, tl.item AS item_id, tl.expenseaccount AS account_id,${name}${closed}
               tl.memo, tl.netamount AS amount, tl.foreignamount AS own_amount
        FROM transactionline tl
        WHERE tl.transaction IN (${ids.join(', ')})
          AND tl.mainline = 'F'
          AND tl.taxline = 'F'
        ORDER BY tl.transaction, tl.id
      `;
}

/** The bills NetSuite made from the POs, from its link table; `withLines` asks which of the PO's lines each is on. */
export function poBillLinksQuery(table: LinkTable, ids: string[], withLines: boolean): string {
  return `
        SELECT l.previousdoc AS po_id,${withLines ? ' l.previousline AS line_id,' : ''} l.nextdoc AS bill_id
        FROM ${table} l
        JOIN transaction t ON t.id = l.nextdoc
        WHERE l.previousdoc IN (${ids.join(', ')})
          AND t.type = 'VendBill'
      `;
}

/** One of a PO's other lines, as vendor_po_expense_lines_put takes it. */
export interface ExpenseLineRow {
  line_id: string;
  account_netsuite_id: string | null;
  account_name: string | null;
  memo: string | null;
  /** In dollars, to the cent; null when NetSuite gave none FleetSuite can read. */
  amount: string | null;
  /** Null when the read didn't ask. */
  closed: boolean | null;
  /** NetSuite's ids for the bills that have the line; null when NetSuite wouldn't say. */
  billed_by: string[] | null;
}

const bare = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const numericId = (v: unknown): string | null => (/^\d+$/.test(bare(v)) ? bare(v) : null);
const amountOf = (v: unknown): number | null => {
  if (bare(v) === '') return null;
  const n = Number(bare(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * NetSuite's rows → each PO's other lines, by NetSuite's id for the PO, in line order; their bills not known yet.
 * Each line's own amount (as the PO shows it) is taken over its net amount, and the amounts are turned the right way
 * round together, so the PO's lines, its item lines with them, add up to more than nothing: NetSuite may sign a PO's
 * lines either way, and a discount on the Expenses tab stays a discount. A row without a line id FleetSuite can read
 * is left out, and an item line is only counted.
 */
export function expenseLinesByPo(rows: readonly any[]): Map<string, ExpenseLineRow[]> {
  const read = new Map<string, Array<{ row: ExpenseLineRow; value: number | null }>>();
  const sums = new Map<string, number>();
  for (const r of rows) {
    const po = numericId(r?.po_id);
    if (!po) continue;
    const value = amountOf(r.own_amount) ?? amountOf(r.amount);
    sums.set(po, (sums.get(po) ?? 0) + (value ?? 0));
    const line = numericId(r.line_id);
    if (!line || bare(r.item_id) !== '') continue;
    const list = read.get(po) ?? [];
    list.push({
      row: {
        line_id: line,
        account_netsuite_id: numericId(r.account_id),
        account_name: bare(r.account_name) || null,
        memo: bare(r.memo) || null,
        amount: null,
        closed: r.isclosed === undefined || r.isclosed === null ? null : r.isclosed === true || bare(r.isclosed).toUpperCase() === 'T',
        billed_by: null,
      },
      value,
    });
    read.set(po, list);
  }
  const out = new Map<string, ExpenseLineRow[]>();
  for (const [po, list] of read) {
    const turn = (sums.get(po) ?? 0) < 0 ? -1 : 1;
    list.sort((a, b) => Number(a.row.line_id) - Number(b.row.line_id));
    out.set(po, list.map(({ row, value }) => ({ ...row, amount: value === null ? null : ((value * turn) || 0).toFixed(2) })));
  }
  return out;
}

/** What NetSuite's link rows say of each PO's bills: on each line, or only on the PO when the read had no lines. */
export interface PoBills {
  byLine: Map<string, Map<string, Set<string>>> | null;
  byPo: Map<string, Set<string>>;
}

export function poBillsOf(rows: readonly any[], withLines: boolean): PoBills {
  const byLine = withLines ? new Map<string, Map<string, Set<string>>>() : null;
  const byPo = new Map<string, Set<string>>();
  for (const r of rows) {
    const po = numericId(r?.po_id);
    const bill = numericId(r?.bill_id);
    if (!po || !bill) continue;
    byPo.set(po, (byPo.get(po) ?? new Set()).add(bill));
    const line = numericId(r?.line_id);
    if (byLine && line) {
      const lines = byLine.get(po) ?? new Map<string, Set<string>>();
      lines.set(line, (lines.get(line) ?? new Set()).add(bill));
      byLine.set(po, lines);
    }
  }
  return { byLine, byPo };
}

/**
 * Each line with the bills that have it, as far as NetSuite's links say: the bills linked to the line; none when no
 * bill came from the PO at all. A line no bill is linked to, on a PO some bill came from, isn't known (null): NetSuite
 * may link a bill to the PO without linking it to each of the PO's other lines. Null too when NetSuite wouldn't say.
 */
export function withBills(po: string, lines: ExpenseLineRow[], bills: PoBills | null): ExpenseLineRow[] {
  return lines.map((l) => {
    const onLine = bills?.byLine?.get(po)?.get(l.line_id);
    let billedBy: string[] | null = null;
    if (onLine?.size) billedBy = [...onLine].sort((a, b) => Number(a) - Number(b));
    else if (bills && !bills.byPo.has(po)) billedBy = [];
    return { ...l, billed_by: billedBy };
  });
}

/** A copy of a PO whose other lines a run reads: NetSuite's id for it and its row in the copy. */
export interface ExpenseTarget {
  netsuiteId: string;
  copyId: string;
}

export interface ExpenseSyncResult {
  /** POs whose other lines were read and kept. */
  pos: number;
  /** Their other lines. */
  lines: number;
  /** POs NetSuite changed whose other lines weren't read this run, so they're marked not read again. */
  unread: number;
  /** POs whose bills NetSuite wouldn't say, so their lines' bills are kept as not known. */
  billsUnknown: number;
  /** Why some weren't read or kept. */
  error?: string;
}

/**
 * Reads the other lines of the POs NetSuite changed (`changed`), then of copies never read, newest first, and keeps
 * them, each with its bills. Reads start only while the run's share of time lasts, the first always; a changed PO
 * whose lines weren't read is marked not read, so what the copy says of it stays true. Never throws: a PO's other
 * lines are a part of the copy the rest of the sync doesn't need.
 */
export async function syncPoExpenseLines(
  service: SupabaseClient,
  changed: ExpenseTarget[],
  now: () => number = Date.now,
): Promise<ExpenseSyncResult> {
  const out: ExpenseSyncResult = { pos: 0, lines: 0, unread: 0, billsUnknown: 0 };
  const errors: string[] = [];
  const started = now();

  // Copies never read, newest first, besides the changed ones.
  const targets = [...changed];
  try {
    const { data, error } = await service
      .from('netsuite_vendor_pos')
      .select('id, netsuite_id')
      .is('expense_lines_read_at', null)
      .order('trandate', { ascending: false, nullsFirst: false })
      .order('id')
      .limit(EXPENSE_BACKFILL + changed.length);
    if (error) throw new Error(error.message);
    const taken = new Set(changed.map((t) => t.netsuiteId));
    for (const r of (data ?? []) as Array<{ id: string; netsuite_id: string | number }>) {
      const id = numericId(r.netsuite_id);
      if (!id || taken.has(id) || targets.length >= changed.length + EXPENSE_BACKFILL) continue;
      taken.add(id);
      targets.push({ netsuiteId: id, copyId: r.id });
    }
  } catch (err) {
    errors.push(`couldn't find the copies not read yet: ${why(err)}`);
  }

  let level: 0 | 1 | 2 = 0;
  let linkRead: LinkRead | null = null;
  let linksRefused = false;
  const done = new Set<string>();
  for (let i = 0; i < targets.length; i += EXPENSE_CHUNK) {
    if (i > 0 && now() - started >= EXPENSE_BUDGET_MS) break;
    const chunk = targets.slice(i, i + EXPENSE_CHUNK);
    const ids = chunk.map((t) => t.netsuiteId);
    let lines: Map<string, ExpenseLineRow[]>;
    try {
      let rows: any[] | null = null;
      while (rows === null) {
        try {
          rows = await suiteqlQueryAll(expenseLinesQuery(ids, level));
        } catch (err) {
          if (!isRejected(err) || level === 2) throw err;
          level = (level + 1) as 1 | 2;
        }
      }
      lines = expenseLinesByPo(rows);
    } catch (err) {
      errors.push(`couldn't read the POs' other lines: ${why(err)}`);
      break;
    }

    // The bills of the POs with other lines: by line, else by PO, from whichever link table answers.
    const withLines = [...lines.keys()];
    let bills: PoBills | null = null;
    if (withLines.length && !linksRefused) {
      const reads: LinkRead[] = linkRead ? [linkRead] : [true, false].flatMap((w) => LINK_TABLES.map((table) => ({ table, withLines: w })));
      let failed = 'NetSuite refused every way of asking';
      for (const read of reads) {
        try {
          bills = poBillsOf(await suiteqlQueryAll(poBillLinksQuery(read.table, withLines, read.withLines)), read.withLines);
          linkRead = read;
          break;
        } catch (err) {
          failed = why(err);
          if (!isRejected(err) || linkRead) break;
        }
      }
      if (!bills) {
        errors.push(`couldn't read which bills have the POs' other lines: ${failed}`);
        // Refused every way, or failed outright before any way answered: not asked again this run.
        if (!linkRead) linksRefused = true;
      }
    }
    if (!bills) out.billsUnknown += withLines.length;

    // Each PO's lines replaced and the PO marked read together.
    const puts = chunk.map((t) => ({ po_id: t.copyId, lines: withBills(t.netsuiteId, lines.get(t.netsuiteId) ?? [], bills) }));
    try {
      const { data, error } = await service.rpc('vendor_po_expense_lines_put', { p_pos: puts });
      if (error) throw new Error(error.message);
      out.pos += puts.length;
      out.lines += Number(data) || 0;
      for (const p of puts) done.add(p.po_id);
    } catch (err) {
      errors.push(`couldn't keep the POs' other lines: ${why(err)}`);
    }
  }

  // A PO NetSuite changed but not read here may have other lines the copy doesn't: not read, until a run reads it.
  const stale = changed.filter((t) => !done.has(t.copyId)).map((t) => t.copyId);
  for (let i = 0; i < stale.length; i += UNREAD_CHUNK) {
    const part = stale.slice(i, i + UNREAD_CHUNK);
    try {
      const { error } = await service.from('netsuite_vendor_pos').update({ expense_lines_read_at: null }).in('id', part);
      if (error) throw new Error(error.message);
      out.unread += part.length;
    } catch (err) {
      errors.push(`couldn't mark the POs not read: ${why(err)}`);
    }
  }

  if (errors.length) {
    out.error = [...new Set(errors)].join('; ').slice(0, 300);
    console.warn(`vendor-po-sync: a PO's other lines: ${out.error}`);
  }
  return out;
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
  /** The POs' other lines (migration 515): read for the POs that changed and some never read. */
  expenses?: ExpenseSyncResult;
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
  const changed: ExpenseTarget[] = [];
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
    changed.push({ netsuiteId: nsId, copyId: header.id });

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

  // The POs' other lines, such as freight. Never throws.
  const expenses = await syncPoExpenseLines(service, changed);

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
      expensePos: expenses.pos, expenseLines: expenses.lines,
      ...(expenses.unread > 0 ? { expenseUnread: expenses.unread } : {}),
      ...(expenses.billsUnknown > 0 ? { expenseBillsUnknown: expenses.billsUnknown } : {}),
      ...(expenses.error ? { expenseError: expenses.error } : {}),
    },
  );
  return {
    modified: pos.length, synced, lines: lineCount, headerErrors, receivedDegraded: degradedSynced,
    ...(companyError ? { companyError } : {}),
    expenses,
    syncStateWrite,
  };
}
