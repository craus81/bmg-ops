import ExcelJS from 'exceljs';
import type { DetailDocument, LedgerRow } from './report-detail';
import type { Pair, Report, ReportKind, ReportLine } from './reports';

/**
 * Books → Reports and an account line's detail as Excel files (docs/books.md
 * "Excel downloads"; the NetSuite Exit Checklist's "Excel downloads", thread
 * "Replacing NetSuite with FleetSuite", 2026-10-31), so the owner or the CPA
 * can work with the books in Excel: the profit and loss, balance sheet or
 * trial balance as Reports shows it, FleetSuite's books next to NetSuite's
 * with the difference, each line indented as on the page; and one account's
 * documents by date with each side's running balance
 * (runningBalances in report-detail.ts). Built on the server by the two
 * download routes; amounts are dollars in Excel's own Accounting format,
 * read as the report shows them, and anything the page warns about is
 * written at the top, in red when it's a failure.
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
