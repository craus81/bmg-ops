import { describe, it, expect } from 'vitest';
import {
  CREDIT_CHECK_STATUSES, CREDIT_LINE_WORDS, checkOwnCreditMemo, checkOwnCreditMemos,
  type NetsuiteCreditMemoData, type OwnCreditLineData, type OwnCreditMemoData, type OwnCreditPairData,
} from './own-credit-memo-check';
import { costLinesText, ownLists, type NetsuiteLineData } from './own-invoice-check';

const ACME = 'c0000000-0000-4000-8000-00000000000a';

const LISTS = ownLists({
  items: {
    55: { number: 'SHELF-1', type: 'InvtPart' },
    56: { number: 'LABOR', type: 'Service' },
    57: { number: 'LIGHT-2', type: 'InvtPart' },
    58: { number: 'DISCOUNT', type: 'Discount' },
    90: { number: 'SUBTOTAL', type: 'Subtotal' },
    91: { number: 'SHIPPING', type: 'ShipItem' },
    900: { number: 'CREDIT', type: 'OthCharge' },
  },
  tax_codes: { 77: { name: 'MO St Charles', rate: '8.488%' }, 78: { name: 'MO Other', rate: '8.238%' } },
  locations: { 1: "O'Fallon", 2: 'Wentzville' },
});

// Books' own copy of CM10001, made against INV2401: a shelf back on the shelf, with its tax, and an hour of labor.
const ownLine = (over: Partial<OwnCreditLineData> = {}): OwnCreditLineData => ({
  line_no: 1, invoice_line: 1, item_id: '55', item_number: 'SHELF-1', description: null, quantity: '1.0000', rate: '125.5000',
  amount: '125.50', taxable: true, tax: '10.65', back_to_stock: true, on_credit_item: false, ...over,
});
const LABOR_LINE = ownLine({
  line_no: 2, invoice_line: 2, item_id: '56', item_number: 'LABOR', rate: '95.0000', amount: '95.00', taxable: false, tax: '0.00', back_to_stock: false,
});

const own = (over: Partial<OwnCreditMemoData> = {}): OwnCreditMemoData => ({
  netsuite_id: '8001', number: 'CM10001', invoice_id: '5001', invoice_number: 'INV2401', made_from_id: null,
  customer_netsuite_id: '9001', customer_id: ACME, date: '2026-10-22', location_id: '1', reason: 'Returned',
  tax_rule: 'credit_tax@1', tax_rate: '0.084880', tax_rate_from: 'invoice', subtotal: '220.50', tax: '10.65', total: '231.15',
  made_at: '2026-10-22T15:00:00Z', lines: [ownLine(), LABOR_LINE], ...over,
});

// NetSuite's credit memo as the ledger mirror copies it: its amounts unsigned, its net amounts its own, a credited sale positive.
const nsLine = (
  lineId: string, kind: string, itemId: string | null, amount: string, netamount: string | null, quantity: string | null = null,
  rate: string | null = null, cost = false,
): NetsuiteLineData => ({
  line_id: lineId, line_no: Number(lineId), kind, item_id: itemId, item_number: null, description: null, quantity, rate, amount, netamount, cost,
});
const SHELF_NS = nsLine('1', 'item', '55', '125.50', '125.50', '1', '125.5');
const LABOR_NS = nsLine('2', 'item', '56', '95.00', '95.00', '1', '95');
const taxNs = (amount: string, code = '77') => nsLine('9', 'tax', code, amount, amount);

const netsuite = (over: Partial<NetsuiteCreditMemoData> = {}): NetsuiteCreditMemoData => ({
  number: 'CM10001', date: '2026-10-22', total: '231.15', customer_netsuite_id: '9001', customer_name: 'Acme Fleet Services',
  memo: null, status: 'Fully Applied', voided: false, deleted: false, lines_copied: true, changed_at: null, copied_at: null,
  lines: [SHELF_NS, LABOR_NS, taxNs('10.65')], ...over,
});

const pair = (over: Partial<OwnCreditPairData> = {}): OwnCreditPairData => ({
  own: own(), netsuite: netsuite(), netsuite_gl: { location_id: '1' }, customer_name: 'Acme Fleet', ...over,
});

const check = (over: Partial<OwnCreditPairData> = {}) => checkOwnCreditMemo(pair(over), LISTS);
const field = (c: ReturnType<typeof checkOwnCreditMemo>, f: string) => c.fields.find((x) => x.field === f)!;

const WORKED_OUT = [
  'Made against INV2401 on Oct 22, 2026.',
  'Its lines are the ones FleetSuite sent NetSuite: each line of the invoice it credits at the quantity and price picked, '
    + 'or the amount, and any amount of its own on the credit item.',
  "Sales tax given back at 8.488%, the invoice's own rate, on the lines the invoice taxed, each line's rounded to the cent.",
  "Its location is the invoice's: NetSuite makes the credit memo from the invoice.",
  "SHELF-1 goes back on the shelf: what that's worth posts apart from the credit, as NetSuite's credit memo's cost lines do, under What it put back on the shelf.",
];

describe("an own credit memo next to NetSuite's", () => {
  it('matches when everything compared is the same', () => {
    const c = check();
    expect(c).toMatchObject({
      netsuiteId: '8001', number: 'CM10001', date: '2026-10-22', invoiceId: '5001', invoiceNumber: 'INV2401', reason: 'Returned',
      customer: 'Acme Fleet', status: 'matches', summary: "Matches NetSuite's credit memo.", differing: 0,
      fleetsuiteTotal: 23115, netsuiteTotal: 23115, backToStock: 1,
    });
    expect(c.fields.map((f) => [f.label, f.fleetsuite, f.netsuite, f.same, f.why])).toEqual([
      ['Customer', 'Acme Fleet', 'Acme Fleet Services', true, null],
      ['Date', 'Oct 22, 2026', 'Oct 22, 2026', true, null],
      ['Location', "O'Fallon", "O'Fallon", true, null],
      ['Lines', '2 lines', '2 lines', true, null],
      ['Before tax', '$220.50', '$220.50', true, null],
      ['Sales tax', '$10.65', '$10.65', true, null],
      ['Total', '$231.15', '$231.15', true, null],
    ]);
    expect(c.lines[0]).toEqual({
      item: 'SHELF-1', itemId: '55',
      fleetsuite: { lineNo: 1, description: null, quantity: 1, rate: 125.5, cents: 12550, priced: true, taxable: true, taxCents: 1065 },
      netsuite: { lineId: '1', description: null, quantity: 1, rate: 125.5, cents: 12550 },
      same: true, why: null,
    });
    expect(c.workedOut).toEqual(WORKED_OUT);
  });

  it("leaves out NetSuite's lines that book the cost of the stock that came back, lines that never post and lines of nothing", () => {
    const c = check({
      netsuite: netsuite({
        lines: [
          SHELF_NS, nsLine('3', 'item', '-2', '220.50', null), nsLine('4', 'item', '90', '220.50', '220.50'), nsLine('5', 'other', null, '0.00', '0'),
          LABOR_NS, nsLine('6', 'item', '55', '60.00', '-60.00', null, null, true), nsLine('7', 'item', '55', '60.00', '60.00', null, null, true),
          taxNs('10.65'),
        ],
      }),
    });
    expect(c).toMatchObject({ status: 'matches', differing: 0 });
    expect(c.lines.map((l) => l.netsuite?.lineId)).toEqual(['1', '2']);
    expect(c.workedOut).toEqual([...WORKED_OUT, costLinesText(2, "NetSuite's credit memo", 'that came back')]);
    expect(c.workedOut[5]).toBe(
      "NetSuite's credit memo books the cost of the stock that came back on 2 lines of its own, which aren't compared here: that cost posts under Stock and cost.",
    );
    // Taken for what was credited, the cost lines would make it differ.
    const counted = check({ netsuite: netsuite({ lines: [SHELF_NS, LABOR_NS, nsLine('6', 'item', '55', '60.00', '60.00'), taxNs('10.65')] }) });
    expect(counted.status).toBe('differs');
  });

  it("waits for NetSuite's credit memo, then its lines, then its posting", () => {
    const before = check({ netsuite: null, netsuite_gl: null });
    expect(before).toMatchObject({
      status: 'waiting', netsuiteTotal: null, lines: [], customer: 'Acme Fleet',
      summary: "Waiting for NetSuite's credit memo: the ledger mirror copies NetSuite's credit memos every two hours.",
    });
    expect(before.fields.every((f) => f.same === null && f.why === null)).toBe(true);

    const unlined = check({ netsuite: netsuite({ lines_copied: false, lines: [] }) });
    expect(unlined).toMatchObject({ status: 'waiting', summary: "Waiting for NetSuite's lines: the credit memo is copied, its lines aren't yet.", lines: [] });
    expect(field(unlined, 'lines')).toMatchObject({ same: null, netsuite: null, why: "NetSuite's lines aren't copied yet." });
    expect([field(unlined, 'subtotal').same, field(unlined, 'tax').same, field(unlined, 'total').same]).toEqual([null, null, true]);

    const unposted = check({ netsuite_gl: null });
    expect(unposted).toMatchObject({ status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the credit memo." });
    expect(field(unposted, 'location')).toMatchObject({ same: null, netsuite: null, why: "The copy of NetSuite's general ledger doesn't have the credit memo yet." });
  });

  it('says when NetSuite voided or deleted its credit memo', () => {
    expect(check({ netsuite: netsuite({ voided: true }) })).toMatchObject({ status: 'voided', summary: "NetSuite's credit memo was voided." });
    expect(check({ netsuite: netsuite({ deleted: true }) })).toMatchObject({ status: 'voided', summary: "NetSuite's credit memo is gone from NetSuite." });
    // Gone or voided is said before anything not yet copied.
    expect(check({ netsuite: netsuite({ deleted: true, lines_copied: false }), netsuite_gl: null }).status).toBe('voided');
  });

  it('says how the customer, the date and the location differ', () => {
    const other = check({ netsuite: netsuite({ customer_netsuite_id: '9002', customer_name: 'Other Fleet' }) });
    expect(other).toMatchObject({ status: 'differs', differing: 1, summary: "Customer: NetSuite's credit memo is for another customer." });
    expect(field(other, 'customer')).toMatchObject({ fleetsuite: 'Acme Fleet', netsuite: 'Other Fleet', same: false });

    expect(field(check({ netsuite: netsuite({ date: '2026-10-24' }) }), 'date')).toMatchObject({
      netsuite: 'Oct 24, 2026', same: false, why: "FleetSuite made it Oct 22, 2026, and NetSuite's credit memo is dated 2 days later.",
    });
    expect(field(check({ netsuite: netsuite({ date: '2026-10-21' }) }), 'date').why)
      .toBe("FleetSuite made it Oct 22, 2026, and NetSuite's credit memo is dated 1 day earlier.");

    const moved = check({ netsuite_gl: { location_id: '2' } });
    expect(moved).toMatchObject({
      status: 'differs', differing: 1,
      summary: "Location: FleetSuite's copy has the invoice's location, O'Fallon, and NetSuite's credit memo books to Wentzville.",
    });
    expect(field(check({ own: own({ location_id: null }), netsuite_gl: { location_id: '2' } }), 'location')).toMatchObject({
      fleetsuite: 'None', netsuite: 'Wentzville', same: false,
      why: "FleetSuite's copy has the invoice's location, none, and NetSuite's credit memo books to Wentzville.",
    });
    expect(field(check({ netsuite_gl: { location_id: null } }), 'location')).toMatchObject({
      netsuite: 'None', same: false, why: "FleetSuite's copy has the invoice's location, O'Fallon, and NetSuite's credit memo books to no location.",
    });
    expect(field(check({ netsuite_gl: { location_id: '5' } }), 'location').netsuite).toBe('Location 5');

    // The first that differs leads, the others after it.
    expect(check({ netsuite: netsuite({ date: '2026-10-24' }), netsuite_gl: { location_id: '2' } }).summary)
      .toBe("Date: FleetSuite made it Oct 22, 2026, and NetSuite's credit memo is dated 2 days later. The location differs too.");
  });

  it("pairs the lines and says how each differs, in a credit memo's words", () => {
    expect(CREDIT_LINE_WORDS).toEqual({ did: 'credited', do: 'credit', doc: 'credit memo' });
    const two = check({ netsuite: netsuite({ total: '367.30', lines: [nsLine('1', 'item', '55', '251.00', '251.00', '2', '125.5'), LABOR_NS, taxNs('21.30')] }) });
    expect(two).toMatchObject({ status: 'differs', differing: 4 });
    expect(two.lines[0]).toMatchObject({ same: false, why: 'FleetSuite credited 1 of SHELF-1 for $125.50, and NetSuite 2 for $251.00.' });
    expect(field(two, 'subtotal')).toMatchObject({ fleetsuite: '$220.50', netsuite: '$346.00', same: false, why: "NetSuite's is $125.50 more." });
    expect(field(two, 'total')).toMatchObject({ same: false, why: "NetSuite's is $136.15 more." });
    // What's before tax and the total follow from the lines and the tax, so the summary doesn't say them again.
    expect(two.summary).toBe('Lines: FleetSuite credited 1 of SHELF-1 for $125.50, and NetSuite 2 for $251.00. The sales tax differs too.');

    const less = check({ netsuite: netsuite({ total: '136.15', lines: [SHELF_NS, taxNs('10.65')] }) });
    expect(field(less, 'lines')).toMatchObject({ fleetsuite: '2 lines', netsuite: '1 line', same: false });
    expect(less.lines[1]).toMatchObject({ netsuite: null, same: false });
    expect(less.lines[1].why).toBe("FleetSuite credited LABOR ($95.00), and NetSuite's credit memo doesn't have it.");
    expect(field(less, 'subtotal').why).toBe("NetSuite's is $95.00 less.");

    const more = check({
      netsuite: netsuite({ total: '331.15', lines: [SHELF_NS, LABOR_NS, nsLine('3', 'item', '57', '100.00', '100.00', '1', '100'), taxNs('10.65')] }),
    });
    expect(more.lines[2]).toMatchObject({ fleetsuite: null, same: false });
    expect(more.lines[2].why).toBe("NetSuite's credit memo has LIGHT-2 ($100.00), and FleetSuite didn't credit it.");

    // Two lines that differ: the first is named, and the other counted.
    const both = check({
      netsuite: netsuite({ total: '410.15', lines: [nsLine('1', 'item', '55', '251.00', '251.00', '2', '125.5'), nsLine('2', 'item', '56', '190.00', '190.00', '2', '95'), taxNs('10.65')] }),
    });
    expect(field(both, 'lines').why).toBe('FleetSuite credited 1 of SHELF-1 for $125.50, and NetSuite 2 for $251.00. 1 other line differs.');
  });

  it('says when NetSuite put shipping or handling on its credit memo', () => {
    const shipped = check({ netsuite: netsuite({ total: '246.15', lines: [SHELF_NS, LABOR_NS, nsLine('3', 'item', '91', '15.00', '15.00'), taxNs('10.65')] }) });
    expect(shipped.status).toBe('differs');
    expect(shipped.lines[2]).toMatchObject({
      item: 'SHIPPING', fleetsuite: null, same: false,
      why: "NetSuite added SHIPPING ($15.00) to the credit memo as shipping or handling, and FleetSuite's copy doesn't have it.",
    });
    expect(shipped.summary).toBe("Lines: NetSuite added SHIPPING ($15.00) to the credit memo as shipping or handling, and FleetSuite's copy doesn't have it.");
  });

  it('explains a sales tax given back that differs, in what each took back', () => {
    // NetSuite also gave back tax on the labor: $95.00 at 8.488% is $8.06.
    const labor = check({ netsuite: netsuite({ total: '239.21', lines: [SHELF_NS, LABOR_NS, taxNs('18.71')] }) });
    expect(labor).toMatchObject({ status: 'differs', differing: 2, summary: "Sales tax: NetSuite also taxed LABOR ($95.00), which FleetSuite doesn't tax." });
    expect(field(labor, 'tax')).toMatchObject({ fleetsuite: '$10.65', netsuite: '$18.71', same: false });
    expect(field(labor, 'subtotal').same).toBe(true);

    // NetSuite's rate isn't the invoice's.
    const rate = check({ netsuite: netsuite({ total: '230.84', lines: [SHELF_NS, LABOR_NS, taxNs('10.34', '78')] }) });
    expect(field(rate, 'tax').why).toBe("NetSuite's rate is 8.238% and FleetSuite's 8.488%, the invoice's own rate.");

    // A copy that gave back no tax: the lines NetSuite taxed are looked for at NetSuite's rate.
    const untaxedOwn = own({ tax_rate: '0', tax_rate_from: 'untaxed', tax: '0.00', total: '220.50', lines: [ownLine({ taxable: false, tax: '0.00' }), LABOR_LINE] });
    expect(field(check({ own: untaxedOwn }), 'tax').why).toBe("NetSuite also taxed SHELF-1 ($125.50), which FleetSuite doesn't tax.");

    // Nothing explains it: each one's is said, in a credit memo's words.
    expect(field(check({ netsuite: netsuite({ total: '231.16', lines: [SHELF_NS, LABOR_NS, taxNs('10.66')] }) }), 'tax').why)
      .toBe('NetSuite took back $10.66 and FleetSuite worked out $10.65.');
  });

  it("can't compare the tax or what's before it when NetSuite's tax line can't be read", () => {
    const c = check({ netsuite: netsuite({ lines: [SHELF_NS, LABOR_NS, nsLine('9', 'tax', '77', 'n/a', null)] }) });
    expect(field(c, 'tax')).toMatchObject({ netsuite: null, same: null, why: null });
    expect(field(c, 'subtotal')).toMatchObject({ netsuite: null, same: null });
    expect(field(c, 'total').same).toBe(true);
    expect(c.status).toBe('matches');
  });

  it('takes a discount credited back as money off, by its own sign or by the item, and one NetSuite spread apart', () => {
    const discount = ownLine({
      line_no: 3, invoice_line: 4, item_id: '58', item_number: 'DISCOUNT', quantity: null, rate: null, amount: '-13.00', taxable: true, tax: '-1.10',
      back_to_stock: false,
    });
    const base = own({ lines: [ownLine(), LABOR_LINE, discount], subtotal: '207.50', tax: '9.55', total: '217.05' });
    const signed = check({ own: base, netsuite: netsuite({ total: '217.05', lines: [SHELF_NS, LABOR_NS, nsLine('3', 'item', '58', '13.00', '-13.00'), taxNs('9.55')] }) });
    expect(signed.status).toBe('matches');
    // Before the copy of NetSuite's item list has the discount, only NetSuite's own sign says it's money off.
    const unlisted = ownLists({ items: { 55: { number: 'SHELF-1', type: 'InvtPart' }, 56: { number: 'LABOR', type: 'Service' } }, tax_codes: {}, locations: {} });
    const bySign = checkOwnCreditMemo(pair({
      own: base, netsuite: netsuite({ total: '217.05', lines: [SHELF_NS, LABOR_NS, nsLine('3', 'item', '58', '13.00', '-13.00'), taxNs('9.55')] }),
    }), unlisted);
    expect(bySign.status).toBe('matches');
    expect(bySign.lines[2].netsuite?.cents).toBe(-1300);
    const unsigned = check({ own: base, netsuite: netsuite({ total: '217.05', lines: [SHELF_NS, LABOR_NS, nsLine('3', 'item', '58', '13.00', null), taxNs('9.55')] }) });
    expect(unsigned.status).toBe('matches');
    expect(unsigned.lines[2].netsuite?.cents).toBe(-1300);

    // NetSuite spread the discount over the shelf: the shelf at its quantity times its price, the discount at the difference.
    const spread = check({
      own: base,
      netsuite: netsuite({ total: '217.05', lines: [nsLine('1', 'item', '55', '112.50', '112.50', '1', '125.5'), LABOR_NS, nsLine('3', 'item', '58', '0.00', '0.00', null, '-13'), taxNs('9.55')] }),
    });
    expect(spread.status).toBe('matches');
    expect(spread.lines.map((l) => [l.item, l.netsuite?.cents])).toEqual([['SHELF-1', 12550], ['LABOR', 9500], ['DISCOUNT', -1300]]);
    expect(spread.workedOut).toContain("NetSuite spread DISCOUNT over the lines it applies to, so NetSuite's lines are taken at their quantities times their prices, "
      + 'and DISCOUNT at the difference.');
  });

  it('says how it worked out the tax, and which lines came back on the shelf or went on the credit item', () => {
    const untaxed = check({
      own: own({ tax_rate: '0', tax_rate_from: 'untaxed', subtotal: '95.00', tax: '0.00', total: '95.00', lines: [LABOR_LINE] }),
      netsuite: netsuite({ total: '95.00', lines: [LABOR_NS] }),
    });
    expect(untaxed).toMatchObject({ status: 'matches', backToStock: 0 });
    expect(untaxed.workedOut).toEqual([...WORKED_OUT.slice(0, 2), 'No sales tax given back: none of the lines it credits was taxed on the invoice.', WORKED_OUT[3]]);

    expect(check({ own: own({ tax_rate_from: 'worked_out' }) }).workedOut[2])
      .toBe("Sales tax given back at 8.488%, worked out from the invoice's sales tax, on the lines the invoice taxed, each line's rounded to the cent.");
    expect(check({ own: own({ tax_rate_from: 'tax_code' }) }).workedOut[2])
      .toBe("Sales tax given back at 8.488%, the rate of the invoice's tax code, on the lines the invoice taxed, each line's rounded to the cent.");

    const light = ownLine({ line_no: 3, invoice_line: 5, item_id: '57', item_number: 'LIGHT-2', rate: '100.0000', amount: '100.00', tax: '8.49' });
    const two = check({ own: own({ lines: [ownLine(), LABOR_LINE, light] }) });
    expect(two.backToStock).toBe(2);
    expect(two.workedOut[4]).toBe("SHELF-1 and LIGHT-2 go back on the shelf: what that's worth posts apart from the credit, as NetSuite's credit memo's cost lines do, under What it put back on the shelf.");

    const onCredit = (lineNo: number, amount: string) => ownLine({
      line_no: lineNo, invoice_line: lineNo === 1 ? 1 : null, item_id: '900', item_number: 'CREDIT', quantity: null, rate: null, amount,
      taxable: false, tax: '0.00', back_to_stock: false, on_credit_item: true,
    });
    const oneCredit = check({ own: own({ lines: [onCredit(1, '125.50'), LABOR_LINE] }) });
    expect(oneCredit.backToStock).toBe(0);
    expect(oneCredit.workedOut[4]).toBe('1 line goes on the credit item, so no part comes back for it.');
    expect(check({ own: own({ lines: [onCredit(1, '125.50'), onCredit(3, '25.00')] }) }).workedOut[4])
      .toBe('2 lines go on the credit item, so no part comes back for them.');
  });

  it("names the credit memo by NetSuite's number when FleetSuite didn't get one, else by its id, and the invoice the same way", () => {
    expect(check({ own: own({ number: null }) }).number).toBe('CM10001');
    expect(check({ own: own({ number: null }), netsuite: null }).number).toBe('NetSuite 8001');
    const c = check({ own: own({ invoice_number: null }) });
    expect(c.invoiceNumber).toBe('NetSuite invoice 5001');
    expect(c.workedOut[0]).toBe('Made against NetSuite invoice 5001 on Oct 22, 2026.');
  });

  it("names the customer as FleetSuite has them, else as NetSuite's credit memo has them", () => {
    expect(check({ customer_name: null }).customer).toBe('Acme Fleet Services');
    expect(check({ customer_name: null, netsuite: null }).customer).toBeNull();
    expect(field(check({ customer_name: null }), 'customer').fleetsuite).toBe('NetSuite customer 9001');
    expect(field(check({ own: own({ customer_netsuite_id: null }) }), 'customer')).toMatchObject({ fleetsuite: 'None', same: false });
  });

  it("checks a month's copies and counts them by status", () => {
    expect(CREDIT_CHECK_STATUSES).toEqual(['differs', 'waiting', 'matches', 'voided']);
    const r = checkOwnCreditMemos({
      credit_memos: [pair(), pair({ netsuite: null }), pair({ netsuite: netsuite({ voided: true }) }), pair({ netsuite_gl: { location_id: '2' } })],
      items: {}, tax_codes: {}, locations: {},
    });
    expect(r.counts).toEqual({ differs: 1, waiting: 1, matches: 1, voided: 1 });
    expect(r.creditMemos.map((c) => c.status)).toEqual(['matches', 'waiting', 'voided', 'differs']);
    expect(checkOwnCreditMemos({ credit_memos: null as never, items: {}, tax_codes: {}, locations: {} })).toEqual({
      creditMemos: [], counts: { differs: 0, waiting: 0, matches: 0, voided: 0 },
    });
  });
});
