/**
 * Filing the 1099s (part 70, no migration, docs/books.md "Filing the 1099s";
 * the NetSuite Exit Checklist's "1099s and e-filing", thread "Replacing
 * NetSuite with FleetSuite", 2026-10-31): who gets a 1099 for a year, from
 * part 50's totals (src/lib/books/1099s.ts) under that year's minimums, each
 * on its form and in its boxes; each one's name and address as NetSuite has
 * them now; and the IRS's own upload template for IRIS, its e-file portal,
 * filled in with them.
 *
 * Tax IDs stay on the device. The payer's is typed on the page; a payee's is
 * typed there, or read there from a NetSuite export picked on it (NetSuite's
 * 1099 report, or a vendor list with the Tax ID column), and checked against
 * the four digits NetSuite has it ending with, the only part of it FleetSuite
 * ever sees (src/lib/vendor-details.ts). They go only into the file saved on
 * the device: never to FleetSuite, never kept, never shown whole but as
 * they're typed.
 *
 * The template is the IRS's own, downloaded from IRIS for the form and year
 * and dropped on the page, so the file has exactly its headings, which IRIS
 * insists on. Each heading is read for what goes under it (`readHeadings`),
 * and can be changed on the page.
 *
 * Nothing is sent to the IRS: the file is uploaded in IRIS by hand, where
 * each form is checked before it's filed.
 *
 * Client-safe and pure but for reading files. Amounts are whole cents.
 */

import { parseDelimited, sheetCells } from '@/lib/import-installs-parse';
import { billingLine, parseDetailsVendor } from '@/lib/vendor-details';
import type { Year1099 } from './1099s';
import { boxKey, nameHeading, nameKey, payeeFinder, STANDARD_BOXES, words, yearPayees } from './1099-report';

export type Form1099 = 'NEC' | 'MISC';
export const FORMS: readonly Form1099[] = ['NEC', 'MISC'];
export const FORM_TITLE: Record<Form1099, string> = { NEC: '1099-NEC', MISC: '1099-MISC' };

const usd = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// ── Minimums ─────────────────────────────────────────────────────────────────

export interface Minimum {
  /** Whole cents. */
  cents: number;
  /** False for a year whose amount isn't put in here yet: the last one known is used. */
  known: boolean;
}

/** The first year the IRS raises the $2,000 for inflation. */
const RAISED_FROM = 2027;

/**
 * The minimum for nonemployee compensation, rents, other income and medical
 * payments, by the year paid: $600 up to 2025, $2,000 from 2026 (the One Big
 * Beautiful Bill Act, section 70433), raised for inflation each year from
 * 2027. Each year's raised amount goes in here as the IRS gives it; until
 * then the last one known is used, which can only give a 1099 to someone paid
 * just under that year's real minimum, never leave one out.
 */
const MINIMUM_FROM: ReadonlyArray<readonly [year: number, cents: number]> = [[0, 600_00], [2026, 2000_00]];

export function minimumFor(year: number): Minimum {
  let cents = 0;
  let from = 0;
  for (const [y, c] of MINIMUM_FROM) {
    if (y <= year) {
      cents = c;
      from = y;
    }
  }
  return { cents, known: year < RAISED_FROM || from === year };
}

const fixed = (cents: number) => (): Minimum => ({ cents, known: true });

/** A box FleetSuite fills in, for one of NetSuite's 1099-MISC categories. */
export interface FiledBox {
  /** NetSuite's category for the accounts paid on. */
  category: string;
  form: Form1099;
  /** Its number on the form. */
  box: string;
  /** As the form names it. */
  label: string;
  /** The least paid in it in a year that makes the form due. */
  minimum: (year: number) => Minimum;
}

/**
 * The boxes FleetSuite fills in. Royalties keep their $10 and an attorney's
 * gross proceeds their $600. A payee with anything in another category (tax
 * withheld, fishing boat proceeds...) is left to be filed by hand: the form
 * it goes on, and what else goes with it, aren't FleetSuite's to guess.
 */
export const FILED_BOXES: readonly FiledBox[] = [
  { category: 'Nonemployee Compensation', form: 'NEC', box: '1', label: 'Nonemployee compensation', minimum: minimumFor },
  { category: 'Rents', form: 'MISC', box: '1', label: 'Rents', minimum: minimumFor },
  { category: 'Royalties', form: 'MISC', box: '2', label: 'Royalties', minimum: fixed(10_00) },
  { category: 'Other Income', form: 'MISC', box: '3', label: 'Other income', minimum: minimumFor },
  { category: 'Medical and Health Care Payments', form: 'MISC', box: '6', label: 'Medical and health care payments', minimum: minimumFor },
  { category: 'Gross Proceeds Paid to an Attorney', form: 'MISC', box: '10', label: 'Gross proceeds paid to an attorney', minimum: fixed(600_00) },
];

const BY_CATEGORY = new Map(FILED_BOXES.map((b) => [boxKey(b.category), b]));

/** The box FleetSuite fills in for a NetSuite category, compared as part 51 compares a report's headings; null for none. */
export const filedBox = (category: string): FiledBox | null => BY_CATEGORY.get(boxKey(category)) ?? null;

/** A box of a form by its number. */
export const boxOf = (form: Form1099, box: string): FiledBox | null => FILED_BOXES.find((b) => b.form === form && b.box === box) ?? null;

// ── Who gets a 1099 ──────────────────────────────────────────────────────────

export interface DueForm {
  form: Form1099;
  payee: string;
  name: string;
  legalName: string | null;
  /** Whole cents by box number, each over 0. */
  boxes: Record<string, number>;
  total: number;
}

/** Paid in a form's boxes, under the minimums: no form. */
export interface UnderMinimum {
  payee: string;
  name: string;
  form: Form1099;
  total: number;
}

/** Marked to get a 1099 and paid on accounts that count, and left for someone to file by hand. */
export interface ByHand {
  payee: string;
  name: string;
  total: number;
  why: string;
}

export interface Due1099 {
  year: number;
  /** The minimum for most boxes. */
  minimum: Minimum;
  /** By form, then name. */
  forms: DueForm[];
  /** The largest first. */
  under: UnderMinimum[];
  byHand: ByHand[];
  /** Why no file can be made for the year yet. */
  blockers: string[];
  counts: Record<Form1099, number>;
}

/**
 * Who gets which 1099 for `taxYear` from part 50's year: each vendor marked to
 * get one and paid on the accounts that count, its categories put in the
 * boxes FleetSuite fills in. A form is due when one of its boxes reaches the
 * box's minimum, and then has every box paid in. Left to be filed by hand: a
 * payee FleetSuite couldn't split some of what it was paid (its boxes may be
 * short), one paid in a category FleetSuite doesn't fill in, and one with a
 * box below nothing.
 */
export function due1099(year: Year1099, taxYear: number, opts: { yearOver: boolean }): Due1099 {
  const forms: DueForm[] = [];
  const under: UnderMinimum[] = [];
  const byHand: ByHand[] = [];
  for (const p of year.forms) {
    const hand = (why: string) => byHand.push({ payee: p.payee, name: p.name, total: p.total, why });
    if (p.unsplit !== 0) {
      hand(`FleetSuite can't split ${usd(p.unsplit)} of what it was paid, so its boxes may be short.`);
      continue;
    }
    const others: string[] = [];
    const byForm = new Map<Form1099, Record<string, number>>();
    for (const [category, cents] of Object.entries(p.boxes)) {
      if (cents === 0) continue;
      const b = filedBox(category);
      if (!b) {
        others.push(category);
        continue;
      }
      const boxes = byForm.get(b.form) ?? {};
      boxes[b.box] = (boxes[b.box] ?? 0) + cents;
      byForm.set(b.form, boxes);
    }
    if (others.length) {
      hand(`It was paid in ${others.join(' and ')}, which FleetSuite doesn't fill in.`);
      continue;
    }
    const belowNothing = [...byForm].flatMap(([form, boxes]) =>
      Object.entries(boxes).filter(([, c]) => c < 0).map(([box]) => boxOf(form, box)!.label.toLowerCase()));
    if (belowNothing.length) {
      hand(`Its ${belowNothing.join(' and ')} ${belowNothing.length === 1 ? 'comes' : 'come'} to less than nothing.`);
      continue;
    }
    for (const form of FORMS) {
      const boxes = byForm.get(form);
      if (!boxes) continue;
      const total = Object.values(boxes).reduce((n, c) => n + c, 0);
      const due = Object.entries(boxes).some(([box, c]) => c >= boxOf(form, box)!.minimum(taxYear).cents);
      if (due) forms.push({ form, payee: p.payee, name: p.name, legalName: p.legalName, boxes, total });
      else under.push({ payee: p.payee, name: p.name, form, total });
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-US');
  forms.sort((a, b) => FORMS.indexOf(a.form) - FORMS.indexOf(b.form) || byName(a, b));
  under.sort((a, b) => b.total - a.total || byName(a, b));
  byHand.sort(byName);

  const blockers: string[] = [];
  if (!opts.yearOver) blockers.push(`${taxYear} isn't over yet, so who gets a 1099 can still change. Make the file in January.`);
  if (year.notCopied.length) {
    blockers.push(`${plural(year.notCopied.length, 'check or bill payment', 'checks and bill payments')} for ${taxYear} ${year.notCopied.length === 1 ? "isn't" : "aren't"} in FleetSuite's copies yet, so the totals may be short. The copies run every two hours.`);
  }
  if (!year.flagsCopied) blockers.push("NetSuite's vendors haven't been copied with their 1099 flags yet, so FleetSuite doesn't know who gets one.");
  return {
    year: taxYear,
    minimum: minimumFor(taxYear),
    forms,
    under,
    byHand,
    blockers,
    counts: { NEC: forms.filter((f) => f.form === 'NEC').length, MISC: forms.filter((f) => f.form === 'MISC').length },
  };
}

// ── Names and addresses, as NetSuite has them now ────────────────────────────

/** A payee as it goes on its 1099: read live from NetSuite's vendor record, its tax ID only as the four digits it ends with. */
export interface PayeeDetails {
  payee: string;
  person: boolean;
  /** A person's names. */
  first: string;
  middle: string;
  last: string;
  /** A company's legal name, or its name when NetSuite has no legal name; blank for a person. */
  business: string;
  /** A company's name when its legal name differs: what it does business as. */
  business2: string;
  address1: string;
  address2: string;
  city: string;
  /** Two letters. */
  state: string;
  /** Five or nine digits. */
  zip: string;
  hasTaxId: boolean | null;
  taxIdEnding: string | null;
  /** Why it can't go on the file as it is. */
  problems: string[];
  /** Worth knowing, without stopping it. */
  notes: string[];
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** What `payee`'s vendor record from NetSuite's REST GET says for its 1099, and what stops it going on the file. */
export function payeeDetails(payee: string, record: unknown): PayeeDetails {
  const v = parseDetailsVendor(record);
  const r = (record ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const notes: string[] = [];
  const first = text(r.firstName);
  const middle = text(r.middleName);
  const last = text(r.lastName);
  const company = text(r.companyName);
  let business = '';
  let business2 = '';
  if (v.isPerson) {
    if (!first || !last) problems.push("NetSuite doesn't have this person's first and last name.");
  } else {
    business = v.legalName || company;
    business2 = v.legalName && company && nameKey(company) !== nameKey(v.legalName) ? company : '';
    if (!business) problems.push('NetSuite has no company or legal name for it.');
  }

  const line = billingLine(v);
  let state = '';
  let zip = '';
  if (!line) {
    problems.push(v.addresses.length ? 'It has more than one address and none is its billing address.' : 'NetSuite has no address for it.');
  } else if (line.country && line.country !== 'US') {
    problems.push('Its billing address is outside the US: file it by hand in IRIS.');
  } else {
    if (!streetLine(line.addr1)) problems.push('Its billing address has no street.');
    if (!cityName(line.city)) problems.push('Its billing address has no city.');
    state = stateCode(line.state) ?? '';
    if (!state) problems.push(line.state ? `Its billing address's state, ${line.state}, isn't a US state.` : 'Its billing address has no state.');
    zip = zipOf(line.zip) ?? '';
    if (!zip) problems.push(line.zip ? `Its billing address's ZIP, ${line.zip}, isn't 5 or 9 digits.` : 'Its billing address has no ZIP.');
  }

  if (v.hasTaxId === false) problems.push('NetSuite has no tax ID for it: ask for its W-9 and put the tax ID in Vendor Details.');
  else if (!v.taxIdEnding) notes.push("NetSuite didn't say what its tax ID ends with, so the one used can't be checked against it.");
  if (v.is1099 === false) problems.push("NetSuite doesn't mark it to get a 1099 any more.");

  return {
    payee,
    person: v.isPerson,
    first,
    middle,
    last,
    business,
    business2,
    address1: line?.addr1 ?? '',
    address2: line?.addr2 ?? '',
    city: line?.city ?? '',
    state,
    zip,
    hasTaxId: v.hasTaxId,
    taxIdEnding: v.taxIdEnding,
    problems,
    notes,
  };
}

/** The name on its form, on one line. */
export function formName(d: PayeeDetails): string {
  return d.person ? [d.first, d.middle, d.last].filter(Boolean).join(' ') : d.business;
}

// ── Tax IDs, only ever on the device ─────────────────────────────────────────

export type TinType = 'EIN' | 'SSN' | 'ITIN';
export const TIN_TYPES: readonly TinType[] = ['EIN', 'SSN', 'ITIN'];

export interface Tin {
  /** Its nine digits. */
  digits: string;
  /** How it was written: 12-3456789 an EIN, 123-45-6789 an SSN (an ITIN when it starts with 9); null for nine digits alone. */
  looks: TinType | null;
}

/** A tax ID as typed or read: nine digits, as 12-3456789, 123-45-6789 or 123456789. Null when it isn't one. */
export function readTin(raw: string): Tin | null {
  const v = raw.replace(/\s/g, '');
  let tin: Tin;
  if (/^\d{2}-\d{7}$/.test(v)) tin = { digits: v.replace('-', ''), looks: 'EIN' };
  else if (/^\d{3}-\d{2}-\d{4}$/.test(v)) tin = { digits: v.replace(/-/g, ''), looks: v.startsWith('9') ? 'ITIN' : 'SSN' };
  else if (/^\d{9}$/.test(v)) tin = { digits: v, looks: null };
  else return null;
  // Not one the IRS gives: all one digit, or 123456789.
  if (/^(\d)\1{8}$/.test(tin.digits) || tin.digits === '123456789') return null;
  return tin;
}

/** The type it's filed as: as it was written, else a person's an SSN (an ITIN when it starts with 9) and a company's an EIN. */
export function tinTypeOf(tin: Tin, person: boolean): TinType {
  if (tin.looks) return tin.looks;
  return person ? (tin.digits.startsWith('9') ? 'ITIN' : 'SSN') : 'EIN';
}

/** All of a tax ID that's ever shown: dots and the four digits it ends with. */
export const maskedTin = (digits: string) => `•••••${digits.slice(-4)}`;

/** A typed or read tax ID held against the four digits NetSuite has it ending with. */
export function checkTin(tin: Tin | null | undefined, details: PayeeDetails | null | undefined): { ok: boolean; why: string } {
  if (!tin) return { ok: false, why: 'No tax ID yet: type it, or drop a NetSuite export with it.' };
  if (!details) return { ok: false, why: 'Check it in NetSuite first.' };
  if (!details.taxIdEnding) return { ok: true, why: `Ends ${tin.digits.slice(-4)}. NetSuite didn't say what its ends with.` };
  if (tin.digits.slice(-4) !== details.taxIdEnding) {
    return { ok: false, why: `It ends ${tin.digits.slice(-4)}, and the one NetSuite has ends ${details.taxIdEnding}.` };
  }
  return { ok: true, why: `Ends ${details.taxIdEnding}, as NetSuite's does.` };
}

/** A heading for a tax ID: Tax ID, TIN, SSN, EIN, Federal ID, Taxpayer ID Number... */
export function isTinHeading(h: string): boolean {
  const w = words(h);
  if (w.some((x) => x === 'tin' || x === 'ssn' || x === 'ein' || x === 'fein' || x === 'itin')) return true;
  return w.some((x) => x === 'tax' || x === 'taxpayer' || x === 'federal')
    && w.some((x) => x === 'id' || x === 'identification' || x === 'number' || x === 'no' || x === 'num');
}

/** A tax ID as NetSuite masks one, ***-**-6789: four digits at most, behind stars or Xs. */
const looksMasked = (s: string) => /[*xX•#]/.test(s) && (s.match(/\d/g)?.length ?? 0) <= 4;

/** A row of a NetSuite export with a vendor and its tax ID. */
export interface TinRow {
  label: string;
  names: string[];
  tin: Tin;
}

export interface TinRead {
  rows: TinRow[];
  /** The heading of the column read as the tax ID. */
  column: string | null;
  /** Rows whose tax ID was masked (***-**-6789) or isn't nine digits. */
  unreadable: number;
  /** Tax IDs that had lost a leading 0, as Excel drops them from numbers, and were given it back. */
  padded: number;
  problems: string[];
}

const MAX_TIN_ROWS = 5000;

/**
 * The vendors and tax IDs in a NetSuite export, read on the device it's picked
 * on: the headings are the first row, within the first 30, naming the vendor
 * (as part 51 reads them) and its tax ID; failing a tax ID heading, a column
 * whose every filled cell is one.
 */
export function readTaxIds(cells: string[][]): TinRead {
  const cell = (row: string[], i: number) => (row[i] ?? '').trim();
  let at = -1;
  let labelAt = -1;
  let tinAt = -1;
  let namesAt: number[] = [];
  for (let r = 0; r < Math.min(cells.length, 30) && at === -1; r++) {
    const kinds = cells[r].map(nameHeading);
    const vendorAt = kinds.indexOf('vendor');
    const label = vendorAt !== -1 ? vendorAt : kinds.indexOf('name');
    if (label === -1) continue;
    let tin = cells[r].findIndex((h, i) => i !== label && isTinHeading(h));
    if (tin === -1) {
      const body = cells.slice(r + 1);
      tin = cells[r].findIndex((_, i) => i !== label
        && body.some((row) => readTin(cell(row, i)))
        && body.every((row) => !cell(row, i) || readTin(cell(row, i)) || looksMasked(cell(row, i))));
    }
    if (tin === -1) continue;
    at = r;
    labelAt = label;
    tinAt = tin;
    namesAt = kinds.flatMap((k, i) => (k && i !== label && i !== tin ? [i] : []));
  }
  if (at === -1) {
    return {
      rows: [], column: null, unreadable: 0, padded: 0,
      problems: ["Couldn't find a vendor and its tax ID in the file: a row of headings naming the vendor (Vendor, Name...) and its Tax ID."],
    };
  }
  const rows: TinRow[] = [];
  let unreadable = 0;
  let padded = 0;
  for (const row of cells.slice(at + 1)) {
    const label = cell(row, labelAt);
    const raw = cell(row, tinAt);
    if (!label || !raw) continue;
    let tin = readTin(raw);
    if (!tin && /^\d{7,8}$/.test(raw)) {
      tin = readTin(raw.padStart(9, '0'));
      if (tin) padded++;
    }
    if (!tin) {
      unreadable++;
      continue;
    }
    rows.push({ label, names: namesAt.map((i) => cell(row, i)).filter(Boolean), tin });
  }
  const problems: string[] = [];
  if (!rows.length) {
    problems.push(unreadable
      ? `None of its ${plural(unreadable, 'tax ID is', 'tax IDs is')} nine digits: NetSuite may have given them masked, as ***-**-6789. Type them instead.`
      : 'It lists no tax IDs.');
  }
  if (rows.length > MAX_TIN_ROWS) problems.push(`It lists ${plural(rows.length, 'vendor', 'vendors')}; FleetSuite reads up to ${MAX_TIN_ROWS.toLocaleString('en-US')}.`);
  return { rows: problems.length ? [] : rows, column: cells[at][tinAt].trim() || null, unreadable, padded, problems };
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Reads a NetSuite export (.csv, .tsv or .xlsx) for tax IDs, on the device it's picked on. Throws an Error to show. */
export async function readTaxIdFile(file: File): Promise<TinRead> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is too big. Export just the vendors with their tax IDs, as CSV.');
  if (ext === 'xls') throw new Error("That's an old .xls file FleetSuite can't read. Use Export – CSV in NetSuite, or save it as .xlsx in Excel.");
  if (ext === 'xlsx' || ext === 'xlsm') {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(await file.arrayBuffer());
    } catch {
      throw new Error("Couldn't read that workbook. Save it as .xlsx again, or use Export – CSV in NetSuite.");
    }
    let first: TinRead | null = null;
    for (const ws of workbook.worksheets) {
      const cells = sheetCells(ws);
      if (!cells.length) continue;
      const read = readTaxIds(cells);
      if (read.rows.length) return read;
      first ??= read;
    }
    return first ?? { rows: [], column: null, unreadable: 0, padded: 0, problems: ['That workbook is empty.'] };
  }
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const t = await file.text();
    return readTaxIds(parseDelimited(t, ext === 'csv' ? ',' : t.includes('\t') ? '\t' : ','));
  }
  throw new Error(`FleetSuite can't read a ".${ext}" file. Use Export – CSV in NetSuite, or an Excel .xlsx.`);
}

export interface TinsFound {
  /** The tax ID the export gives each payee getting a 1099. */
  byPayee: Map<string, Tin>;
  /** Payees it gives two different tax IDs: neither is used. */
  twice: string[];
  /** Rows not for anyone getting a 1099, or that fit more than one payee. */
  unmatched: number;
}

/** Whose tax ID each row holds, found among the year's payees by part 51's rule (`payeeFinder`), for those in `due`. */
export function matchTins(read: TinRead, year: Year1099, due: ReadonlySet<string>): TinsFound {
  const fit = payeeFinder(yearPayees(year).values());
  const byPayee = new Map<string, Tin>();
  const twice = new Set<string>();
  let unmatched = 0;
  for (const r of read.rows) {
    const { payee } = fit(r.label, r.names);
    if (payee === null || !due.has(payee)) {
      unmatched++;
      continue;
    }
    const seen = byPayee.get(payee);
    if (!seen) byPayee.set(payee, r.tin);
    else if (seen.digits !== r.tin.digits) twice.add(payee);
  }
  for (const p of twice) byPayee.delete(p);
  return { byPayee, twice: [...twice], unmatched };
}

// ── What the IRS takes ───────────────────────────────────────────────────────

const ascii = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A name line as the IRS takes one: letters, digits, & - ( ) ' and single spaces; periods and commas dropped, other marks a space. */
export const nameLine = (s: string) => tidy(ascii(s).replace(/[.,]/g, '').replace(/[^A-Za-z0-9&\-()' ]/g, ' '));
/** A person's name: letters, hyphens, apostrophes and single spaces. */
export const personName = (s: string) => tidy(ascii(s).replace(/[.,]/g, '').replace(/[^A-Za-z\-' ]/g, ' '));
/** A street line: letters, digits, hyphens, slashes and single spaces; periods, commas and # dropped. */
export const streetLine = (s: string) => tidy(ascii(s).replace(/[.,#]/g, '').replace(/[^A-Za-z0-9\-/ ]/g, ' '));
/** A city: letters and single spaces, so St. Louis as St Louis and O'Fallon as O Fallon. */
export const cityName = (s: string) => tidy(ascii(s).replace(/[^A-Za-z]/g, ' '));

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', districtofcolumbia: 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', newhampshire: 'NH', newjersey: 'NJ', newmexico: 'NM', newyork: 'NY',
  northcarolina: 'NC', northdakota: 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  rhodeisland: 'RI', southcarolina: 'SC', southdakota: 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', westvirginia: 'WV', wisconsin: 'WI', wyoming: 'WY',
  americansamoa: 'AS', guam: 'GU', northernmarianaislands: 'MP', puertorico: 'PR', virginislands: 'VI', usvirginislands: 'VI',
  armedforcesamericas: 'AA', armedforceseurope: 'AE', armedforcespacific: 'AP',
};
const STATE_CODES = new Set(Object.values(STATES));

/** A US state, territory or military post office as its two letters: MO, Missouri; null for none. */
export function stateCode(s: string): string | null {
  const t = s.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return STATE_CODES.has(t.toUpperCase()) ? t.toUpperCase() : null;
  return STATES[t.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

/** A ZIP as its five or nine digits; null when it isn't one. */
export function zipOf(s: string): string | null {
  const d = s.replace(/[\s-]/g, '');
  return /^\d{5}(\d{4})?$/.test(d) ? d : null;
}

/** A US phone number as its ten digits; null when it isn't one. */
export function phoneOf(s: string): string | null {
  const d = s.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? ten : null;
}

/** Whole cents as the IRS takes an amount: 1234.56, no $ or commas. */
export function amountText(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// ── The IRS's template ───────────────────────────────────────────────────────

/** The IRS's upload template for one form and year, as downloaded from IRIS. */
export interface Template {
  name: string;
  /** The file's text up to the end of its headings' row, exactly as it came. */
  head: string;
  headings: string[];
  /** Rows under the headings: an example, maybe. They aren't written to the file. */
  below: string[][];
  newline: '\r\n' | '\n';
  /** It started with a byte order mark, so the file does too. */
  bom: boolean;
}

/** CSV records, each with the offset in the text where it ends, after its line ending. Quotes as Excel writes them. */
export function csvRecords(t: string): Array<{ cells: string[]; end: number }> {
  const out: Array<{ cells: string[]; end: number }> = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        quoted = false;
        i++;
      } else {
        field += ch;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      field = '';
      i += ch === '\r' && t[i + 1] === '\n' ? 2 : 1;
      out.push({ cells: row, end: i });
      row = [];
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push({ cells: row, end: t.length });
  }
  return out;
}

export type Party = 'payer' | 'recipient';
export const PARTY_FIELDS = [
  'tinType', 'tin', 'name1', 'name2', 'first', 'middle', 'last', 'suffix', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'phone', 'email',
] as const;
export type PartyField = (typeof PARTY_FIELDS)[number];

/** What goes in a column of the template, in every row. */
export type ColumnFill =
  /** Left blank. `read` when FleetSuite knows the column: a box it doesn't fill, a checkbox; false when it couldn't tell what it is. */
  | { kind: 'blank'; read: boolean }
  | { kind: 'form' }
  | { kind: 'year' }
  /** NetSuite's id for the vendor, as the payer's account number for it. */
  | { kind: 'account' }
  | { kind: 'party'; party: Party; field: PartyField }
  | { kind: 'box'; box: string }
  /** Typed on the page: the same in every row. */
  | { kind: 'same'; value: string };

const PAYER_WORDS = new Set(['payer', 'payers', 'filer', 'filers', 'issuer', 'issuers']);
const RECIPIENT_WORDS = new Set(['recipient', 'recipients', 'payee', 'payees']);

// Boxes of either form FleetSuite knows and, unless they're the form's own filled boxes, leaves blank.
const KNOWN_BOXES = new Set([...STANDARD_BOXES, ...FILED_BOXES.map((b) => b.label)].map(boxKey));

const BLANK: ColumnFill = { kind: 'blank', read: true };

/** A party's field a heading names, by its words; 'blank' for one known and left blank; null for none. */
function partyField(w: string[]): PartyField | 'blank' | null {
  const has = (...xs: string[]) => xs.some((x) => w.includes(x));
  if (has('state') && has('no', 'number', 'id', 'identification', 'income', 'tax')) return 'blank';
  if (has('tin', 'taxpayer') && has('type')) return 'tinType';
  if (has('type')) return 'blank';
  if (has('tin', 'ssn', 'ein', 'fein', 'itin') || (has('tax', 'taxpayer', 'federal') && has('id', 'identification', 'number', 'no', 'num'))) return 'tin';
  if (has('email') || (has('e') && has('mail'))) return 'email';
  if (has('phone', 'telephone')) return 'phone';
  if (has('country')) return 'country';
  if (has('zip', 'zipcode', 'postal')) return 'zip';
  if (has('city', 'town')) return 'city';
  if (has('state', 'province', 'territory')) return 'state';
  const second = has('2', 'two', 'second', '2nd');
  if (has('address', 'street')) return second ? 'address2' : 'address1';
  if (has('first')) return 'first';
  if (has('middle')) return 'middle';
  if (has('last', 'surname')) return 'last';
  if (has('suffix')) return 'suffix';
  if (has('name', 'business', 'entity', 'company')) return second ? 'name2' : 'name1';
  return null;
}

/**
 * What goes under each of the template's headings, for `form`. A box is
 * known by what it's for, without "Box 1" or "Amount" (part 51's `boxKey`):
 * one FleetSuite fills in gets its amounts, any other is left blank; a
 * heading naming only its box's number, or a cut-short name with its number,
 * is matched by the number. A party's field is known by its words (Recipient
 * TIN, Payer City...); a heading naming no party is the party before it's,
 * or the recipient's when none is before it. Checkboxes, codes and state
 * boxes are left blank, as is a heading FleetSuite can't read.
 */
export function readHeadings(headings: readonly string[], form: Form1099): ColumnFill[] {
  const own = FILED_BOXES.filter((b) => b.form === form);
  const fits = (key: string, b: FiledBox) => {
    const k = boxKey(b.label);
    return k.startsWith(key) || key.startsWith(k);
  };
  let context: Party = 'recipient';
  return headings.map((h): ColumnFill => {
    const w = words(h);
    if (!w.length) return { kind: 'blank', read: false };
    const has = (...xs: string[]) => xs.some((x) => w.includes(x));

    const key = boxKey(h);
    const exact = key ? own.find((b) => boxKey(b.category) === key || boxKey(b.label) === key) : undefined;
    if (exact) return { kind: 'box', box: exact.box };
    if (key && KNOWN_BOXES.has(key)) return BLANK;
    const number = h.match(/\bbox\s*(\d{1,2}[a-z]?)\b/i)?.[1]?.toLowerCase();
    if (number !== undefined) {
      const b = own.find((x) => x.box === number && (!key || fits(key, x)));
      return b ? { kind: 'box', box: b.box } : BLANK;
    }
    if (key.length >= 8) {
      const b = own.find((x) => fits(key, x));
      if (b) return { kind: 'box', box: b.box };
    }

    if (has('form') && (has('type') || w.length === 1)) return { kind: 'form' };
    if (has('year')) return { kind: 'year' };
    if (has('account')) return { kind: 'account' };
    if (has('notice', 'fatca', 'corrected', 'correction', 'void', 'indicator', 'control', 'withheld', 'office', 'combined', 'filing')) return BLANK;
    if (has('foreign') && !has('country')) return BLANK;

    const named = w.find((x) => PAYER_WORDS.has(x) || RECIPIENT_WORDS.has(x));
    const party: Party = named ? (PAYER_WORDS.has(named) ? 'payer' : 'recipient') : context;
    const field = partyField(w);
    if (field === 'blank') return BLANK;
    if (field === null) return { kind: 'blank', read: false };
    if (named) context = party;
    return { kind: 'party', party, field };
  });
}

const MAX_TEMPLATE_BYTES = 1024 * 1024;

/**
 * The IRS's template from its text: the headings are the first row, within
 * the first ten, with at least three columns read as something to fill in,
 * one of them the recipient's.
 */
export function readTemplate(t: string, name: string, bom: boolean): { template: Template | null; problems: string[] } {
  const records = csvRecords(t);
  for (let r = 0; r < Math.min(records.length, 10); r++) {
    const headings = records[r].cells;
    const fills = readHeadings(headings, 'NEC');
    const filled = fills.filter((f) => f.kind !== 'blank');
    if (filled.length < 3 || !fills.some((f) => f.kind === 'party' && f.party === 'recipient')) continue;
    const newline = t.includes('\r\n') ? '\r\n' : '\n';
    const head = t.slice(0, records[r].end);
    return {
      template: {
        name,
        head: /\r?\n$/.test(head) ? head : head + newline,
        headings: headings.map((h) => h.trim()),
        below: records.slice(r + 1).map((x) => x.cells).filter((cells) => cells.some((c) => c.trim())),
        newline,
        bom,
      },
      problems: [],
    };
  }
  return {
    template: null,
    problems: ["Couldn't find the template's headings: a row naming the recipient's tax ID, name and address. Use the CSV template IRIS gives for the form."],
  };
}

/** Reads the IRS's template (.csv) on the device it's picked on. Throws an Error to show. */
export async function readTemplateFile(file: File): Promise<{ template: Template | null; problems: string[] }> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext !== 'csv') throw new Error("IRIS's templates are .csv files: download the form's CSV template in IRIS and drop that.");
  if (file.size > MAX_TEMPLATE_BYTES) throw new Error("That's too big for one of IRIS's templates.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  // TextDecoder takes a byte order mark off.
  return readTemplate(new TextDecoder('utf-8').decode(bytes), file.name, bom);
}

// ── Filling it in ────────────────────────────────────────────────────────────

/** The payer, as typed on the page. */
export interface Payer {
  /** Its legal name. */
  name: string;
  name2: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
  /** Its EIN as typed: only ever on the device. */
  tin: string;
}

/** What's wrong with the payer as typed. */
export function payerProblems(p: Payer): string[] {
  const problems: string[] = [];
  if (!readTin(p.tin)) problems.push("Type the payer's EIN: nine digits, as 12-3456789.");
  if (!nameLine(p.name)) problems.push("The payer's legal name is blank.");
  if (!streetLine(p.address1)) problems.push("The payer's street is blank.");
  if (!cityName(p.city)) problems.push("The payer's city is blank.");
  if (!stateCode(p.state)) problems.push("The payer's state isn't a US state.");
  if (!zipOf(p.zip)) problems.push("The payer's ZIP isn't 5 or 9 digits.");
  if (p.phone.trim() && !phoneOf(p.phone)) problems.push("The payer's phone isn't 10 digits.");
  return problems;
}

/** A form that goes in the file: who, its boxes, its name and address as NetSuite has them, and its tax ID from the device. */
export interface FileRow {
  form: DueForm;
  details: PayeeDetails;
  tin: Tin;
  tinType: TinType;
}

export interface FileOptions {
  /** Tax IDs and ZIP+4s with their dashes (12-3456789, 63366-1234); without them when false. */
  dashes: boolean;
}

/**
 * Forms in a file: IRIS took up to 100 in a CSV file, and up to 250 from the
 * 2026 filing season (its working group, August 2025), so 100 is within both.
 */
export const FORMS_PER_FILE = 100;

/** What the template's example row, when it has one, says the form and the tax ID types are called. */
function vocabulary(t: Template, fills: readonly ColumnFill[], form: Form1099) {
  let formText = FORM_TITLE[form];
  let tinTypes: Record<TinType, string> = { EIN: 'EIN', SSN: 'SSN', ITIN: 'ITIN' };
  let problem: string | null = null;
  const example = t.below[0];
  if (example) {
    fills.forEach((f, i) => {
      const v = (example[i] ?? '').trim();
      if (!v) return;
      if (f.kind === 'form') {
        if (new RegExp(form, 'i').test(v)) formText = v;
        else if (/nec|misc/i.test(v)) problem = `The template's example is a ${v} form, and this is the ${FORM_TITLE[form]} file: use the ${FORM_TITLE[form]} template.`;
      }
      if (f.kind === 'party' && f.field === 'tinType' && /business|individual/i.test(v)) {
        tinTypes = { EIN: 'BUSINESS_TIN', SSN: 'INDIVIDUAL_TIN', ITIN: 'INDIVIDUAL_TIN' };
      }
    });
  }
  return { formText, tinTypes, problem };
}

const tinText = (digits: string, type: TinType, dashes: boolean) => {
  if (!dashes) return digits;
  return type === 'EIN' ? `${digits.slice(0, 2)}-${digits.slice(2)}` : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
};
const zipText = (zip: string, dashes: boolean) => (dashes && zip.length === 9 ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip);

/** What goes under one column for one form. */
function cellValue(f: ColumnFill, row: FileRow, ctx: {
  form: Form1099; year: number; payer: Payer; opts: FileOptions; formText: string; tinTypes: Record<TinType, string>; personNames: boolean;
}): string {
  switch (f.kind) {
    case 'blank': return '';
    case 'same': return f.value;
    case 'form': return ctx.formText;
    case 'year': return String(ctx.year);
    case 'account': return row.form.payee.replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
    case 'box': {
      const cents = row.form.boxes[f.box];
      return cents ? amountText(cents) : '';
    }
    case 'party': {
      if (f.party === 'payer') {
        const p = ctx.payer;
        const tin = readTin(p.tin);
        switch (f.field) {
          case 'tinType': return ctx.tinTypes.EIN;
          case 'tin': return tin ? tinText(tin.digits, 'EIN', ctx.opts.dashes) : '';
          case 'name1': return nameLine(p.name);
          case 'name2': return nameLine(p.name2);
          case 'address1': return streetLine(p.address1);
          case 'address2': return streetLine(p.address2);
          case 'city': return cityName(p.city);
          case 'state': return stateCode(p.state) ?? '';
          case 'zip': return zipText(zipOf(p.zip) ?? '', ctx.opts.dashes);
          case 'phone': return phoneOf(p.phone) ?? '';
          case 'email': return p.email.trim();
          default: return '';
        }
      }
      const d = row.details;
      switch (f.field) {
        case 'tinType': return ctx.tinTypes[row.tinType];
        case 'tin': return tinText(row.tin.digits, row.tinType, ctx.opts.dashes);
        // A person's name goes in its own columns, or on the name line when the template has none.
        case 'name1': return d.person ? (ctx.personNames ? '' : nameLine(formName(d))) : nameLine(d.business);
        case 'name2': return d.person ? '' : nameLine(d.business2);
        case 'first': return d.person ? personName(d.first) : '';
        case 'middle': return d.person ? personName(d.middle) : '';
        case 'last': return d.person ? personName(d.last) : '';
        case 'address1': return streetLine(d.address1);
        case 'address2': return streetLine(d.address2);
        case 'city': return cityName(d.city);
        case 'state': return d.state;
        case 'zip': return zipText(d.zip, ctx.opts.dashes);
        default: return '';
      }
    }
  }
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const hasFill = (fills: readonly ColumnFill[], party: Party, field: PartyField) =>
  fills.some((f) => f.kind === 'party' && f.party === party && f.field === field);

/** What `fileProblems` says first when no form is ready. */
export const NO_FORMS_READY = 'No forms are ready to go in the file.';

/** Why the file can't be made from this template, these columns and these forms. */
export function fileProblems(t: Template, fills: readonly ColumnFill[], form: Form1099, payer: Payer, rows: readonly FileRow[]): string[] {
  const problems: string[] = [];
  if (fills.length !== t.headings.length) return ["The template's columns changed: drop it again."];
  if (!rows.length) problems.push(NO_FORMS_READY);
  const missing = (what: string) => problems.push(`No column is filled with the ${what}: pick it under Columns.`);
  for (const [field, what] of [['tin', "recipient's tax ID"], ['address1', "recipient's street"], ['city', "recipient's city"], ['state', "recipient's state"], ['zip', "recipient's ZIP"]] as const) {
    if (!hasFill(fills, 'recipient', field)) missing(what);
  }
  if (rows.some((r) => !r.details.person) && !hasFill(fills, 'recipient', 'name1')) missing("recipient's name");
  if (rows.some((r) => r.details.person) && !hasFill(fills, 'recipient', 'name1') && !(hasFill(fills, 'recipient', 'first') && hasFill(fills, 'recipient', 'last'))) {
    missing("recipient's first and last name");
  }
  if (fills.some((f) => f.kind === 'party' && f.party === 'payer')) {
    for (const [field, what] of [['tin', "payer's tax ID"], ['name1', "payer's name"], ['address1', "payer's street"], ['city', "payer's city"], ['state', "payer's state"], ['zip', "payer's ZIP"]] as const) {
      if (!hasFill(fills, 'payer', field)) missing(what);
    }
    problems.push(...payerProblems(payer));
  }
  const boxes = new Set(rows.flatMap((r) => Object.keys(r.form.boxes)));
  for (const box of [...boxes].sort((a, b) => Number(a) - Number(b))) {
    if (!fills.some((f) => f.kind === 'box' && f.box === box)) {
      problems.push(`No column is filled with box ${box}, ${boxOf(form, box)?.label.toLowerCase() ?? 'its amount'}: is this the IRS's ${FORM_TITLE[form]} template?`);
    }
  }
  const { problem } = vocabulary(t, fills, form);
  if (problem) problems.push(problem);
  return problems;
}

export interface MadeFile {
  name: string;
  text: string;
  forms: number;
}

/**
 * The template filled in with `rows`, a file for each `FORMS_PER_FILE`: its
 * own text down to its headings exactly as it came, then a row for each form, each
 * column as `fills` says, the template's line endings and byte order mark
 * kept. Nothing when `fileProblems` has anything to say.
 */
export function makeFiles(
  t: Template,
  fills: readonly ColumnFill[],
  form: Form1099,
  year: number,
  payer: Payer,
  rows: readonly FileRow[],
  opts: FileOptions,
  baseName: string,
): { files: MadeFile[]; problems: string[] } {
  const problems = fileProblems(t, fills, form, payer, rows);
  if (problems.length) return { files: [], problems };
  const { formText, tinTypes } = vocabulary(t, fills, form);
  const ctx = {
    form, year, payer, opts, formText, tinTypes,
    personNames: hasFill(fills, 'recipient', 'first') && hasFill(fills, 'recipient', 'last'),
  };
  const lines = rows.map((row) => fills.map((f) => csvCell(cellValue(f, row, ctx))).join(','));
  const count = Math.ceil(lines.length / FORMS_PER_FILE);
  const files: MadeFile[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = lines.slice(i * FORMS_PER_FILE, (i + 1) * FORMS_PER_FILE);
    files.push({
      name: `${baseName}${count > 1 ? `-${i + 1}-of-${count}` : ''}.csv`,
      text: (t.bom ? '﻿' : '') + t.head + chunk.join(t.newline) + t.newline,
      forms: chunk.length,
    });
  }
  return { files, problems: [] };
}

// ── Showing the columns ──────────────────────────────────────────────────────

const FIELD_LABEL: Record<PartyField, string> = {
  tinType: 'tax ID type', tin: 'tax ID', name1: 'name', name2: 'second name line', first: 'first name',
  middle: 'middle name', last: 'last name', suffix: 'suffix', address1: 'street', address2: 'second street line',
  city: 'city', state: 'state', zip: 'ZIP', country: 'country', phone: 'phone', email: 'email',
};

/** A fill as the page's pick list keys it: payer.tin, box.1, blank... */
export function fillKey(f: ColumnFill): string {
  if (f.kind === 'party') return `${f.party}.${f.field}`;
  if (f.kind === 'box') return `box.${f.box}`;
  return f.kind;
}

/** A fill from its key; `value` for one the same in every row. */
export function fillFromKey(key: string, value = ''): ColumnFill {
  const [kind, rest] = key.split('.');
  if (kind === 'payer' || kind === 'recipient') {
    if ((PARTY_FIELDS as readonly string[]).includes(rest)) return { kind: 'party', party: kind, field: rest as PartyField };
  }
  if (kind === 'box' && rest) return { kind: 'box', box: rest };
  if (kind === 'form' || kind === 'year' || kind === 'account') return { kind };
  if (kind === 'same') return { kind: 'same', value };
  return { kind: 'blank', read: true };
}

/** What a fill puts in its column, in words. */
export function fillLabel(f: ColumnFill, form: Form1099): string {
  switch (f.kind) {
    case 'blank': return f.read ? 'Left blank' : 'Left blank: FleetSuite can\'t tell what it is';
    case 'same': return 'The same in every row';
    case 'form': return 'The form';
    case 'year': return 'The tax year';
    case 'account': return "NetSuite's id for the vendor, as its account number";
    case 'box': return `Box ${f.box}, ${boxOf(form, f.box)?.label.toLowerCase() ?? 'its amount'}`;
    case 'party': return `The ${f.party}'s ${FIELD_LABEL[f.field]}`;
  }
}

/** Every fill a column can be given, for the page's pick list. */
export function fillChoices(form: Form1099): Array<{ key: string; label: string }> {
  const fills: ColumnFill[] = [
    { kind: 'blank', read: true },
    { kind: 'same', value: '' },
    { kind: 'form' },
    { kind: 'year' },
    ...FILED_BOXES.filter((b) => b.form === form).map((b): ColumnFill => ({ kind: 'box', box: b.box })),
    ...PARTY_FIELDS.map((field): ColumnFill => ({ kind: 'party', party: 'recipient', field })),
    { kind: 'account' },
    ...PARTY_FIELDS.map((field): ColumnFill => ({ kind: 'party', party: 'payer', field })),
  ];
  return fills.map((f) => ({ key: fillKey(f), label: fillLabel(f, form) }));
}

/** What goes in each column for the first form, a tax ID shown only by the four digits it ends with. */
export function previewColumn(f: ColumnFill, row: FileRow | null, t: Template, fills: readonly ColumnFill[], form: Form1099, year: number, payer: Payer, opts: FileOptions): string {
  if (f.kind === 'party' && f.field === 'tin') {
    const digits = f.party === 'payer' ? readTin(payer.tin)?.digits : row?.tin.digits;
    return digits ? maskedTin(digits) : '';
  }
  if (!row && f.kind === 'party' && f.party === 'recipient') return '';
  if (!row && f.kind === 'box') return '';
  const { formText, tinTypes } = vocabulary(t, fills, form);
  const blankRow: FileRow = row ?? {
    form: { form, payee: '', name: '', legalName: null, boxes: {}, total: 0 },
    details: {
      payee: '', person: false, first: '', middle: '', last: '', business: '', business2: '', address1: '', address2: '', city: '',
      state: '', zip: '', hasTaxId: null, taxIdEnding: null, problems: [], notes: [],
    },
    tin: { digits: '', looks: null },
    tinType: 'EIN',
  };
  return cellValue(f, blankRow, {
    form, year, payer, opts, formText, tinTypes,
    personNames: hasFill(fills, 'recipient', 'first') && hasFill(fills, 'recipient', 'last'),
  });
}
