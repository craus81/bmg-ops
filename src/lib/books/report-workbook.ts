import ExcelJS from 'exceljs';
import type { CompanyValue } from './inventory-value';
import type { BuilderAsk, BuiltReport } from './report-builder';
import { builderTitle, filterWords, type BuilderBy, type BuilderRows } from './report-builder-words';
import type { DetailDocument, LedgerRow } from './report-detail';
import { coversMonths } from './report-links';
import type { Pair, Report, ReportKind, ReportLine, YearCloseAmounts } from './reports';
import type { FiledReturn, OtherMoves, ReturnHeld, SalesTaxWorksheet } from './sales-tax-worksheet';
import { BASIS_WORDS, RETURN_FIELD_WORDS } from './sales-tax-words';
import type { YearView } from './year-end';
import { CHECK_LABELS, STATE_WORDS } from './year-end-words';

/**
 * Books → Reports and an account line's detail as Excel files (docs/books.md
 * "Excel downloads"; the NetSuite Exit Checklist's "Excel downloads", thread
 * "Replacing NetSuite with FleetSuite", 2026-10-31), so the owner or the CPA
 * can work with the books in Excel: the profit and loss, balance sheet,
 * trial balance or cash flow statement as Reports shows it, FleetSuite's
 * books next to NetSuite's with the difference, each line indented as on the
 * page; one account's documents by date with each side's running balance
 * (runningBalances in report-detail.ts); a company's inventory value at a
 * month's end with how it ties to each inventory account (part 64,
 * inventory-value.ts); and a month's Missouri sales tax worksheet with every
 * document behind it (part 65, sales-tax-worksheet.ts). Built on the server
 * by the download routes, as is a report from the report builder (part 72,
 * report-builder.ts) and a company's year-end package for the CPA, those
 * reports and its stock at the year's end in one file (part 75, Books →
 * Year end); amounts
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

/** Something the page warns about, written above the table: red for a failure, amber for a gap, green for what's settled (a closed year). */
export interface WorkbookNote {
  tone: 'red' | 'amber' | 'green';
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
const GREEN = 'FF006100';
const MUTED = 'FF595959';
const LINK = 'FF0563C1';
const NOTE_COLORS: Record<WorkbookNote['tone'], string> = { red: RED, amber: AMBER, green: GREEN };
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
const monthAfter = (month: string) => {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
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
  cash_flow: 'Statement of Cash Flows',
};

/** A name a file system takes: no slashes, colons or the like. */
const cleanName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

/** A sheet's name as Excel takes one: none of \ / ? * [ ] :, at most 31 characters. */
export function sheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim() || 'Sheet';
}

/** The report's file: "BMG Profit and Loss 2026-01 to 2026-09.xlsx", "BMG Balance Sheet 2026-09-30.xlsx". */
export function reportFileName(company: string, kind: ReportKind, from: string, to: string): string {
  const period = !coversMonths(kind)
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
 * first and last, when it has any) to the right over them. Returns the
 * header's row number.
 */
function titleRows(sheet: ExcelJS.Worksheet, p: {
  company: WorkbookCompany; title: string; period: string; about: string; notes: WorkbookNote[]; now: Date;
  header: string[]; amounts?: [number, number];
}): number {
  const title = (text: string, font: Partial<ExcelJS.Font>) => { sheet.addRow([text]).getCell(1).font = font; };
  title(p.company.legal_name || p.company.name, { bold: true, size: 14 });
  title(p.title, { bold: true, size: 12 });
  title(p.period, {});
  title(p.about, { color: { argb: MUTED } });
  title(`Downloaded ${centralTime(p.now)}.`, { color: { argb: MUTED } });
  for (const n of p.notes) title(n.text, { bold: true, color: { argb: NOTE_COLORS[n.tone] } });
  sheet.addRow([]);
  const head = sheet.addRow(p.header);
  head.eachCell((c, col) => {
    c.font = { bold: true };
    c.fill = HEAD_FILL;
    c.border = { bottom: { style: 'thin' } };
    const amount = !!p.amounts && col >= p.amounts[0] && col <= p.amounts[1];
    c.alignment = { horizontal: amount ? 'right' : 'left', vertical: 'bottom', wrapText: true };
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

const lineLabel = (l: Pick<ReportLine, 'label' | 'inChart'>) => `${l.label}${l.inChart === false ? ' (not in the chart yet)' : ''}`;

/** One report as Reports shows it, in a file of its own. */
export async function reportWorkbook(input: ReportWorkbookInput): Promise<WorkbookFile> {
  const wb = newWorkbook(input.now);
  addReportSheet(wb, input);
  return fileOf(wb, reportFileName(input.company.code, input.kind, input.from, input.to));
}

/** One report's sheet as Reports shows it, every line: the account's number, its name indented under its parent, then its amounts. */
function addReportSheet(wb: ExcelJS.Workbook, input: ReportWorkbookInput): ExcelJS.Worksheet {
  const { kind, from, to, report } = input;
  const trial = kind === 'trial_balance';
  const sheet = wb.addWorksheet(REPORT_NAMES[kind], {
    pageSetup: { orientation: trial ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = trial ? 46 : 52;
  amountColumns(sheet, 3, trial ? 7 : 5);

  titleRows(sheet, {
    company: input.company,
    title: REPORT_NAMES[kind],
    period: coversMonths(kind) ? `${monthStart(from)} to ${monthEnd(to)}` : `As of ${monthEnd(to)}`,
    about: trial
      ? "FleetSuite's own books next to NetSuite's own totals: balance sheet accounts at their month-end balance, income and expenses "
        + "for the year to date, earlier years' net income in retained earnings, as on NetSuite's Trial Balance report."
      : kind === 'cash_flow'
        ? "FleetSuite's own books next to NetSuite's own totals, laid out as NetSuite's Statement of Cash Flows: net income, then what "
          + 'the change in each other account did to cash, cash coming in positive.'
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

  return sheet;
}

// ── The report builder ─────────────────────────────────────────────────────

/** A report's name as NetSuite names its reports: "Profit and Loss by Customer and Month". */
const builderName = (by: BuilderBy, rows: BuilderRows) =>
  builderTitle(by, rows).split(' ').map((w) => (w === 'and' || w === 'by' ? w : w[0].toUpperCase() + w.slice(1))).join(' ');

const BUILDER_COLUMNS: Record<BuilderBy, string> = {
  total: '',
  month: ', a column for each month',
  quarter: ', a column for each quarter',
  year: ', a column for each year',
  division: ', a column for each division',
  location: ', a column for each location',
};

type Picked = Pick<BuiltReport, 'rows' | 'divisions' | 'locations' | 'division' | 'location'>;

/** The division and location the filters picked, with their names. */
const pickedOf = (built: Picked) => ({
  division: built.divisions.find((d) => d.key === built.division) ?? null,
  location: built.locations.find((l) => l.key === built.location) ?? null,
});

/** The report builder's file: "BMG Profit and Loss by Customer and Division 2026-01 to 2026-09.xlsx", naming what the filters picked. */
export function builderFileName(company: string, ask: BuilderAsk, built: Picked): string {
  const period = ask.from === ask.to ? ask.to.slice(0, 7) : `${ask.from.slice(0, 7)} to ${ask.to.slice(0, 7)}`;
  const { division, location } = pickedOf(built);
  const picked = [division?.label, location?.label].filter(Boolean);
  return `${cleanName(`${company} ${builderName(ask.by, built.rows)}${picked.length ? ` (${picked.join(', ')})` : ''} ${period}`)}.xlsx`;
}

/** The warnings the report builder shows above a report, as they read in its file. */
export function builderNotes(p: {
  companyName: string;
  posts: boolean;
  /** Whether the copy of NetSuite's ledger, where a line's location, customer and vendor come from, has been read. */
  copied: boolean;
  /** Whether the report's split of the journal comes to the profit and loss on Reports. */
  ties: boolean;
  lastPosting: (Run & { partial: boolean }) | null;
  lastCopy: Run | null;
}): WorkbookNote[] {
  const notes: WorkbookNote[] = [];
  if (!p.ties) {
    notes.push({
      tone: 'red',
      text: "Something posted to FleetSuite's books while this was read, so its columns may not come to the profit and loss on Reports. "
        + 'Download it again.',
    });
  }
  if (!p.posts) {
    notes.push({ tone: 'amber', text: `${p.companyName} doesn't post to FleetSuite's books yet, so nothing is in this report.` });
  } else if (!p.lastPosting) {
    notes.push({ tone: 'amber', text: "Nothing has posted to FleetSuite's books yet." });
  }
  notes.push(...postingNotes(p.lastPosting, 'this report'));
  if (!p.copied) {
    notes.push({ tone: 'amber', text: "NetSuite's ledger hasn't been copied yet, so lines from its documents have no location, customer or vendor." });
  }
  if (p.lastCopy?.error) {
    notes.push({ tone: 'red', text: `The last copy of NetSuite's ledger failed (${centralTime(p.lastCopy.at)}): ${p.lastCopy.error}` });
  }
  return notes;
}

export interface BuilderWorkbookInput {
  company: WorkbookCompany;
  ask: BuilderAsk;
  built: BuiltReport;
  notes: WorkbookNote[];
  now: Date;
}

/** A report from the report builder as its page shows it, in a file of its own. */
export async function builderWorkbook(input: BuilderWorkbookInput): Promise<WorkbookFile> {
  const wb = newWorkbook(input.now);
  addBuilderSheet(wb, input);
  return fileOf(wb, builderFileName(input.company.code, input.ask, input.built));
}

/**
 * A report from the report builder's sheet as its page shows it: every
 * line, the account's number and its name indented (or the customer's or
 * vendor's name, with no number), then an amount for each column.
 */
function addBuilderSheet(wb: ExcelJS.Workbook, input: BuilderWorkbookInput): ExcelJS.Worksheet {
  const { ask, built } = input;
  const byName = built.rows !== 'account';
  // Lines by name have no number column: the name is the first.
  const label = byName ? 1 : 2;
  const last = label + built.columns.length;
  const name = builderName(ask.by, built.rows);
  // A sheet's name is 31 characters at most: "P&L by Customer and Month" for a longer one.
  const sheet = wb.addWorksheet(sheetName(name.length > 31 ? name.replace('Profit and Loss', 'P&L') : name), {
    pageSetup: { orientation: built.columns.length > 3 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  if (!byName) sheet.getColumn(1).width = 10;
  sheet.getColumn(label).width = 44;
  amountColumns(sheet, label + 1, last, 15);

  const { division, location } = pickedOf(built);
  const filters = filterWords(division, location);
  titleRows(sheet, {
    company: input.company,
    title: name,
    period: `${monthStart(ask.from)} to ${monthEnd(ask.to)}`,
    about: `FleetSuite's own books laid out as NetSuite's income statement${byName ? `, a line for each ${built.rows}` : ''}`
      + `${BUILDER_COLUMNS[ask.by]}${built.columns.length > 1 ? ' and a Total' : ''}.${filters ? ` ${filters}` : ''}`,
    notes: input.notes,
    now: input.now,
    header: [...(byName ? [] : ['Number']), byName ? (built.rows === 'customer' ? 'Customer' : 'Vendor') : 'Account', ...built.columns.map((c) => c.label)],
    amounts: [label + 1, last],
  });

  for (const l of built.lines) {
    const amounts = l.amounts ? l.amounts.map(dollars) : built.columns.map(() => null);
    const row = sheet.addRow([...(byName ? [] : [l.number ?? null]), lineLabel(l), ...amounts]);
    const font: Partial<ExcelJS.Font> = { bold: l.kind !== 'account' };
    row.eachCell({ includeEmpty: true }, (c) => { c.font = font; });
    row.getCell(label).alignment = { indent: l.depth };
    if (l.kind === 'total') {
      for (let c = label + 1; c <= last; c += 1) row.getCell(c).border = { top: { style: l.grand ? 'double' : 'thin' } };
    }
  }

  return sheet;
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
  cash_flow: 'Amounts read as the cash flow statement shows them: cash coming in positive, going out negative.',
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

/** What the inventory value's sheets are called: the items, how they tie to the accounts, and the documents with no item. */
interface InventorySheetNames {
  items: string;
  ties: string;
  docs: string;
}

const INVENTORY_SHEETS: InventorySheetNames = { items: 'Inventory value', ties: 'Ties to the accounts', docs: 'Documents with no item' };

/** One company's inventory value at a month's end, as Inventory value shows it, in a file of its own. */
export async function inventoryWorkbook(input: InventoryWorkbookInput): Promise<WorkbookFile> {
  const wb = newWorkbook(input.now);
  addInventorySheets(wb, input, INVENTORY_SHEETS);
  return fileOf(wb, inventoryFileName(input.company.code, input.month));
}

/**
 * One company's inventory value at a month's end, as Inventory value shows
 * it: each item at each location with its count, average cost and value; each
 * inventory account from the stocked items on it to FleetSuite's balance
 * sheet, every cent between them on a line of its own; and, when there are
 * any, the documents with no stocked item behind them, the month's first.
 * Returns the sheets in that order.
 */
function addInventorySheets(wb: ExcelJS.Workbook, input: InventoryWorkbookInput, names: InventorySheetNames): ExcelJS.Worksheet[] {
  const { month, value } = input;
  const period = `As of ${monthEnd(month)}`;
  const setup = { pageSetup: { orientation: 'portrait' as const, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } };

  const items = wb.addWorksheet(names.items, setup);
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

  const ties = wb.addWorksheet(names.ties, setup);
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
    const docs = wb.addWorksheet(names.docs, { pageSetup: { ...setup.pageSetup, orientation: 'landscape' } });
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
    return [items, ties, docs];
  }

  return [items, ties];
}

// ── Missouri sales tax ─────────────────────────────────────────────────────

/** The sales tax worksheet's file: "BMG Sales tax 2026-10.xlsx". */
export function salesTaxFileName(company: string, month: string): string {
  return `${cleanName(`${company} Sales tax ${month.slice(0, 7)}`)}.xlsx`;
}

/** What Sales tax warns about for a month, as it reads in its file: what to fix first in red, what to know in amber. */
export function salesTaxNotes(p: { month: string; through: string; worksheet: Pick<SalesTaxWorksheet, 'problems' | 'warnings'> }): WorkbookNote[] {
  const notes: WorkbookNote[] = [];
  if (p.month === p.through) {
    notes.push({ tone: 'amber', text: `${monthName(p.month)} isn't over yet, so this is where it stood when the file was made.` });
  }
  notes.push(...p.worksheet.problems.map((text) => ({ tone: 'red' as const, text })));
  notes.push(...p.worksheet.warnings.map((text) => ({ tone: 'amber' as const, text })));
  return notes;
}

export interface SalesTaxWorkbookInput {
  company: WorkbookCompany;
  /** 'YYYY-MM-01'. */
  month: string;
  /** When its return is due, 'YYYY-MM-DD'. */
  due: string;
  worksheet: SalesTaxWorksheet;
  filed: FiledReturn | null;
  held: ReturnHeld | null;
  /** NetSuite's sales tax accounts, as the chart names them. */
  taxAccounts: Array<{ number: string | null; name: string }>;
  notes: WorkbookNote[];
  now: Date;
}

const dayName = (iso: string) => `${monthOf(iso)} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

/**
 * A month's Missouri sales tax as Sales tax shows it: what to file, location
 * by location, with the timely payment allowance and what to pay, and what
 * isn't on the return; the return as filed held against it; every document
 * and its lines, each line taxed or not by FleetSuite's rule; exempt
 * customers' sales and their certificates; and the sales tax accounts
 * through the month.
 */
export async function salesTaxWorkbook(input: SalesTaxWorkbookInput): Promise<WorkbookFile> {
  const { month, due, worksheet: w } = input;
  const wb = newWorkbook(input.now);
  const period = `${monthStart(month)} to ${monthEnd(month)}`;
  const setup = { pageSetup: { orientation: 'portrait' as const, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } };
  const wide = { pageSetup: { ...setup.pageSetup, orientation: 'landscape' as const } };

  const ret = wb.addWorksheet('Return', setup);
  [30, 11, 11].forEach((wd, i) => { ret.getColumn(i + 1).width = wd; });
  amountColumns(ret, 4, 8);
  titleRows(ret, {
    company: input.company,
    title: 'Missouri sales tax return',
    period,
    about: `What goes on Form 53-1 for the month, location by location: the sales NetSuite posted in it, less what isn't taxed by FleetSuite's `
      + `own rule, at the location's rate. Due ${dayName(due)}; the 2% timely payment allowance comes off only when it's filed and paid by then.`,
    notes: input.notes,
    now: input.now,
    header: ['Location', 'Rate', 'Documents', 'Gross receipts', 'Adjustments', 'Taxable sales', 'Tax', "NetSuite's tax"],
    amounts: [3, 8],
  });
  for (const l of w.lines) {
    const row = ret.addRow([
      l.location, l.rate ? l.rate.pct : 'No rate', l.documents, dollars(l.gross), dollars(l.adjustments), dollars(l.taxable),
      l.tax === null ? null : dollars(l.tax), dollars(l.charged),
    ]);
    redIf(row.getCell(2), !l.rate);
  }
  const f = w.figures;
  const total = ret.addRow([
    'Total', null, w.lines.reduce((n, l) => n + l.documents, 0), dollars(f.gross), dollars(f.adjustments), dollars(f.taxable),
    f.tax === null ? null : dollars(f.tax), dollars(f.charged),
  ]);
  total.font = { bold: true };
  for (let c = 4; c <= 8; c += 1) total.getCell(c).border = { top: { style: 'thin' } };
  ret.getColumn(3).numFmt = '#,##0';
  const figure = (label: string, cents: number | null, bold = false) => {
    const row = ret.addRow([label, null, null, null, null, null, cents === null ? 'Not yet' : dollars(cents)]);
    if (bold) row.font = { bold: true };
  };
  figure(`Less the timely payment allowance, 2% when filed and paid by ${dayName(due)}`, f.allowance === null ? null : -f.allowance);
  figure('To pay', f.pay, true);
  if (w.apart.length) {
    ret.addRow([]);
    ret.addRow(["Not on Missouri's return"]).font = { bold: true, size: 12 };
    for (const a of w.apart) {
      const row = ret.addRow([
        a.location, a.state === 'GA' ? 'Georgia' : 'Neither state', a.documents, dollars(a.gross), null, null, null, dollars(a.charged),
      ]);
      redIf(row.getCell(2), a.state !== 'GA');
    }
  }

  if (input.filed && input.held) {
    const filed = input.filed;
    const held = input.held;
    const as = wb.addWorksheet('As filed', setup);
    as.getColumn(1).width = 30;
    amountColumns(as, 2, 4);
    titleRows(as, {
      company: input.company,
      title: `The return as filed ${dayName(filed.filedOn)}`,
      period,
      about: "Each figure on the return as it was typed in, next to what it should be: the worksheet's, and for the allowance and "
        + "what was paid, worked out from the return's own tax.",
      notes: held.notes.map((text) => ({ tone: 'amber' as const, text })),
      now: input.now,
      header: ['Figure', 'On the return', 'Should be', 'Apart'],
      amounts: [2, 4],
    });
    for (const fh of held.fields) {
      const row = as.addRow([
        RETURN_FIELD_WORDS[fh.field], dollars(fh.filed), fh.expected === null ? null : dollars(fh.expected),
        fh.expected === null ? null : dollars(fh.filed - fh.expected),
      ]);
      redIf(row.getCell(4), fh.differs);
    }
    if (filed.note) as.addRow([`Note: ${filed.note}`]).font = { italic: true };
  }

  const docs = wb.addWorksheet('Documents', wide);
  [11, 14, 14, 30, 18, 24, 9].forEach((wd, i) => { docs.getColumn(i + 1).width = wd; });
  docs.getColumn(1).numFmt = DATE;
  amountColumns(docs, 8, 13);
  docs.getColumn(14).width = 80;
  const docsTop = titleRows(docs, {
    company: input.company,
    title: 'Sales tax: every document',
    period,
    about: "Each invoice, credit memo and cash sale NetSuite posted to the month, at its location: its sales, what's taxed by FleetSuite's "
      + "rule, the tax NetSuite charged and FleetSuite's, and why the two differ when they do.",
    notes: [],
    now: input.now,
    header: [
      'Date', 'Type', 'Number', 'Customer', 'Location', 'How it\'s taxed', 'Rate', 'Sales', 'Taxable', 'Not taxed',
      'Counted as taxed, items not known', "NetSuite's tax", "FleetSuite's tax", 'Why they differ',
    ],
    amounts: [7, 13],
  });
  const byDate = [...w.documents].sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? '').localeCompare(b.number ?? '', 'en', { numeric: true }));
  for (const d of byDate) {
    const row = docs.addRow([
      dateCell(d.date), d.typeName, d.number, d.customer, d.location, BASIS_WORDS[d.basis], d.rate?.pct ?? null, dollars(d.gross),
      dollars(d.taxable), dollars(d.untaxed), d.unsorted ? dollars(d.unsorted) : null, dollars(d.charged),
      d.owed === null ? null : dollars(d.owed), d.note,
    ]);
    redIf(row.getCell(13), d.owed !== null && d.owed !== d.charged);
    row.getCell(14).alignment = { wrapText: true, vertical: 'top' };
  }
  if (byDate.length) docs.autoFilter = { from: { row: docsTop, column: 1 }, to: { row: docsTop + byDate.length, column: 14 } };

  const lines = wb.addWorksheet('Lines', setup);
  [11, 14, 14, 18, 24, 17, 10, 14].forEach((wd, i) => { lines.getColumn(i + 1).width = wd; });
  lines.getColumn(1).numFmt = DATE;
  lines.getColumn(6).numFmt = AMOUNT;
  const linesTop = titleRows(lines, {
    company: input.company,
    title: 'Sales tax: each line',
    period,
    about: "Each document's lines on income accounts, taxed or not by FleetSuite's own rule from the line's item: a discount follows "
      + "the line above it, and a line whose item FleetSuite doesn't have yet is counted as taxed.",
    notes: [],
    now: input.now,
    header: ['Date', 'Type', 'Number', 'Location', 'Item', 'Sales', 'Taxed', 'Item known'],
    amounts: [6, 6],
  });
  let lineCount = 0;
  for (const d of byDate) {
    for (const l of d.lines) {
      lines.addRow([dateCell(d.date), d.typeName, d.number, d.location, l.item, dollars(l.cents), l.taxable ? 'Yes' : 'No', l.known ? 'Yes' : 'No']);
      lineCount += 1;
    }
  }
  if (lineCount) lines.autoFilter = { from: { row: linesTop, column: 1 }, to: { row: linesTop + lineCount, column: 8 } };

  if (w.exempt.length) {
    const ex = wb.addWorksheet('Exempt sales', setup);
    [34, 11, 17, 20, 12, 11, 50].forEach((wd, i) => { ex.getColumn(i + 1).width = wd; });
    ex.getColumn(3).numFmt = AMOUNT;
    ex.getColumn(5).numFmt = DATE;
    titleRows(ex, {
      company: input.company,
      title: "Exempt customers' sales",
      period,
      about: "Each customer FleetSuite has as tax exempt (every FleetSuite customer with its NetSuite id is), what they bought in the month, "
        + "and the exemption certificate on file on the sales' dates.",
      notes: [],
      now: input.now,
      header: ['Customer', 'Documents', 'Sales', 'Certificate', 'Expires', 'Files', 'Warning'],
      amounts: [3, 3],
    });
    for (const e of w.exempt) {
      const row = ex.addRow([e.customer, e.documents, dollars(e.gross), e.certNumber, dateCell(e.certExpires), e.certFiles, e.warning]);
      if (e.warning) row.getCell(7).font = { color: { argb: RED } };
    }
  }

  if (w.accounts) {
    const a = w.accounts;
    const acct = wb.addWorksheet('Sales tax account', setup);
    [56, 11, 14, 28, 40].forEach((wd, i) => { acct.getColumn(i + 1).width = wd; });
    acct.getColumn(2).numFmt = DATE;
    amountColumns(acct, 6, 6);
    const names = input.taxAccounts.map((t) => `${t.number ? `${t.number} ` : ''}${t.name}`).join(', ');
    titleRows(acct, {
      company: input.company,
      title: 'Sales tax account',
      period,
      about: `${names || "NetSuite's sales tax accounts"} in NetSuite's ledger as FleetSuite copies it, owed to the state positive: `
        + "through the month, then what came off it in the month and the month after, when the month's return is paid.",
      notes: [],
      now: input.now,
      header: ['', 'Date', 'Number', 'Name', 'Memo', 'Amount'],
      amounts: [6, 6],
    });
    const line = (label: string, cents: number, style: { bold?: boolean; indent?: number } = {}) => {
      const row = acct.addRow([label, null, null, null, null, dollars(cents)]);
      if (style.bold) row.font = { bold: true };
      if (style.indent) row.getCell(1).alignment = { indent: style.indent };
    };
    line(`At the end of ${monthName(monthBefore(month))}`, a.start, { bold: true });
    for (const m of a.moves) line(`${m.typeName}, ${count(m.documents, 'document', 'documents')}`, m.amount, { indent: 1 });
    line(`At the end of ${monthName(month)}`, a.end, { bold: true });
    line(`FleetSuite's books at the end of ${monthName(month)}`, a.books);
    const list = (title: string, moves: OtherMoves) => {
      acct.addRow([]);
      acct.addRow([title]).font = { bold: true, size: 12 };
      if (!moves.count) {
        acct.addRow(['None']).font = { italic: true, color: { argb: MUTED } };
        return;
      }
      for (const o of moves.list) acct.addRow([o.typeName, dateCell(o.date), o.number, o.name, o.memo, dollars(o.amount)]);
      if (moves.count > moves.list.length) {
        acct.addRow([`${count(moves.count - moves.list.length, 'more document', 'more documents')} not listed`]).font = { italic: true };
      }
      const all = acct.addRow(['Total', null, null, null, null, dollars(moves.total)]);
      all.font = { bold: true };
      all.getCell(6).border = { top: { style: 'thin' } };
    };
    list(`Other documents on it in ${monthName(month)}: payments to the state, journal entries`, a.others);
    list(`In ${monthName(monthAfter(month))}, when ${monthOf(month)}'s return is paid`, a.next);
  }

  return fileOf(wb, salesTaxFileName(input.company.code, month));
}

// ── The year-end package ───────────────────────────────────────────────────

/** The year-end package's file: "BMG Year-end package 2027.xlsx". */
export function yearEndFileName(company: string, year: number): string {
  return `${cleanName(`${company} Year-end package ${year}`)}.xlsx`;
}

/** The year as Year end shows it (yearView in year-end.ts), which the package reads. */
export type YearEndView = Pick<YearView, 'own' | 'over' | 'checks' | 'closed' | 'changedSince' | 'events'>;

/**
 * What Year end says about the year, as it reads at the top of each of the
 * package's sheets: that it isn't over yet, that it closes in NetSuite, so
 * FleetSuite's side is the rehearsal, that it's closed, by whom and when,
 * and that FleetSuite's books have changed since.
 */
export function yearEndNotes(p: {
  name: string;
  year: number;
  liveFrom: string | null;
  view: Pick<YearEndView, 'own' | 'over' | 'closed' | 'changedSince'>;
}): WorkbookNote[] {
  const { year, view } = p;
  const notes: WorkbookNote[] = [];
  if (!view.over) notes.push({ tone: 'amber', text: `${year} isn't over yet, so this is where it stood when the file was made.` });
  if (!view.own) {
    notes.push({
      tone: 'amber',
      text: `${p.liveFrom ? `${year} is before ${p.name}'s books went live, so it` : `${p.name}'s books aren't live yet, so ${year}`} closes in NetSuite: `
        + "FleetSuite's side here is the rehearsal.",
    });
  }
  if (view.closed) {
    const { at, by } = view.closed;
    notes.push({ tone: 'green', text: `${year} is closed${by ? ` by ${by}` : ''}${at ? `, ${centralTime(at)}` : ''}.` });
    if (view.changedSince) {
      notes.push({
        tone: 'red',
        text: `FleetSuite's books have changed since ${year} closed: it closed at ${fmt(view.closed.netIncome ?? 0)} of net income and `
          + `${fmt(view.closed.retainedEarnings ?? 0)} of retained earnings. An account's type may have changed in the chart.`,
      });
    }
  }
  return notes;
}

export interface YearEndWorkbookInput {
  company: WorkbookCompany;
  year: number;
  /** The last month the reports cover, 'YYYY-MM-01': December, or this month while the year isn't over. */
  to: string;
  liveFrom: string | null;
  view: YearEndView;
  /** How the year closes into retained earnings, both sides (yearCloseAmounts in reports.ts). */
  close: YearCloseAmounts;
  /** The trial balance and balance sheet at `to`'s end, the profit and loss and cash flow statement from January through it. */
  reports: Record<ReportKind, Report>;
  /** What Reports warns about (reportNotes). */
  reportNotes: WorkbookNote[];
  /** The profit and loss by month from the report builder, with what it warns about (builderNotes). */
  byMonth: { ask: BuilderAsk; built: BuiltReport; notes: WorkbookNote[] };
  /** The company's stock at `to`'s end, with what Inventory value warns about (inventoryNotes); null for a company with none. */
  inventory: { value: CompanyValue; notes: WorkbookNote[] } | null;
  now: Date;
}

const PACKAGE_INVENTORY: InventorySheetNames = {
  items: 'Inventory value', ties: 'Inventory ties to accounts', docs: 'Inventory documents, no item',
};

/**
 * A company's year for the CPA in one file, as Books shows it: a contents
 * sheet listing the others, each linked, with what's done before the year
 * closes; the trial balance and balance sheet at the year's end, the profit
 * and loss for the year and by month, the cash flow statement and how the
 * year closes into retained earnings, FleetSuite's books next to NetSuite's
 * own totals; and, for a company with stock, its inventory value at the
 * year's end. What Year end says about the year is at the top of each sheet,
 * above what the sheet's own page warns about.
 */
export async function yearEndWorkbook(input: YearEndWorkbookInput): Promise<WorkbookFile> {
  const { company, year, to, view, now } = input;
  const january = `${year}-01-01`;
  const end = monthEnd(to);
  const period = `${monthStart(january)} to ${end}`;
  const wb = newWorkbook(now);
  const yearNotes = yearEndNotes({ name: company.name, year, liveFrom: input.liveFrom, view });
  const reportNotes = [...yearNotes, ...input.reportNotes];
  // First in the file; filled once the sheets it lists are in.
  const contents = wb.addWorksheet('Contents', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });

  const listed: Array<{ sheet: ExcelJS.Worksheet; holds: string }> = [];
  const add = (sheet: ExcelJS.Worksheet, holds: string) => { listed.push({ sheet, holds }); };
  const statement = (kind: ReportKind) => addReportSheet(wb, { company, kind, from: january, to, report: input.reports[kind], notes: reportNotes, now });
  add(statement('trial_balance'), `Each account at ${end}, income and expenses for the year, FleetSuite's books next to NetSuite's.`);
  add(statement('balance_sheet'), `At ${end}, FleetSuite's books next to NetSuite's.`);
  add(statement('profit_and_loss'), `${period}, FleetSuite's books next to NetSuite's.`);
  add(
    addBuilderSheet(wb, { company, ask: input.byMonth.ask, built: input.byMonth.built, notes: [...yearNotes, ...input.byMonth.notes], now }),
    "The profit and loss with a column for each month and a Total, FleetSuite's books.",
  );
  add(statement('cash_flow'), `${period}, FleetSuite's books next to NetSuite's.`);
  add(retainedEarningsSheet(wb, input, reportNotes), `How ${year} closes into retained earnings, both sides, and each time it was closed or reopened.`);
  if (input.inventory) {
    // Inventory value's own notes say when its month isn't over, so the year's first note, which says it of the year, is left off.
    const notes = [...yearNotes.slice(view.over ? 0 : 1), ...input.inventory.notes];
    const [items, ties, docs] = addInventorySheets(wb, { company, month: to, value: input.inventory.value, notes, now }, PACKAGE_INVENTORY);
    add(items, `Each item at each location at ${end}: on hand, average cost and value.`);
    add(ties, `How the items come to each inventory account on the balance sheet at ${end}.`);
    if (docs) add(docs, `Documents on the inventory accounts with no stocked item, from January 1, 2025 to ${end}.`);
  }

  contents.getColumn(1).width = 30;
  contents.getColumn(2).width = 100;
  titleRows(contents, {
    company,
    title: `Year-end package ${year}`,
    period,
    about: "FleetSuite's books at the year's end for the CPA, a sheet for each report as Books shows it, with what to know about it at its top.",
    notes: yearNotes,
    now,
    header: ['Sheet', 'What it holds'],
  });
  const entry = (cells: ExcelJS.CellValue[]) => {
    const row = contents.addRow(cells);
    row.getCell(1).alignment = { vertical: 'top' };
    row.getCell(2).alignment = { vertical: 'top', wrapText: true };
    return row;
  };
  for (const { sheet, holds } of listed) {
    entry([{ text: sheet.name, hyperlink: `#'${sheet.name}'!A1` }, holds]).getCell(1).font = { color: { argb: LINK }, underline: true };
  }
  contents.addRow([]);
  contents.addRow([`Before ${year} closes`]).font = { bold: true, size: 12 };
  for (const c of view.checks) {
    const row = entry([`${CHECK_LABELS[c.key]}: ${STATE_WORDS[c.state]}`, c.detail]);
    if (c.state === 'todo') row.font = { bold: true, color: { argb: AMBER } };
  }

  return fileOf(wb, yearEndFileName(company.code, year));
}

/**
 * How the year closes into retained earnings, as Year end shows it, both
 * sides and the difference: retained earnings at January 1, what was posted
 * to them in the year, its net income and retained earnings once it closes;
 * then which account they're on, and each time the year was closed or
 * reopened, oldest first.
 */
function retainedEarningsSheet(wb: ExcelJS.Workbook, input: YearEndWorkbookInput, notes: WorkbookNote[]): ExcelJS.Worksheet {
  const { year, close, view } = input;
  const sheet = wb.addWorksheet('Retained Earnings', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  sheet.getColumn(1).width = 62;
  amountColumns(sheet, 2, 4);
  titleRows(sheet, {
    company: input.company,
    title: 'Retained earnings',
    period: `${monthStart(`${year}-01-01`)} to ${monthEnd(`${year}-12-01`)}`,
    about: "How the year closes into retained earnings, FleetSuite's books next to NetSuite's own totals. Nothing is posted to close a year: "
      + "the balance sheet takes its net income into retained earnings on January 1, as NetSuite's does.",
    notes,
    now: input.now,
    header: ['', 'FleetSuite', 'NetSuite', 'Difference'],
    amounts: [2, 4],
  });
  const line = (label: string, pair: Pair, total = false) => {
    const row = sheet.addRow([label, dollars(pair.fleetsuite), dollars(pair.netsuite), dollars(pair.fleetsuite - pair.netsuite)]);
    if (total) {
      row.font = { bold: true };
      for (let c = 2; c <= 4; c += 1) row.getCell(c).border = { top: { style: 'double' } };
    }
    redIf(row.getCell(4), pair.fleetsuite !== pair.netsuite);
  };
  line(`Retained earnings, January 1, ${year}`, close.starting);
  line(`Posted to retained earnings in ${year}`, close.posted);
  line(`Net income for ${year}`, close.netIncome);
  line(`Retained earnings once ${year} closes, January 1, ${year + 1}`, close.closed, true);

  sheet.addRow([]);
  sheet.addRow([close.account
    ? `Retained earnings is ${[close.account.number, close.account.name].filter(Boolean).join(' ')}.`
    : "The chart has no retained earnings account, so they're the balance sheet's own line of earlier years' net income."]).font = { color: { argb: MUTED } };
  if (view.events.length) {
    sheet.addRow([]);
    sheet.addRow([`${year} closed and reopened`]).font = { bold: true, size: 12 };
    for (const e of view.events) {
      const amounts = e.action === 'closed' && e.netIncome !== null ? `, at ${fmt(e.netIncome)} of net income` : '';
      sheet.addRow([`${e.action === 'closed' ? 'Closed' : 'Reopened'}${e.by ? ` by ${e.by}` : ''}, ${centralTime(e.at)}${amounts}${e.reason ? `: ${e.reason}` : ''}`]);
    }
  }
  return sheet;
}
