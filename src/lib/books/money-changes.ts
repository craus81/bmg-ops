import type { SupabaseClient } from '@supabase/supabase-js';
import { SETUP_WORDS } from '@/lib/ach-file';
import { readNames } from './netsuite-feed';
import { isOwnNumberType, OWN_NUMBER_KINDS } from './own-numbers';
import { isSwitchPiece, SWITCHES } from './switches';

/**
 * Books → Change history (part 86, migration 508, docs/books.md "Change
 * history"): every change to a row of FleetSuite's books that
 * books_money_changes holds, newest first. Each says which record, what
 * changed from what to what, how it was made (in FleetSuite; from a browser
 * signed in to the database, around FleetSuite's server; straight in the
 * database; or by a FleetSuite update) and, where FleetSuite knows, who made
 * it. A locked column (a vendor's bank account, BMG's own account for an ACH
 * file, the file itself) is named, never shown: the history never had it.
 * The vendors' bank numbers and the ACH setups and files are shown to super
 * admins only, as Pay Vendors shows them; the rest is open to whoever opens
 * the books.
 *
 * The daily books check tells the super admins about the changes made
 * outside FleetSuite, once (lookAtOutsideChanges, markOutsideChangesTold).
 */

/** How a change was made: FleetSuite's server, a browser's sign-in, a FleetSuite update, or straight in the database. */
export type ChangeVia = 'server' | 'screen' | 'database' | 'migration';
export type ChangeOp = 'insert' | 'update' | 'delete';

/** One column of a change as the history keeps it: from (left out on an insert) and to (left out on a delete), or hidden. */
export interface ChangedColumn {
  from?: unknown;
  to?: unknown;
  hidden?: boolean;
}

/** A row of books_money_changes. */
export interface ChangeRecord {
  id: number;
  at: string;
  table_name: string;
  op: ChangeOp;
  row_key: Record<string, unknown>;
  row_name: Record<string, unknown>;
  changed: Record<string, ChangedColumn>;
  via: ChangeVia;
  actor: string | null;
  db_login: string;
  db_app: string | null;
  migration: string | null;
  tx: number;
  told_at: string | null;
}

export const CHANGE_COLUMNS = 'id, at, table_name, op, row_key, row_name, changed, via, actor, db_login, db_app, migration, tx, told_at';

/** The groups the history can be narrowed to. */
export type ChangeArea =
  | 'switches' | 'settings' | 'closing' | 'paying' | 'bank' | 'received' | 'entries' | 'documents' | 'stock' | 'reconciling'
  | 'journal' | 'copies' | 'other';

export const AREAS: ReadonlyArray<{ key: ChangeArea; name: string }> = [
  { key: 'switches', name: 'Switches' },
  { key: 'settings', name: 'Companies, accounts and settings' },
  { key: 'closing', name: 'Closing months and years' },
  { key: 'paying', name: 'Paying vendors' },
  { key: 'bank', name: 'Bank numbers and ACH' },
  { key: 'received', name: 'Payments and deposits' },
  { key: 'entries', name: 'Journal entries and card charges' },
  { key: 'documents', name: 'Invoices, bills and credits' },
  { key: 'stock', name: 'Stock' },
  { key: 'reconciling', name: 'Reconciliations, sales tax and rent' },
  { key: 'journal', name: 'The journal' },
  { key: 'copies', name: "NetSuite's copies and sends" },
  { key: 'other', name: "Mistake checks, saved reports and the CPA's reviews" },
];

/** The area only super admins see: the vendors' bank numbers and the ACH setups and files, whose screens are theirs. */
export const OWNER_AREA: ChangeArea = 'bank';

interface TableInfo {
  /** What one row is, in words. */
  what: string;
  area: ChangeArea;
  /**
   * The columns that name a row, in the order migration 508's trigger was given them, for a table every change to
   * which is recorded; null for the rest of the books, where only a change made outside FleetSuite is.
   */
  names: readonly string[] | null;
}

const every = (what: string, area: ChangeArea, names: string) => ({ what, area, names: names.split(',') });
const outside = (what: string, area: ChangeArea) => ({ what, area, names: null });

/** Every table migration 508 records changes to: each of the books' tables but the history itself. */
export const TABLES: Readonly<Record<string, TableInfo>> = {
  books_switches: every('Switch', 'switches', 'piece'),
  gl_companies: every('Company', 'settings', 'code,name'),
  gl_accounts: every('Account in the chart', 'settings', 'number,name'),
  gl_periods: every('Month', 'closing', 'company_id,period_start'),
  gl_year_closes: every('Year', 'closing', 'company_id,year'),
  vendor_payment_runs: every('Payment run', 'paying', 'company,bank_account_name,pay_date,total_cents'),
  vendor_payment_run_payments: every('Payment in a run', 'paying', 'vendor_name,method,total_cents'),
  vendor_checks: every('Check', 'paying', 'company,check_number'),
  vendor_check_layouts: every('Check layout', 'paying', 'company,bank_account_netsuite_id'),
  vendor_bank_accounts: every("Vendor's bank numbers", 'bank', 'vendor_name,routing_number,account_last4'),
  vendor_ach_setups: every('ACH setup', 'bank', 'company,bank_account_netsuite_id'),
  vendor_ach_files: every('ACH file', 'bank', 'company,file_name,total_cents'),
  vendor_ach_file_payments: every('Payment in an ACH file', 'bank', 'vendor_name,cents'),
  received_payments: every('Customer payment', 'received', 'company,customer_name,amount_cents'),
  received_deposits: every('Customer deposit', 'received', 'company,customer_name,sales_order_number,amount_cents'),
  made_bank_deposits: every('Bank deposit', 'received', 'company,bank_account_name,deposit_date,total_cents'),
  typed_journal_entries: every('Journal entry typed in FleetSuite', 'entries', 'company,journal,tran_date,total_cents'),
  typed_vendor_credits: every('Vendor credit', 'documents', 'company,vendor_name,credit_number,total_cents'),
  invoice_credit_memos: every('Credit memo', 'documents', 'customer_name,invoice_number,total_cents'),
  invoice_fixes: every('Invoice fix', 'documents', 'customer_name,invoice_number'),
  bill_fixes: every('Bill fix', 'documents', 'vendor_name,bill_number'),
  detail_changes: every("Customer's or vendor's details", 'documents', 'record_type,name'),
  card_merchant_rules: every("Card merchant's account", 'settings', 'company,merchant_key'),
  card_charges: every('Card charge', 'entries', 'company,charge_date,description,cents'),
  card_charge_sends: every("A month's card charges", 'entries', 'company,month,total_cents'),
  gl_snapped_bills: every('Snapped bill', 'documents', 'vendor_name,bill_number,total'),
  sales_tax_rates: every('Sales tax rate', 'settings', 'location_id,starts_on'),
  sales_tax_returns: every('Sales tax return', 'reconciling', 'company,month'),
  own_number_series: every('Own number series', 'settings', 'doc_type'),
  rent_mortgage_setups: every('Rent and mortgage setup', 'settings', 'company'),
  rent_mortgage_months: every('Rent and mortgage month', 'reconciling', 'company,month'),
  bank_rec_starts: every('Bank reconciliation start', 'reconciling', 'company,account'),
  bank_recs: every('Bank reconciliation', 'reconciling', 'company,account,month'),
  inventory_adjustment_asks: every('Inventory adjustment for approval', 'stock', 'item_number,location_id'),
  inventory_transfers: every('Inventory transfer', 'stock', 'company,tran_date'),
  stock_counts: every('Stock count', 'stock', 'number,location_name'),

  gl_period_events: outside('Month closed or reopened', 'closing'),
  gl_year_close_events: outside('Year closed or reopened', 'closing'),
  gl_entries: outside('Journal entry', 'journal'),
  gl_lines: outside('Journal line', 'journal'),
  gl_netsuite_transactions: outside("NetSuite's copy: transaction", 'copies'),
  gl_netsuite_lines: outside("NetSuite's copy: transaction line", 'copies'),
  gl_netsuite_opening: outside("NetSuite's copy: opening balance", 'copies'),
  gl_netsuite_month_totals: outside("NetSuite's copy: month's totals", 'copies'),
  gl_netsuite_copy_lock: outside("NetSuite's copy: who's copying", 'copies'),
  gl_netsuite_lists: outside("NetSuite's copy: list entry", 'copies'),
  gl_netsuite_deposits: outside("NetSuite's copy: deposit", 'copies'),
  gl_netsuite_bills: outside("NetSuite's copy: bill", 'copies'),
  gl_netsuite_bill_payments: outside("NetSuite's copy: bill payment", 'copies'),
  gl_netsuite_spending: outside("NetSuite's copy: check or card charge", 'copies'),
  gl_netsuite_stock_documents: outside("NetSuite's copy: stock move", 'copies'),
  gl_netsuite_stock_lines: outside("NetSuite's copy: stock move line", 'copies'),
  gl_netsuite_stock_opening: outside("NetSuite's copy: opening stock", 'copies'),
  gl_netsuite_stock_counts: outside("NetSuite's copy: stock on hand", 'copies'),
  gl_netsuite_opening_parties: outside("NetSuite's copy: customer's or vendor's opening balance", 'copies'),
  gl_netsuite_open_items: outside("NetSuite's copy: open invoice or bill", 'copies'),
  gl_netsuite_1099_accounts: outside("NetSuite's copy: 1099 account", 'copies'),
  gl_netsuite_1099_reports: outside("NetSuite's 1099 report", 'copies'),
  netsuite_sends: outside('Send to NetSuite', 'copies'),
  record_differences: outside('Changed in NetSuite', 'copies'),
  gl_own_invoices: outside('Own invoice', 'documents'),
  gl_own_invoice_lines: outside('Own invoice line', 'documents'),
  gl_own_invoice_versions: outside("Own invoice's earlier version", 'documents'),
  gl_own_bills: outside('Own bill', 'documents'),
  gl_own_bill_lines: outside('Own bill line', 'documents'),
  gl_own_bill_versions: outside("Own bill's earlier version", 'documents'),
  gl_own_credit_memos: outside('Own credit memo', 'documents'),
  gl_own_credit_memo_lines: outside('Own credit memo line', 'documents'),
  gl_own_vendor_credits: outside('Own vendor credit', 'documents'),
  gl_own_vendor_credit_lines: outside('Own vendor credit line', 'documents'),
  own_numbers: outside('Own number', 'documents'),
  own_number_outside_told: outside('Made in NetSuite, told about', 'documents'),
  own_invoice_pdfs: outside('Invoice PDF', 'documents'),
  gl_own_payments: outside('Own customer payment', 'received'),
  gl_own_payment_applications: outside("Own payment's invoice", 'received'),
  gl_own_deposits: outside('Own customer deposit', 'received'),
  gl_own_bank_deposits: outside('Own bank deposit', 'received'),
  gl_own_bill_payments: outside('Own bill payment', 'paying'),
  gl_own_journal_entries: outside('Own journal entry', 'entries'),
  gl_own_journal_entry_lines: outside('Own journal entry line', 'entries'),
  card_charge_imports: outside('Card download', 'entries'),
  gl_own_fulfillments: outside('Own fulfillment', 'stock'),
  gl_own_fulfillment_lines: outside('Own fulfillment line', 'stock'),
  gl_own_receipts: outside('Own receipt', 'stock'),
  gl_own_receipt_lines: outside('Own receipt line', 'stock'),
  stock_count_lines: outside('Stock count line', 'stock'),
  bank_rec_ticks: outside('Bank reconciliation tick', 'reconciling'),
  bank_rec_events: outside('Bank reconciliation done or undone', 'reconciling'),
  gl_mistake_checks: outside('Mistake check', 'other'),
  books_saved_reports: outside('Saved report', 'other'),
  books_rules_reviews: outside("CPA's review of how the books work", 'other'),
};

/** The tables in an area. */
export const tablesIn = (area: ChangeArea): string[] => Object.keys(TABLES).filter((t) => TABLES[t].area === area);

/** The tables only super admins see. */
export const OWNER_TABLES: readonly string[] = tablesIn(OWNER_AREA);

/** What the history can be narrowed to by how a change was made. */
export type ChangeShow = 'all' | 'outside' | 'fleetsuite' | 'updates';

export const SHOWS: ReadonlyArray<{ key: ChangeShow; name: string }> = [
  { key: 'all', name: 'All' },
  { key: 'outside', name: 'Outside FleetSuite' },
  { key: 'fleetsuite', name: 'In FleetSuite' },
  { key: 'updates', name: 'FleetSuite updates' },
];

const VIAS: Readonly<Record<Exclude<ChangeShow, 'all'>, ChangeVia[]>> = {
  outside: ['screen', 'database'],
  fleetsuite: ['server'],
  updates: ['migration'],
};

/** A change made around FleetSuite's own checks: straight in the database, or from a browser signed in to it. */
export const isOutside = (via: ChangeVia) => via === 'screen' || via === 'database';

/** Changes a page of the history shows. */
export const CHANGES_PAGE = 50;
/** The days the summary counts. */
export const SUMMARY_DAYS = 30;

// ── Words ──────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** The most of a value a change shows. */
const SHOWN_MAX = 300;

const central = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A moment as the page shows it: "Nov 2, 2026, 3:00 PM Central". */
export const centralTime = (iso: string) => `${central.format(new Date(iso))} Central`;
const dayWords = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));
const monthWords = (day: string) => monthFormat.format(new Date(`${day}T00:00:00Z`));

const dollars = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const clip = (text: string) => (text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX - 1)}…` : text);

/** Columns that hold dollars and cents as a plain number (the rest of money is in whole cents, in columns ending _cents). */
const DOLLAR_COLUMNS = new Set(['total', 'amount', 'amount_open', 'debit', 'credit', 'rate', 'tax', 'value', 'billed_extra']);
/** Columns that hold the first day of a month, which stands for the month. */
const MONTH_COLUMNS = new Set(['month', 'period_start', 'posting_month', 'first_month', 'from_month', 'to_month']);
/** Columns that hold who did something besides those ending _by. */
const PERSON_COLUMNS = new Set(['actor', 'actor_id', 'user_id']);

/** A column's name in words, where its own name doesn't say it plainly. */
const COLUMN_WORDS: Readonly<Record<string, string>> = {
  is_on: 'On',
  account_locked: 'Account number',
  offset_locked: "BMG's account number",
  file_locked: 'The file',
  confirm_seal: 'Record of the call-back',
  account_last4: 'Account ends',
  offset_last4: "BMG's account ends",
  offset_routing: "BMG's routing number",
  offset_type: "BMG's account type",
  next_seq: 'Next number',
  rate_pct: 'Rate',
  books_live_from: 'Books live from',
  company_id: 'Company',
};

const WORD_FIXES: Readonly<Record<string, string>> = {
  netsuite: 'NetSuite', id: 'ID', ids: 'IDs', ach: 'ACH', po: 'PO', cpa: 'CPA', pdf: 'PDF', gl: 'GL', url: 'URL', sec: 'SEC',
};

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A column's name as the page shows it. */
export function columnWords(table: string, column: string): string {
  if (table === 'vendor_ach_setups') {
    const setup = SETUP_WORDS[column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof typeof SETUP_WORDS];
    if (setup) return capital(setup);
  }
  const fixed = COLUMN_WORDS[column];
  if (fixed) return fixed;
  return capital(column.replace(/_cents$/, '').split('_').map((w) => WORD_FIXES[w] ?? w).join(' '));
}

/** What the page needs to put a value in words: people's names and the companies' codes, by their IDs. */
export interface WordsContext {
  names: Map<string, string>;
  companies: Map<string, string>;
}

/** What the page shows of one value a column held. */
export function shownValue(column: string, value: unknown, ctx: WordsContext): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (column.endsWith('_cents')) return dollars(value);
    if (DOLLAR_COLUMNS.has(column)) return dollars(Math.round(value * 100));
    if (column === 'rate_pct') return `${value}%`;
    return String(value);
  }
  if (typeof value === 'string') {
    if (UUID.test(value) && (column.endsWith('_by') || PERSON_COLUMNS.has(column))) return ctx.names.get(value) ?? 'Someone';
    if (column === 'company_id' && ctx.companies.has(value)) return ctx.companies.get(value)!;
    if (DAY.test(value)) return MONTH_COLUMNS.has(column) ? monthWords(value) : dayWords(value);
    if (STAMP.test(value) && !Number.isNaN(Date.parse(value))) return centralTime(value);
    return value === '' ? '(empty)' : clip(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    if (value.length <= 6 && value.every((v) => v === null || typeof v !== 'object')) return clip(value.map((v) => String(v)).join(', '));
    return `${value.length.toLocaleString('en-US')} ${value.length === 1 ? 'item' : 'items'}`;
  }
  return clip(JSON.stringify(value));
}

/** One of the columns that name a row, in words, or null when it's empty. */
function namePart(table: string, column: string, value: unknown, ctx: WordsContext): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  switch (column) {
    case 'piece': return isSwitchPiece(value) ? SWITCHES[value].name : text;
    case 'doc_type': return isOwnNumberType(value) ? OWN_NUMBER_KINDS[value].many : text;
    case 'record_type': return text === 'customer' ? 'Customer' : text === 'vendor' ? 'Vendor' : text;
    case 'journal': return text === 'cpa_adjustments' ? 'CPA adjustments' : text === 'general' ? 'General journal' : text;
    case 'method': return text === 'ach' ? 'By ACH' : text === 'check' ? 'By check' : text;
    case 'bank_account_netsuite_id': return `bank account ${text}`;
    case 'location_id': return `location ${text}`;
    case 'account': return `account ${text}`;
    case 'routing_number': return `routing ${text}`;
    case 'account_last4': return `account ending ${text}`;
    case 'check_number': return `check ${text}`;
    case 'bill_number': return `bill ${text}`;
    case 'credit_number': return `credit ${text}`;
    case 'number': return table === 'stock_counts' ? `count ${text}` : text;
    case 'year': return text;
    default: return shownValue(column, value, ctx);
  }
}

/** A row's name: its own naming columns in words, or its key when the table names none. */
export function rowWords(table: string, key: Record<string, unknown>, name: Record<string, unknown>, ctx: WordsContext): string {
  const parts = (TABLES[table]?.names ?? []).map((c) => namePart(table, c, name[c], ctx)).filter((p): p is string => !!p);
  if (parts.length) return parts.join(' · ');
  return Object.entries(key)
    .map(([c, v]) => `${columnWords(table, c)} ${typeof v === 'string' && UUID.test(v) ? v.slice(0, 8) : String(v)}`)
    .join(' · ');
}

/** How a change was made, in a line. */
export function howWords(row: Pick<ChangeRecord, 'via' | 'db_login' | 'db_app' | 'migration'>, who: string | null): string {
  if (row.via === 'server') return who ? `In FleetSuite, by ${who}` : 'In FleetSuite';
  if (row.via === 'migration') return `By the FleetSuite update ${row.migration || 'that ran then'}`;
  if (row.via === 'screen') return `From a browser signed in ${who ? `as ${who}` : 'to the database'}, around FleetSuite's own screens`;
  return `Straight in the database${row.db_app ? ` with ${row.db_app}` : ''}, signed in as ${row.db_login}`;
}

/** A change as the page shows it. */
export interface ShownChange {
  id: number;
  at: string;
  table: string;
  /** What the row is, in words. */
  what: string;
  /** The row's key, column by column, to open its own history. */
  key: Record<string, unknown>;
  /** The row's name in words, or its key when it has none. */
  name: string;
  op: ChangeOp;
  via: ChangeVia;
  outside: boolean;
  who: string | null;
  how: string;
  /** Each column it changed: from left out (null) on an insert, to on a delete; a locked one hidden. */
  columns: Array<{ column: string; label: string; from: string | null; to: string | null; hidden: boolean }>;
  /** When the super admins were told about one made outside FleetSuite. */
  toldAt: string | null;
}

/** What the page shows of one hidden column's side: emptied or set, never its value. */
const hiddenSide = (item: ChangedColumn, side: 'from' | 'to') => (side in item && item[side] === null ? '(empty)' : '(not shown)');

/** What the page shows of one change. */
export function shownChange(row: ChangeRecord, ctx: WordsContext): ShownChange {
  const who = row.actor ? ctx.names.get(row.actor) ?? 'Someone' : null;
  const columns = Object.keys(row.changed ?? {}).sort().map((column) => {
    const item = row.changed[column] ?? {};
    const hidden = item.hidden === true;
    const side = (s: 'from' | 'to') => {
      if (s === 'from' ? row.op === 'insert' : row.op === 'delete') return null;
      return hidden ? hiddenSide(item, s) : shownValue(column, item[s], ctx);
    };
    return { column, label: columnWords(row.table_name, column), from: side('from'), to: side('to'), hidden };
  });
  return {
    id: Number(row.id),
    at: row.at,
    table: row.table_name,
    what: TABLES[row.table_name]?.what ?? row.table_name,
    key: row.row_key ?? {},
    name: rowWords(row.table_name, row.row_key ?? {}, row.row_name ?? {}, ctx),
    op: row.op,
    via: row.via,
    outside: isOutside(row.via),
    who,
    how: howWords(row, who),
    columns,
    toldAt: row.told_at,
  };
}

// ── Reading ────────────────────────────────────────────────────────────────

/** Each company's code by its ID, for a row that names its company by ID. */
export async function readCompanyCodes(service: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await service.from('gl_companies').select('id, code');
  // A code is only a label: without them a change still shows, with the company's ID.
  if (error) return new Map();
  return new Map(((data ?? []) as Array<{ id: string; code: string }>).map((c) => [c.id, c.code]));
}

/** The people a page of changes names: who made each, and the people its columns name. */
export function peopleIn(rows: ChangeRecord[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.actor) ids.add(row.actor);
    for (const [column, item] of Object.entries(row.changed ?? {})) {
      if (!(column.endsWith('_by') || PERSON_COLUMNS.has(column))) continue;
      for (const v of [item?.from, item?.to]) if (typeof v === 'string' && UUID.test(v)) ids.add(v);
    }
  }
  return [...ids];
}

/** What can be read of the history: every table, or every one but the super admins' own. */
const hiddenFrom = (owner: boolean): readonly string[] => (owner ? [] : OWNER_TABLES);
const notIn = (tables: readonly string[]) => `(${tables.join(',')})`;

async function counted(query: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const { count, error } = await query;
  if (error) throw new Error(`Couldn't count the changes: ${error.message}`);
  return count ?? 0;
}

/** The last SUMMARY_DAYS days' changes: how many were made in FleetSuite, outside it, and by FleetSuite's updates. */
export async function readSummary(
  service: SupabaseClient,
  opts: { now: Date; owner: boolean },
): Promise<{ days: number; fleetsuite: number; outside: number; updates: number }> {
  const since = new Date(opts.now.getTime() - SUMMARY_DAYS * 86_400_000).toISOString();
  const hidden = hiddenFrom(opts.owner);
  const head = () => {
    const q = service.from('books_money_changes').select('id', { count: 'exact', head: true }).gte('at', since);
    return hidden.length ? q.not('table_name', 'in', notIn(hidden)) : q;
  };
  const [fleetsuite, outsideCount, updates] = await Promise.all([
    counted(head().in('via', VIAS.fleetsuite)),
    counted(head().in('via', VIAS.outside)),
    counted(head().in('via', VIAS.updates)),
  ]);
  return { days: SUMMARY_DAYS, fleetsuite, outside: outsideCount, updates };
}

/**
 * One page of the history, newest first, narrowed by how the changes were made and to an area or one row of a table,
 * and whether there's more. A row's key is matched column by column.
 */
export async function readChanges(
  service: SupabaseClient,
  opts: { show: ChangeShow; area: ChangeArea | null; table: string | null; key: Record<string, unknown> | null; owner: boolean; page: number },
): Promise<{ rows: ChangeRecord[]; more: boolean }> {
  let q = service.from('books_money_changes').select(CHANGE_COLUMNS);
  if (opts.show !== 'all') q = q.in('via', VIAS[opts.show]);
  if (opts.table) q = q.eq('table_name', opts.table);
  else if (opts.area) q = q.in('table_name', tablesIn(opts.area));
  if (opts.table && opts.key) q = q.contains('row_key', opts.key);
  const hidden = hiddenFrom(opts.owner);
  if (hidden.length) q = q.not('table_name', 'in', notIn(hidden));
  const from = opts.page * CHANGES_PAGE;
  const { data, error } = await q.order('id', { ascending: false }).range(from, from + CHANGES_PAGE);
  if (error) throw new Error(`Couldn't read the changes: ${error.message}`);
  const rows = (data ?? []) as unknown as ChangeRecord[];
  return { rows: rows.slice(0, CHANGES_PAGE), more: rows.length > CHANGES_PAGE };
}

/** Puts a page of changes in words, reading the people and companies they name. */
export async function shownChanges(service: SupabaseClient, rows: ChangeRecord[]): Promise<ShownChange[]> {
  if (!rows.length) return [];
  const [names, companies] = await Promise.all([readNames(service, peopleIn(rows)), readCompanyCodes(service)]);
  return rows.map((row) => shownChange(row, { names, companies }));
}

/** A row's key as a link gives it: a JSON object of a few plain values, or null when it isn't one. */
export function parseRowKey(text: string | null): Record<string, string | number | boolean> | null {
  if (!text || text.length > 500) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.length || entries.length > 4) return null;
  for (const [column, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(column)) return null;
    if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  }
  return parsed as Record<string, string | number | boolean>;
}

// ── The daily check ────────────────────────────────────────────────────────

/** The changes made outside FleetSuite nobody has been told about, counted by table and by how. */
export interface OutsideChanges {
  changes: number;
  /** The newest one's ID: telling about them marks them up to it. */
  through: number;
  /** What the database had finished when it looked: a change still being made then, though numbered lower, waits for the next look. */
  snapshot: string;
  firstAt: string;
  lastAt: string;
  /** Most first. */
  tables: Array<{ table: string; changes: number }>;
  ways: Array<{ via: 'screen' | 'database'; login: string; app: string | null; changes: number }>;
}

/** What the daily books check tells the super admins about: the changes made outside FleetSuite since it last did; null when none. */
export async function lookAtOutsideChanges(service: SupabaseClient): Promise<OutsideChanges | null> {
  const { data, error } = await service.rpc('books_outside_changes');
  if (error) throw new Error(`couldn't read the change history (${error.message})`);
  const raw = (data ?? {}) as {
    changes?: number; through?: number | null; snapshot?: string | null; first_at?: string | null; last_at?: string | null;
    tables?: Array<{ table: string; changes: number }>;
    ways?: Array<{ via: 'screen' | 'database'; login: string; app: string | null; changes: number }>;
  };
  if (!raw.changes || raw.through == null || !raw.first_at || !raw.last_at) return null;
  return {
    changes: Number(raw.changes),
    through: Number(raw.through),
    snapshot: raw.snapshot ?? '',
    firstAt: raw.first_at,
    lastAt: raw.last_at,
    tables: (raw.tables ?? []).map((t) => ({ table: t.table, changes: Number(t.changes) })),
    ways: (raw.ways ?? []).map((w) => ({ via: w.via, login: w.login, app: w.app ?? null, changes: Number(w.changes) })),
  };
}

/** Marks the changes made outside FleetSuite that a look saw as told about; how many it marked. */
export async function markOutsideChangesTold(service: SupabaseClient, seen: Pick<OutsideChanges, 'through' | 'snapshot'>): Promise<number> {
  const { data, error } = await service.rpc('books_outside_changes_told', { p: { through: seen.through, snapshot: seen.snapshot } });
  if (error) throw new Error(`couldn't note the changes told about (${error.message})`);
  return Number((data as { told?: number } | null)?.told ?? 0);
}
