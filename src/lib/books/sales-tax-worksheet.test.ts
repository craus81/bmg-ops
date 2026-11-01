import { describe, it, expect } from 'vitest';
import {
  dueDate, holdReturn, rateOn, readRates, readReturn, salesTaxWorksheet,
  type SalesTaxDocumentData, type SalesTaxMonthData, type SalesTaxRateRow, type SalesTaxReturnRow,
} from './sales-tax-worksheet';

const AR = '120';
const SALES = '400';
const INSTALLS = '410';
const COGS = '580';
const MO_TAX = '250';
const GA_TAX = '251';
/** A sales tax account the chart has as income. */
const ODD_TAX = '252';
const MAR = '2025-03-01';

const RATE_ROWS: SalesTaxRateRow[] = [
  { location_id: '1', starts_on: '2025-01-01', rate_pct: '8.488', note: null },
  { location_id: '2', starts_on: '2025-01-01', rate_pct: '8.488', note: null },
  { location_id: '3', starts_on: '2025-01-01', rate_pct: '8.488', note: null },
];
const FACTS = { rates: readRates(RATE_ROWS), taxAccounts: [MO_TAX, GA_TAX] };

/** A GL line: [line, account, cents debit positive, location, customer]; the account's type follows from it. */
type Gl = [string, string, number, (string | null)?, (string | null)?];
const TYPES: Record<string, string> = {
  [AR]: 'accounts_receivable', [SALES]: 'income', [INSTALLS]: 'income', [COGS]: 'cost_of_goods_sold',
  [MO_TAX]: 'other_current_liability', [GA_TAX]: 'other_current_liability', [ODD_TAX]: 'income', 100: 'bank',
};
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
/** A mirror line: [line, kind, item, number]. */
type Line = [string, 'item' | 'tax' | 'other', string | null, (string | null)?];

function doc(id: string, type: string, date: string, gl: Gl[], lines: Line[] | null): SalesTaxDocumentData {
  return {
    id, type, number: `${type.slice(0, 2)}${id}`, date, copied: lines !== null,
    gl: gl.map(([line_id, account, cents, location_id, entity_id]) => ({
      line_id, account, account_type: TYPES[account] ?? null, debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00',
      location_id: location_id ?? null, entity_id: entity_id ?? null,
    })),
    lines: (lines ?? []).map(([line_id, kind, item_id, item_number], i) => ({
      line_id, line_no: i + 1, kind, item_id, item_number: item_number ?? null, netamount: null,
    })),
  };
}

const customer = (name: string, over: Partial<SalesTaxMonthData['customers'][string]> = {}) => ({
  name, rows: 1, exempt: 0, cert_number: null, cert_expires: null, cert_files: 0, netsuite_taxable: 'T', ...over,
});

const others = (list: SalesTaxMonthData['account']['others']['list'] = []) => ({
  list, count: list.length, total: (list.reduce((t, o) => t + Math.round(Number(o.amount) * 100), 0) / 100).toFixed(2),
});

function month(documents: SalesTaxDocumentData[], over: Partial<SalesTaxMonthData> = {}): SalesTaxMonthData {
  return {
    documents,
    items: {
      55: { number: 'SHELF-1', type: 'InvtPart' }, 56: { number: 'LABOR', type: 'Service' }, 57: { number: '06S646', type: 'NonInvtPart' },
      58: { number: 'DISC', type: 'Discount' }, 59: { number: 'RACK-9', type: 'Service' },
    },
    parts: { 59: { number: 'RACK-9', type: 'Service', taxable_override: true } },
    tax_codes: { 77: { name: 'MO St Charles', rate: '8.488%' }, 78: { name: 'MO Jackson', rate: '8.85%' } },
    locations: { 1: "O'Fallon", 2: 'Wentzville', 3: 'Kansas City', 5: 'Social Circle', 9: 'Denver' },
    customers: {
      9001: customer('Acme Fleet'),
      9002: customer('Bluebird Schools', { exempt: 1, cert_number: 'EX-4471', cert_expires: '2025-06-30', cert_files: 1, netsuite_taxable: 'F' }),
      9003: customer('Cardinal Plumbing'),
    },
    account: { opening: '1000.00', before: '-970.00', moves: [], others: others(), next: others(), books: '0' },
    ...over,
  };
}

// March: a shelf and an install at O'Fallon, the shelf back, a school's order at Wentzville, an install at Social Circle.
const MARCH = [
  doc('7001', 'CustInvc', '2025-03-05', [
    ['0', AR, 55730, '1', '9001'], ['1', SALES, -25100, '1'], ['2', INSTALLS, -28500, '1'], ['3', MO_TAX, -2130, '1'], ['4', COGS, 12000, '1'],
  ], [['1', 'item', '55', 'SHELF-1'], ['2', 'item', '56', 'LABOR'], ['3', 'tax', '77'], ['4', 'item', '55', 'SHELF-1']]),
  doc('7002', 'CustCred', '2025-03-12', [['0', AR, -13561, '1', '9001'], ['1', SALES, 12500, '1'], ['2', MO_TAX, 1061, '1']],
    [['1', 'item', '55', 'SHELF-1'], ['2', 'tax', '77']]),
  doc('7003', 'CustInvc', '2025-03-20', [['0', AR, 40000, '2', '9002'], ['1', SALES, -40000, '2']], null),
  doc('7007', 'CashSale', '2025-03-25', [['0', '100', 21200, '5', '9003'], ['1', INSTALLS, -20000, '5'], ['2', GA_TAX, -1200, '5']], null),
];

describe('rates', () => {
  it('reads each as a fraction and a percent, location by location in order', () => {
    const rates = readRates([
      { location_id: '10', starts_on: '2025-04-01', rate_pct: 9, note: null },
      { location_id: '2', starts_on: '2025-04-01T00:00:00', rate_pct: '8.738', note: 'Quarter' },
      { location_id: '2', starts_on: '2025-01-01', rate_pct: '8.488', note: null },
    ]);
    expect(rates).toEqual([
      { locationId: '2', startsOn: '2025-01-01', rate: 0.08488, pct: '8.488%', note: null },
      { locationId: '2', startsOn: '2025-04-01', rate: 0.08738, pct: '8.738%', note: 'Quarter' },
      { locationId: '10', startsOn: '2025-04-01', rate: 0.09, pct: '9%', note: null },
    ]);
  });

  it('finds the one in force on a day: the last to start on or before it', () => {
    const rates = readRates([...RATE_ROWS, { location_id: '1', starts_on: '2025-04-01', rate_pct: '8.738', note: null }]);
    expect(rateOn(rates, '1', '2025-03-31')?.pct).toBe('8.488%');
    expect(rateOn(rates, '1', '2025-04-01')?.pct).toBe('8.738%');
    expect(rateOn(rates, '1', '2026-12-31')?.pct).toBe('8.738%');
    expect(rateOn(rates, '1', '2024-12-31')).toBeNull();
    expect(rateOn(rates, '5', '2025-04-01')).toBeNull();
    expect(rateOn(rates, null, '2025-04-01')).toBeNull();
  });
});

describe('when a return is due', () => {
  it('is the 20th of the month after, moved to the Monday when that is a weekend', () => {
    expect(dueDate('2025-09-01')).toBe('2025-10-20');
    expect(dueDate('2025-12-01')).toBe('2026-01-20');
    // April 20, 2025 is a Sunday and September 20, 2025 a Saturday.
    expect(dueDate(MAR)).toBe('2025-04-21');
    expect(dueDate('2025-08-01')).toBe('2025-09-22');
  });
});

describe("a month's worksheet", () => {
  it('puts each Missouri location on the return with its gross, what is taken off, its taxable sales and tax', () => {
    const w = salesTaxWorksheet(MAR, month(MARCH), FACTS);
    expect(w.lines.map(({ rate, ...l }) => ({ ...l, rate: rate?.pct }))).toEqual([
      // A shelf at $251, an install at $285 that isn't taxed, the shelf back at $125: $126 taxed at 8.488%.
      { locationId: '1', location: "O'Fallon", rate: '8.488%', documents: 2, gross: 41100, adjustments: -28500, taxable: 12600, tax: 1069, charged: 1069, unsorted: 0 },
      // An exempt school's order, its lines not copied: nothing taxed.
      { locationId: '2', location: 'Wentzville', rate: '8.488%', documents: 1, gross: 40000, adjustments: -40000, taxable: 0, tax: 0, charged: 0, unsorted: 0 },
      // No sales, still a line.
      { locationId: '3', location: 'Kansas City', rate: '8.488%', documents: 0, gross: 0, adjustments: 0, taxable: 0, tax: 0, charged: 0, unsorted: 0 },
    ]);
    // 2% of $10.69 is 21.38 cents.
    expect(w.figures).toEqual({ gross: 81100, adjustments: -68500, taxable: 12600, tax: 1069, allowance: 21, pay: 1048, charged: 1069 });
    expect(w.apart).toEqual([{ state: 'GA', locationId: '5', location: 'Social Circle', documents: 1, gross: 20000, charged: 1200 }]);
    expect(w.counts).toEqual({ sales: 3, returns: 1 });
    expect(w.problems).toEqual([]);
    expect(w.warnings).toEqual([]);
  });

  it('sorts every line by FleetSuite\'s rule and says why NetSuite\'s tax differs', () => {
    const w = salesTaxWorksheet(MAR, month(MARCH), FACTS);
    const [invoice, credit, school, cash] = w.documents;
    expect(invoice).toMatchObject({
      typeName: 'Invoice', location: "O'Fallon", state: 'MO', customer: 'Acme Fleet', basis: 'rate', gross: 53600, taxable: 25100,
      untaxed: 28500, unsorted: 0, charged: 2130, owed: 2130, note: null,
    });
    // The cost of goods sold line isn't a sale.
    expect(invoice.lines).toEqual([
      { lineId: '1', item: 'SHELF-1', cents: 25100, taxable: true, known: true },
      { lineId: '2', item: 'LABOR', cents: 28500, taxable: false, known: true },
    ]);
    expect(credit).toMatchObject({ typeName: 'Credit Memo', gross: -12500, taxable: -12500, charged: -1061, owed: -1061, note: null });
    expect(school).toMatchObject({ customer: 'Bluebird Schools', basis: 'exempt_customer', gross: 40000, taxable: 0, owed: 0, note: null });
    expect(cash).toMatchObject({
      state: 'GA', basis: 'georgia', taxable: 0, charged: 1200, owed: 0,
      note: "FleetSuite doesn't tax work at Social Circle, Georgia, and NetSuite charged $12.00.",
    });
  });

  it('lists exempt customers\' sales with their certificates on the sales\' dates', () => {
    const late = doc('7010', 'CustInvc', '2025-07-02', [['0', AR, 5000, '2', '9002'], ['1', SALES, -5000, '2']], [['1', 'item', '55']]);
    const none = doc('7011', 'CustInvc', '2025-07-03', [['0', AR, 7000, '1', '9004'], ['1', SALES, -7000, '1']], [['1', 'item', '55']]);
    const data = month([MARCH[2], late, none], {
      customers: { ...month([]).customers, 9004: customer('Dogwood Church', { exempt: 1, netsuite_taxable: 'F' }) },
    });
    const w = salesTaxWorksheet('2025-07-01', data, FACTS);
    expect(w.exempt).toEqual([
      {
        customerId: '9002', customer: 'Bluebird Schools', documents: 2, gross: 45000, certNumber: 'EX-4471', certExpires: '2025-06-30', certFiles: 1,
        warning: 'Certificate expired Jun 30, 2025, before 1 of the 2 sales.',
      },
      { customerId: '9004', customer: 'Dogwood Church', documents: 1, gross: 7000, certNumber: null, certExpires: null, certFiles: 0, warning: 'No exemption certificate on file.' },
    ]);
    const after = salesTaxWorksheet('2025-07-01', month([late]), FACTS);
    expect(after.exempt[0].warning).toBe('Certificate expired Jun 30, 2025, before the sale.');
  });

  it('counts a customer as exempt only when every FleetSuite customer with its NetSuite id is', () => {
    const sale = doc('7020', 'CustInvc', '2025-03-10', [['0', AR, 10849, '1', '9002'], ['1', SALES, -10000, '1'], ['2', MO_TAX, -849, '1']], [['1', 'item', '55'], ['2', 'tax', '77']]);
    const data = month([sale]);
    data.customers['9002'] = { ...data.customers['9002'], rows: 2, exempt: 1 };
    const w = salesTaxWorksheet(MAR, data, FACTS);
    expect(w.documents[0]).toMatchObject({ basis: 'rate', taxable: 10000, owed: 849, charged: 849 });
    expect(w.exempt).toEqual([]);
    expect(w.warnings).toEqual(['Only 1 of the 2 FleetSuite customers for Bluebird Schools are tax exempt, so their sales are counted as taxed.']);
  });

  it('takes a discount\'s tax from the line above, and an admin\'s say over the item\'s type', () => {
    const sale = doc('7030', 'CustInvc', '2025-03-11', [
      ['0', AR, 0, '1', '9001'], ['1', SALES, -10000, '1'], ['2', SALES, 1000, '1'], ['3', INSTALLS, -5000, '1'], ['4', INSTALLS, 500, '1'],
      ['5', SALES, -2000, '1'], ['6', INSTALLS, -3000, '1'], ['7', SALES, 0, '1'],
    ], [
      ['1', 'item', '55'], ['2', 'item', '58'], ['3', 'item', '56'], ['4', 'item', '58'], ['5', 'item', '59'], ['6', 'item', '57'], ['7', 'item', '55'],
    ]);
    const [d] = salesTaxWorksheet(MAR, month([sale]), FACTS).documents;
    expect(d.lines.map((l) => [l.item, l.cents, l.taxable])).toEqual([
      ['SHELF-1', 10000, true], ['DISC', -1000, true], ['LABOR', 5000, false], ['DISC', -500, false],
      // A service item an admin set as taxed, and an 06 service number, whatever its type.
      ['RACK-9', 2000, true], ['06S646', 3000, false],
    ]);
    expect(d).toMatchObject({ gross: 18500, taxable: 11000, untaxed: 7500 });
  });

  it('counts a line whose item isn\'t known, and a document whose lines aren\'t copied, as taxed', () => {
    const partly = doc('7040', 'CustInvc', '2025-03-14', [
      ['0', AR, 31849, '1', '9001'], ['1', SALES, -10000, '1'], ['2', SALES, -20000, '1'], ['3', INSTALLS, -1000, '1'], ['9', MO_TAX, -849, '1'],
    ], [['1', 'item', '55'], ['2', 'item', '9999', 'NEW-1'], ['9', 'tax', '77']]);
    const cash = doc('7041', 'CashSale', '2025-03-15', [['0', '100', 5000, '1', '9001'], ['1', INSTALLS, -5000, '1']], null);
    const w = salesTaxWorksheet(MAR, month([partly, cash, MARCH[0]]), FACTS);
    const [a, b] = w.documents;
    // NEW-1 isn't in either list; line 3 isn't in the mirror's copy.
    expect(a.lines.map((l) => [l.item, l.taxable, l.known])).toEqual([['SHELF-1', true, true], ['NEW-1', true, true], ['Line 3', true, false]]);
    expect(a).toMatchObject({ taxable: 31000, unsorted: 1000, owed: 2632, charged: 849 });
    expect(a.note).toBe("NetSuite didn't tax NEW-1 ($200.00) and Line 3 ($10.00), which FleetSuite taxes.");
    expect(b).toMatchObject({ taxable: 5000, unsorted: 5000, owed: 424, charged: 0 });
    expect(b.note).toBe("FleetSuite doesn't copy a cash sale's lines, so all $50.00 is counted as taxed; NetSuite charged $0.00.");
    expect(w.warnings).toEqual(["$60.00 on 2 documents is counted as taxed because FleetSuite doesn't have the lines' items yet."]);

    const waiting = doc('7042', 'CustInvc', '2025-03-16', [['0', AR, 10000, '1', '9001'], ['1', SALES, -10000, '1']], null);
    expect(salesTaxWorksheet(MAR, month([waiting]), FACTS).documents[0].note)
      .toBe("Its lines aren't in FleetSuite's copy of NetSuite yet, so all $100.00 is counted as taxed; NetSuite charged $0.00.");

    // Its one taxed line not copied yet, next to a copied one that isn't taxed.
    const mixed = doc('7043', 'CustInvc', '2025-03-17', [['0', AR, 6000, '1', '9001'], ['1', INSTALLS, -5000, '1'], ['2', SALES, -1000, '1']], [['1', 'item', '56']]);
    expect(salesTaxWorksheet(MAR, month([mixed]), FACTS).documents[0].note).toBe("NetSuite didn't tax Line 2 ($10.00), which FleetSuite taxes.");
  });

  it('names a NetSuite rate that differs from the location\'s, and a line NetSuite taxed that FleetSuite doesn\'t', () => {
    const rate = doc('7050', 'CustInvc', '2025-03-18', [['0', AR, 10885, '1', '9001'], ['1', SALES, -10000, '1'], ['2', MO_TAX, -885, '1']], [['1', 'item', '55'], ['2', 'tax', '78']]);
    const labor = doc('7051', 'CustInvc', '2025-03-19', [
      ['0', AR, 58519, '1', '9001'], ['1', SALES, -25100, '1'], ['2', INSTALLS, -28500, '1'], ['3', MO_TAX, -4549, '1'],
    ], [['1', 'item', '55'], ['2', 'item', '56'], ['3', 'tax', '77']]);
    const [a, b] = salesTaxWorksheet(MAR, month([rate, labor]), FACTS).documents;
    expect(a.note).toBe("NetSuite's rate is 8.85% and FleetSuite's 8.488%, O'Fallon's from Jan 1, 2025.");
    expect(b.note).toBe("NetSuite also taxed LABOR ($285.00), which FleetSuite doesn't tax.");
  });

  it('says NetSuite took back tax on a credit memo to an exempt customer', () => {
    const credit = doc('7060', 'CustCred', '2025-03-21', [['0', AR, -10849, '2', '9002'], ['1', SALES, 10000, '2'], ['2', MO_TAX, 849, '2']], [['1', 'item', '55'], ['2', 'tax', '77']]);
    const [d] = salesTaxWorksheet(MAR, month([credit]), FACTS).documents;
    expect(d).toMatchObject({ basis: 'exempt_customer', gross: -10000, taxable: 0, charged: -849, owed: 0 });
    expect(d.note).toBe('FleetSuite has Bluebird Schools as tax-exempt, and NetSuite took back $8.49.');
  });

  it('keeps apart what it can\'t put on a Missouri location\'s line, and says what to fix', () => {
    const nowhere = doc('7070', 'CustInvc', '2025-03-22', [['0', AR, 1000, null, '9001'], ['1', SALES, -1000]], [['1', 'item', '55']]);
    const denver = doc('7071', 'CustInvc', '2025-03-23', [['0', AR, 2000, '9', '9001'], ['1', SALES, -2000, '9']], [['1', 'item', '55']]);
    // Its location named only on its income line.
    const lineOnly = doc('7072', 'CustInvc', '2025-03-24', [['0', AR, 3000, null, '9001'], ['1', SALES, -3000, '3']], [['1', 'item', '55']]);
    const w = salesTaxWorksheet(MAR, month([nowhere, denver, lineOnly, MARCH[3]]), FACTS);
    expect(w.documents.map((d) => [d.location, d.state, d.basis])).toEqual([
      ['No location', '—', 'no_location'], ['Denver', '—', 'other_state'], ['Kansas City', 'MO', 'rate'], ['Social Circle', 'GA', 'georgia'],
    ]);
    // Georgia's first.
    expect(w.apart.map((a) => [a.location, a.documents, a.gross])).toEqual([['Social Circle', 1, 20000], ['Denver', 1, 2000], ['No location', 1, 1000]]);
    expect(w.problems).toEqual([
      "1 document is at Denver, which isn't in Missouri or Georgia ($20.00): if it's in Missouri, add its rate below.",
      "1 document has no location ($10.00), so it isn't on a location's line: set it in NetSuite.",
    ]);
    // A rate makes Denver a Missouri location.
    const rated = salesTaxWorksheet(MAR, month([denver]), { ...FACTS, rates: readRates([...RATE_ROWS, { location_id: '9', starts_on: '2025-03-01', rate_pct: '7', note: null }]) });
    expect(rated.lines.find((l) => l.locationId === '9')).toMatchObject({ location: 'Denver', taxable: 2000, tax: 140 });
    expect(rated.problems).toEqual([]);
  });

  it('can\'t work out the tax until every location has a rate on its documents\' dates', () => {
    const rates = readRates([{ location_id: '1', starts_on: '2025-03-15', rate_pct: '8.738', note: null }]);
    const early = doc('7080', 'CustInvc', '2025-03-10', [['0', AR, 10849, '1', '9001'], ['1', SALES, -10000, '1'], ['2', MO_TAX, -849, '1']], [['1', 'item', '55'], ['2', 'tax', '77']]);
    const later = doc('7081', 'CustInvc', '2025-03-20', [['0', AR, 10000, '1', '9001'], ['1', SALES, -10000, '1']], [['1', 'item', '55']]);
    const w = salesTaxWorksheet(MAR, month([early, later]), { ...FACTS, rates });
    expect(w.lines.map((l) => [l.location, l.rate?.pct ?? null, l.taxable, l.tax])).toEqual([["O'Fallon", null, 10000, null], ["O'Fallon", '8.738%', 10000, 874]]);
    expect(w.documents[0]).toMatchObject({ basis: 'no_rate', charged: 849, owed: null, note: null });
    expect(w.figures).toMatchObject({ taxable: 20000, tax: null, allowance: null, pay: null });
    expect(w.problems).toEqual(["No sales tax rate for O'Fallon covers 1 document this month: add one below."]);
  });

  it('rolls the sales tax accounts through the month', () => {
    const data = month(MARCH, {
      account: {
        opening: '1000.00', before: '-970.00', books: '10.69',
        moves: [
          { type: 'CashSale', documents: 1, amount: '12.00' }, { type: 'CustCred', documents: 1, amount: '-10.61' },
          { type: 'CustInvc', documents: 1, amount: '21.30' }, { type: 'TaxPymt', documents: 1, amount: '-30.00' },
        ],
        others: others([{ id: '7100', type: 'TaxPymt', number: 'TP7100', date: '2025-03-18', memo: 'February 2025', name: 'Missouri Department of Revenue', amount: '-30.00' }]),
        next: others([{ id: '7102', type: 'TaxPymt', number: 'TP7102', date: '2025-04-15', memo: null, name: null, amount: '-10.69' }]),
      },
    });
    const { accounts } = salesTaxWorksheet(MAR, data, FACTS);
    expect(accounts).toEqual({
      start: 3000,
      moves: [
        { type: 'CashSale', typeName: 'Cash Sale', documents: 1, amount: 1200 }, { type: 'CustCred', typeName: 'Credit Memo', documents: 1, amount: -1061 },
        { type: 'CustInvc', typeName: 'Invoice', documents: 1, amount: 2130 }, { type: 'TaxPymt', typeName: 'Sales Tax Payment', documents: 1, amount: -3000 },
      ],
      charged: 2269,
      end: 2269,
      others: { list: [expect.objectContaining({ id: '7100', typeName: 'Sales Tax Payment', amount: -3000 })], count: 1, total: -3000 },
      next: { list: [expect.objectContaining({ id: '7102', amount: -1069 })], count: 1, total: -1069 },
      books: 1069,
    });
  });

  it('says so when NetSuite\'s sales tax accounts haven\'t been read', () => {
    const w = salesTaxWorksheet(MAR, month(MARCH), { ...FACTS, taxAccounts: null });
    expect(w.accounts).toBeNull();
    expect(w.documents.map((d) => d.charged)).toEqual([0, 0, 0, 0]);
    expect(w.problems).toEqual(["Where NetSuite posts sales tax hasn't been read yet, so the tax it charged isn't known. Sync now on the NetSuite lists page reads it."]);
  });

  it("takes a document at its receivable line's location and customer, else its income line's and any line's", () => {
    // Billed from Wentzville for work at O'Fallon: the receivable line's location is the document's.
    const billed = doc('7090', 'CustInvc', '2025-03-26', [['0', AR, 10849, '2', '9001'], ['1', SALES, -10000, '1'], ['2', MO_TAX, -849, '1']], [['1', 'item', '55'], ['2', 'tax', '77']]);
    // A cash sale that names its customer only on its income line.
    const cash = doc('7091', 'CashSale', '2025-03-27', [['0', '100', 5000, '1'], ['1', INSTALLS, -5000, '1', '9003']], null);
    const [a, b] = salesTaxWorksheet(MAR, month([billed, cash]), FACTS).documents;
    expect([a.location, a.customer]).toEqual(['Wentzville', 'Acme Fleet']);
    expect([b.location, b.customer]).toEqual(["O'Fallon", 'Cardinal Plumbing']);
  });

  it("knows a location's state by its name, else by FleetSuite's own ids, and names one NetSuite's lists don't", () => {
    // A second Wentzville shop with no rate yet, and Social Circle before NetSuite's lists name it.
    const shop = doc('7092', 'CustInvc', '2025-03-26', [['0', AR, 10000, '12', '9001'], ['1', SALES, -10000, '12']], [['1', 'item', '55']]);
    const georgia = doc('7093', 'CustInvc', '2025-03-27', [['0', AR, 5000, '5', '9001'], ['1', INSTALLS, -5000, '5']], [['1', 'item', '56']]);
    const w = salesTaxWorksheet(MAR, month([shop, georgia], { locations: { 1: "O'Fallon", 2: 'Wentzville', 3: 'Kansas City', 12: 'Wentzville Paint Shop' } }), FACTS);
    expect(w.documents.map((d) => [d.location, d.state, d.basis])).toEqual([['Wentzville Paint Shop', 'MO', 'no_rate'], ['Location 5', 'GA', 'georgia']]);
    expect(w.problems).toEqual(['No sales tax rate for Wentzville Paint Shop covers 1 document this month: add one below.']);
  });

  it("keeps Social Circle off Missouri's return even when it's given a rate", () => {
    const rates = readRates([...RATE_ROWS, { location_id: '5', starts_on: '2025-01-01', rate_pct: '7', note: null }]);
    const w = salesTaxWorksheet(MAR, month([MARCH[3]]), { ...FACTS, rates });
    expect(w.documents[0]).toMatchObject({ state: 'GA', basis: 'georgia', rate: null, owed: 0 });
    expect(w.lines.map((l) => l.locationId)).toEqual(['1', '2', '3']);
  });

  it("doesn't tax an exempt customer's sale on a day with no rate, and taxes a customer FleetSuite doesn't have", () => {
    const rates = readRates([{ location_id: '1', starts_on: '2025-03-15', rate_pct: '8.488', note: null }]);
    const school = doc('7094', 'CustInvc', '2025-03-10', [['0', AR, 10000, '1', '9002'], ['1', SALES, -10000, '1']], [['1', 'item', '55']]);
    const stranger = doc('7095', 'CustInvc', '2025-03-20', [['0', AR, 10849, '1', '9005'], ['1', SALES, -10000, '1'], ['2', MO_TAX, -849, '1']], [['1', 'item', '55'], ['2', 'tax', '77']]);
    const unnamed = doc('7099', 'CustInvc', '2025-03-21', [['0', AR, 10849, '1', '9006'], ['1', SALES, -10000, '1'], ['2', MO_TAX, -849, '1']], [['1', 'item', '55'], ['2', 'tax', '77']]);
    const data = month([school, stranger, unnamed]);
    data.customers['9005'] = customer('Elm Street Garage', { rows: 0 });
    data.customers['9006'] = { ...customer('x'), name: null };
    const w = salesTaxWorksheet(MAR, data, { ...FACTS, rates });
    expect(w.documents.map((d) => [d.customer, d.basis, d.owed])).toEqual([
      ['Bluebird Schools', 'exempt_customer', 0], ['Elm Street Garage', 'rate', 849], ['Customer 9006', 'rate', 849],
    ]);
    expect(w.problems).toEqual([]);
  });

  it("takes back a cash refund, and a credit memo whose lines aren't copied, with no allowance on a month that's a refund", () => {
    const refund = doc('7096', 'CashRfnd', '2025-03-26', [['0', '100', -5424, '1', '9001'], ['1', SALES, 5000, '1'], ['2', MO_TAX, 424, '1']], [['1', 'item', '55'], ['2', 'tax', '77']]);
    const credit = doc('7097', 'CustCred', '2025-03-27', [['0', AR, -10400, '1', '9001'], ['1', SALES, 10000, '1'], ['2', MO_TAX, 400, '1']], null);
    const moves = [{ type: 'CashRfnd', documents: 1, amount: '-4.24' }, { type: 'CustCred', documents: 1, amount: '-4.00' }];
    const w = salesTaxWorksheet(MAR, month([refund, credit], { account: { ...month([]).account, moves } }), FACTS);
    expect(w.counts).toEqual({ sales: 0, returns: 2 });
    expect(w.documents.map((d) => [d.typeName, d.charged, d.owed, d.note])).toEqual([
      ['Cash Refund', -424, -424, null],
      ['Credit Memo', -400, -849, "Its lines aren't in FleetSuite's copy of NetSuite yet, so all $100.00 is counted as taxed; NetSuite took back $4.00."],
    ]);
    // $150.00 back at 8.488% is $12.73 less tax, and there's no allowance on a refund.
    expect(w.figures).toMatchObject({ taxable: -15000, tax: -1273, allowance: 0, pay: -1273 });
    expect(w.accounts?.charged).toBe(-824);
    expect(w.warnings).toEqual(["-$100.00 on 1 document is counted as taxed because FleetSuite doesn't have the lines' items yet."]);
  });

  it("doesn't count a sales tax account the chart has as income as a sale", () => {
    const sale = doc('7098', 'CustInvc', '2025-03-26', [['0', AR, 10849, '1', '9001'], ['1', SALES, -10000, '1'], ['2', ODD_TAX, -849, '1']], [['1', 'item', '55'], ['2', 'tax', '77']]);
    const [d] = salesTaxWorksheet(MAR, month([sale]), { ...FACTS, taxAccounts: [MO_TAX, GA_TAX, ODD_TAX] }).documents;
    expect(d).toMatchObject({ gross: 10000, taxable: 10000, charged: 849, owed: 849, note: null });
  });

  it("says when NetSuite has a customer as not taxable that FleetSuite taxes, and leaves NetSuite's rate out when its tax lines have more than one", () => {
    const plumber = doc('7100', 'CustInvc', '2025-03-26', [['0', AR, 10000, '1', '9003'], ['1', SALES, -10000, '1']], [['1', 'item', '55']]);
    const two = doc('7101', 'CustInvc', '2025-03-27', [['0', AR, 10842, '1', '9001'], ['1', SALES, -10000, '1'], ['2', MO_TAX, -442, '1'], ['3', MO_TAX, -400, '1']], [
      ['1', 'item', '55'], ['2', 'tax', '78'], ['3', 'tax', '77'],
    ]);
    const data = month([plumber, two]);
    data.customers['9003'] = customer('Cardinal Plumbing', { netsuite_taxable: 'F' });
    const [a, b] = salesTaxWorksheet(MAR, data, FACTS).documents;
    expect(a.note).toBe('NetSuite has Cardinal Plumbing as not taxable, so it charged no sales tax, and FleetSuite taxes them. '
      + 'If they are tax-exempt, mark them so on their FleetSuite customer record.');
    expect(b.note).toBe('NetSuite charged $8.42 and FleetSuite worked out $8.49.');
  });

  it("puts a location with no sales on the return at its rate on the month's last day", () => {
    const rates = readRates([...RATE_ROWS, { location_id: '3', starts_on: '2025-03-15', rate_pct: '8.738', note: null }]);
    const w = salesTaxWorksheet(MAR, month([]), { ...FACTS, rates });
    expect(w.lines.map((l) => [l.location, l.rate?.pct, l.documents])).toEqual([["O'Fallon", '8.488%', 0], ['Wentzville', '8.488%', 0], ['Kansas City', '8.738%', 0]]);
  });

  it('takes a certificate as on file with its file alone, and good through the day it expires', () => {
    const onTheDay = doc('7012', 'CustInvc', '2025-06-30', [['0', AR, 5000, '2', '9002'], ['1', SALES, -5000, '2']], [['1', 'item', '55']]);
    const fileOnly = doc('7013', 'CustInvc', '2025-06-12', [['0', AR, 7000, '1', '9004'], ['1', SALES, -7000, '1']], [['1', 'item', '55']]);
    const data = month([onTheDay, fileOnly], {
      customers: { ...month([]).customers, 9004: customer('Dogwood Church', { exempt: 1, cert_files: 1, netsuite_taxable: 'F' }) },
    });
    expect(salesTaxWorksheet('2025-06-01', data, FACTS).exempt.map((e) => [e.customer, e.warning])).toEqual([['Dogwood Church', null], ['Bluebird Schools', null]]);
  });

  it("names a line's item by its number, else NetSuite's id for it, else the line, and takes its type from NetSuite's lists first", () => {
    const sale = doc('7102', 'CustInvc', '2025-03-26', [['0', AR, 3000, '1', '9001'], ['1', SALES, -1000, '1'], ['2', SALES, -1000, '1'], ['3', SALES, -1000, '1']], [
      ['1', 'item', '9998'], ['3', 'item', '60'],
    ]);
    const data = month([sale]);
    data.items['60'] = { number: 'BRKT-2', type: 'InvtPart' };
    data.parts['60'] = { number: 'BRKT-2', type: 'Service', taxable_override: null };
    const [d] = salesTaxWorksheet(MAR, data, FACTS).documents;
    expect(d.lines.map((l) => [l.item, l.taxable, l.known])).toEqual([['Item 9998', true, true], ['BRKT-2', true, true], ['Line 2', true, false]]);
  });
});

describe('a return held against its worksheet', () => {
  const w = salesTaxWorksheet(MAR, month(MARCH, {
    account: { opening: '0', before: '0', moves: [], books: '0', others: others(), next: others([{ id: '7102', type: 'TaxPymt', number: null, date: '2025-04-15', memo: null, name: null, amount: '-10.69' }]) },
  }), FACTS);
  const row = (over: Partial<SalesTaxReturnRow> = {}): SalesTaxReturnRow => ({
    company: 'BMG', month: MAR, filed_on: '2025-04-18', gross_cents: '81100', adjustments_cents: -68500, taxable_cents: 12600, tax_cents: 1069,
    allowance_cents: 21, paid_cents: 1048, note: null, ...over,
  });

  it("reads a return's days without their times", () => {
    expect(readReturn(row({ month: '2025-03-01T00:00:00', filed_on: '2025-04-18T00:00:00' }))).toMatchObject({ month: MAR, filedOn: '2025-04-18', gross: 81100 });
  });

  it('matches when the return says what the worksheet does', () => {
    const held = holdReturn(readReturn(row()), w.figures, w.accounts);
    expect(held).toMatchObject({ filedOn: '2025-04-18', due: '2025-04-21', late: false, clearedNext: 1069, notes: [] });
    expect(held.fields.map((f) => [f.field, f.filed, f.expected, f.differs])).toEqual([
      ['gross', 81100, 81100, false], ['adjustments', -68500, -68500, false], ['taxable', 12600, 12600, false],
      ['tax', 1069, 1069, false], ['allowance', 21, 21, false], ['paid', 1048, 1048, false],
    ]);
  });

  it('says how far each figure is from the worksheet\'s', () => {
    const held = holdReturn(readReturn(row({ gross_cents: 80000, taxable_cents: 13600, tax_cents: 1154, allowance_cents: 23, paid_cents: 1131 })), w.figures, w.accounts);
    expect(held.fields.filter((f) => f.differs).map((f) => f.field)).toEqual(['gross', 'taxable', 'tax']);
    expect(held.notes).toEqual([
      'Gross receipts on the return are $11.00 less than the worksheet\'s.',
      'Taxable sales on the return are $10.00 more than the worksheet\'s.',
      'Tax on the return is $0.85 more than the worksheet\'s.',
      "The return's gross receipts and adjustments come to $115.00, not its taxable sales of $136.00.",
      "NetSuite's sales tax account came down $10.69 in April 2025, and the return's tax is $11.54.",
    ]);
  });

  it('holds the allowance to 2% of the return\'s tax, and to none when it was filed late', () => {
    expect(holdReturn(readReturn(row({ allowance_cents: 50, paid_cents: 1019 })), w.figures, w.accounts).notes)
      .toEqual(["The timely payment allowance is 2% of the return's tax, $0.21, and the return took $0.50."]);
    // Filed on the day it's due is on time.
    expect(holdReturn(readReturn(row({ filed_on: '2025-04-21' })), w.figures, w.accounts)).toMatchObject({ late: false, notes: [] });
    const late = holdReturn(readReturn(row({ filed_on: '2025-04-22' })), w.figures, w.accounts);
    expect(late).toMatchObject({ late: true });
    expect(late.fields.find((f) => f.field === 'allowance')).toMatchObject({ expected: 0, differs: true });
    expect(late.notes).toEqual(['It was filed Apr 22, 2025, after it was due on Apr 21, 2025, and a late return gets no timely payment allowance unless that day was a holiday.']);
    // Filed late, no allowance, and the penalty paid.
    expect(holdReturn(readReturn(row({ filed_on: '2025-05-02', allowance_cents: 0, paid_cents: 1169 })), w.figures, w.accounts).notes)
      .toEqual(['What was paid is $1.00 more than the tax less the allowance, as penalties or interest would be.']);
    expect(holdReturn(readReturn(row({ paid_cents: 1000 })), w.figures, w.accounts).notes)
      .toEqual(['What was paid is $0.48 less than the tax less the allowance.']);
  });

  it('says when nothing has come off NetSuite\'s sales tax account for it yet', () => {
    const none = salesTaxWorksheet(MAR, month(MARCH), FACTS);
    expect(holdReturn(readReturn(row()), none.figures, none.accounts).notes).toEqual(["Nothing came off NetSuite's sales tax account in April 2025 for it yet."]);
    // Without the accounts, there's nothing to say about them.
    expect(holdReturn(readReturn(row()), none.figures, null).notes).toEqual([]);
  });

  it("holds nothing against the return's tax while the worksheet can't work it out", () => {
    const rates = readRates([{ location_id: '1', starts_on: '2025-03-15', rate_pct: '8.488', note: null }]);
    const open = salesTaxWorksheet(MAR, month(MARCH), { ...FACTS, rates });
    const held = holdReturn(readReturn(row()), open.figures, null);
    expect(held.fields.find((f) => f.field === 'tax')).toMatchObject({ filed: 1069, expected: null, differs: false });
    expect(held.notes).toEqual([]);
  });
});
