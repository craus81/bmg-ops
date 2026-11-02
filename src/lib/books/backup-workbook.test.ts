// The journal workbook in each backup of FleetSuite's books (part 84): a Read
// me, each company's trial balance, the chart of accounts and every line of
// every entry, written as the journal is read, a sheet of lines at a time.
// This writes one from made-up books, opens it again with exceljs, and holds
// what each sheet shows.
import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { BackupWorkbook, JOURNAL_SHEET_ROWS, centralTime, postedTime, typeWords, type JournalRow, type WorkbookAccount } from './backup-workbook';

const BMG = 'c-bmg';
const COOL = 'c-1084';
const HOLD = 'c-hold';
const AMOUNT = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';

const account = (over: Partial<WorkbookAccount> & Pick<WorkbookAccount, 'id' | 'name'>): WorkbookAccount => ({
  number: null, type: 'income', companyId: null, parentId: null, netsuiteId: null, control: false, active: true, ...over,
});
const ACCOUNTS: WorkbookAccount[] = [
  account({ id: 'a-sales', number: '40000', name: 'Upfit Sales', netsuiteId: '54' }),
  account({ id: 'a-ar', number: '11000', name: 'Accounts Receivable', type: 'accounts_receivable', netsuiteId: '119', control: true }),
  account({ id: 'a-petty', number: '9000', name: 'Petty Cash', type: 'bank', companyId: BMG, active: false }),
  account({ id: 'a-labor', number: '40100', name: 'Upfit Sales, Labor', parentId: 'a-sales' }),
  account({ id: 'a-suspense', name: 'Suspense', type: 'other_current_asset', companyId: BMG }),
];

const line = (over: Partial<JournalRow>): JournalRow => ({
  company: 'BMG', entryNo: 1, date: '2026-11-03', account: '11000', accountName: 'Accounts Receivable', debit: 0, credit: 0,
  memo: null, lineMemo: null, division: null, location: null, item: null, vendor: null, job: null,
  source: 'invoice INV1001', rule: 'invoice@1', postedAt: '2026-11-03T08:11:00.000Z', postedBy: null, reverses: null, ...over,
});

describe('the journal workbook in a backup', () => {
  let book: ExcelJS.Workbook;
  let bytes: Buffer;
  let lines: { lines: number; sheets: number };
  const values = (sheet: string) => book.getWorksheet(sheet)!.getSheetValues().filter(Boolean).map((r: any) => r.slice(1));

  beforeAll(async () => {
    const workbook = BackupWorkbook.start({
      madeAt: new Date('2026-11-03T08:11:00Z'),
      companies: [
        { id: BMG, code: 'BMG', name: 'BMG Fleet Installations' },
        { id: COOL, code: '1084', name: '1084 Cool Springs' },
        { id: HOLD, code: 'HOLD', name: 'Hold Co' },
      ],
      accounts: ACCOUNTS,
      balances: [
        { companyId: BMG, accountId: 'a-sales', debitCents: 0, creditCents: 125000 },
        { companyId: BMG, accountId: 'a-ar', debitCents: 150000, creditCents: 25000 },
        { companyId: BMG, accountId: 'a-petty', debitCents: 2500, creditCents: 0 },
        { companyId: BMG, accountId: 'a-labor', debitCents: 0, creditCents: 2500 },
        { companyId: COOL, accountId: 'a-gone', debitCents: 100, creditCents: 100 },
      ],
      entries: 2,
      lines: 5,
      sheetRows: 3,
    });
    workbook.addJournal([
      line({ debit: 1500, memo: 'INV1001, Acme Fleet', division: 'upfit', location: 'ofallon', item: 'HITCH-1', job: 'JOB-7', postedBy: 'Craig' }),
      line({ account: '40000', accountName: 'Upfit Sales', credit: 1250, lineMemo: 'Upfit labor', division: 'upfit' }),
      line({ account: '40100', accountName: 'Upfit Sales, Labor', credit: 250 }),
    ]);
    workbook.addJournal([
      line({ entryNo: 2, date: '2026-11-04', credit: 250, source: 'reversal', rule: 'reversal', reverses: 1, postedAt: '2026-07-01T08:11:00Z', vendor: 'V-9' }),
      line({ entryNo: 2, date: '2026-11-04', account: null, accountName: 'Account a-gone', debit: 250, source: 'reversal', rule: 'reversal', reverses: 1 }),
    ]);
    lines = workbook.journalLines;
    bytes = await workbook.finish();
    book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as any);
  });

  it('is an xlsx with its sheets in order, the journal spread over sheets of the size given', () => {
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(book.worksheets.map((s) => s.name)).toEqual(['Read me', 'Trial balance', 'Chart of accounts', 'Journal', 'Journal 2']);
    expect(lines).toEqual({ lines: 5, sheets: 2 });
    expect(JOURNAL_SHEET_ROWS).toBe(1_000_000);
    expect(JOURNAL_SHEET_ROWS).toBeLessThan(1_048_576);
  });

  it('says when it was copied and what it holds', () => {
    const readMe = values('Read me');
    expect(readMe[0]).toEqual(["FleetSuite's books"]);
    expect(readMe[1][0]).toBe('Copied November 3, 2026 at 2:11 AM Central, as the journal stood when the backup began. Entries posted while it ran are in the next backup.');
    expect(readMe[2][0]).toContain('every entry with its lines, 2 entries and 5 lines.');
    expect(readMe[3][0]).toContain('docs/books.md "Backups"');
  });

  it("shows each company's trial balance, accounts in number order, and a company with nothing posted", () => {
    expect(values('Trial balance')).toEqual([
      ['Account', 'Account name', 'Debits', 'Credits', 'Balance (debit +)'],
      ['BMG Fleet Installations (BMG)'],
      ['9000', 'Petty Cash', 25, 0, 25],
      ['11000', 'Accounts Receivable', 1500, 250, 1250],
      ['40000', 'Upfit Sales', 0, 1250, -1250],
      ['40100', 'Upfit Sales, Labor', 0, 25, -25],
      [undefined, 'Total', 1525, 1525, 0],
      ['1084 Cool Springs (1084)'],
      [undefined, 'Account a-gone', 1, 1, 0],
      [undefined, 'Total', 1, 1, 0],
      ['Hold Co (HOLD)'],
      [undefined, 'Nothing posted yet.'],
    ]);
    const sheet = book.getWorksheet('Trial balance')!;
    expect(sheet.getRow(3).getCell(3).numFmt).toBe(AMOUNT);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('lists every account with its type, company, NetSuite account, control, active and parent', () => {
    expect(values('Chart of accounts')).toEqual([
      ['Account', 'Account name', 'Type', 'Company', 'NetSuite account', 'Control account', 'Active', 'Parent'],
      [undefined, 'Suspense', 'Other current asset', 'BMG', undefined, undefined, 'Yes'],
      ['9000', 'Petty Cash', 'Bank', 'BMG', undefined, undefined, 'No'],
      ['11000', 'Accounts Receivable', 'Accounts receivable', 'Every company', '119', 'Yes', 'Yes'],
      ['40000', 'Upfit Sales', 'Income', 'Every company', '54', undefined, 'Yes'],
      ['40100', 'Upfit Sales, Labor', 'Income', 'Every company', undefined, undefined, 'Yes', '40000'],
    ]);
  });

  it('writes every line of every entry, an empty cell for what a line lacks', () => {
    const journal = values('Journal');
    expect(journal[0]).toEqual([
      'Company', 'Entry', 'Date', 'Account', 'Account name', 'Debit', 'Credit', 'Entry memo', 'Line memo', 'Division', 'Location',
      'Item', 'Vendor', 'Job', 'Source', 'Posting rule', 'Posted', 'Posted by', 'Reverses entry',
    ]);
    expect(journal[1]).toEqual([
      'BMG', 1, new Date('2026-11-03T00:00:00Z'), '11000', 'Accounts Receivable', 1500, undefined, 'INV1001, Acme Fleet', undefined, 'upfit', 'ofallon',
      'HITCH-1', undefined, 'JOB-7', 'invoice INV1001', 'invoice@1', '11/3/26, 2:11 AM', 'Craig',
    ]);
    expect(journal[2].slice(5, 10)).toEqual([undefined, 1250, undefined, 'Upfit labor', 'upfit']);
    expect(journal).toHaveLength(4);

    const next = values('Journal 2');
    expect(next[0]).toEqual(journal[0]);
    expect(next.slice(1).map((r) => [r[1], r[2], r[3], r[4], r[5], r[6], r[12], r[14], r[16], r[18]])).toEqual([
      [2, new Date('2026-11-04T00:00:00Z'), '11000', 'Accounts Receivable', undefined, 250, 'V-9', 'reversal', '7/1/26, 3:11 AM', 1],
      [2, new Date('2026-11-04T00:00:00Z'), undefined, 'Account a-gone', 250, undefined, undefined, 'reversal', '11/3/26, 2:11 AM', 1],
    ]);
    const sheet = book.getWorksheet('Journal 2')!;
    expect(sheet.getRow(2).getCell(6).numFmt).toBe(AMOUNT);
    expect(sheet.getRow(2).getCell(3).numFmt).toBe('m/d/yyyy');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('says moments in Central time and account types in words', () => {
    expect(centralTime(new Date('2026-11-03T08:11:00Z'))).toBe('November 3, 2026 at 2:11 AM Central');
    expect(centralTime('2026-07-01T08:11:00Z')).toBe('July 1, 2026 at 3:11 AM Central');
    expect(postedTime('2026-11-03T23:30:00Z')).toBe('11/3/26, 5:30 PM');
    expect(typeWords('accounts_receivable')).toBe('Accounts receivable');
    expect(typeWords('income')).toBe('Income');
  });
});
