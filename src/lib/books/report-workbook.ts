import ExcelJS from 'exceljs';
import type { CompanyValue } from './inventory-value';
import type { DetailDocument, LedgerRow } from './report-detail';
import type { Pair, Report, ReportKind, ReportLine } from './reports';

/**
 * Books → Reports and an account line's detail as Excel files (docs/books.md
 * "Excel downloads"; the NetSuite Exit Checklist's "Excel downloads", thread
 * "Replacing NetSuite with FleetSuite", 2026-10-31), so the owner or the CPA
 * can work with the books in Excel: the profit and loss, balance sheet or
 * trial balance as Reports shows it, FleetSuite's books next to NetSuite's
 * with the difference, each line indented as on the page; one account's
 * documents by date with each side's running balance
 * (runningBalances in report-detail.ts); and a company's inventory value at
 * a month's end with how it ties to each inventory account (part 64,
 * inventory-value.ts). Built on the server by the download routes; amounts
 * are dollars in Excel's own Accounting format, read as the report shows
 * them, and anything the page warns about is written at the top, in red
 * when it's a failure.
 */

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A file to send: its name, type and bytes. */
export interface WorkbookFile {
  name: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface WorkbookCompany {
  code: string;
  name: string;
  legal_name: string | null;
}

/** Something the page warns about, written above the table: red for a failure, amber for a gap. */
export interface WorkbookNote {
  tone: 'red' | 'amber';
  text: string;
}

/** How the last posting run and the last copy of NetSuite's ledger went, as loadReports reads them. */
interface Run {
  at: string;
  error: string | null;
}

// Excel's own Accounting format: the dollar sign at the left, negatives in brackets, nothing as a dash.
const AMOUNT = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';
const DATE = 'm/d/yyyy';
const RED = 'FFC00000';
const AMBER = 'FF9C5700';
const MUTED = 'FF595959';
const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1];
const monthName = (month: string) => `${monthOf(month)} ${month.slice(0, 4)}`;
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const monthStart = (month: string) => `${monthOf(month)} 1, ${month.slice(0, 4)}`;
const monthEnd = (month: string) => `${monthOf(month)} ${lastDay(month)}, ${month.slice(0, 4)}`;
const monthBefore = (month: string) => {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
};
const rangeText = (from: string, to: string) => {
  if (from === to) return monthName(to);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${monthOf(from)} to ${monthName(to)}`;
  return `${monthName(from)} to ${monthName(to)}`;
};

const central = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'long', timeStyle: 'short' });
/** A moment as the owner reads it: "October 31, 2026 at 4:12 AM Central". */
const centralTime = (at: Date | string) => `${central.format(new Date(at))} Central`;

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencySign: 'accounting' });
const fmt = (cents: number) => money.format(cents / 100);
const dollars = (cents: number) => cents / 100 || 0;
const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const REPORT_NAMES: Record<ReportKind, string> = {
  profit_and_loss: 'Profit and Loss',
  balance_sheet: 'Balance Sheet',
  trial_balance: 'Trial Balance',
};

/** A name a file system takes: no slashes, colons or the like. */
const cleanName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

/** A sheet's name as Excel takes one: none of \ / ? * [ ] :, at most 31 characters. */
export function sheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim() || 'Sheet';
}

/** The report's file: "BMG Profit and Loss 2026-01 to 2026-09.xlsx", "BMG Balance Sheet 2026-09-30.xlsx". */
export function reportFileName(company: string, kind: ReportKind, from: string, to: string): string {
  const period = kind !== 'profit_and_loss'
    ? `${to.slice(0, 7)}-${String(lastDay(to)).padStart(2, '0')}`
    : from === to ? to.slice(0, 7) : `${from.slice(0, 7)} to ${to.slice(0, 7)}`;
  return `${cleanName(`${company} ${REPORT_NAMES[kind]} ${period}`)}.xlsx`;
}

/** An account's documents' file: "BMG 4000 Sales 2026-01 to 2026-09.xlsx". */
export function accountFileName(company: string, account: { number: string | null; name: string }, from: string, to: string): string {
  const period = from === to ? to.slice(0, 7) : `${from.slice(0, 7)} to ${to.slice(0, 7)}`;
  return `${cleanName(`${company} ${account.number ? `${account.number} ` : ''}${account.name} ${period}`)}.xlsx`;
}

/** The warnings Reports shows above a report, as they read in its file. */
export function reportNotes(p: {
  companyName: string;
  posts: boolean;
  checked: boolean;
  lastPosting: (Run & { partial: boolean }) | null;
  lastCopy: Run | null;
}): WorkbookNote[] {
  const notes: WorkbookNote[] = [];
  if (!p.posts) {
    notes.push({ tone: 'amber', text: `${p.companyName} doesn't post to FleetSuite's books yet, so its side holds only the starting balances from NetSuite.` });
  } else if (!p.lastPosting) {
    notes.push({ tone: 'amber', text: "Nothing has posted to FleetSuite's books yet." });
  }
  notes.push(...postingNotes(p.lastPosting, 'this report'));
  if (!p.checked) notes.push({ tone: 'amber', text: "NetSuite's totals haven't been read yet, so NetSuite's side is empty." });
  if (p.lastCopy?.error) {
    notes.push({ tone: 'red', text: `The last copy of NetSuite's ledger failed (${centralTime(p.lastCopy.at)}): ${p.lastCopy.error}` });
  }
  return notes;
}

/** The warnings an account line's detail shows, as they read in its file, and whether the file lists every document. */
export function detailNotes(p: {
  lastPosting: (Run & { partial: boolean }) | null;
  /** What NetSuite's own totals say moved, and what the copy of its ledger holds of it, as the line shows them. */
  moved: number;
  copied: number;
  /** Documents in the file, and in the months. */
  listed: number;
  documents: number;
  from: string;
  to: string;
}): WorkbookNote[] {
  const months = p.from === p.to ? 'this month' : 'these months';
  const notes = postingNotes(p.lastPosting, 'this account');
  if (p.copied !== p.moved) {
    notes.push({
      tone: 'amber',
      text: `NetSuite's own totals say this account moved ${fmt(p.moved)} in ${months}, but the copy of its ledger holds ${fmt(p.copied)} `
        + "of it so far, so some of NetSuite's documents may be missing below and NetSuite's running balance won't reach its line. "
        + 'The next copy catches up.',
    });
  }
  if (p.listed < p.documents) {
    notes.push({
      tone: 'red',
      text: `This file lists the first ${p.listed.toLocaleString('en-US')} of ${count(p.documents, 'document', 'documents')}, by date, `
        + 'so the running balances stop short of the line. Pick fewer months for the rest.',
    });
  }
  return notes;
}

function postingNotes(run: (Run & { partial: boolean }) | null, what: string): WorkbookNote[] {
  if (run?.error) return [{ tone: 'red', text: `The last posting run failed (${centralTime(run.at)}): ${run.error}` }];
  if (run?.partial) {
    return [{
      tone: 'amber',
      text: `Still posting: the last run (${centralTime(run.at)}) stopped for time, so some documents aren't in ${what} yet. `
        + 'It carries on at the next run.',
    }];
  }
  return [];
}

// ── Building a sheet ───────────────────────────────────────────────────────

/**
 * The rows above a sheet's table: who, what, when, how to read it, and its
 * notes, then the table's header, its amount columns' headings (`amounts`,
 * first and last) to the right over them. Returns the header's row number.
 */
function titleRows(sheet: ExcelJS.Worksheet, p: {
  company: WorkbookCompany; title: string; period: string; about: string; notes: WorkbookNote[]; now: Date;
  header: string[]; amounts: [number, number];
}): number {
  const title = (text: string, font: Partial<ExcelJS.Font>) => { sheet.addRow([text]).getCell(1).font = font; };
  title(p.company.legal_name || p.company.name, { bold: true, size: 14 });
  title(p.title, { bold: true, size: 12 });
  title(p.period, {});
  title(p.about, { color: { argb: MUTED } });
  title(`Downloaded ${centralTime(p.now)}.`, { color: { argb: MUTED } });
  for (const n of p.notes) title(n.text, { bold: true, color: { argb: n.tone === 'red' ? RED : AMBER } });
  sheet.addRow([]);
  const head = sheet.addRow(p.header);
  head.eachCell((c, col) => {
    c.font = { bold: true };
    c.fill = HEAD_FILL;
    c.border = { bottom: { style: 'thin' } };
    c.alignment = { horizontal: col >= p.amounts[0] && col <= p.amounts[1] ? 'right' : 'left', vertical: 'bottom', wrapText: true };
  });
  sheet.views = [{ state: 'frozen', ySplit: head.number }];
  sheet.pageSetup.printTitlesRow = `${head.number}:${head.number}`;
  return head.number;
}

function newWorkbook(now: Date): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FleetSuite';
  wb.created = now;
  return wb;
}

async function fileOf(wb: ExcelJS.Workbook, name: string): Promise<WorkbookFile> {
  const buffer = await wb.xlsx.writeBuffer();
  return { name, type: XLSX_TYPE, bytes: new Uint8Array(buffer as ArrayBuffer) };
}

/** Amount columns: dollars in Accounting format, wide enough for millions. */
function amountColumns(sheet: ExcelJS.Worksheet, first: number, last: number, width = 17) {
  for (let c = first; c <= last; c += 1) {
    const col = sheet.getColumn(c);
    col.width = width;
    col.numFmt = AMOUNT;
  }
}

const redIf = (cell: ExcelJS.Cell, differs: boolean) => {
  if (differs) cell.font = { ...cell.font, bold: true, color: { argb: RED } };
};

// ── Reports ────────────────────────────────────────────────────────────────

export interface ReportWorkbookInput {
  company: WorkbookCompany;
  kind: ReportKind;
  /** The profit and loss covers from through to; the balance sheet and trial balance are at to's end. 'YYYY-MM-01'. */
  from: string;
  to: string;
  report: Report;
  notes: WorkbookNote[];
  now: Date;
}

const lineLabel = (l: ReportLine) => `${l.label}${l.inChart === false ? ' (not in the chart yet)' : ''}`;

/** One report as Reports shows it, every line: the account's number, its name indented under its parent, then its amounts. */
export async function reportWorkbook(input: ReportWorkbookInput): Promise<WorkbookFile> {
  const { kind, from, to, report } = input;
  const trial = kind === 'trial_balance';
  const wb = newWorkbook(input.now);
  const sheet = wb.addWorksheet(REPORT_NAMES[kind], {
    pageSetup: { orientation: trial ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = trial ? 46 : 52;
  amountColumns(sheet, 3, trial ? 7 : 5);

  titleRows(sheet, {
    company: input.company,
    title: REPORT_NAMES[kind],
    period: kind === 'profit_and_loss' ? `${monthStart(from)} to ${monthEnd(to)}` : `As of ${monthEnd(to)}`,
    about: trial
      ? "FleetSuite's own books next to NetSuite's own totals: balance sheet accounts at their month-end balance, income and expenses "
        + "for the year to date, earlier years' net income in retained earnings, as on NetSuite's Trial Balance report."
      : "FleetSuite's own books next to NetSuite's own totals, laid out as NetSuite's reports are.",
    notes: input.notes,
    now: input.now,
    header: trial
      ? ['Number', 'Account', 'FleetSuite debit', 'FleetSuite credit', 'NetSuite debit', 'NetSuite credit', 'Difference']
      : ['Number', 'Account', 'FleetSuite', 'NetSuite', 'Difference'],
    amounts: [3, trial ? 7 : 5],
  });

  const debit = (cents: number | null) => (cents && cents > 0 ? dollars(cents) : null);
  const credit = (cents: number | null) => (cents && cents < 0 ? dollars(-cents) : null);
  const last = trial ? 7 : 5;

  for (const l of report.lines) {
    const amounts = l.fleetsuite !== null && l.netsuite !== null;
    const diff = amounts ? l.fleetsuite! - l.netsuite! : 0;
    const values = trial
      ? [debit(l.fleetsuite), credit(l.fleetsuite), debit(l.netsuite), credit(l.netsuite), amounts ? dollars(diff) : null]
      : amounts ? [dollars(l.fleetsuite!), dollars(l.netsuite!), dollars(diff)] : [null, null, null];
    const row = sheet.addRow([l.number ?? null, lineLabel(l), ...values]);
    const total = l.kind === 'total';
    const font: Partial<ExcelJS.Font> = { bold: l.kind !== 'account', italic: !!l.derived };
    row.eachCell({ includeEmpty: true }, (c) => { c.font = font; });
    row.getCell(2).alignment = { indent: l.depth };
    if (total) {
      for (let c = 3; c <= last; c += 1) row.getCell(c).border = { top: { style: l.grand ? 'double' : 'thin' } };
    }
    redIf(row.getCell(last), diff !== 0);
  }

  if (trial && report.totals) {
    const { fleetsuite, netsuite } = report.totals;
    const row = sheet.addRow([null, 'Total', dollars(fleetsuite.debit), dollars(fleetsuite.credit), dollars(netsuite.debit), dollars(netsuite.credit), null]);
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.font = { bold: true };
      if (col >= 3) c.border = { top: { style: 'double' } };
    });
  }

  return fileOf(wb, reportFileName(input.company.code, kind, from, to));
}

// ── An account's documents ─────────────────────────────────────────────────

export interface AccountWorkbookInput {
  company: WorkbookCompany;
  /** The report the line is on: the documents read as it shows them. */
  kind: ReportKind;
  from: string;
  to: string;
  account: { number: string | null; name: string };
  rows: LedgerRow[];
  /** Every document in the months, listed or not. */
  documents: number;
  notes: WorkbookNote[];
  now: Date;
}

const ONLY: Record<NonNullable<DetailDocument['only']>, string> = {
  netsuite: 'Only in NetSuite',
  fleetsuite: 'Only in FleetSuite',
  not_posted: "FleetSuite doesn't post these yet",
};

const READS: Record<ReportKind, string> = {
  profit_and_loss: 'Amounts read as the profit and loss shows them.',
  balance_sheet: 'Amounts read as the balance sheet shows them.',
  trial_balance: 'Amounts read as the trial balance shows them: debits positive, credits negative.',
};

const dateCell = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`) : null);

/**
 * One account line's documents by date, each side's running balance after
 * each: the line's balance before the months on top for a balance sheet
 * account, the line itself at the bottom. Where the documents don't come to
 * the line (some aren't listed), the bottom says what they come to, in red.
 */
export async function accountWorkbook(input: AccountWorkbookInput): Promise<WorkbookFile> {
  const { from, to, account, rows } = input;
  const wb = newWorkbook(input.now);
  const title = `${account.number ? `${account.number} ` : ''}${account.name}`;
  const sheet = wb.addWorksheet(sheetName(title), {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const widths = [11, 20, 14, 28, 40];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  sheet.getColumn(1).numFmt = DATE;
  amountColumns(sheet, 6, 8, 16);
  amountColumns(sheet, 9, 10, 18);
  sheet.getColumn(11).width = 30;

  const listed = rows.filter((r) => r.kind === 'document').length;
  const starting = rows.some((r) => r.kind === 'starting');
  const header = titleRows(sheet, {
    company: input.company,
    title,
    period: `${monthStart(from)} to ${monthEnd(to)}`,
    about: `Every document that moved this account in ${from === to ? 'the month' : 'these months'} (${count(input.documents, 'document', 'documents')}), `
      + "by date, with each side's balance after it: FleetSuite's journal next to the copy of NetSuite's general ledger. "
      + READS[input.kind],
    notes: input.notes,
    now: input.now,
    header: ['Date', 'Type', 'Number', 'Name', 'Memo', 'FleetSuite', 'NetSuite', 'Difference', 'FleetSuite balance', 'NetSuite balance', 'Note'],
    amounts: [6, 10],
  });

  const balances = (b: Pair) => [dollars(b.fleetsuite - b.netsuite), dollars(b.fleetsuite), dollars(b.netsuite)];
  for (const r of rows) {
    if (r.kind === 'starting') {
      const row = sheet.addRow([null, `Balance at the end of ${monthName(monthBefore(from))}`, null, null, null, null, null, ...balances(r.balance)]);
      row.font = { bold: true };
      redIf(row.getCell(8), r.balance.fleetsuite !== r.balance.netsuite);
    } else if (r.kind === 'document') {
      const d = r.document;
      const row = sheet.addRow([
        dateCell(d.date), d.type, d.number, d.name, d.memo,
        dollars(d.fleetsuite), dollars(d.netsuite), dollars(d.fleetsuite - d.netsuite),
        dollars(r.balance.fleetsuite), dollars(r.balance.netsuite), d.only ? ONLY[d.only] : null,
      ]);
      redIf(row.getCell(8), d.fleetsuite !== d.netsuite);
      if (d.only) row.getCell(11).font = { color: { argb: d.only === 'not_posted' ? AMBER : RED } };
    } else if (r.kind === 'closing') {
      const row = sheet.addRow([
        dateCell(r.month), "Earlier years' net income, taken into retained earnings at the year's start", null, null, null,
        dollars(r.amount.fleetsuite), dollars(r.amount.netsuite), dollars(r.amount.fleetsuite - r.amount.netsuite),
        dollars(r.balance.fleetsuite), dollars(r.balance.netsuite), null,
      ]);
      row.font = { italic: true };
      redIf(row.getCell(8), r.amount.fleetsuite !== r.amount.netsuite);
    } else {
      const short = (['fleetsuite', 'netsuite'] as const).filter((side) => r.reached[side] !== r.balance[side]);
      const row = sheet.addRow([
        null, starting ? `Balance at the end of ${monthName(to)}` : `Total, ${rangeText(from, to)}`, null, null, null, null, null,
        ...balances(r.balance),
        short.length
          ? `The documents above come to ${short.map((side) => `${fmt(r.reached[side])} on ${side === 'fleetsuite' ? "FleetSuite's" : "NetSuite's"} side`).join(' and ')}`
          : null,
      ]);
      row.font = { bold: true };
      for (let c = 8; c <= 10; c += 1) row.getCell(c).border = { top: { style: 'double' } };
      redIf(row.getCell(8), r.balance.fleetsuite !== r.balance.netsuite);
      if (short.includes('fleetsuite')) redIf(row.getCell(9), true);
      if (short.includes('netsuite')) redIf(row.getCell(10), true);
      if (short.length) row.getCell(11).font = { bold: true, color: { argb: RED } };
    }
  }
  if (listed) sheet.autoFilter = { from: { row: header, column: 1 }, to: { row: sheet.rowCount, column: 11 } };

  return fileOf(wb, accountFileName(input.company.code, account, from, to));
}

// ── Inventory value at a month's end ──────────────────────────────────────

/** The inventory value's file: "BMG Inventory value 2026-10-31.xlsx". */
export function inventoryFileName(company: string, month: string): string {
  return `${cleanName(`${company} Inventory value ${month.slice(0, 7)}-${String(lastDay(month)).padStart(2, '0')}`)}.xlsx`;
}

/** What Inventory value warns about for a company, as it reads in its file. */
export function inventoryNotes(p: {
  month: string;
  /** This month, the latest the page offers. */
  through: string;
  company: Pick<CompanyValue, 'company' | 'netsuiteThrough' | 'netsuiteShort'>;
  lastCopy: (Run & { partial: boolean }) | null;
  lastPosting: (Run & { partial: boolean }) | null;
}): WorkbookNote[] {
  const notes: WorkbookNote[] = [];
  if (p.month === p.through) {
    notes.push({ tone: 'amber', text: `${monthName(p.month)} isn't over yet, so this is where it stood when the file was made.` });
  }
  if (!p.lastCopy) {
    notes.push({ tone: 'amber', text: "NetSuite's stock moves haven't been copied yet, so no item has a count or value." });
  } else if (p.lastCopy.error) {
    notes.push({ tone: 'red', text: `The last copy of NetSuite's stock moves failed (${centralTime(p.lastCopy.at)}): ${p.lastCopy.error}` });
  } else if (p.lastCopy.partial) {
    notes.push({
      tone: 'amber',
      text: `Still copying NetSuite's stock moves: the last run (${centralTime(p.lastCopy.at)}) stopped for time, so some items' `
        + "moves aren't in yet. It carries on at the next run.",
    });
  }
  notes.push(...postingNotes(p.lastPosting, "FleetSuite's books"));
  if (p.company.netsuiteShort) {
    notes.push({
      tone: 'amber',
      text: p.company.netsuiteThrough
        ? `NetSuite's own totals for ${p.company.company} are read through ${monthName(p.company.netsuiteThrough)}, so NetSuite's balance sheet stops there.`
        : `NetSuite's own totals for ${p.company.company} haven't been read yet, so NetSuite's balance sheet holds only its starting entry.`,
    });
  }
  return notes;
}

export interface InventoryWorkbookInput {
  company: WorkbookCompany;
  /** 'YYYY-MM-01'. */
  month: string;
  value: CompanyValue;
  notes: WorkbookNote[];
  now: Date;
}

const QUANTITY = '#,##0.#####';
// What one cost on average: dollars to four places, as NetSuite keeps it, in the Accounting format's shape.
const AVERAGE = '_($* #,##0.00##_);_($* (#,##0.00##);_($* "-"??_);_(@_)';

/**
 * One company's inventory value at a month's end, as Inventory value shows
 * it: each item at each location with its count, average cost and value; each
 * inventory account from the stocked items on it to FleetSuite's balance
 * sheet, every cent between them on a line of its own; and the documents
 * with no stocked item behind them, the month's first.
 */
export async function inventoryWorkbook(input: InventoryWorkbookInput): Promise<WorkbookFile> {
  const { month, value } = input;
  const wb = newWorkbook(input.now);
  const period = `As of ${monthEnd(month)}`;
  const setup = { pageSetup: { orientation: 'portrait' as const, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } };

  const items = wb.addWorksheet('Inventory value', setup);
  [16, 34, 16, 12, 14, 17, 34].forEach((w, i) => { items.getColumn(i + 1).width = w; });
  items.getColumn(4).numFmt = QUANTITY;
  items.getColumn(5).numFmt = AVERAGE;
  items.getColumn(6).numFmt = AMOUNT;
  const head = titleRows(items, {
    company: input.company,
    title: 'Inventory value',
    period,
    about: "Each item at each location at the month's end: how many were on hand, what one cost on average and what they were worth, "
      + "as FleetSuite counts them from NetSuite's documents, each in the month NetSuite posted it to.",
    notes: input.notes,
    now: input.now,
    header: ['Item', 'Description', 'Location', 'On hand', 'Average cost', 'Value', 'Note'],
    amounts: [4, 6],
  });
  for (const l of value.lines) {
    const row = items.addRow([
      l.item, l.description, l.location, l.quantity, l.averageCost === null ? null : l.averageCost / 100, dollars(l.value),
      l.belowZero ? 'Fewer than none on hand' : l.leftover ? 'None on hand, but value on its lines' : null,
    ]);
    redIf(row.getCell(4), l.belowZero);
    if (l.belowZero || l.leftover) row.getCell(7).font = { color: { argb: l.belowZero ? RED : AMBER } };
  }
  const total = items.addRow(['Total', null, null, null, null, dollars(value.value), null]);
  total.font = { bold: true };
  total.getCell(6).border = { top: { style: 'double' } };
  if (value.lines.length) items.autoFilter = { from: { row: head, column: 1 }, to: { row: head + value.lines.length, column: 7 } };

  const ties = wb.addWorksheet('Ties to the accounts', setup);
  ties.getColumn(1).width = 80;
  amountColumns(ties, 2, 2, 18);
  titleRows(ties, {
    company: input.company,
    title: 'Inventory value: how it ties to the accounts',
    period,
    about: "Each inventory account at the month's end, from the stocked items on it to FleetSuite's balance sheet, "
      + 'everything between them on a line of its own.',
    notes: input.notes,
    now: input.now,
    header: ['Inventory account', 'Amount'],
    amounts: [2, 2],
  });
  const line = (label: string, cents: number, style: { bold?: boolean; indent?: number; red?: boolean } = {}) => {
    const row = ties.addRow([label, dollars(cents)]);
    if (style.bold) row.font = { bold: true };
    if (style.indent) row.getCell(1).alignment = { indent: style.indent };
    redIf(row.getCell(2), !!style.red && cents !== 0);
  };
  value.accounts.forEach((a, i) => {
    if (i) ties.addRow([]);
    ties.addRow([`${a.account}${a.fixedAsset ? ', a fixed asset account' : ''}`]).font = { bold: true, size: 12 };
    line(`Stocked items at the end of ${monthName(monthBefore(month))}`, a.items.before);
    for (const m of a.items.moves) line(`${m.type}, ${count(m.documents, 'document', 'documents')} in ${monthOf(month)}`, m.total, { indent: 1 });
    line(`Stocked items at the end of ${monthName(month)}`, a.items.end, { bold: true });
    if (a.start) line("Where NetSuite's ledger and the items stood apart on December 31, 2024", a.start, { indent: 1 });
    if (a.entries.count) {
      const inMonth = a.entries.month.count ? `, ${a.entries.month.count} of them in ${monthOf(month)}` : '';
      line(`${count(a.entries.count, 'document', 'documents')} since with no stocked item${inMonth}`, a.entries.total, { indent: 1 });
    }
    if (a.unexplained) line("Not accounted for: FleetSuite's copy of NetSuite's ledger is off", a.unexplained, { indent: 1, red: true });
    line("NetSuite's ledger, as FleetSuite copies it", a.ledger, { bold: true });
    if (a.notCopied) line("In NetSuite's own totals, not in FleetSuite's copy of its ledger yet", a.notCopied, { indent: 1 });
    line("NetSuite's balance sheet", a.netsuite, { bold: true });
    if (a.booksApart) line("FleetSuite's books apart from NetSuite's", a.booksApart, { indent: 1, red: true });
    line("FleetSuite's balance sheet", a.books, { bold: true });
    line("FleetSuite's books less the stocked items", a.apart, { bold: true });
  });

  const entries = value.accounts.filter((a) => a.entries.count > 0);
  if (entries.length) {
    const docs = wb.addWorksheet('Documents with no item', { pageSetup: { ...setup.pageSetup, orientation: 'landscape' } });
    [30, 11, 20, 14, 28, 40, 16, 14].forEach((w, i) => { docs.getColumn(i + 1).width = w; });
    docs.getColumn(2).numFmt = DATE;
    docs.getColumn(7).numFmt = AMOUNT;
    const top = titleRows(docs, {
      company: input.company,
      title: 'Documents on the inventory accounts with no stocked item',
      period: `January 1, 2025 to ${monthEnd(month)}`,
      about: "Each document that posted to an inventory account on no stocked item's stock line, a journal entry say: "
        + `on each account, ${monthName(month)}'s first, then the biggest.`,
      notes: [],
      now: input.now,
      header: ['Account', 'Date', 'Type', 'Number', 'Name', 'Memo', 'Amount', `In ${monthOf(month)}`],
      amounts: [7, 7],
    });
    for (const a of entries) {
      for (const r of a.entries.rows) {
        docs.addRow([a.account, dateCell(r.date), r.type, r.number, r.name, r.memo, dollars(r.amount), r.inMonth ? 'Yes' : null]);
      }
      if (a.entries.more.count) {
        const more = docs.addRow([
          a.account, null, null, null, `${count(a.entries.more.count, 'smaller document', 'smaller documents')} not listed`, null,
          dollars(a.entries.more.total), null,
        ]);
        more.font = { italic: true };
      }
    }
    docs.autoFilter = { from: { row: top, column: 1 }, to: { row: docs.rowCount, column: 8 } };
  }

  return fileOf(wb, inventoryFileName(input.company.code, month));
}
