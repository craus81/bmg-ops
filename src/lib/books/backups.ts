import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import { ledgerPdfsEnabled } from '@/lib/ledger/pdf-gate';
import { r2HeadInfo, r2PresignGet, r2Upload } from '@/lib/r2';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { BackupWorkbook, centralTime, type JournalRow, type WorkbookAccount, type WorkbookBalance, type WorkbookCompany } from './backup-workbook';
import { BACKUPS_LISTED } from './backup-words';

/**
 * Backups of FleetSuite's books (part 84; the NetSuite Exit Checklist's
 * "Backups", thread "Replacing NetSuite with FleetSuite"; docs/books.md
 * "Backups"). Every night at 2:11 AM Central, and whenever a super admin
 * presses Back up now on Books → Backups, FleetSuite copies every table of
 * the books (BACKUP_TABLES) out of Supabase into one zip in BMG's private
 * file storage (Cloudflare R2, under books-backups/):
 *   * tables/<table>.csv, each table as Postgres's COPY reads it back, a
 *     value in quotes and NULL an empty field without them, so nothing is
 *     lost on the way back in;
 *   * <name>-journal.xlsx, the journal to read in Excel
 *     (backup-workbook.ts);
 *   * manifest.json, what each file holds (columns, key, rows, SHA-256),
 *     the order to load them in, and the trial balance the journal adds up
 *     to; README.txt, the same in words.
 * The journal is copied as it stood the moment the backup began (migration
 * 506's snapshot), so an entry posted while it runs is wholly in the next
 * one; the other tables are read children first, which keeps a row's
 * parents in the copy. Before the zip is kept it's opened again: every
 * file's SHA-256 has to match the manifest and the journal's CSV files
 * have to add up, entry for entry, line for line and account by account,
 * to the books' own trial balance as of that moment, and what lands in
 * storage has to be the size sent. One that doesn't check out is kept for
 * a look but marked failed, and the daily check's first look tells the
 * super admins (and Craig by email) about a backup that failed, or about
 * none made in 26 hours.
 *
 * It only reads the books and writes to BMG's own storage, so it needs no
 * switch; it goes there only while the storage is confirmed private
 * (src/lib/ledger/pdf-gate.ts). Every copy is kept.
 */

/** Its row in sync_state; left out of System Health like the other books jobs, since the daily check tells about it. */
export const BOOKS_BACKUP = 'books_backup';
/** Where the zips go in BMG's file storage; never reachable through the generic storage routes (storage-guard.ts). */
export const BACKUP_PREFIX = 'books-backups';
export const BACKUP_FORMAT = 'fleetsuite-books-backup@1';
/** Hours after the last good backup before the daily check says none has been made. */
export const BACKUP_DUE_HOURS = 26;
/** A backup still running after this long has stopped: its server was cut off (migration 506 marks it failed). */
export const BACKUP_STOPPED_MINUTES = 10;
/** The nightly run's moment, 08:11 UTC (vercel.json). */
export const NIGHTLY_UTC = { hour: 8, minute: 11 };
/** Backups the page lists (backup-words.ts, so the page has it without this file). */
export { BACKUPS_LISTED };

/** Rows read at a time from a table, and journal entries (each with its lines). */
const PAGE_ROWS = 5000;
const JOURNAL_ENTRIES = 1000;

/**
 * Every table FleetSuite's books keep, in the order their migrations made
 * them: the journal and its months and years, the copies of NetSuite's
 * books, FleetSuite's own documents, and what the books' pieces keep
 * (switches, saved reports, sends to NetSuite, payment runs, bank
 * reconciliations, sales tax, own numbers, counts, the CPA's reviews).
 * Every table a migration from 359 on makes is either here or in NOT_BOOKS
 * (backups.test.ts).
 */
export const BACKUP_TABLES: readonly string[] = [
  'gl_companies', 'gl_accounts', 'gl_periods', 'gl_period_events', 'gl_entries', 'gl_lines',
  'gl_netsuite_transactions', 'gl_netsuite_lines', 'gl_netsuite_opening', 'gl_netsuite_month_totals', 'gl_netsuite_copy_lock',
  'gl_netsuite_lists', 'gl_netsuite_deposits', 'gl_netsuite_bills', 'gl_netsuite_bill_payments', 'gl_netsuite_spending',
  'gl_netsuite_stock_documents', 'gl_netsuite_stock_lines', 'gl_netsuite_stock_opening', 'gl_netsuite_stock_counts',
  'gl_netsuite_opening_parties', 'gl_netsuite_open_items', 'gl_netsuite_1099_accounts', 'gl_netsuite_1099_reports',
  'gl_own_invoices', 'gl_own_invoice_lines', 'gl_own_fulfillments', 'gl_own_fulfillment_lines', 'gl_mistake_checks',
  'gl_own_bills', 'gl_own_bill_lines', 'gl_own_receipts', 'gl_own_receipt_lines', 'gl_snapped_bills',
  'books_switches', 'invoice_credit_memos', 'gl_own_credit_memos', 'gl_own_credit_memo_lines',
  'typed_vendor_credits', 'gl_own_vendor_credits', 'gl_own_vendor_credit_lines',
  'card_charge_imports', 'card_charge_sends', 'card_charges', 'card_merchant_rules',
  'typed_journal_entries', 'gl_own_journal_entries', 'gl_own_journal_entry_lines', 'inventory_transfers',
  'invoice_fixes', 'gl_own_invoice_versions', 'bill_fixes', 'gl_own_bill_versions', 'detail_changes', 'netsuite_sends',
  'record_differences', 'received_payments', 'gl_own_payments', 'gl_own_payment_applications',
  'received_deposits', 'gl_own_deposits', 'made_bank_deposits', 'gl_own_bank_deposits',
  'vendor_payment_runs', 'vendor_payment_run_payments', 'gl_own_bill_payments', 'vendor_check_layouts', 'vendor_checks',
  'vendor_bank_accounts', 'vendor_ach_setups', 'vendor_ach_files', 'vendor_ach_file_payments',
  'rent_mortgage_setups', 'rent_mortgage_months', 'bank_rec_starts', 'bank_recs', 'bank_rec_ticks', 'bank_rec_events',
  'inventory_adjustment_asks', 'sales_tax_rates', 'sales_tax_returns',
  'own_number_series', 'own_numbers', 'own_number_outside_told', 'own_invoice_pdfs', 'stock_counts', 'stock_count_lines',
  'books_saved_reports', 'gl_year_closes', 'gl_year_close_events', 'books_money_changes', 'books_rules_reviews',
];

/** Tables migrations from 359 on make that aren't the books, and what they are instead. */
export const NOT_BOOKS: Readonly<Record<string, string>> = {
  part_price_mismatches: "Parts whose FleetSuite and NetSuite prices differ, found again each night.",
  netsuite_vendor_po_expense_lines: "A copy of NetSuite's purchase orders' other lines, such as freight, read again from NetSuite.",
  customer_holds: "Sales: a hold on a customer's orders.",
  so_print_queue: 'Sales: which sales orders are waiting to be printed for the board.',
  customer_hold_overrides: 'Sales: an order let through a hold.',
  photo_shares: 'Photo links sent to customers.',
  netsuite_estimates: "A copy of NetSuite's estimates, read again from NetSuite.",
  netsuite_estimate_lines: "A copy of NetSuite's estimate lines, read again from NetSuite.",
  phone_spam_numbers: "The phone agent's spam list.",
  dropbox_client_folders: "Customers' Dropbox folders.",
  dropbox_client_files: "Customers' Dropbox files.",
  qc_fix_reports: 'Quality checks in the shop.',
  qc_fix_photos: 'Quality check photos.',
  graphics_job_kits: 'Graphics jobs.',
  graphics_job_client_files: "Graphics jobs' customer files.",
  graphics_material_options: 'Graphics materials.',
  role_feature_settings: 'Who sees what in FleetSuite.',
  estimate_download_tokens: 'Download links on estimates.',
  estimate_client_files: "Estimates' customer files.",
  estimate_invoices: "Estimates' links to their invoices.",
  drop_ship_orders: 'Purchasing: drop ship orders.',
  hitch_parts: 'The hitch catalog.',
  hitch_fitment: 'The hitch catalog.',
  hitch_settings: 'The hitch catalog.',
  curt_prices: "CURT's price list.",
  email_unsubscribes: 'Who asked not to be emailed.',
  outreach_targets: 'Sales outreach.',
  shop_staff: 'The shop schedule.',
  staff_time_off: 'The shop schedule.',
  typed_invoices: 'Pro forma invoices, which never post.',
  typed_sales_orders: 'Sales orders typed in FleetSuite, before NetSuite has them.',
  so_invoice_claims: "A sales order's invoicing in progress, held for minutes.",
  document_send_marks: 'Which documents were emailed.',
  inventory_adjustments: "Inventory's log of the adjustments staff make; the books keep NetSuite's copy of each.",
  app_requests: 'In-app requests.',
  app_request_messages: 'In-app requests.',
  app_request_files: 'In-app requests.',
  app_request_me_too: 'In-app requests.',
  books_backups: 'The record of the backups themselves.',
  books_restore_drills: 'The record of the restore drills, which put each backup back into a scratch database.',
};

export interface BackupColumn {
  name: string;
  type: string;
}

/** One table as migration 506's books_backup_begin describes it. */
export interface BackupTable {
  table: string;
  columns: BackupColumn[];
  generated: string[];
  identity: string[];
  key: string[];
  parents: string[];
}

type Row = (string | null)[];

interface Started {
  state: 'started';
  id: string;
  started_at: string;
  snapshot: string;
  migration: string | null;
  tables: BackupTable[];
}

interface Running {
  state: 'running';
  id: string | null;
  started_at: string | null;
  how: string | null;
}

interface TrialBalance {
  entries: number;
  lines: number;
  accounts: { company_id: string; account_id: string; debit: string; credit: string }[];
}

/** A problem to say as it is, in the words the page shows. */
export class BackupProblem extends Error {}

/** An error's message on one line, for a record or a page. */
export const reasonOf = (err: unknown) => String((err as any)?.message || err || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 500);
/** 1 → '1 entry', 1200 → '1,200 entries'. */
export const counted = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// ── CSV, as Postgres's COPY writes and reads it ─────────────────────────────

/** A value in quotes, its quotes doubled; NULL an empty field without them, which COPY reads back as NULL. */
export function csvValue(value: string | null): string {
  return value === null ? '' : `"${value.replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly (string | null)[]): string {
  return `${values.map(csvValue).join(',')}\n`;
}

/**
 * Reads CSV back a record at a time: a quoted value is that text (an empty
 * one ''), an empty field without quotes is null. Takes Postgres's own
 * unquoted values too, and \r\n line ends.
 */
export function* csvRows(text: string): Generator<Row> {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const row: Row = [];
    for (;;) {
      if (text[i] === '"') {
        let value = '';
        i += 1;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) throw new Error('A quoted value never ends.');
          value += text.slice(i, q);
          if (text[q + 1] === '"') {
            value += '"';
            i = q + 2;
            continue;
          }
          i = q + 1;
          break;
        }
        row.push(value);
      } else {
        let j = i;
        while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j += 1;
        const raw = text.slice(i, j);
        row.push(raw === '' ? null : raw);
        i = j;
      }
      if (i >= n) {
        yield row;
        return;
      }
      const ch = text[i];
      if (ch === ',') {
        i += 1;
        continue;
      }
      if (ch === '\r' && text[i + 1] === '\n') i += 2;
      else if (ch === '\n' || ch === '\r') i += 1;
      else throw new Error(`A value runs on into ${JSON.stringify(ch)}.`);
      yield row;
      break;
    }
  }
}

// ── Amounts in whole cents, exactly ────────────────────────────────────────

/** '1250.50' → 125050, '-0.01' → -1, exactly. Refuses anything finer than a cent, or too large to add up exactly. */
export function exactCents(text: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2})0*)?$/.exec(String(text).trim());
  if (!m) throw new Error(`An amount FleetSuite can't read: ${String(text).slice(0, 40)}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`An amount too large to add up exactly: ${String(text).slice(0, 40)}`);
  return m[1] && cents ? -cents : cents;
}

/** Whole cents as money: -123456 → '-$1,234.56'. */
export function moneyText(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

// ── Names and order ────────────────────────────────────────────────────────

/** 'fleetsuite-books-2026-11-03-081100Z', from the moment the backup began (UTC). */
export function backupName(at: Date): string {
  const iso = at.toISOString();
  return `fleetsuite-books-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** Its file under BACKUP_PREFIX: '2026/fleetsuite-books-2026-11-03-081100Z.zip'. */
export function backupFilePath(at: Date): string {
  return `${at.toISOString().slice(0, 4)}/${backupName(at)}.zip`;
}

/** The order a restore loads tables in: each after the tables its foreign keys point at, otherwise as listed. */
export function loadOrder(tables: readonly Pick<BackupTable, 'table' | 'parents'>[]): string[] {
  const listed = new Set(tables.map((t) => t.table));
  const done = new Set<string>();
  const order: string[] = [];
  let left = [...tables];
  while (left.length) {
    const ready = left.filter((t) => t.parents.every((p) => p === t.table || !listed.has(p) || done.has(p)));
    // A loop of foreign keys: COPY with them off loads in any order, so the first as listed goes next.
    for (const t of ready.length ? ready : [left[0]]) {
      done.add(t.table);
      order.push(t.table);
    }
    left = left.filter((t) => !done.has(t.table));
  }
  return order;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
const names = (t: BackupTable) => t.columns.map((c) => c.name);
const sameList = (a: readonly string[] | null | undefined, b: readonly string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

/** Where each named column sits in a table's rows. */
function columnsOf<K extends string>(table: BackupTable, wanted: readonly K[]): Record<K, number> {
  const at = {} as Record<K, number>;
  for (const name of wanted) {
    const i = table.columns.findIndex((c) => c.name === name);
    if (i < 0) throw new Error(`${table.table} has no ${name} column`);
    at[name] = i;
  }
  return at;
}

/** A moment as Postgres writes it in UTC ('2026-11-03 08:11:00.123456+00') as a Date. */
export function pgTime(text: string): Date {
  return new Date(text.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00'));
}

// ── The database's side (migration 506) ────────────────────────────────────

async function call<T>(service: SupabaseClient, fn: string, p: Record<string, unknown>): Promise<T> {
  const { data, error } = await service.rpc(fn, { p });
  if (error) throw new Error(error.message || `${fn} failed`);
  return data as T;
}

interface TableFile {
  table: string;
  csv: Buffer;
  rows: number;
  sha256: string;
}

const fileOf = (table: string, chunks: string[], rows: number): TableFile => {
  const csv = Buffer.from(chunks.join(''), 'utf8');
  return { table, csv, rows, sha256: sha256(csv) };
};

/** One table, page by page by its key, as CSV; `onRows` sees each page. */
async function readTable(
  service: SupabaseClient,
  table: BackupTable,
  limit: number,
  inTime: () => void,
  onRows?: (rows: Row[]) => void,
): Promise<TableFile> {
  const columns = names(table);
  const chunks = [csvRow(columns)];
  let rows = 0;
  let after: string[] | null = null;
  for (;;) {
    inTime();
    const page: { columns: string[]; rows: Row[]; last: string[] | null } = await call(service, 'books_backup_page', {
      table: table.table, after, limit,
    });
    if (!sameList(page.columns, columns)) throw new BackupProblem(`${table.table} changed while it was being copied. The next backup copies it as it is now.`);
    for (const r of page.rows) {
      if (r.length !== columns.length) throw new Error(`${table.table} sent a row of ${r.length} values for ${columns.length} columns`);
      chunks.push(csvRow(r));
    }
    rows += page.rows.length;
    onRows?.(page.rows);
    if (!page.last) break;
    after = page.last;
  }
  return fileOf(table.table, chunks, rows);
}

// ── Making one ─────────────────────────────────────────────────────────────

export interface BackupRunOptions {
  how: 'nightly' | 'by_hand';
  /** profiles.id and name of who pressed Back up now. */
  by?: string | null;
  byName?: string | null;
  /** Date.now() past which it stops and fails, before the platform cuts it off. */
  deadline: number;
  /** The tables to copy; BACKUP_TABLES unless a test gives fewer. */
  tables?: readonly string[];
  /** Rows read at a time from a table, and journal entries; PAGE_ROWS and JOURNAL_ENTRIES unless a test gives fewer. */
  pageRows?: number;
  journalEntries?: number;
}

export interface BackupRunResult {
  state: 'made' | 'failed' | 'running';
  id: string | null;
  startedAt: string | null;
  file: string | null;
  bytes: number | null;
  error: string | null;
  heartbeat?: HeartbeatResult;
}

interface Made {
  path: string;
  bytes: number;
  sha256: string;
  tables: number;
  rows: number;
  entries: number;
  lines: number;
  checked: boolean;
  problem: string | null;
}

/** Why no copy of the books can go to BMG's file storage now, or null while it's confirmed private. */
export function storageProblem(gate: { enabled: boolean; readError?: string }): string | null {
  if (gate.enabled) return null;
  return gate.readError
    ? `FleetSuite couldn't check that BMG's file storage is private (${gate.readError}), so no copy of the books goes there.`
    : "BMG's file storage isn't confirmed private (docs/r2-private-flip.md), so no copy of the books goes there.";
}

/** What a run that reads in time makes: the zip, what's in it, and whether it checked out. */
async function makeBackup(service: SupabaseClient, begun: Started, opts: BackupRunOptions): Promise<Made> {
  const closed = storageProblem(await ledgerPdfsEnabled(service));
  if (closed) throw new BackupProblem(closed);

  const madeAt = pgTime(begun.started_at);
  const name = backupName(madeAt);
  const path = backupFilePath(madeAt);
  const tables = new Map(begun.tables.map((t) => [t.table, t]));
  const table = (t: string) => {
    const found = tables.get(t);
    if (!found) throw new Error(`${t} isn't among the tables copied`);
    return found;
  };
  const files = new Map<string, TableFile>();
  const pageRows = opts.pageRows ?? PAGE_ROWS;
  const inTime = () => {
    if (Date.now() > opts.deadline) {
      throw new BackupProblem(`It ran out of time with ${files.size} of ${begun.tables.length} tables copied.`);
    }
  };

  // The companies and the chart of accounts first: the workbook names them.
  const companyRows: Row[] = [];
  const accountRows: Row[] = [];
  files.set('gl_companies', await readTable(service, table('gl_companies'), pageRows, inTime, (rows) => companyRows.push(...rows)));
  files.set('gl_accounts', await readTable(service, table('gl_accounts'), pageRows, inTime, (rows) => accountRows.push(...rows)));
  const cc = columnsOf(table('gl_companies'), ['id', 'code', 'name'] as const);
  const ac = columnsOf(table('gl_accounts'), ['id', 'number', 'name', 'account_type', 'parent_id', 'company_id', 'netsuite_account_id', 'is_control', 'active'] as const);
  const companies: WorkbookCompany[] = companyRows
    .map((r) => ({ id: r[cc.id]!, code: r[cc.code]!, name: r[cc.name]! }))
    .sort((a, b) => (a.code === 'BMG' ? -1 : b.code === 'BMG' ? 1 : a.code.localeCompare(b.code)));
  const accounts: WorkbookAccount[] = accountRows.map((r) => ({
    id: r[ac.id]!, number: r[ac.number], name: r[ac.name]!, type: r[ac.account_type]!, parentId: r[ac.parent_id],
    companyId: r[ac.company_id], netsuiteId: r[ac.netsuite_account_id], control: r[ac.is_control] === 'true', active: r[ac.active] === 'true',
  }));
  const companyCode = new Map(companies.map((c) => [c.id, c.code]));
  const accountOf = new Map(accounts.map((a) => [a.id, a]));

  // What the books add up to as of the moment the backup began, which the copy has to match.
  const tb = await call<TrialBalance>(service, 'books_backup_trial_balance', { snapshot: begun.snapshot });
  const balances: WorkbookBalance[] = tb.accounts.map((a) => ({
    companyId: a.company_id, accountId: a.account_id, debitCents: exactCents(a.debit), creditCents: exactCents(a.credit),
  }));

  const workbook = BackupWorkbook.start({ madeAt, companies, accounts, balances, entries: Number(tb.entries), lines: Number(tb.lines) });
  let xlsx: Buffer;
  try {
    // The journal, entries in order each with its lines, into its CSV files and the workbook at once.
    const entriesTable = table('gl_entries');
    const linesTable = table('gl_lines');
    const ec = columnsOf(entriesTable, ['id', 'entry_no', 'company_id', 'entry_date', 'source_type', 'source_id', 'posting_rule', 'memo', 'reverses_entry_id', 'posted_by_name', 'posted_at'] as const);
    const lc = columnsOf(linesTable, ['entry_id', 'company_id', 'entry_date', 'account_id', 'debit', 'credit', 'memo', 'division', 'location', 'vendor_ref', 'job_ref', 'item_number'] as const);
    const entryChunks = [csvRow(names(entriesTable))];
    const lineChunks = [csvRow(names(linesTable))];
    const entryNos = new Map<string, number>();
    let entryCount = 0;
    let lineCount = 0;
    let after: number | null = null;
    do {
      inTime();
      const page: { entry_columns: string[]; line_columns: string[]; entries: Row[]; lines: Row[]; last: number | null } = await call(
        service, 'books_backup_journal', { snapshot: begun.snapshot, after, limit: opts.journalEntries ?? JOURNAL_ENTRIES },
      );
      if (!sameList(page.entry_columns, names(entriesTable)) || !sameList(page.line_columns, names(linesTable))) {
        throw new BackupProblem('The journal changed shape while it was being copied. The next backup copies it as it is now.');
      }
      const onPage = new Map<string, Row>();
      for (const e of page.entries) {
        if (e.length !== entriesTable.columns.length) throw new Error(`gl_entries sent a row of ${e.length} values`);
        entryChunks.push(csvRow(e));
        onPage.set(e[ec.id]!, e);
        entryNos.set(e[ec.id]!, Number(e[ec.entry_no]));
      }
      const rows: JournalRow[] = [];
      for (const l of page.lines) {
        if (l.length !== linesTable.columns.length) throw new Error(`gl_lines sent a row of ${l.length} values`);
        lineChunks.push(csvRow(l));
        const e = onPage.get(l[lc.entry_id]!);
        if (!e) throw new Error('A journal line came without its entry.');
        const account = accountOf.get(l[lc.account_id]!);
        rows.push({
          company: companyCode.get(l[lc.company_id]!) ?? '',
          entryNo: Number(e[ec.entry_no]),
          date: l[lc.entry_date]!,
          account: account?.number ?? null,
          accountName: account?.name ?? `Account ${l[lc.account_id]}`,
          debit: Number(l[lc.debit]),
          credit: Number(l[lc.credit]),
          memo: e[ec.memo],
          lineMemo: l[lc.memo],
          division: l[lc.division],
          location: l[lc.location],
          item: l[lc.item_number],
          vendor: l[lc.vendor_ref],
          job: l[lc.job_ref],
          // A reversal's source is the entry it reverses, which Reverses entry names.
          source: e[ec.reverses_entry_id] ? e[ec.source_type]! : [e[ec.source_type], e[ec.source_id]].filter(Boolean).join(' '),
          rule: e[ec.posting_rule]!,
          postedAt: pgTime(e[ec.posted_at]!).toISOString(),
          postedBy: e[ec.posted_by_name],
          reverses: e[ec.reverses_entry_id] ? entryNos.get(e[ec.reverses_entry_id]!) ?? null : null,
        });
      }
      workbook.addJournal(rows);
      entryCount += page.entries.length;
      lineCount += page.lines.length;
      after = page.last;
    } while (after !== null);
    files.set('gl_entries', fileOf('gl_entries', entryChunks, entryCount));
    files.set('gl_lines', fileOf('gl_lines', lineChunks, lineCount));
  } finally {
    // Closed either way, so a failed run leaves nothing open.
    xlsx = await workbook.finish();
  }

  // Everything else, children before parents: a row read later has its parents in the copy.
  for (const t of loadOrder(begun.tables).reverse()) {
    if (files.has(t)) continue;
    files.set(t, await readTable(service, table(t), pageRows, inTime));
  }

  const order = loadOrder(begun.tables);
  const workbookName = `${name}-journal.xlsx`;
  const manifest = {
    format: BACKUP_FORMAT,
    made_at: madeAt.toISOString(),
    how: opts.how,
    asked_by: opts.how === 'by_hand' ? opts.byName ?? null : null,
    snapshot: begun.snapshot,
    migration: begun.migration,
    app_commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    restore: 'docs/books.md "Backups" in FleetSuite\'s code',
    csv: { header: true, quote: '"', null: 'an empty field without quotes', encoding: 'UTF8', times: 'UTC' },
    load_order: order,
    tables: begun.tables.map((t) => {
      const f = files.get(t.table)!;
      return { ...t, file: `tables/${t.table}.csv`, rows: f.rows, bytes: f.csv.length, sha256: f.sha256 };
    }),
    journal: {
      workbook: workbookName,
      entries: Number(tb.entries),
      lines: Number(tb.lines),
      trial_balance: tb.accounts,
    },
  };
  const zip = new JSZip();
  const folder = zip.folder(name)!;
  for (const t of begun.tables) {
    folder.file(`tables/${t.table}.csv`, files.get(t.table)!.csv, { compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }
  folder.file(workbookName, xlsx, { compression: 'STORE' });
  folder.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, { compression: 'DEFLATE' });
  folder.file('README.txt', readmeText({ madeAt, name, migration: begun.migration, workbook: workbookName }), { compression: 'DEFLATE' });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
  const rows = [...files.values()].reduce((sum, f) => sum + f.rows, 0);
  files.clear();

  // Opened again before it's kept.
  const problem = await checkBackup(bytes, { name, manifest, tb, companyCode, accountOf });

  const there = await r2HeadInfo(BACKUP_PREFIX, path);
  if (there) throw new BackupProblem(`A backup named ${path} is already in storage, so this one wasn't written over it.`);
  const sent = await r2Upload(BACKUP_PREFIX, path, bytes, 'application/zip');
  if (!sent.success) throw new BackupProblem(`Couldn't keep it in BMG's file storage: ${sent.error || 'no reason given'}.`);
  const landed = await r2HeadInfo(BACKUP_PREFIX, path);
  const stored = !landed
    ? "BMG's file storage doesn't show the file after it was sent."
    : landed.bytes !== bytes.length
      ? `BMG's file storage holds ${landed.bytes ?? 'no'} bytes of the ${bytes.length} sent.`
      : landed.etag && /^[0-9a-f]{32}$/i.test(landed.etag) && landed.etag.toLowerCase() !== md5(bytes)
        ? "BMG's file storage holds different bytes from the ones sent."
        : null;

  return {
    path,
    bytes: bytes.length,
    sha256: sha256(bytes),
    tables: begun.tables.length,
    rows,
    entries: Number(tb.entries),
    lines: Number(tb.lines),
    checked: problem === null,
    problem: problem ?? stored,
  };
}

/**
 * Opens a backup's zip again: every table's file is there with the SHA-256
 * the manifest gives it, and the journal's CSV files add up, entry for
 * entry, line for line and account by account, to the books' trial balance
 * as of the moment it began. What's wrong, in words, or null.
 */
export async function checkBackup(
  bytes: Uint8Array,
  p: {
    name: string;
    manifest: { tables: { table: string; file: string; sha256: string; columns: BackupColumn[] }[] };
    tb: TrialBalance;
    companyCode?: ReadonlyMap<string, string>;
    accountOf?: ReadonlyMap<string, Pick<WorkbookAccount, 'number' | 'name'>>;
  },
): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes);
  for (const t of p.manifest.tables) {
    const file = zip.file(`${p.name}/${t.file}`);
    if (!file) return `The backup has no ${t.file}.`;
    if (sha256(await file.async('uint8array')) !== t.sha256) return `${t.file} in the backup isn't what was written.`;
  }

  const read = async (table: string) => {
    const t = p.manifest.tables.find((x) => x.table === table);
    if (!t) throw new Error(`The backup has no ${table}.`);
    const text = await zip.file(`${p.name}/${t.file}`)!.async('string');
    const rows = csvRows(text);
    const header = rows.next();
    if (header.done || !sameList(header.value as string[], t.columns.map((c) => c.name))) throw new Error(`${t.file} doesn't start with its columns.`);
    return { rows, at: (name: string) => t.columns.findIndex((c) => c.name === name) };
  };

  try {
    const entries = await read('gl_entries');
    let entryCount = 0;
    while (!entries.rows.next().done) entryCount += 1;
    if (entryCount !== Number(p.tb.entries)) {
      return `The backup's journal has ${counted(entryCount, 'entry', 'entries')}, and the books had ${counted(Number(p.tb.entries), 'entry', 'entries')} when it began.`;
    }

    const lines = await read('gl_lines');
    const company = lines.at('company_id');
    const account = lines.at('account_id');
    const debit = lines.at('debit');
    const credit = lines.at('credit');
    const sums = new Map<string, { debit: number; credit: number }>();
    let lineCount = 0;
    for (const row of lines.rows) {
      lineCount += 1;
      const key = `${row[company]}|${row[account]}`;
      const sum = sums.get(key) ?? { debit: 0, credit: 0 };
      sum.debit += exactCents(row[debit] ?? '');
      sum.credit += exactCents(row[credit] ?? '');
      sums.set(key, sum);
    }
    if (lineCount !== Number(p.tb.lines)) {
      return `The backup's journal has ${counted(lineCount, 'line', 'lines')}, and the books had ${counted(Number(p.tb.lines), 'line', 'lines')} when it began.`;
    }

    const named = (companyId: string, accountId: string) => {
      const a = p.accountOf?.get(accountId);
      const code = p.companyCode?.get(companyId);
      return `${a ? [a.number, a.name].filter(Boolean).join(' ') : `account ${accountId}`}${code ? ` (${code})` : ''}`;
    };
    const books = new Map(p.tb.accounts.map((a) => [`${a.company_id}|${a.account_id}`, a]));
    for (const [key, a] of books) {
      const copy = sums.get(key) ?? { debit: 0, credit: 0 };
      const want = { debit: exactCents(a.debit), credit: exactCents(a.credit) };
      if (copy.debit !== want.debit || copy.credit !== want.credit) {
        return `The backup's journal adds up differently for ${named(a.company_id, a.account_id)}: ${moneyText(copy.debit)} of debits and ${moneyText(copy.credit)} of credits, `
          + `and the books had ${moneyText(want.debit)} and ${moneyText(want.credit)}.`;
      }
    }
    for (const key of sums.keys()) {
      if (!books.has(key)) {
        const [companyId, accountId] = key.split('|');
        return `The backup's journal has lines on ${named(companyId, accountId)}, which the books didn't have when it began.`;
      }
    }
  } catch (err) {
    return `The backup's journal couldn't be read back: ${reasonOf(err)}`;
  }
  return null;
}

function readmeText(p: { madeAt: Date; name: string; migration: string | null; workbook: string }): string {
  return [
    `FleetSuite's books, backed up ${centralTime(p.madeAt)}.`,
    '',
    "What's here",
    '- tables/: every table of the books as a CSV file, its first line naming the columns. A value in quotes is that text; an empty field without quotes is NULL. Times are UTC.',
    `- ${p.workbook}: the journal to read in Excel: each account's debits and credits, every entry with its lines, the chart of accounts.`,
    "- manifest.json: what each file holds (columns, key, rows, SHA-256), the order to load them in, and the trial balance the journal adds up to.",
    '',
    'The journal (gl_entries and gl_lines) is as it stood when the backup began. The other tables were read while it ran, each table a moment after the ones that point at it.',
    '',
    `Restoring (docs/books.md "Backups" in FleetSuite's code says it in full)`,
    `1. Run FleetSuite's migrations${p.migration ? ` up to ${p.migration}` : ''} on an empty database.`,
    '2. In psql: SET session_replication_role = replica; empty the tables the migrations filled in (TRUNCATE them, the backup\'s tables, CASCADE); then for each table in manifest.json\'s load_order:',
    `   \\copy public.<table> (<its columns>) FROM '${p.name}/tables/<table>.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`,
    '3. SET session_replication_role = origin; then set each identity column\'s sequence past its highest number (setval).',
    "4. Check the journal's trial balance against manifest.json's.",
    '',
    "Vendors' bank and ACH numbers are in it only as FleetSuite encrypted them. Reading them needs FleetSuite's VENDOR_BANK_KEY, which isn't in the backup.",
    '',
  ].join('\n');
}

/**
 * Makes a backup now: starts it (one at a time; one already running is
 * said, not doubled), copies the books into a zip, checks it, keeps it in
 * BMG's file storage, and writes how it went to its row and to sync_state.
 * Never throws for a problem with the backup; a failed one says why.
 */
export async function runBackup(service: SupabaseClient, opts: BackupRunOptions): Promise<BackupRunResult> {
  const startedAt = Date.now();
  let begun: Started | Running;
  try {
    begun = await call<Started | Running>(service, 'books_backup_begin', {
      how: opts.how,
      by: opts.how === 'by_hand' ? opts.by ?? null : null,
      by_name: opts.how === 'by_hand' ? opts.byName ?? null : null,
      tables: opts.tables ?? BACKUP_TABLES,
    });
  } catch (err) {
    const error = `Couldn't start a backup: ${reasonOf(err)}`;
    const heartbeat = await recordHeartbeat(service, BOOKS_BACKUP, { how: opts.how, state: 'failed', error }, { startedAt, records: null, touchLastSyncedAt: false });
    return { state: 'failed', id: null, startedAt: null, file: null, bytes: null, error, heartbeat };
  }
  if (begun.state === 'running') {
    return { state: 'running', id: begun.id ?? null, startedAt: begun.started_at ?? null, file: null, bytes: null, error: null };
  }

  let made: Made | null = null;
  let error: string | null = null;
  try {
    made = await makeBackup(service, begun, opts);
  } catch (err) {
    error = err instanceof BackupProblem ? err.message : `Something went wrong: ${reasonOf(err)}`;
    console.error('[books] backup failed:', reasonOf(err));
  }

  const status: 'made' | 'failed' = made && made.checked && !made.problem ? 'made' : 'failed';
  const finalError = status === 'made' ? null : (error ?? made?.problem ?? 'It stopped without saying why.');
  const finishing = {
    id: begun.id,
    status,
    error: finalError,
    ...(made ? {
      file_path: made.path, file_bytes: made.bytes, file_sha256: made.sha256, tables: made.tables, rows: made.rows,
      entries: made.entries, lines: made.lines, checked: made.checked,
    } : {}),
  };
  try {
    await call(service, 'books_backup_finish', finishing);
  } catch (err) {
    // Whatever the record wouldn't take, it says the backup failed and why.
    error = `The backup's record wouldn't take how it went: ${reasonOf(err)}`;
    await call(service, 'books_backup_finish', { id: begun.id, status: 'failed', error }).catch(() => null);
    const heartbeat = await recordHeartbeat(service, BOOKS_BACKUP, { how: opts.how, id: begun.id, state: 'failed', error }, { startedAt, records: null, touchLastSyncedAt: false });
    return { state: 'failed', id: begun.id, startedAt: begun.started_at, file: made?.path ?? null, bytes: made?.bytes ?? null, error, heartbeat };
  }

  const heartbeat = await recordHeartbeat(service, BOOKS_BACKUP, {
    how: opts.how,
    id: begun.id,
    state: status,
    file: made?.path ?? null,
    bytes: made?.bytes ?? null,
    tables: made?.tables ?? null,
    rows: made?.rows ?? null,
    entries: made?.entries ?? null,
    lines: made?.lines ?? null,
    checked: made?.checked ?? null,
    ...(finalError ? { error: finalError } : {}),
  }, { startedAt, records: made?.rows ?? null, touchLastSyncedAt: status === 'made' });
  return {
    state: status,
    id: begun.id,
    startedAt: begun.started_at,
    file: made?.path ?? null,
    bytes: made?.bytes ?? null,
    error: finalError,
    heartbeat,
  };
}

// ── Reading them back ──────────────────────────────────────────────────────

export type BackupStatus = 'running' | 'made' | 'failed' | 'stopped';

/** One backup as Books → Backups lists it. */
export interface BackupRecord {
  id: string;
  how: 'nightly' | 'by_hand';
  askedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: BackupStatus;
  file: string | null;
  fileName: string | null;
  bytes: number | null;
  sha256: string | null;
  tables: number | null;
  rows: number | null;
  entries: number | null;
  lines: number | null;
  checked: boolean | null;
  error: string | null;
}

const RECORD_COLUMNS = 'id, how, asked_by_name, started_at, finished_at, status, file_path, file_bytes, file_sha256, table_count, row_count, entry_count, line_count, checked, error';

const asNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** A row of books_backups as the page shows it; one still running past BACKUP_STOPPED_MINUTES has stopped. */
export function recordOf(row: any, now: Date): BackupRecord {
  const startedAt = String(row.started_at);
  const stopped = row.status === 'running' && now.getTime() - new Date(startedAt).getTime() > BACKUP_STOPPED_MINUTES * 60_000;
  const file = row.file_path ?? null;
  return {
    id: row.id,
    how: row.how,
    askedBy: row.asked_by_name ?? null,
    startedAt,
    finishedAt: row.finished_at ?? null,
    status: stopped ? 'stopped' : row.status,
    file,
    fileName: file ? String(file).split('/').pop()! : null,
    bytes: asNumber(row.file_bytes),
    sha256: row.file_sha256 ?? null,
    tables: asNumber(row.table_count),
    rows: asNumber(row.row_count),
    entries: asNumber(row.entry_count),
    lines: asNumber(row.line_count),
    checked: row.checked ?? null,
    error: stopped ? 'It stopped before it finished.' : row.error ?? null,
  };
}

/** The next nightly backup after `now`: 08:11 UTC, 2:11 AM Central (3:11 in summer time). */
export function nextNightly(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_UTC.hour, NIGHTLY_UTC.minute));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** No good backup within BACKUP_DUE_HOURS. */
export function backupDue(lastMade: Pick<BackupRecord, 'startedAt'> | null, now: Date): boolean {
  return !lastMade || now.getTime() - new Date(lastMade.startedAt).getTime() > BACKUP_DUE_HOURS * 3_600_000;
}

export interface BackupsView {
  backups: BackupRecord[];
  lastMade: BackupRecord | null;
  due: boolean;
  next: string;
  /** Why backups can't go to BMG's file storage now (storageProblem), or null. */
  storageProblem: string | null;
}

async function lastMadeBackup(service: SupabaseClient, now: Date): Promise<BackupRecord | null> {
  const { data, error } = await service.from('books_backups').select(RECORD_COLUMNS)
    .eq('status', 'made').order('started_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (error) throw new Error(`couldn't read the backups (${error.message})`);
  return data?.[0] ? recordOf(data[0], now) : null;
}

/** Books → Backups: the newest BACKUPS_LISTED backups, the last good one, whether one is due, and whether storage is private. */
export async function loadBackups(service: SupabaseClient, now = new Date()): Promise<BackupsView> {
  const { data, error } = await service.from('books_backups').select(RECORD_COLUMNS)
    .order('started_at', { ascending: false }).order('id', { ascending: false }).limit(BACKUPS_LISTED);
  if (error) throw new Error(`couldn't read the backups (${error.message})`);
  const backups = (data ?? []).map((r) => recordOf(r, now));
  const lastMade = backups.find((b) => b.status === 'made') ?? await lastMadeBackup(service, now);
  return {
    backups,
    lastMade,
    due: backupDue(lastMade, now),
    next: nextNightly(now).toISOString(),
    storageProblem: storageProblem(await ledgerPdfsEnabled(service)),
  };
}

/** A short-lived link that downloads one made backup's zip under its own name; null when it has no file. */
export async function backupDownloadUrl(service: SupabaseClient, id: string): Promise<{ url: string; fileName: string } | null> {
  const { data, error } = await service.from('books_backups').select('file_path').eq('id', id).maybeSingle();
  if (error) throw new Error(`couldn't read the backup (${error.message})`);
  const path = data?.file_path as string | null | undefined;
  if (!path) return null;
  const fileName = path.split('/').pop()!;
  return { url: await r2PresignGet(BACKUP_PREFIX, path, { filename: fileName, disposition: 'attachment', expiresIn: 300 }), fileName };
}

// ── The daily check's look ─────────────────────────────────────────────────

/** What the daily check's first look tells about backups: the latest one failed, none was made in BACKUP_DUE_HOURS, or none ever. */
export interface BackupAlertItem {
  kind: 'failed' | 'missed' | 'never';
  id: string | null;
  error: string | null;
  lastMadeAt: string | null;
}

/** Looked at only at the day's first look, after the night's backup, so each problem is told once a day. */
export async function lookAtBackups(service: SupabaseClient, first: boolean, now = new Date()): Promise<BackupAlertItem | null> {
  if (!first) return null;
  const { data, error } = await service.from('books_backups').select(RECORD_COLUMNS)
    .order('started_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (error) throw new Error(`couldn't read the backups (${error.message})`);
  const lastMade = await lastMadeBackup(service, now);
  if (!data?.length) return { kind: 'never', id: null, error: null, lastMadeAt: null };
  const newest = recordOf(data[0], now);
  if (newest.status === 'failed' || newest.status === 'stopped') {
    return { kind: 'failed', id: newest.id, error: newest.error, lastMadeAt: lastMade?.startedAt ?? null };
  }
  if (backupDue(lastMade, now)) return { kind: 'missed', id: null, error: null, lastMadeAt: lastMade?.startedAt ?? null };
  return null;
}
