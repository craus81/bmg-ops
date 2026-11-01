import { KNOWN_LOCATION_IDS } from '@/lib/invoice-location';
import { isPartTaxable } from '@/lib/line-taxability';
import { lastDay, monthAfter } from './bank-reconciliation';
import { monthText } from './differences';
import { TRAN_TYPE_NAMES, toCents } from './netsuite-gl';
import { dayText, explainTax, parseRate, pct } from './own-invoice-check';
import { lineTax, TAKES_OFF, type TaxBasis } from './own-invoices';
import { stateOf } from './sales-report';

/**
 * Missouri sales tax (part 65, migration 496, docs/books.md "Sales tax"; the
 * NetSuite Exit Checklist's "Missouri sales tax", thread "Replacing NetSuite
 * with FleetSuite"): what goes on a month's Missouri sales tax return, worked
 * out from what NetSuite posted that month, so the return can be filed from
 * FleetSuite and held against what was filed. Pure; amounts are whole cents.
 *
 *   * Each invoice, credit memo and cash sale NetSuite posted to the company
 *     in the month sits at its location: its receivable line's, else its
 *     first income line's. O'Fallon, Wentzville and Kansas City (and any
 *     location given a rate) are each a line on Missouri's return; Social
 *     Circle, Georgia isn't on it; a document at no location, or at one in
 *     neither state, has to be fixed before the return is filed.
 *   * Its sales are its lines on income accounts, credit less debit, so a
 *     credit memo takes them back: the gross receipts. Each is taxed or not by
 *     FleetSuite's own rule (src/lib/line-taxability.ts) from the ledger
 *     mirror's copy of the line's item: a discount follows the line above
 *     it, an exempt customer's sales (every FleetSuite customer with its
 *     NetSuite id exempt) aren't taxed, and a line whose item isn't known
 *     yet, or a document whose lines aren't copied, is taxed, so nothing
 *     quietly shrinks the tax. What isn't taxed is the return's adjustment.
 *   * Each location's tax is its taxable sales at the rate in force on the
 *     documents' dates (sales_tax_rates: a rate from its starting day until
 *     the next one), and the return's 2% timely payment allowance comes off
 *     the total when it's filed and paid by the 20th of the month after.
 *   * Next to it: the tax NetSuite charged on the same documents, each one
 *     whose tax differs from FleetSuite's rule worked out line by line and
 *     why (own-invoice-check.ts's explainTax), exempt customers' certificates
 *     on the sales' dates, and the sales tax accounts through the month.
 *   * A return typed in as filed is held against all of it.
 */

// ── What gl_sales_tax_month gives (migration 496) ──────────────────────────

export interface SalesTaxGlLineData {
  line_id: string;
  account: string;
  account_type: string | null;
  debit: string;
  credit: string;
  location_id: string | null;
  entity_id: string | null;
}

export interface SalesTaxMirrorLineData {
  line_id: string;
  line_no: number | null;
  kind: string;
  item_id: string | null;
  item_number: string | null;
  /** NetSuite's own signed amount, a sale negative. */
  netamount: string | null;
}

export interface SalesTaxDocumentData {
  id: string;
  type: string;
  number: string | null;
  date: string;
  /** Whether the ledger mirror has copied the document's lines. */
  copied: boolean;
  gl: SalesTaxGlLineData[];
  lines: SalesTaxMirrorLineData[];
}

export interface SalesTaxOtherData {
  id: string;
  type: string;
  number: string | null;
  date: string;
  memo: string | null;
  name: string | null;
  amount: string;
}

export interface SalesTaxOthersData {
  list: SalesTaxOtherData[];
  count: number;
  total: string;
}

export interface SalesTaxCustomerData {
  name: string | null;
  /** How many FleetSuite customers have this NetSuite id, and how many of them are tax exempt. */
  rows: number;
  exempt: number;
  cert_number: string | null;
  cert_expires: string | null;
  cert_files: number;
  /** NetSuite's customer list's Taxable box, 'T' or 'F'. */
  netsuite_taxable: string | null;
}

export interface SalesTaxMonthData {
  documents: SalesTaxDocumentData[];
  items: Record<string, { number: string; type: string | null }>;
  parts: Record<string, { number: string | null; type: string | null; taxable_override: boolean | null }>;
  tax_codes: Record<string, { name: string; rate: string | null }>;
  locations: Record<string, string>;
  customers: Record<string, SalesTaxCustomerData>;
  account: {
    opening: string;
    before: string;
    moves: Array<{ type: string; documents: number; amount: string }>;
    others: SalesTaxOthersData;
    next: SalesTaxOthersData;
    books: string;
  };
}

/** A row of sales_tax_rates. */
export interface SalesTaxRateRow {
  location_id: string;
  starts_on: string;
  rate_pct: string | number;
  note: string | null;
}

/** A row of sales_tax_returns; amounts in cents. */
export interface SalesTaxReturnRow {
  company: string;
  month: string;
  filed_on: string;
  gross_cents: number | string;
  adjustments_cents: number | string;
  taxable_cents: number | string;
  tax_cents: number | string;
  allowance_cents: number | string;
  paid_cents: number | string;
  note: string | null;
}

// ── Rates ──────────────────────────────────────────────────────────────────

/** Missouri's timely payment allowance: 2% of the tax, when the return is filed and paid by its due date. */
export const TIMELY_ALLOWANCE = 0.02;

export interface SalesTaxRate {
  locationId: string;
  startsOn: string;
  /** A fraction: 0.08488 is 8.488%. */
  rate: number;
  /** As people write it: '8.488%'. */
  pct: string;
  note: string | null;
}

const byId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function readRates(rows: SalesTaxRateRow[]): SalesTaxRate[] {
  return rows
    .map((r) => {
      const rate = parseRate(String(r.rate_pct)) ?? 0;
      return { locationId: String(r.location_id), startsOn: String(r.starts_on).slice(0, 10), rate, pct: pct(rate), note: r.note };
    })
    .sort((a, b) => byId(a.locationId, b.locationId) || a.startsOn.localeCompare(b.startsOn));
}

/** The rate in force at a location on a day: the one that started last, on or before it; null when none has. */
export function rateOn(rates: SalesTaxRate[], locationId: string | null, day: string): SalesTaxRate | null {
  let found: SalesTaxRate | null = null;
  for (const r of rates) {
    if (r.locationId === locationId && r.startsOn <= day && (!found || r.startsOn > found.startsOn)) found = r;
  }
  return found;
}

// ── Months and the due date ────────────────────────────────────────────────

/**
 * When a month's return is due: the 20th of the month after, or the Monday after when that's a weekend. A holiday
 * isn't moved for, so a return filed the day after a holiday on the 20th shows as late.
 */
export function dueDate(month: string): string {
  const next = monthAfter(month);
  const day = new Date(Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 20));
  const weekday = day.getUTCDay();
  if (weekday === 6) day.setUTCDate(22);
  if (weekday === 0) day.setUTCDate(21);
  return day.toISOString().slice(0, 10);
}

// ── Documents ──────────────────────────────────────────────────────────────

export const SALES_TYPES = new Set(['CustInvc', 'CashSale']);
export const RETURN_TYPES = new Set(['CustCred', 'CashRfnd']);
/** The ledger mirror copies invoices' and credit memos' lines (src/lib/ledger/netsuite-mirror.ts), not cash sales'. */
const MIRRORED_TYPES = new Set(['CustInvc', 'CustCred']);

/**
 * How a document is taxed: at its location's rate, not at all (an exempt customer, or work at Social Circle,
 * Georgia), or it can't be yet (no rate for its Missouri location on its date, no location, or a location in
 * neither state).
 */
export type DocumentBasis = 'rate' | 'exempt_customer' | 'georgia' | 'no_rate' | 'no_location' | 'other_state';

/** A document's line on an income account, sorted by FleetSuite's rule. */
export interface SortedLine {
  lineId: string;
  /** Its item's number, or what stands for it. */
  item: string;
  /** Its sales, credit less debit: a credit memo's are negative. */
  cents: number;
  taxable: boolean;
  /** Whether the ledger mirror has the line, so its item is known. */
  known: boolean;
}

export interface WorkedDocument {
  id: string;
  type: string;
  typeName: string;
  number: string | null;
  date: string;
  locationId: string | null;
  location: string;
  /** 'MO', 'GA' or '—'. */
  state: string;
  customerId: string | null;
  customer: string | null;
  basis: DocumentBasis;
  rate: SalesTaxRate | null;
  lines: SortedLine[];
  gross: number;
  taxable: number;
  untaxed: number;
  /** Taxable sales on lines the mirror hasn't copied, counted as taxed until it does. */
  unsorted: number;
  /** The tax NetSuite charged on it (credit memos': taken back, negative). */
  charged: number;
  /** The tax by FleetSuite's rule, line by line as its own invoices work it out; null when it has no rate. */
  owed: number | null;
  /** Why the two differ, when they do. */
  note: string | null;
}

/** What the worksheet is worked out from beyond the month's read. */
export interface WorksheetFacts {
  rates: SalesTaxRate[];
  /** NetSuite's sales tax accounts (src/lib/books/netsuite-lists.ts's tax accounts); null when they haven't been read. */
  taxAccounts: string[] | null;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const dollars = (cents: number) => money.format(cents / 100);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const sum = <T>(rows: T[], of: (row: T) => number) => rows.reduce((total, row) => total + of(row), 0);
/** The 2% timely payment allowance on a tax, rounded as FleetSuite rounds tax; none on a tax that's a refund. */
const allowanceOn = (tax: number) => Math.max(0, lineTax(tax, TIMELY_ALLOWANCE));
const typeName = (type: string) => TRAN_TYPE_NAMES[type] ?? type;

interface Lists {
  items: Map<string, { number: string; type: string | null }>;
  parts: Map<string, { number: string | null; type: string | null; taxable_override: boolean | null }>;
  taxCodes: Map<string, number | null>;
  locations: Map<string, string>;
  customers: Map<string, SalesTaxCustomerData>;
  rates: SalesTaxRate[];
  taxAccounts: Set<string>;
  rated: Set<string>;
}

/** The state a location is in: by its name, else by FleetSuite's known ids; a location given a rate is in Missouri. */
function stateAt(locationId: string | null, lists: Lists): string {
  if (!locationId) return '—';
  const byName = stateOf(lists.locations.get(locationId) ?? null);
  if (byName !== '—') return byName;
  const known = Object.entries(KNOWN_LOCATION_IDS).find(([, id]) => id === locationId);
  if (known) return stateOf(known[0]);
  return lists.rated.has(locationId) ? 'MO' : '—';
}

const locationName = (locationId: string | null, lists: Lists) =>
  (locationId ? lists.locations.get(locationId) ?? `Location ${locationId}` : 'No location');

/** NetSuite's rate on a document, when its tax lines all have the same one. */
function netsuiteRate(doc: SalesTaxDocumentData, lists: Lists): number | null {
  const rates = new Set(doc.lines.filter((l) => l.kind === 'tax').map((l) => (l.item_id ? lists.taxCodes.get(l.item_id) ?? null : null)));
  if (rates.size !== 1) return null;
  return [...rates][0];
}

/** Whether FleetSuite has a customer as tax exempt: every FleetSuite customer with its NetSuite id is. */
const isExempt = (c: SalesTaxCustomerData | undefined) => !!c && c.rows > 0 && c.exempt === c.rows;

function workOutDocument(doc: SalesTaxDocumentData, lists: Lists): WorkedDocument {
  const main = doc.gl.find((l) => l.line_id === '0');
  const income = doc.gl.filter((l) => l.account_type === 'income' && !lists.taxAccounts.has(l.account));
  const locationId = main?.location_id ?? income.find((l) => l.location_id)?.location_id ?? null;
  const customerId = main?.entity_id ?? doc.gl.find((l) => l.entity_id)?.entity_id ?? null;
  const customer = customerId ? lists.customers.get(customerId) : undefined;
  const state = stateAt(locationId, lists);
  const rate = state === 'MO' ? rateOn(lists.rates, locationId, doc.date) : null;

  let basis: DocumentBasis;
  if (!locationId) basis = 'no_location';
  else if (state === 'GA') basis = 'georgia';
  else if (state !== 'MO') basis = 'other_state';
  else if (isExempt(customer)) basis = 'exempt_customer';
  else if (!rate) basis = 'no_rate';
  else basis = 'rate';
  const taxes = basis === 'rate' || basis === 'no_rate';

  // In the mirror's order, so a discount follows the line above it; then any income line it doesn't have.
  const byLine = new Map(income.map((l) => [l.line_id, l]));
  const mirrored = new Map(doc.lines.filter((l) => l.kind !== 'tax').map((l) => [l.line_id, l]));
  const order = [
    ...doc.lines.filter((l) => l.kind !== 'tax' && byLine.has(l.line_id)).map((l) => l.line_id),
    ...income.map((l) => l.line_id).filter((id) => !mirrored.has(id)),
  ];
  const lines: SortedLine[] = [];
  for (const lineId of order) {
    const g = byLine.get(lineId)!;
    const cents = toCents(g.credit) - toCents(g.debit);
    if (cents === 0) continue;
    const m = mirrored.get(lineId);
    const listed = m?.item_id ? lists.items.get(m.item_id) : undefined;
    const part = m?.item_id ? lists.parts.get(m.item_id) : undefined;
    const type = listed?.type ?? part?.type ?? null;
    const number = m?.item_number ?? listed?.number ?? part?.number ?? null;
    const above = lines[lines.length - 1];
    const byRule = !m ? true
      : type && TAKES_OFF.has(type) && above ? above.taxable
        : isPartTaxable({ item_type: type, item_number: number, taxable_override: part?.taxable_override ?? null });
    lines.push({
      lineId,
      item: number ?? (m?.item_id ? `Item ${m.item_id}` : `Line ${lineId}`),
      cents,
      taxable: taxes && byRule,
      known: !!m,
    });
  }

  const gross = sum(lines, (l) => l.cents);
  const taxable = sum(lines, (l) => (l.taxable ? l.cents : 0));
  const unsorted = sum(lines, (l) => (l.taxable && !l.known ? l.cents : 0));
  const charged = sum(doc.gl.filter((l) => lists.taxAccounts.has(l.account)), (l) => toCents(l.credit) - toCents(l.debit));
  const owed = basis === 'rate' ? sum(lines, (l) => (l.taxable ? lineTax(l.cents, rate!.rate) : 0))
    : basis === 'exempt_customer' || basis === 'georgia' ? 0
      : null;
  const location = locationName(locationId, lists);

  let note: string | null = null;
  if (owed !== null && owed !== charged) {
    const back = RETURN_TYPES.has(doc.type);
    const verb = back ? 'took back' : 'charged';
    if (unsorted !== 0 && unsorted === taxable && !lines.some((l) => l.known)) {
      const why = MIRRORED_TYPES.has(doc.type)
        ? "Its lines aren't in FleetSuite's copy of NetSuite yet"
        : `FleetSuite doesn't copy a ${typeName(doc.type).toLowerCase()}'s lines`;
      note = `${why}, so all ${dollars(Math.abs(gross))} is counted as taxed; NetSuite ${verb} ${dollars(Math.abs(charged))}.`;
    } else {
      const flip = back ? -1 : 1;
      const sides: TaxBasis = basis === 'georgia' ? 'georgia' : basis === 'exempt_customer' ? 'exempt_customer' : 'rate';
      note = explainTax({
        lines: lines.map((l) => ({ item: l.item, cents: flip * l.cents, taxable: l.taxable, priced: true })),
        fleetsuite: flip * owed,
        rate: rate?.rate ?? 0,
        basis: sides,
        netsuite: flip * charged,
        netsuiteRate: netsuiteRate(doc, lists),
        customer: customer?.name ?? null,
        customerTaxable: customer?.netsuite_taxable === 'T' ? true : customer?.netsuite_taxable === 'F' ? false : null,
        rateFrom: rate ? `${location}'s from ${dayText(rate.startsOn)}` : undefined,
        charged: back ? verb : undefined,
      });
    }
  }

  return {
    id: doc.id,
    type: doc.type,
    typeName: typeName(doc.type),
    number: doc.number,
    date: doc.date,
    locationId,
    location,
    state,
    customerId,
    customer: customer?.name ?? (customerId ? `Customer ${customerId}` : null),
    basis,
    rate,
    lines,
    gross,
    taxable,
    untaxed: gross - taxable,
    unsorted,
    charged,
    owed,
    note,
  };
}

// ── The return ─────────────────────────────────────────────────────────────

/** One of the return's lines: a Missouri location at one rate. */
export interface ReturnLine {
  locationId: string;
  location: string;
  /** The rate its documents were taxed at; null for documents on days with no rate. */
  rate: SalesTaxRate | null;
  documents: number;
  gross: number;
  /** What's taken off for sales that aren't taxed: negative. */
  adjustments: number;
  taxable: number;
  /** Taxable sales at the rate; null when there's no rate and something to tax. */
  tax: number | null;
  /** The tax NetSuite charged on the same documents. */
  charged: number;
  unsorted: number;
}

/** What to file, Form 53-1's way. */
export interface ReturnFigures {
  gross: number;
  adjustments: number;
  taxable: number;
  /** Null until every line has a rate. */
  tax: number | null;
  /** 2% of the tax, when filed and paid on time. */
  allowance: number | null;
  pay: number | null;
  charged: number;
}

/** Sales that aren't on Missouri's return: Georgia's, or at no location or one in neither state. */
export interface ApartLine {
  state: string;
  locationId: string | null;
  location: string;
  documents: number;
  gross: number;
  charged: number;
}

/** An exempt customer's sales in the month, and their certificate. */
export interface ExemptSales {
  customerId: string;
  customer: string;
  documents: number;
  gross: number;
  certNumber: string | null;
  certExpires: string | null;
  certFiles: number;
  /** A sale after the certificate expired, or no certificate on file. */
  warning: string | null;
}

// ── The sales tax accounts ─────────────────────────────────────────────────

export interface AccountMove {
  type: string;
  typeName: string;
  documents: number;
  amount: number;
}

export interface OtherMove {
  id: string;
  type: string;
  typeName: string;
  number: string | null;
  date: string;
  memo: string | null;
  name: string | null;
  amount: number;
}

export interface OtherMoves {
  list: OtherMove[];
  count: number;
  total: number;
}

/** The sales tax accounts in the copy of NetSuite's ledger through the month, owed to the state positive. */
export interface TaxAccounts {
  start: number;
  moves: AccountMove[];
  /** What the month's sales and returns moved them by. */
  charged: number;
  end: number;
  /** The month's other moves (payments to the state, journal entries) and the month after's, when the month's return is paid. */
  others: OtherMoves;
  next: OtherMoves;
  /** What FleetSuite's own books hold on them at the month's end. */
  books: number;
}

function otherMoves(data: SalesTaxOthersData): OtherMoves {
  return {
    list: data.list.map((o) => ({
      id: o.id, type: o.type, typeName: typeName(o.type), number: o.number, date: o.date, memo: o.memo, name: o.name, amount: toCents(o.amount),
    })),
    count: data.count,
    total: toCents(data.total),
  };
}

// ── Held against the return as filed ───────────────────────────────────────

export interface FiledReturn {
  company: string;
  month: string;
  filedOn: string;
  gross: number;
  adjustments: number;
  taxable: number;
  tax: number;
  allowance: number;
  paid: number;
  note: string | null;
}

export function readReturn(row: SalesTaxReturnRow): FiledReturn {
  return {
    company: row.company,
    month: String(row.month).slice(0, 10),
    filedOn: String(row.filed_on).slice(0, 10),
    gross: Number(row.gross_cents),
    adjustments: Number(row.adjustments_cents),
    taxable: Number(row.taxable_cents),
    tax: Number(row.tax_cents),
    allowance: Number(row.allowance_cents),
    paid: Number(row.paid_cents),
    note: row.note,
  };
}

export type ReturnField = 'gross' | 'adjustments' | 'taxable' | 'tax' | 'allowance' | 'paid';
export const RETURN_FIELDS: readonly ReturnField[] = ['gross', 'adjustments', 'taxable', 'tax', 'allowance', 'paid'];
export const RETURN_FIELD_WORDS: Readonly<Record<ReturnField, string>> = {
  gross: 'Gross receipts',
  adjustments: 'Adjustments',
  taxable: 'Taxable sales',
  tax: 'Tax',
  allowance: 'Timely payment allowance',
  paid: 'Paid',
};

export interface FieldHeld {
  field: ReturnField;
  filed: number;
  /** What it should be: the worksheet's, or for the allowance and what's paid, worked out from the return's own tax. */
  expected: number | null;
  differs: boolean;
}

export interface ReturnHeld {
  filedOn: string;
  due: string;
  late: boolean;
  fields: FieldHeld[];
  /** What the sales tax accounts went down by in the month after, for the state, owed positive. */
  clearedNext: number;
  /** Sentences on what differs; empty when nothing does. */
  notes: string[];
}

export function holdReturn(filed: FiledReturn, figures: ReturnFigures, accounts: TaxAccounts | null): ReturnHeld {
  const due = dueDate(filed.month);
  const late = filed.filedOn > due;
  const allowance = late ? 0 : allowanceOn(filed.tax);
  const expected: Record<ReturnField, number | null> = {
    gross: figures.gross,
    adjustments: figures.adjustments,
    taxable: figures.taxable,
    tax: figures.tax,
    allowance,
    paid: filed.tax - filed.allowance,
  };
  const fields = RETURN_FIELDS.map((field) => ({
    field, filed: filed[field], expected: expected[field], differs: expected[field] !== null && filed[field] !== expected[field],
  }));

  const notes: string[] = [];
  for (const f of fields) {
    if (!f.differs || f.field === 'allowance' || f.field === 'paid') continue;
    const apart = f.filed - f.expected!;
    const verb = f.field === 'tax' ? 'is' : 'are';
    notes.push(`${RETURN_FIELD_WORDS[f.field]} on the return ${verb} ${dollars(Math.abs(apart))} ${apart > 0 ? 'more' : 'less'} than the worksheet's.`);
  }
  if (fields.find((f) => f.field === 'allowance')!.differs) {
    notes.push(late
      ? `It was filed ${dayText(filed.filedOn)}, after it was due on ${dayText(due)}, and a late return gets no timely payment allowance unless that day was a holiday.`
      : `The timely payment allowance is 2% of the return's tax, ${dollars(allowance)}, and the return took ${dollars(filed.allowance)}.`);
  }
  if (fields.find((f) => f.field === 'paid')!.differs) {
    const apart = filed.paid - expected.paid!;
    notes.push(`What was paid is ${dollars(Math.abs(apart))} ${apart > 0 ? 'more' : 'less'} than the tax less the allowance${apart > 0 ? ', as penalties or interest would be' : ''}.`);
  }
  const clearedNext = accounts ? 0 - accounts.next.total : 0;
  if (accounts && clearedNext !== filed.tax) {
    notes.push(clearedNext === 0
      ? `Nothing came off NetSuite's sales tax account in ${monthText(monthAfter(filed.month))} for it yet.`
      : `NetSuite's sales tax account came down ${dollars(clearedNext)} in ${monthText(monthAfter(filed.month))}, and the return's tax is ${dollars(filed.tax)}.`);
  }
  return { filedOn: filed.filedOn, due, late, fields, clearedNext, notes };
}

// ── The worksheet ──────────────────────────────────────────────────────────

export interface SalesTaxWorksheet {
  month: string;
  lines: ReturnLine[];
  figures: ReturnFigures;
  apart: ApartLine[];
  documents: WorkedDocument[];
  counts: Record<'sales' | 'returns', number>;
  exempt: ExemptSales[];
  /** Null when NetSuite's sales tax accounts haven't been read. */
  accounts: TaxAccounts | null;
  /** What has to be fixed before the return is filed. */
  problems: string[];
  /** What's worth knowing first. */
  warnings: string[];
}

export function salesTaxWorksheet(month: string, data: SalesTaxMonthData, facts: WorksheetFacts): SalesTaxWorksheet {
  const lists: Lists = {
    items: new Map(Object.entries(data.items ?? {})),
    parts: new Map(Object.entries(data.parts ?? {})),
    taxCodes: new Map(Object.entries(data.tax_codes ?? {}).map(([id, c]) => [id, parseRate(c.rate)])),
    locations: new Map(Object.entries(data.locations ?? {})),
    customers: new Map(Object.entries(data.customers ?? {})),
    rates: facts.rates,
    taxAccounts: new Set(facts.taxAccounts ?? []),
    rated: new Set(facts.rates.map((r) => r.locationId)),
  };
  const documents = data.documents.map((d) => workOutDocument(d, lists));

  // Missouri's lines, location by location and rate by rate; everything else apart.
  const lines = new Map<string, ReturnLine>();
  const apart = new Map<string, ApartLine>();
  const blank = (locationId: string, rate: SalesTaxRate | null): ReturnLine => ({
    locationId, location: locationName(locationId, lists), rate, documents: 0, gross: 0, adjustments: 0, taxable: 0, tax: 0, charged: 0, unsorted: 0,
  });
  // Every Missouri location with a rate is on the return, sales or none.
  for (const locationId of lists.rated) {
    const rate = rateOn(facts.rates, locationId, lastDay(month));
    if (rate && stateAt(locationId, lists) === 'MO') lines.set(`${locationId}|${rate.startsOn}`, blank(locationId, rate));
  }
  for (const d of documents) {
    if (d.state === 'MO' && d.locationId) {
      const key = `${d.locationId}|${d.rate?.startsOn ?? ''}`;
      if (!lines.has(key)) lines.set(key, blank(d.locationId, d.rate));
      const line = lines.get(key)!;
      line.documents += 1;
      line.gross += d.gross;
      line.adjustments -= d.untaxed;
      line.taxable += d.taxable;
      line.charged += d.charged;
      line.unsorted += d.unsorted;
    } else {
      const key = `${d.state}|${d.locationId ?? ''}`;
      if (!apart.has(key)) apart.set(key, { state: d.state, locationId: d.locationId, location: d.location, documents: 0, gross: 0, charged: 0 });
      const line = apart.get(key)!;
      line.documents += 1;
      line.gross += d.gross;
      line.charged += d.charged;
    }
  }
  const returnLines = [...lines.values()]
    .map((l) => ({ ...l, tax: l.rate ? lineTax(l.taxable, l.rate.rate) : l.taxable === 0 ? 0 : null }))
    .sort((a, b) => byId(a.locationId, b.locationId) || (a.rate?.startsOn ?? '').localeCompare(b.rate?.startsOn ?? ''));
  const tax = returnLines.some((l) => l.tax === null) ? null : sum(returnLines, (l) => l.tax!);
  const allowance = tax === null ? null : allowanceOn(tax);
  const figures: ReturnFigures = {
    gross: sum(returnLines, (l) => l.gross),
    adjustments: sum(returnLines, (l) => l.adjustments),
    taxable: sum(returnLines, (l) => l.taxable),
    tax,
    allowance,
    pay: tax === null ? null : tax - allowance!,
    charged: sum(returnLines, (l) => l.charged),
  };

  // Exempt customers' sales, with their certificates on the sales' dates.
  const exempt = new Map<string, ExemptSales & { dates: string[] }>();
  for (const d of documents) {
    if (d.basis !== 'exempt_customer' || !d.customerId) continue;
    const c = lists.customers.get(d.customerId)!;
    if (!exempt.has(d.customerId)) {
      exempt.set(d.customerId, {
        customerId: d.customerId, customer: d.customer ?? `Customer ${d.customerId}`, documents: 0, gross: 0,
        certNumber: c.cert_number, certExpires: c.cert_expires, certFiles: c.cert_files, warning: null, dates: [],
      });
    }
    const e = exempt.get(d.customerId)!;
    e.documents += 1;
    e.gross += d.gross;
    e.dates.push(d.date);
  }
  const exemptSales = [...exempt.values()].map(({ dates, ...e }) => {
    const after = e.certExpires ? dates.filter((day) => day > e.certExpires!).length : 0;
    let warning: string | null = null;
    if (!e.certNumber && e.certFiles === 0) warning = 'No exemption certificate on file.';
    else if (after) {
      warning = `Certificate expired ${dayText(e.certExpires!)}, before ${after === dates.length ? (after === 1 ? 'the sale' : `all ${after} sales`) : `${after} of the ${dates.length} sales`}.`;
    }
    return { ...e, warning };
  }).sort((a, b) => b.gross - a.gross || a.customer.localeCompare(b.customer));

  // The sales tax accounts.
  let accounts: TaxAccounts | null = null;
  if (facts.taxAccounts) {
    const moves = data.account.moves.map((m) => ({ type: m.type, typeName: typeName(m.type), documents: m.documents, amount: toCents(m.amount) }));
    const start = toCents(data.account.opening) + toCents(data.account.before);
    accounts = {
      start,
      moves,
      charged: sum(moves.filter((m) => SALES_TYPES.has(m.type) || RETURN_TYPES.has(m.type)), (m) => m.amount),
      end: start + sum(moves, (m) => m.amount),
      others: otherMoves(data.account.others),
      next: otherMoves(data.account.next),
      books: toCents(data.account.books),
    };
  }

  const apartLines = [...apart.values()].sort((a, b) => (a.state === 'GA' ? 0 : 1) - (b.state === 'GA' ? 0 : 1) || a.location.localeCompare(b.location));
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!facts.taxAccounts) {
    problems.push("Where NetSuite posts sales tax hasn't been read yet, so the tax it charged isn't known. Sync now on the NetSuite lists page reads it.");
  }
  for (const l of returnLines.filter((r) => r.tax === null)) {
    problems.push(`No sales tax rate for ${l.location} covers ${plural(l.documents, 'document', 'documents')} this month: add one below.`);
  }
  for (const a of apartLines) {
    if (a.state === 'GA') continue;
    problems.push(a.locationId
      ? `${plural(a.documents, 'document is', 'documents are')} at ${a.location}, which isn't in Missouri or Georgia (${dollars(a.gross)}): if it's in Missouri, add its rate below.`
      : `${plural(a.documents, 'document has', 'documents have')} no location (${dollars(a.gross)}), so ${a.documents === 1 ? "it isn't" : "they aren't"} on a location's line: set it in NetSuite.`);
  }
  const unsorted = documents.filter((d) => d.unsorted !== 0);
  if (unsorted.length) {
    warnings.push(`${dollars(sum(unsorted, (d) => d.unsorted))} on ${plural(unsorted.length, 'document', 'documents')} is counted as taxed `
      + "because FleetSuite doesn't have the lines' items yet.");
  }
  const mixed = [...lists.customers.entries()].filter(([, c]) => c.exempt > 0 && c.exempt < c.rows);
  for (const [, c] of mixed) {
    warnings.push(`Only ${c.exempt} of the ${c.rows} FleetSuite customers for ${c.name ?? 'one customer'} are tax exempt, so their sales are counted as taxed.`);
  }

  return {
    month,
    lines: returnLines,
    figures,
    apart: apartLines,
    documents,
    counts: { sales: documents.filter((d) => SALES_TYPES.has(d.type)).length, returns: documents.filter((d) => RETURN_TYPES.has(d.type)).length },
    exempt: exemptSales,
    accounts,
    problems,
    warnings,
  };
}
