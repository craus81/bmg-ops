import { describe, it, expect } from 'vitest';
import {
  checkOwnInvoice,
  checkOwnInvoices,
  dayText,
  explainTax,
  ownLists,
  pairLines,
  parseRate,
  pct,
  takeApartSpread,
  taxFlips,
  type NetsuiteInvoiceData,
  type NetsuiteLineData,
  type OwnInvoiceData,
  type OwnLineData,
  type OwnPairData,
  type TaxSides,
} from './own-invoice-check';

const ACME = 'c0000000-0000-4000-8000-00000000000a';

const LISTS = ownLists({
  items: {
    55: { number: 'SHELF-1', type: 'InvtPart' },
    56: { number: 'LABOR', type: 'Service' },
    58: { number: 'DISCOUNT', type: 'Discount' },
    61: { number: 'TOW-1', type: 'NonInvtPart' },
    90: { number: 'SUBTOTAL', type: 'Subtotal' },
  },
  tax_codes: { 77: { name: 'MO St Charles', rate: '8.488%' }, 78: { name: 'MO Other', rate: '8.238%' }, 79: { name: 'No rate', rate: null } },
  locations: { 1: "O'Fallon", 2: 'Wentzville', 5: 'Social Circle' },
});

const ownLine = (over: Partial<OwnLineData> = {}): OwnLineData => ({
  line_no: 1, item_id: '55', item_number: 'SHELF-1', description: null, quantity: '2', rate: '125.5', amount: '251.00',
  priced: true, taxable: true, tax: '21.30', sales_order_line_id: null, ...over,
});
const LABOR_LINE = ownLine({ line_no: 2, item_id: '56', item_number: 'LABOR', quantity: '3', rate: '95', amount: '285.00', taxable: false, tax: '0.00' });

const own = (over: Partial<OwnInvoiceData> = {}): OwnInvoiceData => ({
  netsuite_id: '5001', number: 'INV2401', made_from: 'po', made_from_id: 'po-1', sales_order_id: null,
  customer_netsuite_id: '9001', customer_id: ACME, date: '2026-10-20', location_id: '1', location_from: 'sent',
  po_number: 'PO-77', memo: null, vin: null, terms_id: '4', terms_name: 'Net 30', terms_days: 30, due_date: '2026-11-19',
  tax_rule: 'tax@1', tax_basis: 'rate', tax_rate: '0.084880', subtotal: '536.00', tax: '21.30', total: '557.30',
  lines_from: 'sent', unknowns: [], made_at: '2026-10-20T15:00:00Z', lines: [ownLine(), LABOR_LINE], ...over,
});

const nsLine = (lineId: string, kind: string, itemId: string | null, amount: string, netamount: string | null, quantity: string | null = null, rate: string | null = null): NetsuiteLineData => ({
  line_id: lineId, line_no: Number(lineId), kind, item_id: itemId, item_number: null, description: null, quantity, rate, amount, netamount,
});
const SHELF_NS = nsLine('1', 'item', '55', '251.00', '-251.00', '2', '125.5');
const LABOR_NS = nsLine('2', 'item', '56', '285.00', '-285.00', '3', '95');
const taxNs = (amount: string, code = '77') => nsLine('9', 'tax', code, amount, `-${amount}`);

const netsuite = (over: Partial<NetsuiteInvoiceData> = {}): NetsuiteInvoiceData => ({
  number: 'INV2401', date: '2026-10-20', due_date: '2026-11-19', total: '557.30', customer_netsuite_id: '9001',
  customer_name: 'Acme Fleet Services', po_number: 'PO-77', memo: null, status: 'Open', voided: false, deleted: false,
  lines_copied: true, changed_at: null, copied_at: null, lines: [SHELF_NS, LABOR_NS, taxNs('21.30')], ...over,
});

const pair = (over: Partial<OwnPairData> = {}): OwnPairData => ({
  own: own(), netsuite: netsuite(), netsuite_gl: { location_id: '1' }, customer_name: 'Acme Fleet',
  customer_list: { terms_id: '4', taxable: 'T' }, ...over,
});

const check = (over: Partial<OwnPairData> = {}) => checkOwnInvoice(pair(over), LISTS);
const field = (c: ReturnType<typeof checkOwnInvoice>, f: string) => c.fields.find((x) => x.field === f)!;

describe('an own invoice next to NetSuite\'s', () => {
  it('matches when everything compared is the same', () => {
    const c = check();
    expect(c).toMatchObject({
      netsuiteId: '5001', number: 'INV2401', date: '2026-10-20', madeFrom: 'po', madeFromText: "a PO's open quantities",
      customer: 'Acme Fleet', status: 'matches', summary: "Matches NetSuite's invoice.", differing: 0,
      fleetsuiteTotal: 55730, netsuiteTotal: 55730, unknowns: [],
    });
    expect(c.fields.map((f) => [f.label, f.fleetsuite, f.netsuite, f.same, f.why])).toEqual([
      ['Customer', 'Acme Fleet', 'Acme Fleet Services', true, null],
      ['Date', 'Oct 20, 2026', 'Oct 20, 2026', true, null],
      ['Location', "O'Fallon", "O'Fallon", true, null],
      ['Due', 'Nov 19, 2026 (Net 30)', 'Nov 19, 2026', true, null],
      ['Lines', '2 lines', '2 lines', true, null],
      ['Before tax', '$536.00', '$536.00', true, null],
      ['Sales tax', '$21.30', '$21.30', true, null],
      ['Total', '$557.30', '$557.30', true, null],
    ]);
    expect(c.lines[0]).toEqual({
      item: 'SHELF-1', itemId: '55',
      fleetsuite: { lineNo: 1, description: null, quantity: 2, rate: 125.5, cents: 25100, priced: true, taxable: true, taxCents: 2130 },
      netsuite: { lineId: '1', description: null, quantity: 2, rate: 125.5, cents: 25100 },
      same: true, why: null,
    });
    expect(c.workedOut).toEqual([
      "Made from a PO's open quantities on Oct 20, 2026.",
      'Its lines are the ones FleetSuite sent NetSuite, at the prices it sent.',
      "Sales tax at 8.488%, the rate in Settings → Sales Tax, on the lines FleetSuite taxes (not service items), each line's rounded to the cent.",
      "Due 30 days after its date: Net 30, the customer's terms in NetSuite.",
      'Its location is the one FleetSuite gave NetSuite.',
    ]);
  });

  it('says when the copy is the invoice as FleetSuite fixed it', () => {
    const c = check({ own: own({ lines_from: 'fixed' }) });
    expect(c.status).toBe('matches');
    expect(c.workedOut[1]).toBe(
      "Fixed in FleetSuite: its date and lines are the invoice's as FleetSuite fixed it, the lines it kept as NetSuite had them and the ones it changed or added as FleetSuite sent them.",
    );
  });

  it('leaves out NetSuite\'s lines that never post and its lines of nothing', () => {
    const c = check({
      netsuite: netsuite({
        lines: [SHELF_NS, nsLine('3', 'item', '-2', '536.00', null), nsLine('4', 'item', '90', '536.00', '-536.00'), nsLine('5', 'other', null, '0.00', '0'), LABOR_NS, taxNs('21.30')],
      }),
    });
    expect(c.status).toBe('matches');
    expect(c.lines.map((l) => l.netsuite?.lineId)).toEqual(['1', '2']);
  });

  it('waits for NetSuite\'s invoice, then its lines, then its posting', () => {
    const before = check({ netsuite: null, netsuite_gl: null });
    expect(before).toMatchObject({
      status: 'waiting', netsuiteTotal: null, lines: [], customer: 'Acme Fleet',
      summary: "Waiting for NetSuite's invoice: the ledger mirror copies NetSuite's invoices every two hours.",
    });
    expect(before.fields.every((f) => f.same === null)).toBe(true);

    expect(check({ netsuite: netsuite({ lines_copied: false, lines: [] }) })).toMatchObject({
      status: 'waiting', summary: "Waiting for NetSuite's lines: the invoice is copied, its lines aren't yet.", lines: [],
    });
    expect(field(check({ netsuite: netsuite({ lines_copied: false, lines: [] }) }), 'lines').why).toBe("NetSuite's lines aren't copied yet.");

    const unposted = check({ netsuite_gl: null });
    expect(unposted).toMatchObject({ status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the invoice." });
    expect(field(unposted, 'location')).toMatchObject({ same: null, netsuite: null, why: "The copy of NetSuite's general ledger doesn't have the invoice yet." });
  });

  it('says when NetSuite voided or deleted its invoice', () => {
    expect(check({ netsuite: netsuite({ voided: true }) })).toMatchObject({ status: 'voided', summary: "NetSuite's invoice was voided." });
    expect(check({ netsuite: netsuite({ deleted: true }) })).toMatchObject({ status: 'voided', summary: "NetSuite's invoice is gone from NetSuite." });
  });

  it('names a line NetSuite taxed and FleetSuite didn\'t, and which total is more', () => {
    // 285.00 at 8.488% is 24.19.
    const c = check({ netsuite: netsuite({ total: '581.49', lines: [SHELF_NS, LABOR_NS, taxNs('45.49')] }) });
    expect(c).toMatchObject({
      status: 'differs', differing: 2, netsuiteTotal: 58149,
      // The total differs only because the tax does, so the summary doesn't say it again.
      summary: "Sales tax: NetSuite also taxed LABOR ($285.00), which FleetSuite doesn't tax.",
    });
    expect(field(c, 'subtotal').same).toBe(true);
    expect(field(c, 'tax')).toMatchObject({ same: false, fleetsuite: '$21.30', netsuite: '$45.49' });
    expect(field(c, 'total')).toMatchObject({ same: false, why: "NetSuite's is $24.19 more." });
  });

  it('names NetSuite\'s rate when it isn\'t the one in Settings', () => {
    // 251.00 at 8.238% is 20.68.
    const c = check({ netsuite: netsuite({ total: '556.68', lines: [SHELF_NS, LABOR_NS, taxNs('20.68', '78')] }) });
    expect(field(c, 'tax').why).toBe("NetSuite's rate is 8.238% and FleetSuite's 8.488%, from Settings → Sales Tax.");
    expect(field(c, 'total').why).toBe("NetSuite's is $0.62 less.");
  });

  it('explains a customer NetSuite doesn\'t tax', () => {
    const c = check({ netsuite: netsuite({ total: '536.00', lines: [SHELF_NS, LABOR_NS] }), customer_list: { taxable: 'F' } });
    expect(field(c, 'tax').why).toBe(
      'NetSuite has Acme Fleet as not taxable, so it charged no sales tax, and FleetSuite taxes them. '
      + 'If they are tax-exempt, mark them so on their FleetSuite customer record.',
    );
  });

  it('says how the date, due date, customer and location differ', () => {
    const c = check({
      own: own({ location_from: 'rule' }),
      netsuite: netsuite({ date: '2026-10-21', due_date: '2026-11-17', customer_netsuite_id: '9002', customer_name: 'Bravo Transit' }),
      netsuite_gl: { location_id: '2' },
    });
    expect(c.status).toBe('differs');
    expect(field(c, 'customer')).toMatchObject({ same: false, netsuite: 'Bravo Transit', why: "NetSuite's invoice is for another customer." });
    expect(field(c, 'date').why).toBe("FleetSuite made it Oct 20, 2026, and NetSuite's invoice is dated 1 day later.");
    expect(field(c, 'due_date').why).toBe(
      "FleetSuite's is 30 days after the invoice's date (Net 30, the customer's terms in NetSuite), and NetSuite's is 2 days earlier.",
    );
    expect(field(c, 'location').why).toBe("FleetSuite's invoice location rule puts it in O'Fallon, and NetSuite's invoice took Wentzville from its sales order.");
    expect(c.summary).toBe("Customer: NetSuite's invoice is for another customer. The date, the location and the due date differ too.");
    expect(c.workedOut[4]).toBe("Its location is FleetSuite's invoice location rule's, from the customer: NetSuite took the sales order's.");

    const nowhere = check({ netsuite_gl: { location_id: null } });
    expect(field(nowhere, 'location')).toMatchObject({
      same: false, netsuite: 'None', why: "FleetSuite gave NetSuite O'Fallon, and NetSuite's invoice books to no location.",
    });
  });

  it('pairs the lines by item and says how each differs', () => {
    const c = check({
      own: own({
        lines: [ownLine(), LABOR_LINE, ownLine({ line_no: 3, item_id: '61', item_number: 'TOW-1', quantity: '1', rate: '50', amount: '50.00', tax: '4.24' })],
        subtotal: '586.00', tax: '25.54', total: '611.54',
      }),
      netsuite: netsuite({
        total: '432.50',
        lines: [
          nsLine('1', 'item', '55', '125.50', '-125.50', '1', '125.5'),
          nsLine('2', 'item', '56', '285.00', '-285.00', '3', '95'),
          nsLine('4', 'item', '70', '10.00', '-10.00', '1', '10'),
          taxNs('12.00'),
        ],
      }),
    });
    expect(c.lines.map((l) => [l.item, l.same, l.why])).toEqual([
      ['SHELF-1', false, 'FleetSuite billed 2 of SHELF-1 for $251.00, and NetSuite 1 for $125.50.'],
      ['LABOR', true, null],
      ['TOW-1', false, "FleetSuite billed TOW-1 ($50.00), and NetSuite's invoice doesn't have it."],
      ['NetSuite item 70', false, "NetSuite's invoice has NetSuite item 70 ($10.00), and FleetSuite didn't bill it."],
    ]);
    expect(field(c, 'lines')).toMatchObject({
      same: false, fleetsuite: '3 lines', netsuite: '3 lines',
      why: 'FleetSuite billed 2 of SHELF-1 for $251.00, and NetSuite 1 for $125.50. 2 other lines differ.',
    });
    // What's before tax and the total differ because the lines do; the tax as well, so it's named.
    expect(c.summary).toBe('Lines: FleetSuite billed 2 of SHELF-1 for $251.00, and NetSuite 1 for $125.50. 2 other lines differ. The sales tax differs too.');
    const unpricedGone = check({
      own: own({ lines: [ownLine(), { ...LABOR_LINE, rate: null, amount: '0.00', priced: false }], unknowns: ['prices'], subtotal: '251.00', total: '272.30' }),
      netsuite: netsuite({ total: '272.30', lines: [SHELF_NS, taxNs('21.30')] }),
    });
    expect(unpricedGone.lines[1].why).toBe("FleetSuite billed LABOR, and NetSuite's invoice doesn't have it.");
    expect(unpricedGone.summary).toBe("Lines: FleetSuite billed LABOR, and NetSuite's invoice doesn't have it.");
  });

  it('takes NetSuite\'s discount as money off, by its own sign or by the item', () => {
    const discount = ownLine({ line_no: 2, item_id: '58', item_number: 'DISCOUNT', quantity: null, rate: null, amount: '-20.00', tax: '-1.70' });
    const base = { lines: [ownLine(), discount], subtotal: '231.00', tax: '19.60', total: '250.60' };
    const signed = check({ own: own(base), netsuite: netsuite({ total: '250.60', lines: [SHELF_NS, nsLine('2', 'item', '58', '20.00', '20.00'), taxNs('19.60')] }) });
    expect(signed.status).toBe('matches');
    const unsigned = check({ own: own(base), netsuite: netsuite({ total: '250.60', lines: [SHELF_NS, nsLine('2', 'item', '58', '20.00', null), taxNs('19.60')] }) });
    expect(unsigned.status).toBe('matches');
    expect(unsigned.lines[1].netsuite?.cents).toBe(-2000);
  });

  it('matches a discount NetSuite spread over the line it applies to', () => {
    const discount = ownLine({ line_no: 3, item_id: '58', item_number: 'DISCOUNT', quantity: null, rate: null, amount: '-20.00', taxable: false, tax: '0.00' });
    const spreadNs = [SHELF_NS, nsLine('2', 'item', '56', '265.00', '-265.00', '3', '95'), nsLine('3', 'item', '58', '0.00', '0.00', null, '20'), taxNs('21.30')];
    const c = check({
      own: own({ lines: [ownLine(), LABOR_LINE, discount], subtotal: '516.00', total: '537.30' }),
      netsuite: netsuite({ total: '537.30', lines: spreadNs }),
    });
    expect(c.status).toBe('matches');
    expect(c.lines.map((l) => l.netsuite?.cents)).toEqual([25100, 28500, -2000]);
    expect(c.workedOut).toContain("NetSuite spread DISCOUNT over the lines it applies to, so NetSuite's lines are taken at their quantities times their prices, "
      + 'and DISCOUNT at the difference.');
    // Without the discount's line FleetSuite's labor is $20 more than NetSuite's.
    const noDiscount = check({ own: own({ lines: [ownLine(), LABOR_LINE], total: '557.30' }), netsuite: netsuite({ total: '537.30', lines: spreadNs }) });
    expect(noDiscount.status).toBe('differs');
    expect(noDiscount.workedOut.some((w) => w.startsWith('NetSuite spread'))).toBe(true);
  });

  it('is incomplete when what matches can\'t be all of it', () => {
    const c = check({ own: own({ unknowns: ['location'], location_id: null, location_from: null }) });
    expect(c).toMatchObject({
      status: 'incomplete', unknowns: ['which location it books to'],
      summary: "Matches where it can be checked. FleetSuite didn't know which location it books to.",
    });
    expect(field(c, 'location')).toMatchObject({
      same: null, fleetsuite: null, why: "FleetSuite didn't know which location it books to: its invoice location rule couldn't tell from the customer.",
    });
    expect(c.workedOut[4]).toBe("Its location isn't known.");
  });

  it('leaves the money uncompared when FleetSuite didn\'t know a price, and says what NetSuite charged', () => {
    const unpriced = ownLine({ line_no: 2, item_id: '56', item_number: 'LABOR', quantity: '3', rate: null, amount: '0.00', priced: false, taxable: false, tax: '0.00' });
    const c = check({ own: own({ lines: [ownLine(), unpriced], unknowns: ['prices'], subtotal: '251.00', total: '272.30' }) });
    expect(c.status).toBe('incomplete');
    expect(c.lines[1]).toMatchObject({ same: true, why: 'NetSuite priced LABOR at $285.00.' });
    for (const f of ['subtotal', 'tax', 'total']) {
      expect(field(c, f)).toMatchObject({ same: null, fleetsuite: null, why: "FleetSuite didn't know the price of a line NetSuite priced itself." });
    }
    expect(field(c, 'total').netsuite).toBe('$557.30');
  });

  it('compares nothing of the lines when FleetSuite didn\'t know them', () => {
    const c = check({
      own: own({ lines: [], unknowns: ['lines', 'location'], location_id: null, location_from: null, subtotal: '0.00', tax: '0.00', total: '0.00', lines_from: 'sales_order_copy', made_from: 'vehicle' }),
    });
    expect(c.status).toBe('incomplete');
    expect(c.lines).toEqual([]);
    expect(field(c, 'lines')).toMatchObject({
      same: null, fleetsuite: null, netsuite: '2 lines',
      why: "FleetSuite didn't know the lines it billed (FleetSuite's copy of the sales order didn't have the order yet).",
    });
    expect(c.summary).toBe(
      "Matches where it can be checked. FleetSuite didn't know the lines it billed (FleetSuite's copy of the sales order didn't have the order yet) and which location it books to.",
    );
    expect(c.workedOut.slice(0, 2)).toEqual([
      'Made from a finished vehicle on Oct 20, 2026.',
      "Its lines are what FleetSuite's copy of the sales order still had to bill: NetSuite billed the order whole.",
    ]);
  });

  it('says how it worked out tax and terms for Georgia, a tax-exempt customer and a customer with no terms', () => {
    const georgia = check({ own: own({ tax_basis: 'georgia', tax_rate: '0.000000', terms_name: null, terms_id: null, terms_days: 0, due_date: '2026-10-20' }) });
    expect(georgia.workedOut[2]).toBe("No sales tax: work at Social Circle, Georgia isn't taxed.");
    expect(georgia.workedOut[3]).toBe('Due when billed: the customer has no terms in NetSuite.');
    expect(field(georgia, 'due_date').fleetsuite).toBe('Oct 20, 2026 (no terms: due when billed)');
    const exempt = check({ own: own({ tax_basis: 'exempt_customer', tax_rate: '0.000000', terms_name: null, terms_id: null, terms_days: null, due_date: null, unknowns: ['terms'] }) });
    expect(exempt.workedOut[2]).toBe('No sales tax: the customer is tax-exempt in FleetSuite.');
    expect(exempt.workedOut[3]).toBe("Its due date isn't known: the customer's terms weren't.");
    expect(field(exempt, 'due_date')).toMatchObject({ same: null, fleetsuite: null, why: "FleetSuite didn't know the customer's terms, so its due date." });
  });

  it('names the invoice by NetSuite\'s number when FleetSuite didn\'t get one, else by its id', () => {
    expect(check({ own: own({ number: null }) }).number).toBe('INV2401');
    expect(check({ own: own({ number: null }), netsuite: null }).number).toBe('NetSuite 5001');
  });

  it('checks a month\'s copies and counts them by status', () => {
    const r = checkOwnInvoices({
      invoices: [pair(), pair({ netsuite: null }), pair({ netsuite: netsuite({ voided: true }) })],
      items: {}, tax_codes: {}, locations: {}, terms: {},
    });
    expect(r.counts).toEqual({ differs: 0, incomplete: 0, waiting: 1, matches: 1, voided: 1 });
    expect(r.invoices.map((i) => i.status)).toEqual(['matches', 'waiting', 'voided']);
  });
});

describe('explaining a sales tax that differs', () => {
  const lines: TaxSides['lines'] = [
    { item: 'SHELF-1', cents: 25100, taxable: true, priced: true },
    { item: 'LABOR', cents: 28500, taxable: false, priced: true },
    { item: 'TOW-1', cents: 5000, taxable: false, priced: true },
  ];
  const sides = (over: Partial<TaxSides>): TaxSides => ({
    lines, fleetsuite: 2130, rate: 0.08488, basis: 'rate', netsuite: 2130, netsuiteRate: 0.08488, customer: 'Acme Fleet', customerTaxable: true, ...over,
  });

  it('says nothing when they agree', () => {
    expect(explainTax(sides({}))).toBeNull();
  });

  it('names FleetSuite\'s reason for charging none', () => {
    expect(explainTax(sides({ fleetsuite: 0, basis: 'georgia' }))).toBe("FleetSuite doesn't tax work at Social Circle, Georgia, and NetSuite charged $21.30.");
    expect(explainTax(sides({ fleetsuite: 0, basis: 'exempt_customer' }))).toBe('FleetSuite has Acme Fleet as tax-exempt, and NetSuite charged $21.30.');
    expect(explainTax(sides({ fleetsuite: 0, basis: 'exempt_customer', customer: null }))).toBe('FleetSuite has this customer as tax-exempt, and NetSuite charged $21.30.');
  });

  it('names the lines taxed the other way, two or more as a list', () => {
    // 50.00 at 8.488% is 4.24; LABOR's 24.19.
    expect(explainTax(sides({ netsuite: 2130 + 2419 + 424 }))).toBe("NetSuite also taxed LABOR ($285.00) and TOW-1 ($50.00), which FleetSuite doesn't tax.");
    expect(explainTax(sides({ netsuite: 2419 }))).toBe(
      "NetSuite also taxed LABOR ($285.00), which FleetSuite doesn't tax. NetSuite didn't tax SHELF-1 ($251.00), which FleetSuite taxes.",
    );
    expect(explainTax(sides({ netsuite: 0, netsuiteRate: null }))).toBe("NetSuite didn't tax SHELF-1 ($251.00), which FleetSuite taxes.");
  });

  it('says what each charged when no set of lines explains it', () => {
    expect(explainTax(sides({ netsuite: 2131 }))).toBe('NetSuite charged $21.31 and FleetSuite worked out $21.30.');
    const many = Array.from({ length: 13 }, (_, i) => ({ item: `P-${i}`, cents: 1000, taxable: true, priced: true }));
    expect(explainTax(sides({ lines: many, fleetsuite: 1105, netsuite: 0, netsuiteRate: null }))).toBe('NetSuite charged no sales tax.');
  });
});

describe('finding the lines taxed the other way', () => {
  const l = (cents: number, taxable: boolean, priced = true) => ({ cents, taxable, priced });

  it('finds none needed when the tax already agrees, and the fewest lines otherwise', () => {
    const lines = [l(10000, true), l(5000, false), l(5000, false)];
    expect(taxFlips(lines, 0.1, 1000)).toEqual([]);
    expect(taxFlips(lines, 0.1, 1500)).toEqual([lines[1]]);
    expect(taxFlips(lines, 0.1, 2000)).toEqual([lines[1], lines[2]]);
    expect(taxFlips(lines, 0.1, 500)).toEqual([lines[0], lines[1]]);
  });

  it('skips lines without a price or an amount, and gives up when nothing fits or there are too many lines', () => {
    const lines = [l(10000, true), l(0, false), l(7000, false, false)];
    expect(taxFlips(lines, 0.1, 0)).toEqual([lines[0]]);
    expect(taxFlips(lines, 0.1, 333)).toBeNull();
    expect(taxFlips(Array.from({ length: 13 }, () => l(100, true)), 0.1, 0)).toBeNull();
  });
});

describe('taking apart a discount NetSuite spread over lines', () => {
  const TYPES: Record<string, string> = { 55: 'InvtPart', 56: 'Service', 58: 'Discount', 59: 'Markup' };
  const typeOf = (id: string | null) => (id ? TYPES[id] ?? null : null);
  const line = (itemId: string | null, cents: number | null, quantity: number | null = null, rate: number | null = null) => ({ itemId, quantity, rate, cents });
  const shelf = line('55', 25100, 2, 125.5);

  it('takes each line at its quantity times its price, and the discount or markup at the difference', () => {
    const lines = [shelf, line('56', 26500, 3, 95), line('58', 0, null, 20)];
    const out = takeApartSpread(lines, typeOf);
    expect(out.lines.map((l) => l.cents)).toEqual([25100, 28500, -2000]);
    expect(out.spread).toBe(lines[2]);
    expect(out.lines[0]).toBe(shelf);
    const markup = takeApartSpread([shelf, line('56', 29925, 3, 95), line('59', 0)], typeOf);
    expect(markup.lines.map((l) => l.cents)).toEqual([25100, 28500, 1425]);
  });

  it('keeps a discount NetSuite didn\'t spread at its own amount', () => {
    const out = takeApartSpread([shelf, line('56', 26500, 3, 95), line('58', 0), line('58', -1000)], typeOf);
    expect(out.lines.map((l) => l.cents)).toEqual([25100, 28500, -2000, -1000]);
  });

  it('leaves the lines at their net amounts when it can\'t tell what each charged', () => {
    const labor = line('56', 26500, 3, 95);
    const cases = {
      noSpread: [shelf, labor, line('58', -2000)],
      twoSpreads: [shelf, labor, line('58', 0), line('59', 0)],
      noRate: [shelf, line('56', 26500, 3, null), line('58', 0)],
      noQuantity: [shelf, line('56', 26500, null, 95), line('58', 0)],
      unreadable: [shelf, line('56', null, 3, 95), line('58', 0)],
      credit: [shelf, line('56', -26500, 3, 95), line('58', 0)],
      nothingOff: [shelf, line('56', 28500, 3, 95), line('58', 0)],
      nothingOn: [shelf, line('56', 28500, 3, 95), line('59', 0)],
      discountAddingOn: [shelf, line('56', 30500, 3, 95), line('58', 0)],
      markupTakingOff: [shelf, labor, line('59', 0)],
    };
    for (const [name, lines] of Object.entries(cases)) {
      const out = takeApartSpread(lines, typeOf);
      expect({ name, same: out.lines === lines, spread: out.spread }).toEqual({ name, same: true, spread: null });
    }
  });
});

describe('pairing lines', () => {
  type Side<T> = T & { itemId: string | null; itemNumber: string | null };
  const name = (id: string | null, number: string | null) => number || `item ${id}`;
  const mine = (lineNo: number, cents: number, quantity: number | null = 1): Side<Parameters<typeof pairLines>[0][number]> => ({
    lineNo, itemId: '55', itemNumber: 'SHELF-1', description: null, quantity, rate: null, cents, priced: true, taxable: true, taxCents: 0,
  });
  const theirs = (lineId: string, cents: number | null, quantity: number | null = 1): Side<Parameters<typeof pairLines>[1][number]> => ({
    lineId, itemId: '55', itemNumber: null, description: null, quantity, rate: null, cents,
  });

  it('pairs a line at the same amount first, then the rest in order', () => {
    const pairs = pairLines([mine(1, 10000), mine(2, 25100)], [theirs('a', 25100), theirs('b', 10000)], name);
    expect(pairs.map((p) => [p.fleetsuite?.lineNo, p.netsuite?.lineId, p.same])).toEqual([[1, 'b', true], [2, 'a', true]]);
  });

  it('says how a quantity or an amount differs, or that NetSuite\'s couldn\'t be read', () => {
    expect(pairLines([mine(1, 25100, 2)], [theirs('a', 25000, 2)], name)[0].why).toBe('FleetSuite billed SHELF-1 for $251.00, and NetSuite for $250.00.');
    expect(pairLines([mine(1, 25100, 2)], [theirs('a', 25100, 3)], name)[0].why).toBe('FleetSuite billed 2 of SHELF-1, and NetSuite 3.');
    expect(pairLines([mine(1, 25100, 1.5)], [theirs('a', 25100, 1.5)], name)[0]).toMatchObject({ same: true, why: null });
    expect(pairLines([mine(1, 25100)], [theirs('a', null)], name)[0]).toMatchObject({ same: null, why: "NetSuite's amount for SHELF-1 couldn't be read." });
    expect(pairLines([mine(1, 25100, 2)], [theirs('a', null, 1)], name)[0]).toMatchObject({ same: false, why: "NetSuite's amount for SHELF-1 couldn't be read." });
    const extra = pairLines([], [theirs('a', null)], name)[0];
    expect(extra).toMatchObject({ item: 'item 55', fleetsuite: null, same: false, why: "NetSuite's invoice has item 55, and FleetSuite didn't bill it." });
  });
});

describe('reading NetSuite\'s words', () => {
  it('reads a tax code\'s rate as a fraction, with or without the percent sign', () => {
    expect(parseRate('8.488%')).toBeCloseTo(0.08488, 10);
    expect(parseRate(' 8.488 ')).toBeCloseTo(0.08488, 10);
    expect(parseRate('0%')).toBe(0);
    for (const bad of ['', null, undefined, 'n/a', '-1%']) expect(parseRate(bad)).toBeNull();
  });

  it('writes rates and days the way the pages read', () => {
    expect(pct(0.08488)).toBe('8.488%');
    expect(pct(0.0795)).toBe('7.95%');
    expect(pct(0)).toBe('0%');
    expect(dayText('2026-11-18')).toBe('Nov 18, 2026');
    expect(dayText('2027-01-01')).toBe('Jan 1, 2027');
  });

  it('keeps a tax code with no rate, and reads rates by tax code', () => {
    expect(LISTS.taxCodes.get('79')).toEqual({ name: 'No rate', rate: null });
    expect(LISTS.taxCodes.get('78')?.rate).toBeCloseTo(0.08238, 10);
  });
});
