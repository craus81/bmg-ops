import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuiteqlError, suiteqlQueryAll } from '@/lib/netsuite';
import { compactSuiteqlError } from '@/lib/sales-order-sync';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { COPY_FROM } from './netsuite-gl';

/**
 * The NetSuite lists FleetSuite's posting rules need, copied every two hours
 * (migration 363; owner decision 2026-10-11, thread "Replacing NetSuite with
 * FleetSuite"): locations, departments, classes, terms and tax codes, plus
 * the accounts each item and vendor posts to. With them the rules can pick
 * the same accounts NetSuite does, and the copied GL lines' locations,
 * departments and classes have names.
 *
 * It runs right after the chart of accounts in the ledger mirror cron
 * (/api/cron/ledger-netsuite-mirror, :35 on even hours), and from "Sync now"
 * on the Books lists page. Each list is read whole with SuiteQL and handed
 * to gl_netsuite_lists_apply in pages; then gl_netsuite_lists_finish marks
 * what NetSuite no longer has. One list NetSuite won't give doesn't stop the
 * others, and a field it won't give is left out with a note rather than
 * failing the list. Nothing is written back to NetSuite.
 *
 * Which account a tax code posts to comes from what sales tax actually
 * posted to since the GL copy starts: its tax lines, counted by tax code and
 * account (SuiteQL shows little of the tax codes themselves).
 *
 * The record of each run (sync_state 'books_netsuite_lists') is left out of
 * HEALTH_MONITORS like the other books jobs: the books are hidden from
 * everyone but the owner, and it carries counts only.
 */

export const BOOKS_LISTS_SYNC = 'books_netsuite_lists';

export type ListKind = 'location' | 'department' | 'class' | 'term' | 'tax_code' | 'vendor' | 'item';

/** Rows per gl_netsuite_lists_apply call: one transaction each, well inside the API's request limit. */
const APPLY_PAGE = 1000;

type Row = Record<string, unknown>;
export type ListDetails = Record<string, string | number>;

export interface ListRow {
  netsuite_id: string;
  name: string;
  parent_netsuite_id: string | null;
  active: boolean;
  details: ListDetails;
}

/** A field NetSuite may refuse to give; the list is then read without it. */
export interface OptionalField {
  field: string;
  /** The details key it fills, when it fills one. */
  key?: string;
  /** Plural, for the note when NetSuite won't give it. */
  label: string;
}

export interface ListDef {
  kind: ListKind;
  /** Plural, as the notes and the page say it. */
  label: string;
  /** What one is called when NetSuite gives no name. */
  singular: string;
  /** The SuiteQL record. */
  record: string;
  /** Fields the list can't do without. */
  required: string[];
  optional: OptionalField[];
  where?: string;
  /** Time a read needs: with less left before the deadline, the next run copies it. */
  minLeftMs: number;
}

const PARENT: OptionalField = { field: 'parent', label: 'parents' };
const FULL_NAME: OptionalField = { field: 'fullname', key: 'full_name', label: 'full names' };

/** In the order they're copied: the small lists first, the items, by far the longest, last. */
export const LISTS: readonly ListDef[] = [
  {
    kind: 'location', label: 'locations', singular: 'Location', record: 'location',
    required: ['id', 'name', 'isinactive'],
    optional: [PARENT, FULL_NAME, { field: 'subsidiary', key: 'subsidiary_id', label: 'subsidiaries' }],
    minLeftMs: 10_000,
  },
  {
    kind: 'department', label: 'departments', singular: 'Department', record: 'department',
    required: ['id', 'name', 'isinactive'],
    optional: [PARENT, FULL_NAME],
    minLeftMs: 10_000,
  },
  {
    kind: 'class', label: 'classes', singular: 'Class', record: 'classification',
    required: ['id', 'name', 'isinactive'],
    optional: [PARENT, FULL_NAME],
    minLeftMs: 10_000,
  },
  {
    kind: 'term', label: 'terms', singular: 'Terms', record: 'term',
    required: ['id', 'name', 'isinactive'],
    optional: [
      { field: 'daysuntilnetdue', key: 'days_until_net_due', label: 'days until due' },
      { field: 'discountpercent', key: 'discount_percent', label: 'discounts' },
      { field: 'daysuntilexpiry', key: 'discount_days', label: 'discount days' },
    ],
    minLeftMs: 10_000,
  },
  {
    // NetSuite's sales tax items. SuiteQL shows little of them, so beyond the
    // id every field is one it may refuse.
    kind: 'tax_code', label: 'tax codes', singular: 'Tax code', record: 'salestaxitem',
    required: ['id'],
    optional: [
      { field: 'itemid', label: 'names' },
      { field: 'description', key: 'description', label: 'descriptions' },
      { field: 'isinactive', label: 'inactive flags' },
      { field: 'rate', key: 'rate', label: 'rates' },
      { field: 'taxtype', key: 'tax_type', label: 'tax types' },
      { field: 'taxagency', key: 'tax_agency_id', label: 'tax agencies' },
    ],
    minLeftMs: 15_000,
  },
  {
    kind: 'vendor', label: 'vendors', singular: 'Vendor', record: 'vendor',
    required: ['id', 'entityid', 'isinactive'],
    optional: [
      { field: 'companyname', label: 'company names' },
      { field: 'expenseaccount', key: 'expense_account', label: 'default expense accounts' },
      { field: 'payablesaccount', key: 'payables_account', label: 'payables accounts' },
      { field: 'terms', key: 'terms_id', label: 'terms' },
    ],
    minLeftMs: 20_000,
  },
  {
    // The tax items are the tax codes above, so they're left out. Items that
    // never post (descriptions, subtotals, item groups) are kept, so the
    // invoice rule can tell their lines from a sale. The COGS account isn't
    // read: this account answers 500 for it every time (2026-10-11), which
    // sent every run into the slow field-by-field read. Where an item's cost
    // posts comes from NetSuite's fulfillments, with that posting rule.
    kind: 'item', label: 'items', singular: 'Item', record: 'item',
    required: ['id', 'itemid', 'itemtype', 'isinactive'],
    optional: [
      { field: 'displayname', key: 'display_name', label: 'display names' },
      { field: 'incomeaccount', key: 'income_account', label: 'income accounts' },
      { field: 'assetaccount', key: 'asset_account', label: 'asset accounts' },
      { field: 'expenseaccount', key: 'expense_account', label: 'expense accounts' },
    ],
    where: "r.itemtype NOT IN ('TaxItem', 'TaxGroup')",
    minLeftMs: 40_000,
  },
];

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const isTrue = (v: unknown): boolean => v === true || text(v).toUpperCase() === 'T';
const numericId = (v: unknown): string | null => (/^\d+$/.test(text(v)) ? text(v) : null);
const reason = (err: unknown) => compactSuiteqlError(err);

/** A count or percentage as a number ('2%' → 2); anything else is left out. */
function amount(v: unknown): number | null {
  const s = text(v).replace(/%$/, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "a", "a and b", "a, b and c". */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// ── Reading a list ─────────────────────────────────────────────────────────

export function listQuery(def: ListDef, optional: readonly OptionalField[] = def.optional): string {
  const fields = [...def.required, ...optional.map((o) => o.field)].map((f) => `r.${f}`).join(', ');
  return `SELECT ${fields} FROM ${def.record} r${def.where ? ` WHERE ${def.where}` : ''} ORDER BY r.id`;
}

/** One optional field, for every row that has it (readFieldByField). */
export function fieldQuery(def: ListDef, o: OptionalField): string {
  const where = [def.where && `(${def.where})`, `r.${o.field} IS NOT NULL`].filter(Boolean).join(' AND ');
  return `SELECT r.id, r.${o.field} FROM ${def.record} r WHERE ${where} ORDER BY r.id`;
}

const isRejectedQuery = (err: unknown) => isSuiteqlError(err) && err.status === 400;
/**
 * A 500 that outlived the query's retries. This account answers 500
 * UNEXPECTED_ERROR for some columns instead of refusing them (a transaction's
 * createdfrom, src/lib/so-invoices.ts; an item's cogsaccount, 2026-10-11,
 * no longer read), so it's treated like a refusal that names no field.
 */
const isColumnFailure = (err: unknown) => isSuiteqlError(err) && err.status === 500;

/**
 * SuiteQL's way of saying the integration role can't see a record type at
 * all. Case matters: a refused field reads "Field 'x' for record 'y' was not
 * found", which is not this.
 */
export const recordNotFound = (err: unknown): boolean =>
  /\bRecord '[^']+' was not found/.test(String((err as any)?.message || err));

/** Whether NetSuite's refusal names this field (quoted, or after an alias). */
export function namesField(err: unknown, field: string): boolean {
  return new RegExp(`(['"]|\\.)${field}(['"]|\\b)`, 'i').test(String((err as any)?.message || err));
}

type SuiteqlAll = (query: string) => Promise<Row[]>;

/**
 * Every row of a list. When NetSuite refuses the query naming optional
 * fields, those are dropped and the read is tried again. When it refuses
 * without naming one, or answers 500, the list is read field by field
 * instead, so only the fields that fail are left out. A record the role
 * can't see, a failure with no optional field left to blame, or any other
 * failure is thrown.
 */
export async function readList(query: SuiteqlAll, def: ListDef): Promise<{ rows: Row[]; dropped: OptionalField[] }> {
  let optional = [...def.optional];
  const dropped = new Set<OptionalField>();
  const read = (rows: Row[]) => ({ rows, dropped: def.optional.filter((o) => dropped.has(o)) });
  for (;;) {
    try {
      return read(await query(listQuery(def, optional)));
    } catch (err) {
      if (!(isRejectedQuery(err) || isColumnFailure(err)) || recordNotFound(err) || optional.length === 0) throw err;
      const named = isRejectedQuery(err) ? optional.filter((o) => namesField(err, o.field)) : [];
      if (named.length === 0) return read(await readFieldByField(query, def, optional, dropped));
      for (const o of named) dropped.add(o);
      optional = optional.filter((o) => !dropped.has(o));
    }
  }
}

/**
 * The required fields alone, then each optional field in a read of its own,
 * merged by id. A field NetSuite refuses or answers 500 for joins `dropped`;
 * the required read failing fails the list.
 */
async function readFieldByField(query: SuiteqlAll, def: ListDef, optional: OptionalField[], dropped: Set<OptionalField>): Promise<Row[]> {
  const rows = await query(listQuery(def, []));
  const byId = new Map(rows.map((row) => [text(row.id), row]));
  for (const o of optional) {
    try {
      for (const value of await query(fieldQuery(def, o))) {
        const row = byId.get(text(value.id));
        if (row) row[o.field] = value[o.field];
      }
    } catch (err) {
      if (!(isRejectedQuery(err) || isColumnFailure(err))) throw err;
      dropped.add(o);
    }
  }
  return rows;
}

/** One NetSuite row as gl_netsuite_lists_apply takes it, or null without an id. */
export function mapListRow(def: ListDef, row: Row): ListRow | null {
  const id = numericId(row.id);
  if (!id) return null;
  const details: ListDetails = {};
  const put = (key: string, value: string | number | null) => {
    if (value !== null && value !== '') details[key] = value;
  };
  let name = '';
  switch (def.kind) {
    case 'location':
    case 'department':
    case 'class':
      name = text(row.name);
      if (text(row.fullname) !== name) put('full_name', text(row.fullname));
      if (def.kind === 'location') put('subsidiary_id', numericId(row.subsidiary));
      break;
    case 'term':
      name = text(row.name);
      put('days_until_net_due', amount(row.daysuntilnetdue));
      put('discount_percent', amount(row.discountpercent));
      put('discount_days', amount(row.daysuntilexpiry));
      break;
    case 'tax_code':
      name = text(row.itemid) || text(row.description);
      if (text(row.description) !== name) put('description', text(row.description));
      put('rate', text(row.rate));
      put('tax_type', text(row.taxtype));
      put('tax_agency_id', numericId(row.taxagency));
      break;
    case 'vendor':
      name = text(row.companyname) || text(row.entityid);
      if (text(row.entityid) !== name) put('entity_id', text(row.entityid));
      put('expense_account', numericId(row.expenseaccount));
      put('payables_account', numericId(row.payablesaccount));
      put('terms_id', numericId(row.terms));
      break;
    case 'item':
      name = text(row.itemid);
      put('item_type', text(row.itemtype));
      if (text(row.displayname) !== name) put('display_name', text(row.displayname));
      put('income_account', numericId(row.incomeaccount));
      put('asset_account', numericId(row.assetaccount));
      put('expense_account', numericId(row.expenseaccount));
      break;
  }
  return {
    netsuite_id: id,
    name: name || `${def.singular} ${id}`,
    parent_netsuite_id: numericId(row.parent),
    active: !isTrue(row.isinactive),
    details,
  };
}

/** The list's rows, one per NetSuite id (a row read twice across pages keeps its later read). */
export function mapList(def: ListDef, rows: Row[]): ListRow[] {
  const byId = new Map<string, ListRow>();
  for (const row of rows) {
    const mapped = mapListRow(def, row);
    if (mapped) byId.set(mapped.netsuite_id, mapped);
  }
  return [...byId.values()];
}

// ── Where sales tax posts ──────────────────────────────────────────────────

const suiteqlDate = (iso: string) => `TO_DATE('${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}', 'MM/DD/YYYY')`;

/** Sales tax's GL lines since the GL copy starts, counted by tax code and account. */
export const TAX_ACCOUNTS_QUERY = `
    SELECT tl.item AS tax_code_id, tal.account AS account_id, COUNT(*) AS line_count
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
    WHERE tal.posting = 'T' AND tl.taxline = 'T' AND tal.account IS NOT NULL
      AND t.trandate >= ${suiteqlDate(COPY_FROM)}
    GROUP BY tl.item, tal.account
    ORDER BY tl.item, tal.account
  `;

export interface TaxAccount {
  /** NULL when NetSuite's tax line names no tax code. */
  tax_code_id: string | null;
  account_id: string;
  lines: number;
}

export function mapTaxAccounts(rows: Row[]): TaxAccount[] {
  const out: TaxAccount[] = [];
  for (const row of rows) {
    const account = numericId(row.account_id);
    if (!account) continue;
    out.push({ tax_code_id: numericId(row.tax_code_id), account_id: account, lines: Number(row.line_count) || 0 });
  }
  return out.sort((a, b) => b.lines - a.lines || a.account_id.localeCompare(b.account_id));
}

// ── Where items with no income account post ────────────────────────────────

/**
 * Invoice lines since the GL copy starts whose item has no income account,
 * a payment item say, counted by item and the account NetSuite posted them
 * to. Such an item posts to an account of its own that the items copy
 * doesn't read, so the invoice rule goes by where NetSuite posted it, as it
 * does for sales tax. Tax lines are left out, and cost of goods posts on
 * stock, which has an income account.
 */
export const ITEM_ACCOUNTS_QUERY = `
    SELECT tl.item AS item_id, i.itemid AS item_name, tal.account AS account_id, COUNT(*) AS line_count
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
    JOIN item i ON i.id = tl.item
    WHERE tal.posting = 'T' AND t.type = 'CustInvc' AND tl.taxline = 'F' AND i.incomeaccount IS NULL
      AND tal.account IS NOT NULL AND t.trandate >= ${suiteqlDate(COPY_FROM)}
    GROUP BY tl.item, i.itemid, tal.account
    ORDER BY tl.item, tal.account
  `;

export interface ItemAccount {
  item_id: string;
  /** NetSuite's item name (its item number), to show. */
  item_name: string;
  account_id: string;
  lines: number;
}

export function mapItemAccounts(rows: Row[]): ItemAccount[] {
  const out: ItemAccount[] = [];
  for (const row of rows) {
    const item = numericId(row.item_id);
    const account = numericId(row.account_id);
    if (!item || !account) continue;
    out.push({ item_id: item, item_name: text(row.item_name), account_id: account, lines: Number(row.line_count) || 0 });
  }
  return out.sort((a, b) => b.lines - a.lines || a.item_id.localeCompare(b.item_id) || a.account_id.localeCompare(b.account_id));
}

// ── The run ────────────────────────────────────────────────────────────────

export interface ListResult {
  received?: number;
  added?: number;
  changed?: number;
  gone?: number;
  /** Detail keys NetSuite wouldn't give this run, so they're missing on every row. */
  missing?: string[];
  /** Not read this run for lack of time. */
  skipped?: boolean;
  error?: string;
}

export interface BooksListsSyncResult {
  lists: Partial<Record<ListKind, ListResult>>;
  /** Where sales tax posted since the GL copy starts. */
  taxAccounts?: TaxAccount[];
  /** Where invoice lines for items with no income account posted since the GL copy starts. */
  itemAccounts?: ItemAccount[];
  /** What the run couldn't do, in plain words. */
  notes?: string[];
  /** Set when no list could be read at all. */
  error?: string;
}

async function applyList(service: SupabaseClient, kind: ListKind, rows: ListRow[]) {
  let added = 0;
  let changed = 0;
  for (let i = 0; i < rows.length; i += APPLY_PAGE) {
    const { data, error } = await service.rpc('gl_netsuite_lists_apply', { p: { kind, rows: rows.slice(i, i + APPLY_PAGE) } });
    if (error) throw new Error(error.message);
    added += Number((data as any)?.added) || 0;
    changed += Number((data as any)?.changed) || 0;
  }
  const { data, error } = await service.rpc('gl_netsuite_lists_finish', { p: { kind, netsuite_ids: rows.map((r) => r.netsuite_id) } });
  if (error) throw new Error(error.message);
  const finish = (data ?? {}) as { gone?: number; here?: number; cut_short?: boolean };
  return { added, changed, gone: Number(finish.gone) || 0, here: Number(finish.here) || 0, cutShort: !!finish.cut_short };
}

export async function syncBooksLists(
  service: SupabaseClient,
  opts: { deadline?: number; deps?: { query?: SuiteqlAll; now?: () => number } } = {},
): Promise<BooksListsSyncResult & { heartbeat: HeartbeatResult }> {
  const now = opts.deps?.now ?? Date.now;
  // A background sync can wait out NetSuite's occasional transient error.
  const query: SuiteqlAll = opts.deps?.query ?? ((q) => suiteqlQueryAll(q, 1000, { retries: 2 }));
  const startedAt = now();
  const result: BooksListsSyncResult = { lists: {} };
  const notes: string[] = [];

  for (const def of LISTS) {
    if (opts.deadline !== undefined && opts.deadline - now() < def.minLeftMs) {
      result.lists[def.kind] = { skipped: true };
      notes.push(`There wasn't time left to copy the ${def.label}; the next run will.`);
      continue;
    }
    try {
      const { rows, dropped } = await readList(query, def);
      const mapped = mapList(def, rows);
      const applied = await applyList(service, def.kind, mapped);
      const missing = dropped.flatMap((o) => (o.key ? [o.key] : []));
      result.lists[def.kind] = {
        received: mapped.length, added: applied.added, changed: applied.changed, gone: applied.gone,
        ...(missing.length ? { missing } : {}),
      };
      if (dropped.length) {
        notes.push(`NetSuite wouldn't give the ${def.label}' ${joinWords(dropped.map((o) => o.label))}, so they're left out.`);
      }
      if (applied.cutShort) {
        notes.push(`NetSuite listed ${mapped.length.toLocaleString('en-US')} ${def.label} and FleetSuite has ${applied.here.toLocaleString('en-US')}, so none were marked gone.`);
      }
    } catch (err) {
      result.lists[def.kind] = { error: reason(err) };
      notes.push(recordNotFound(err)
        ? `NetSuite's integration role can't see ${def.label}, so they aren't copied. The role needs permission to view them.`
        : `NetSuite wouldn't list its ${def.label} (${reason(err)}).`);
    }

    // Where things post is read with the tax codes, early in the run, so a
    // run short of time for the items still has it.
    if (def.kind === 'tax_code') {
      try {
        result.taxAccounts = mapTaxAccounts(await query(TAX_ACCOUNTS_QUERY));
      } catch (err) {
        notes.push(`NetSuite wouldn't say which accounts sales tax posts to (${reason(err)}).`);
      }
      try {
        result.itemAccounts = mapItemAccounts(await query(ITEM_ACCOUNTS_QUERY));
      } catch (err) {
        notes.push(`NetSuite wouldn't say where items with no income account post (${reason(err)}).`);
      }
    }
  }

  const outcomes = Object.values(result.lists);
  if (outcomes.length && outcomes.every((l) => l.error)) result.error = "NetSuite wouldn't give any of the lists.";
  if (notes.length) result.notes = notes;
  const heartbeat = await recordHeartbeat(service, BOOKS_LISTS_SYNC, result, {
    startedAt,
    records: outcomes.reduce((n, l) => n + (l.received ?? 0), 0),
  });
  return { ...result, heartbeat };
}
