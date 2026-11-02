import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';

/**
 * The journal of a backup of FleetSuite's books as an Excel workbook
 * (part 84, docs/books.md "Backups"), for people to open: each account's
 * debits and credits company by company, the chart of accounts, and every
 * entry with its lines, as the journal stood when the backup began. The
 * backup's CSV files are what a restore loads; this is the same journal to
 * read. Written as it's read (src/lib/books/backups.ts), a page of entries
 * at a time, so a journal of any size never sits in memory whole; a sheet
 * holds a million lines, and more go on to "Journal 2".
 */

/** The lines one Journal sheet holds; Excel's own limit is 1,048,576 rows. */
export const JOURNAL_SHEET_ROWS = 1_000_000;

export interface WorkbookCompany {
  id: string;
  code: string;
  name: string;
}

export interface WorkbookAccount {
  id: string;
  number: string | null;
  name: string;
  type: string;
  companyId: string | null;
  parentId: string | null;
  netsuiteId: string | null;
  control: boolean;
  active: boolean;
}

/** One account's debits and credits as of the backup, in whole cents. */
export interface WorkbookBalance {
  companyId: string;
  accountId: string;
  debitCents: number;
  creditCents: number;
}

/** One line of an entry, as the Journal sheet shows it. */
export interface JournalRow {
  company: string;
  entryNo: number;
  date: string;
  account: string | null;
  accountName: string;
  debit: number;
  credit: number;
  memo: string | null;
  lineMemo: string | null;
  division: string | null;
  location: string | null;
  item: string | null;
  vendor: string | null;
  job: string | null;
  source: string;
  rule: string;
  postedAt: string;
  postedBy: string | null;
  reverses: number | null;
}

export interface BackupWorkbookStart {
  madeAt: Date;
  companies: WorkbookCompany[];
  accounts: WorkbookAccount[];
  balances: WorkbookBalance[];
  entries: number;
  lines: number;
  /** Lines a Journal sheet holds; JOURNAL_SHEET_ROWS unless a test gives fewer. */
  sheetRows?: number;
}

// Excel's own Accounting format, as the other books workbooks use it (report-workbook.ts).
const AMOUNT = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';
const DATE = 'm/d/yyyy';
const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
const MUTED = 'FF595959';

const central = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'long', timeStyle: 'short' });
const centralShort = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'short', timeStyle: 'short' });
/** A moment as the owner reads it: "November 3, 2026 at 2:11 AM Central". */
export const centralTime = (at: Date | string) => `${central.format(new Date(at))} Central`;
/** A posting's moment in a Journal cell: "11/3/26, 2:11 AM". */
export const postedTime = (at: string) => centralShort.format(new Date(at));

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const dollars = (cents: number) => cents / 100 || 0;
/** 'accounts_receivable' → 'Accounts receivable'. */
export const typeWords = (type: string) => {
  const words = type.replace(/_/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};
const byNumber = (a: Pick<WorkbookAccount, 'number' | 'name'>, b: Pick<WorkbookAccount, 'number' | 'name'>) =>
  (a.number ?? '').localeCompare(b.number ?? '', 'en-US', { numeric: true }) || a.name.localeCompare(b.name, 'en-US');

const JOURNAL_COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: 'Company', width: 9 },
  { header: 'Entry', width: 9 },
  { header: 'Date', width: 11, style: { numFmt: DATE } },
  { header: 'Account', width: 10 },
  { header: 'Account name', width: 30 },
  { header: 'Debit', width: 15, style: { numFmt: AMOUNT } },
  { header: 'Credit', width: 15, style: { numFmt: AMOUNT } },
  { header: 'Entry memo', width: 36 },
  { header: 'Line memo', width: 30 },
  { header: 'Division', width: 10 },
  { header: 'Location', width: 11 },
  { header: 'Item', width: 14 },
  { header: 'Vendor', width: 14 },
  { header: 'Job', width: 14 },
  { header: 'Source', width: 24 },
  { header: 'Posting rule', width: 18 },
  { header: 'Posted', width: 17 },
  { header: 'Posted by', width: 18 },
  { header: 'Reverses entry', width: 14 },
];

const dateCell = (date: string) => new Date(`${date.slice(0, 10)}T00:00:00Z`);

export class BackupWorkbook {
  private journal: ExcelJS.Worksheet | null = null;
  private onSheet = 0;
  private sheets = 0;
  private written = 0;

  private constructor(
    private readonly book: ExcelJS.stream.xlsx.WorkbookWriter,
    private readonly ended: Promise<void>,
    private readonly chunks: Buffer[],
    private readonly sheetRows: number,
  ) {}

  /** Opens the workbook and writes Read me, Trial balance and Chart of accounts, ready for the journal's lines. */
  static start(input: BackupWorkbookStart): BackupWorkbook {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve, reject) => {
      out.on('end', () => resolve());
      out.on('error', reject);
    });
    const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
    book.creator = 'FleetSuite';
    book.created = input.madeAt;
    const workbook = new BackupWorkbook(book, ended, chunks, input.sheetRows ?? JOURNAL_SHEET_ROWS);
    workbook.readMe(input);
    workbook.trialBalance(input);
    workbook.chart(input);
    workbook.nextJournalSheet();
    return workbook;
  }

  private readMe(input: BackupWorkbookStart): void {
    const sheet = this.book.addWorksheet('Read me');
    sheet.columns = [{ width: 110 }];
    const title = sheet.addRow(["FleetSuite's books"]);
    title.font = { bold: true, size: 14 };
    title.commit();
    const lines = [
      `Copied ${centralTime(input.madeAt)}, as the journal stood when the backup began. Entries posted while it ran are in the next backup.`,
      `Trial balance: each account's debits and credits, company by company. Journal: every entry with its lines, ${count(input.entries, 'entry', 'entries')} and ${count(input.lines, 'line', 'lines')}. Chart of accounts: every account.`,
      'This workbook is for reading. The backup it came in also holds every table of the books as a CSV file, which is what a restore loads, and manifest.json, which says what each file holds; docs/books.md "Backups" in FleetSuite\'s code says how to restore.',
    ];
    for (const text of lines) {
      const row = sheet.addRow([text]);
      row.alignment = { wrapText: true, vertical: 'top' };
      row.commit();
    }
    sheet.commit();
  }

  private trialBalance(input: BackupWorkbookStart): void {
    const sheet = this.book.addWorksheet('Trial balance', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Account', width: 10 },
      { header: 'Account name', width: 36 },
      { header: 'Debits', width: 17, style: { numFmt: AMOUNT } },
      { header: 'Credits', width: 17, style: { numFmt: AMOUNT } },
      { header: 'Balance (debit +)', width: 17, style: { numFmt: AMOUNT } },
    ];
    this.head(sheet.getRow(1));
    const accounts = new Map(input.accounts.map((a) => [a.id, a]));
    for (const company of input.companies) {
      const balances = input.balances
        .filter((b) => b.companyId === company.id)
        .map((b) => ({ ...b, account: accounts.get(b.accountId) ?? { number: null, name: `Account ${b.accountId}` } }))
        .sort((a, b) => byNumber(a.account, b.account));
      const name = sheet.addRow([`${company.name} (${company.code})`]);
      name.font = { bold: true };
      name.commit();
      if (!balances.length) {
        const none = sheet.addRow([null, 'Nothing posted yet.']);
        none.font = { color: { argb: MUTED } };
        none.commit();
        continue;
      }
      let debits = 0;
      let credits = 0;
      for (const b of balances) {
        debits += b.debitCents;
        credits += b.creditCents;
        sheet.addRow([b.account.number, b.account.name, dollars(b.debitCents), dollars(b.creditCents), dollars(b.debitCents - b.creditCents)]).commit();
      }
      const total = sheet.addRow([null, 'Total', dollars(debits), dollars(credits), dollars(debits - credits)]);
      total.font = { bold: true };
      total.commit();
      sheet.addRow([]).commit();
    }
    sheet.commit();
  }

  private chart(input: BackupWorkbookStart): void {
    const sheet = this.book.addWorksheet('Chart of accounts', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Account', width: 10 },
      { header: 'Account name', width: 36 },
      { header: 'Type', width: 24 },
      { header: 'Company', width: 10 },
      { header: 'NetSuite account', width: 16 },
      { header: 'Control account', width: 15 },
      { header: 'Active', width: 8 },
      { header: 'Parent', width: 10 },
    ];
    this.head(sheet.getRow(1));
    const companies = new Map(input.companies.map((c) => [c.id, c.code]));
    const accounts = new Map(input.accounts.map((a) => [a.id, a]));
    for (const a of [...input.accounts].sort(byNumber)) {
      sheet.addRow([
        a.number,
        a.name,
        typeWords(a.type),
        a.companyId ? companies.get(a.companyId) ?? null : 'Every company',
        a.netsuiteId,
        a.control ? 'Yes' : null,
        a.active ? 'Yes' : 'No',
        a.parentId ? accounts.get(a.parentId)?.number ?? null : null,
      ]).commit();
    }
    sheet.commit();
  }

  private head(row: ExcelJS.Row): void {
    row.font = { bold: true };
    row.fill = HEAD_FILL;
    row.commit();
  }

  private nextJournalSheet(): void {
    this.journal?.commit();
    this.sheets += 1;
    this.journal = this.book.addWorksheet(this.sheets === 1 ? 'Journal' : `Journal ${this.sheets}`, { views: [{ state: 'frozen', ySplit: 1 }] });
    this.journal.columns = JOURNAL_COLUMNS;
    this.head(this.journal.getRow(1));
    this.onSheet = 0;
  }

  /** Writes lines of entries to the Journal sheet, in the order given. */
  addJournal(rows: readonly JournalRow[]): void {
    for (const r of rows) {
      if (this.onSheet >= this.sheetRows) this.nextJournalSheet();
      // An empty cell for what a line doesn't have, and for the side of the line that's zero.
      this.journal!.addRow([
        r.company, r.entryNo, dateCell(r.date), r.account, r.accountName,
        r.debit || null, r.credit || null, r.memo, r.lineMemo, r.division, r.location,
        r.item, r.vendor, r.job, r.source, r.rule, postedTime(r.postedAt), r.postedBy, r.reverses,
      ]).commit();
      this.onSheet += 1;
      this.written += 1;
    }
  }

  /** How many journal lines it holds so far, and on how many sheets. */
  get journalLines(): { lines: number; sheets: number } {
    return { lines: this.written, sheets: this.sheets };
  }

  /** Closes the workbook and hands back its bytes. */
  async finish(): Promise<Buffer> {
    this.journal?.commit();
    this.journal = null;
    await this.book.commit();
    await this.ended;
    return Buffer.concat(this.chunks);
  }
}
