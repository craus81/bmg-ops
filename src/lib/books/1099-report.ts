/**
 * NetSuite's 1099 report next to FleetSuite's (part 51, migration 482,
 * docs/books.md "1099s"; the NetSuite Exit Checklist, thread "Replacing
 * NetSuite with FleetSuite", 2026-10-31): reads the 1099 report exported
 * from NetSuite (Export – CSV, or an Excel .xlsx) into each vendor's amounts
 * by box of the form, and holds it against FleetSuite's totals worked out
 * from its copy of NetSuite (src/lib/books/1099s.ts), vendor by vendor and
 * box by box.
 *
 * Only each vendor's names and amounts are kept. The file is read on the
 * phone or computer it's picked on and never sent anywhere: a column that
 * holds a tax ID, an address or anything else that isn't a vendor's name or
 * an amount for a box is left out, and any run of nine digits in what is
 * kept is taken out, so a vendor's tax ID never reaches FleetSuite. The
 * route and the database refuse a nine-digit run too.
 *
 * Client-safe and pure but for reading the file. Amounts are whole cents.
 */

import { parseDelimited, sheetCells } from '@/lib/import-installs-parse';
import type { Payee1099, Year1099 } from './1099s';

/** A column of the report that's kept: the amounts for a box of the form, or the total. */
export interface ReportColumn {
  /** Its key in each vendor's amounts: c1, c2... */
  key: string;
  /** Its heading in the report. */
  header: string;
  /** The box it's for, by FleetSuite's name for the category when it has one; null for the total. */
  box: string | null;
}

/** A vendor in the report. */
export interface ReportVendor {
  /** As the report names it. */
  label: string;
  /** Other names the report gives it: its legal name, say. */
  names: string[];
  /** Whole cents by column key; a blank or 0 isn't listed. */
  amounts: Record<string, number>;
}

/** NetSuite's 1099 report as kept: names and amounts only. */
export interface Report1099 {
  /** The lines above the report's headings: its title and dates, as NetSuite printed them. */
  title: string[];
  columns: ReportColumn[];
  /** The headings of the columns left out: tax IDs, addresses, anything that isn't a name or an amount for a box. */
  leftOut: string[];
  vendors: ReportVendor[];
  /** Rows not kept as vendors: total rows, rows of amounts naming no vendor, and rows naming one again (added to its first). */
  skipped: { totals: number; noName: number; combined: number };
}

export interface ReportRead {
  /** Null when it can't be read; problems says why. */
  report: Report1099 | null;
  problems: string[];
  /** The workbook sheet it was read from. */
  sheetName?: string;
}

export const MAX_VENDORS = 5000;
export const MAX_COLUMNS = 40;
const MAX_TEXT = 200;
const MAX_NAMES = 5;
const MAX_TITLE = 6;
const MAX_LEFT_OUT = 60;
const MAX_CENTS = 1e13;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PROBLEMS = 10;

// Nine digits or more, one character apart at most ("123-45-6789", "12 3456789"): a tax ID, maybe.
// Migration 482 refuses the same.
const NINE_DIGITS = /\d(?:[^\dA-Za-z]?\d){8,}/;
const NINE_DIGITS_ALL = new RegExp(NINE_DIGITS.source, 'g');

/** Whether text has a run of nine digits in it. */
export const hasNineDigits = (s: string) => NINE_DIGITS.test(s);

/** Text as kept: any run of nine digits taken out, spaces tidied, cut to 200 characters. */
export function scrub(s: string): string {
  return s.replace(NINE_DIGITS_ALL, '***').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

const plain = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = (s: string) => plain(s).replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);

/** A name as compared: without its case, accents, spacing or punctuation, "&" as "and". */
export const nameKey = (s: string) => words(scrub(s)).join('');

// A heading's words that say which form or box, not what the box is for.
const FORM_WORDS = new Set(['1099', 'misc', 'nec', 'form']);
const BOX_WORDS = new Set([...FORM_WORDS, 'box', 'amount', 'amounts']);

/** A box's heading or category name as compared: without "Box 7", "1099-NEC" or "Amount". */
export function boxKey(s: string): string {
  return words(s).filter((w) => !BOX_WORDS.has(w) && !/^\d{1,2}[a-z]?$/.test(w)).join('');
}

const TOTALS = new Set([
  'total', 'totals', 'totalamount', 'amount', 'totalpaid', 'amountpaid', 'totalpayments', 'grandtotal',
  'reportable', 'reportableamount', 'totalreportable', 'totalreportableamount',
]);
const isTotalHeader = (h: string) => TOTALS.has(words(h).filter((w) => !FORM_WORDS.has(w)).join(''));

const VENDOR_HEADERS = new Set([
  'vendor', 'vendorname', 'name', 'payee', 'payeename', 'recipient', 'recipientname', 'recipientsname',
  'entity', 'entityname', 'company', 'companyname', 'vendorcompanyname',
]);
const OTHER_NAME_HEADERS = new Set([
  'legalname', 'vendorlegalname', 'recipientlegalname', 'printoncheckas', 'printas', 'dba', 'doingbusinessas',
  'businessname', 'vendorid', 'entityid', 'vendornumber', 'vendorno',
]);

/**
 * The 1099-MISC and 1099-NEC boxes NetSuite's categories are named for,
 * so a box column FleetSuite has no account for is still read.
 */
export const STANDARD_BOXES = [
  'Nonemployee Compensation', 'Rents', 'Royalties', 'Other Income', 'Federal Income Tax Withheld',
  'Fishing Boat Proceeds', 'Medical and Health Care Payments', 'Substitute Payments in Lieu of Dividends or Interest',
  'Direct Sales', 'Crop Insurance Proceeds', 'Gross Proceeds Paid to an Attorney', 'Fish Purchased for Resale',
  'Section 409A Deferrals', 'Excess Golden Parachute Payments', 'Nonqualified Deferred Compensation', 'State Tax Withheld',
];

/** "$1,234.56", "(1,234.56)" and "-1234.56" as whole cents; null when it's blank; NaN when it isn't an amount. */
export function readMoney(raw: string): number | null {
  let s = raw.trim().replace(/[$,\s]/g, '');
  if (s === '' || s === '-' || s === '–' || s === '—') return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
  const cents = Math.round(Number(s) * 100) * (negative ? -1 : 1);
  return cents === 0 ? 0 : cents;
}

/** A row that totals others: "Total", "Grand Total", "Total - Sample Painting". Not a vendor named "Total Signs". */
const isTotalRow = (label: string) => /^(grand\s+)?totals?$/i.test(label) || /^total\s*[-–—:]/i.test(label);

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * Reads the report from its cells: the heading row is the first, within the
 * first 30 rows, that names the vendor and at least one box or a total.
 * Rows above it are the report's title. `boxes` are FleetSuite's names for
 * the categories, matched to the report's headings first.
 */
export function read1099Report(cells: string[][], boxes: readonly string[]): ReportRead {
  const known = new Map<string, string>();
  for (const name of [...boxes, ...STANDARD_BOXES]) {
    const k = boxKey(name);
    if (k && !known.has(k)) known.set(k, name);
  }

  type Kind = { kind: 'box'; box: string } | { kind: 'total' } | { kind: 'vendor' } | { kind: 'name' } | { kind: 'out' };
  const classify = (h: string): Kind => {
    if (!h.trim()) return { kind: 'out' };
    const box = known.get(boxKey(h));
    if (box) return { kind: 'box', box };
    if (isTotalHeader(h)) return { kind: 'total' };
    const k = words(h).join('');
    if (VENDOR_HEADERS.has(k)) return { kind: 'vendor' };
    if (OTHER_NAME_HEADERS.has(k)) return { kind: 'name' };
    return { kind: 'out' };
  };

  let at = -1;
  let kinds: Kind[] = [];
  for (let r = 0; r < Math.min(cells.length, 30) && at === -1; r++) {
    const row = cells[r].map(classify);
    const named = row.some((k) => k.kind === 'vendor' || k.kind === 'name');
    if (named && row.some((k) => k.kind === 'box' || k.kind === 'total')) {
      at = r;
      kinds = row;
    }
  }
  if (at === -1) {
    return {
      report: null,
      problems: ["Couldn't find the report's headings: a row naming the vendor and at least one box of the form (Rents, Nonemployee Compensation...) or a total."],
    };
  }

  const headers = cells[at];
  const vendorAt = kinds.findIndex((k) => k.kind === 'vendor');
  const labelAt = vendorAt !== -1 ? vendorAt : kinds.findIndex((k) => k.kind === 'name');
  const amountsAt = kinds.flatMap((k, i) => (k.kind === 'box' || k.kind === 'total' ? [i] : []));
  if (amountsAt.length > MAX_COLUMNS) {
    return { report: null, problems: [`The report has ${amountsAt.length} columns of amounts; FleetSuite reads up to ${MAX_COLUMNS}.`] };
  }
  const columns: ReportColumn[] = amountsAt.map((i, n) => {
    const k = kinds[i];
    return { key: `c${n + 1}`, header: scrub(headers[i]) || `Column ${i + 1}`, box: k.kind === 'box' ? k.box : null };
  });
  const body = cells.slice(at + 1);
  const cell = (row: string[], i: number) => (row[i] ?? '').trim();

  // Another name column whose cells have nine digits in a row is a tax ID column by another name: left out whole.
  const namesAt = kinds.flatMap((k, i) => (i !== labelAt && (k.kind === 'vendor' || k.kind === 'name') ? [i] : []));
  const keptNamesAt = namesAt.filter((i) => !body.some((row) => hasNineDigits(cell(row, i))));
  const leftOut = headers
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => i !== labelAt && !amountsAt.includes(i) && !keptNamesAt.includes(i))
    .map(({ h }) => scrub(h))
    .filter(Boolean)
    .slice(0, MAX_LEFT_OUT);

  const problems: string[] = [];
  let more = 0;
  const problem = (s: string) => (problems.length < MAX_PROBLEMS ? problems.push(s) : more++);
  const skipped = { totals: 0, noName: 0, combined: 0 };
  const vendors: ReportVendor[] = [];
  const byKey = new Map<string, ReportVendor>();

  body.forEach((row, n) => {
    const line = at + n + 2;
    const amounts: Record<string, number> = {};
    let any = false;
    for (const [c, i] of amountsAt.entries()) {
      const raw = cell(row, i);
      const cents = readMoney(raw);
      if (cents === null) continue;
      if (Number.isNaN(cents) || Math.abs(cents) > MAX_CENTS) {
        problem(`Row ${line}: "${scrub(raw).slice(0, 30)}" under ${columns[c].header} isn't an amount.`);
        continue;
      }
      any = true;
      if (cents !== 0) amounts[columns[c].key] = cents;
    }
    // A row with no amount at all is a heading or a note, not a vendor.
    if (!any) return;
    const label = scrub(cell(row, labelAt));
    if (!nameKey(label)) {
      skipped.noName++;
      return;
    }
    if (isTotalRow(label)) {
      skipped.totals++;
      return;
    }
    const names = [...new Set(keptNamesAt.map((i) => scrub(cell(row, i))).filter((s) => s && nameKey(s) !== nameKey(label)))];
    const key = nameKey(label);
    const first = byKey.get(key);
    if (first) {
      skipped.combined++;
      for (const [k, c] of Object.entries(amounts)) {
        const sum = (first.amounts[k] ?? 0) + c;
        if (sum === 0) delete first.amounts[k];
        else first.amounts[k] = sum;
      }
      for (const s of names) if (!first.names.includes(s) && first.names.length < MAX_NAMES) first.names.push(s);
      return;
    }
    const vendor = { label, names: names.slice(0, MAX_NAMES), amounts };
    byKey.set(key, vendor);
    vendors.push(vendor);
  });

  if (more) problems.push(`And ${plural(more, 'more cell', 'more cells')} that ${more === 1 ? "isn't an amount" : "aren't amounts"}.`);
  if (!problems.length && !vendors.length) problems.push('The report lists no vendors under its headings.');
  if (vendors.length > MAX_VENDORS) problems.push(`The report lists ${plural(vendors.length, 'vendor', 'vendors')}; FleetSuite reads up to ${MAX_VENDORS.toLocaleString('en-US')}.`);
  if (problems.length) return { report: null, problems };

  const title = cells.slice(0, at)
    .map((row) => scrub(row.filter((c) => c.trim()).join(' · ')))
    .filter(Boolean)
    .slice(0, MAX_TITLE);
  return { report: { title, columns, leftOut, vendors, skipped }, problems: [] };
}

/** Reads an exported report file (.csv, .tsv or .xlsx) on the device it's picked on. Throws an Error to show. */
export async function read1099ReportFile(file: File, boxes: readonly string[]): Promise<ReportRead> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is too big for a 1099 report. Export the summary report as CSV and upload that.');
  if (ext === 'xls') {
    throw new Error("NetSuite's Excel export is an old .xls file FleetSuite can't read. Use Export – CSV in NetSuite instead, or open the file in Excel and save it as .xlsx.");
  }
  if (ext === 'xlsx' || ext === 'xlsm') {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(await file.arrayBuffer());
    } catch {
      throw new Error("Couldn't read that workbook. Save it as .xlsx again, or use Export – CSV in NetSuite.");
    }
    let first: ReportRead | null = null;
    for (const ws of workbook.worksheets) {
      const cells = sheetCells(ws);
      if (!cells.length) continue;
      const out = { ...read1099Report(cells, boxes), sheetName: ws.name };
      if (out.report) return out;
      first ??= out;
    }
    return first ?? { report: null, problems: ['That workbook is empty.'] };
  }
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    // text() reads it as UTF-8 and drops the byte order mark Excel puts first.
    const text = await file.text();
    return read1099Report(parseDelimited(text, ext === 'csv' ? ',' : text.includes('\t') ? '\t' : ','), boxes);
  }
  throw new Error(`FleetSuite can't read a ".${ext}" file. Use Export – CSV in NetSuite, or an Excel .xlsx.`);
}

/** The years 2000–2099 a report's title names: the year it's for, most likely. */
export function titleYears(title: readonly string[]): number[] {
  const found = new Set<number>();
  for (const line of title) for (const m of line.matchAll(/(^|\D)(20\d\d)(?!\d)/g)) found.add(Number(m[2]));
  return [...found].sort((a, b) => a - b);
}

// ── Checking what's sent ─────────────────────────────────────────────────────

const isText = (v: unknown): v is string => typeof v === 'string';

/**
 * A report as the 1099s route takes it, checked and rebuilt from only what's
 * kept, or why it's refused. A name, heading or title with nine digits in a
 * row is refused, not cleaned: the page cleans it before sending, so one
 * that still has one didn't come from the page.
 */
export function checkReport(v: unknown): { report: Report1099 & { fileName: string } } | { error: string } {
  if (!v || typeof v !== 'object') return { error: 'No report to keep' };
  const o = v as Record<string, unknown>;
  // Everything sent as text, to refuse it all if any of it has nine digits in a row.
  const raw: string[] = [];
  const text = (s: string) => {
    raw.push(s);
    return scrub(s);
  };
  const list = (x: unknown, max: number): string[] | null => {
    const items = x ?? [];
    if (!Array.isArray(items) || items.length > max || !items.every(isText)) return null;
    return items.map(text).filter(Boolean);
  };
  if (!isText(o.fileName) || !o.fileName.trim()) return { error: "The report's file name is missing" };
  const fileName = text(o.fileName);
  const title = list(o.title, MAX_TITLE);
  if (!title) return { error: "The report's title isn't a list of lines" };
  const leftOut = list(o.leftOut, MAX_LEFT_OUT);
  if (!leftOut) return { error: "The report's left-out headings aren't a list" };

  if (!Array.isArray(o.columns) || !o.columns.length || o.columns.length > MAX_COLUMNS) {
    return { error: `The report needs 1 to ${MAX_COLUMNS} columns of amounts` };
  }
  const columns: ReportColumn[] = [];
  for (const c of o.columns as unknown[]) {
    const col = (c ?? {}) as Record<string, unknown>;
    if (!isText(col.key) || !/^c\d{1,2}$/.test(col.key) || columns.some((x) => x.key === col.key)) return { error: 'A column of amounts has no key of its own' };
    if (!isText(col.header) || !col.header.trim()) return { error: `Column ${col.key} has no heading` };
    if (col.box !== null && (!isText(col.box) || !col.box.trim())) return { error: `Column ${col.key} names no box` };
    columns.push({ key: col.key, header: text(col.header), box: col.box === null ? null : text(col.box) });
  }
  const keys = new Set(columns.map((c) => c.key));

  if (!Array.isArray(o.vendors) || !o.vendors.length || o.vendors.length > MAX_VENDORS) {
    return { error: `The report needs 1 to ${MAX_VENDORS.toLocaleString('en-US')} vendors` };
  }
  const vendors: ReportVendor[] = [];
  for (const [n, x] of (o.vendors as unknown[]).entries()) {
    const r = (x ?? {}) as Record<string, unknown>;
    if (!isText(r.label) || !nameKey(r.label)) return { error: `Vendor ${n + 1} of the report has no name` };
    const names = list(r.names, MAX_NAMES);
    if (!names) return { error: `Vendor ${n + 1}'s other names aren't a list` };
    if (!r.amounts || typeof r.amounts !== 'object' || Array.isArray(r.amounts)) return { error: `Vendor ${n + 1} has no amounts` };
    const amounts: Record<string, number> = {};
    for (const [k, c] of Object.entries(r.amounts as Record<string, unknown>)) {
      if (!keys.has(k)) return { error: `Vendor ${n + 1} has an amount under no column` };
      if (typeof c !== 'number' || !Number.isSafeInteger(c) || Math.abs(c) > MAX_CENTS) return { error: `Vendor ${n + 1} has an amount that isn't whole cents` };
      if (c !== 0) amounts[k] = c;
    }
    vendors.push({ label: text(r.label), names, amounts });
  }

  const s = (o.skipped ?? {}) as Record<string, unknown>;
  const count = (c: unknown) => (typeof c === 'number' && Number.isSafeInteger(c) && c >= 0 ? c : 0);
  if (raw.some(hasNineDigits)) {
    return { error: 'The report has nine digits in a row in a name or heading, which could be a tax ID, so it wasn\'t kept. Upload it from the 1099s page, which takes them out.' };
  }
  return {
    report: {
      fileName, title, columns, leftOut, vendors,
      skipped: { totals: count(s.totals), noName: count(s.noName), combined: count(s.combined) },
    },
  };
}

// ── Side by side ─────────────────────────────────────────────────────────────

export interface Amounts1099 {
  total: number;
  /** By box, FleetSuite's name for each when it has one. */
  boxes: Record<string, number>;
}

/** A vendor in both: NetSuite's report and FleetSuite's totals. */
export interface ComparedVendor {
  /** FleetSuite's: NetSuite's id for the vendor. */
  payee: string;
  name: string;
  legalName: string | null;
  marked: boolean | null;
  /** How the report names it: more than one when it lists the vendor under names that are all this vendor's. */
  labels: string[];
  netsuite: Amounts1099;
  fleetsuite: Amounts1099;
  /** NetSuite's less FleetSuite's, in total and for each box the report has, those that aren't 0. */
  differences: Amounts1099;
  same: boolean;
  /** What FleetSuite couldn't split of what it was paid, a likely reason it differs. */
  unsplit: number;
}

export interface OnlyInReport {
  label: string;
  names: string[];
  netsuite: Amounts1099;
  /** FleetSuite's vendors the report's names fit, when they fit more than one. */
  candidates: string[];
}

export interface Comparison1099 {
  /** The boxes the report has columns for. */
  boxes: string[];
  /** Whether the report has a total; when it hasn't, NetSuite's total is its boxes added up. */
  hasTotal: boolean;
  /** Differing first, the largest difference first; then the same, the largest first. */
  vendors: ComparedVendor[];
  /** In the report, not matched to one of FleetSuite's vendors. */
  onlyInReport: OnlyInReport[];
  /** FleetSuite's 1099s (marked, paid on accounts that count) the report doesn't have. */
  onlyInFleetSuite: Array<{ payee: string; name: string; legalName: string | null; fleetsuite: Amounts1099 }>;
  counts: { same: number; differ: number; onlyInReport: number; onlyInFleetSuite: number };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-US');

/** FleetSuite's payees, each with the names the report could know it by. */
function payeeKeys(p: Payee1099): string[] {
  const names = [p.name, p.legalName ?? '', p.entityId ?? '', p.entityId ? `${p.entityId} ${p.name}` : ''];
  return [...new Set(names.map(nameKey).filter(Boolean))];
}

/**
 * NetSuite's report held against FleetSuite's year, vendor by vendor and box
 * by box. A report vendor is FleetSuite's when its name, or failing that one
 * of its other names, is one of FleetSuite's vendor's names (its name, legal
 * name, NetSuite id, or id and name together), compared without case or
 * punctuation, and fits no other vendor. Failing those, the first word of its
 * name is tried when it has a digit in it, as NetSuite puts a vendor's id
 * before its name ("V1001 Sample Painting" for one FleetSuite knows only as
 * V1001, a person whose company name is blank, say). A box column is compared
 * with the category of the same name; the total with all FleetSuite counted.
 */
export function compare1099(year: Year1099, report: Report1099): Comparison1099 {
  const payees = new Map<string, Payee1099>();
  for (const p of [...year.forms, ...year.notMarked, ...year.nothingCounted, ...year.byCard]) if (!payees.has(p.payee)) payees.set(p.payee, p);
  const index = new Map<string, Set<string>>();
  for (const p of payees.values()) {
    for (const k of payeeKeys(p)) {
      if (!index.has(k)) index.set(k, new Set());
      index.get(k)!.add(p.payee);
    }
  }
  const find = (s: string) => index.get(nameKey(s)) ?? new Set<string>();
  const byId = (label: string) => {
    const first = label.trim().split(/\s+/)[0];
    return /\d/.test(first) ? find(first) : new Set<string>();
  };

  // Each column's box by FleetSuite's name for it when FleetSuite has the category.
  const fleetBoxes = new Map<string, string>();
  for (const a of year.accounts) if (!fleetBoxes.has(boxKey(a.category))) fleetBoxes.set(boxKey(a.category), a.category);
  for (const c of year.categories) if (!fleetBoxes.has(boxKey(c))) fleetBoxes.set(boxKey(c), c);
  const boxOf = (c: ReportColumn) => (c.box === null ? null : fleetBoxes.get(boxKey(c.box)) ?? c.box);
  const boxes = [...new Set(report.columns.map(boxOf).filter((b): b is string => b !== null))];
  const totalColumn = report.columns.find((c) => c.box === null);

  const amountsOf = (v: ReportVendor): Amounts1099 => {
    const out: Amounts1099 = { total: 0, boxes: {} };
    for (const c of report.columns) {
      const cents = v.amounts[c.key] ?? 0;
      const box = boxOf(c);
      if (box !== null) out.boxes[box] = (out.boxes[box] ?? 0) + cents;
    }
    out.total = totalColumn
      ? v.amounts[totalColumn.key] ?? 0
      : Object.values(out.boxes).reduce((n, c) => n + c, 0);
    return out;
  };

  const matched = new Map<string, { labels: string[]; netsuite: Amounts1099 }>();
  const onlyInReport: OnlyInReport[] = [];
  for (const v of report.vendors) {
    const byLabel = find(v.label);
    const byNames = new Set(v.names.flatMap((n) => [...find(n)]));
    let fits: Set<string>;
    if (byLabel.size === 1) fits = byLabel;
    else if (byLabel.size > 1) fits = new Set([...byLabel].filter((p) => byNames.has(p)));
    else fits = byNames.size ? byNames : byId(v.label);
    const amounts = amountsOf(v);
    if (fits.size !== 1) {
      const could = byLabel.size > 1 ? byLabel : fits;
      onlyInReport.push({
        label: v.label,
        names: v.names,
        netsuite: amounts,
        candidates: [...could].map((p) => payees.get(p)!.name).sort((a, b) => a.localeCompare(b, 'en-US')),
      });
      continue;
    }
    const [payee] = fits;
    const seen = matched.get(payee);
    if (!seen) {
      matched.set(payee, { labels: [v.label], netsuite: amounts });
      continue;
    }
    seen.labels.push(v.label);
    seen.netsuite.total += amounts.total;
    for (const [b, c] of Object.entries(amounts.boxes)) seen.netsuite.boxes[b] = (seen.netsuite.boxes[b] ?? 0) + c;
  }

  const vendors: ComparedVendor[] = [...matched].map(([id, m]) => {
    const p = payees.get(id)!;
    const fleetsuite: Amounts1099 = { total: p.total, boxes: Object.fromEntries(boxes.map((b) => [b, p.boxes[b] ?? 0])) };
    const differences: Amounts1099 = { total: m.netsuite.total - p.total, boxes: {} };
    for (const b of boxes) {
      const d = (m.netsuite.boxes[b] ?? 0) - (p.boxes[b] ?? 0);
      if (d !== 0) differences.boxes[b] = d;
    }
    return {
      payee: id,
      name: p.name,
      legalName: p.legalName,
      marked: p.marked,
      labels: m.labels,
      netsuite: m.netsuite,
      fleetsuite,
      differences,
      same: differences.total === 0 && !Object.keys(differences.boxes).length,
      unsplit: p.unsplit,
    };
  });
  const biggestDifference = (v: ComparedVendor) => Math.max(Math.abs(v.differences.total), ...Object.values(v.differences.boxes).map(Math.abs));
  vendors.sort((a, b) => Number(a.same) - Number(b.same)
    || (a.same ? b.netsuite.total - a.netsuite.total : biggestDifference(b) - biggestDifference(a))
    || byName(a, b));
  onlyInReport.sort((a, b) => b.netsuite.total - a.netsuite.total || a.label.localeCompare(b.label, 'en-US'));

  const onlyInFleetSuite = year.forms
    .filter((p) => !matched.has(p.payee))
    .map((p) => ({ payee: p.payee, name: p.name, legalName: p.legalName, fleetsuite: { total: p.total, boxes: { ...p.boxes } } }))
    .sort((a, b) => b.fleetsuite.total - a.fleetsuite.total || byName(a, b));

  const same = vendors.filter((v) => v.same).length;
  return {
    boxes,
    hasTotal: !!totalColumn,
    vendors,
    onlyInReport,
    onlyInFleetSuite,
    counts: { same, differ: vendors.length - same, onlyInReport: onlyInReport.length, onlyInFleetSuite: onlyInFleetSuite.length },
  };
}
