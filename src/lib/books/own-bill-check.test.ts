import { describe, it, expect } from 'vitest';
import {
  billLists,
  checkOwnBill,
  checkOwnBills,
  netsuiteBillLines,
  type BillCopiesThrough,
  type BillPairData,
  type BillPairsData,
  type NetsuiteBillData,
  type OwnBillData,
} from './own-bill-check';

const SUBCONTRACTORS = '611';
const RACK = '9001';
const BIN = '9002';
const SUBTOTAL = '9100';

const MADE_AT = '2026-10-21T15:00:00.000Z';
const LATER = '2026-10-21T17:00:00.000Z';
const EARLIER = '2026-10-21T13:00:00.000Z';
/** Neither copy has run since the bill was made. */
const BEFORE: BillCopiesThrough = { bills: EARLIER, ledger: EARLIER };
/** Both have. */
const SINCE: BillCopiesThrough = { bills: LATER, ledger: LATER };

const lists = billLists({
  accounts: { [SUBCONTRACTORS]: { number: '61100', name: 'Subcontractors' }, '612': { number: '61200', name: 'Repairs' } },
  items: {
    [RACK]: { number: 'RACK-48', type: 'InvtPart', display_name: 'Ladder rack' },
    [BIN]: { number: 'BIN-10', type: 'InvtPart', display_name: null },
    [SUBTOTAL]: { number: 'Subtotal', type: 'Subtotal', display_name: null },
  },
});

/** A CNI vendor invoice's bill: one line to Subcontractors. */
const expenseBill = (over: Partial<OwnBillData> = {}): OwnBillData => ({
  netsuite_id: '8801',
  number: 'VI-1042',
  company: 'BMG',
  made_from: 'vendor_invoice',
  made_from_id: 'inv-1',
  vendor_id: '412',
  vendor_name: 'Northside Install Co.',
  reference_no: 'VI-1042',
  date: '2026-10-21',
  po_id: null,
  po_number: null,
  location_id: '1',
  invoice_total: null,
  unknowns: [],
  made_at: MADE_AT,
  lines: [{ line_no: 1, account_id: SUBCONTRACTORS, item_id: null, item_number: null, description: 'Install', quantity: null, rate: null, amount: '1250.00', po_line_id: null }],
  ...over,
});

/** NetSuite's bill as the bills copy has it, its lines signed the way NetSuite gives them. */
const netsuite = (over: Partial<NetsuiteBillData> = {}): NetsuiteBillData => ({
  number: 'VI-1042',
  type: 'VendBill',
  date: '2026-10-21',
  vendor_id: '412',
  vendor_name: 'Northside Install Co.',
  total: '1250.00',
  status: 'A',
  voided: false,
  gone: false,
  lines: [{ line_id: '1', item: null, account: SUBCONTRACTORS, amount: '-1250.00', own_amount: '-1250.00', quantity: null, memo: 'Install', tax: false }],
  companies: ['BMG'],
  ...over,
});

/** A Parts Mail bill made from PO453-ACME: 12 racks and 3 bins. */
const partsMailBill = (over: Partial<OwnBillData> = {}): OwnBillData => expenseBill({
  netsuite_id: '8802',
  number: 'INV-5521',
  made_from: 'parts_mail',
  made_from_id: 'parts-1',
  vendor_id: '77',
  vendor_name: 'Acme Truck Racks',
  reference_no: 'INV-5521',
  po_id: '5001',
  po_number: 'PO453-ACME',
  location_id: null,
  invoice_total: '2199.97',
  lines: [
    { line_no: 1, account_id: null, item_id: RACK, item_number: 'RACK-48', description: 'Ladder rack', quantity: '12.0000', rate: '178.3333', amount: '2140.00', po_line_id: '2' },
    { line_no: 2, account_id: null, item_id: BIN, item_number: 'BIN-10', description: null, quantity: '3.0000', rate: '19.9900', amount: '59.97', po_line_id: '3' },
  ],
  ...over,
});

const partsMailNetsuite = (over: Partial<NetsuiteBillData> = {}): NetsuiteBillData => netsuite({
  number: 'INV-5521',
  vendor_id: '77',
  vendor_name: 'Acme Truck Racks',
  total: '2199.97',
  lines: [
    { line_id: '1', item: RACK, account: '210', amount: '2140.00', own_amount: '2140.00', quantity: '12', tax: false },
    { line_id: '2', item: BIN, account: '210', amount: '59.97', own_amount: '59.97', quantity: '3', tax: false },
    { line_id: '3', item: SUBTOTAL, account: null, amount: '2199.97', quantity: null, tax: false },
  ],
  ...over,
});

const pair = (own: OwnBillData, ns: NetsuiteBillData | null): BillPairData => ({ own, netsuite: ns });
const field = (check: ReturnType<typeof checkOwnBill>, name: string) => check.fields.find((f) => f.field === name)!;

describe("NetSuite's bill lines", () => {
  it('leaves out tax and layout lines, and turns them so they add up to the total the right way round', () => {
    const ns = netsuite({
      lines: [
        { line_id: '1', item: null, account: SUBCONTRACTORS, amount: '-1000.00', own_amount: '-1000.00', quantity: null, tax: false },
        { line_id: '2', item: RACK, account: '210', amount: '-250.00', own_amount: null, quantity: '-2', tax: false },
        { line_id: '3', item: null, account: '220', amount: '-80.00', quantity: null, tax: true },
        { line_id: '4', item: SUBTOTAL, account: null, amount: '-1250.00', quantity: null, tax: false },
      ],
    });
    expect(netsuiteBillLines(ns, lists.items)).toEqual([
      { key: `account:${SUBCONTRACTORS}`, item: null, account: SUBCONTRACTORS, quantity: null, cents: 100000 },
      { key: `item:${RACK}`, item: RACK, account: null, quantity: 2, cents: 25000 },
    ]);
  });

  it("can't be read when the copy couldn't read them, or one has no amount", () => {
    expect(netsuiteBillLines(netsuite({ lines: null }), lists.items)).toBeNull();
    expect(netsuiteBillLines(netsuite({ lines: [{ line_id: '1', item: null, account: SUBCONTRACTORS, amount: null, quantity: null }] }), lists.items)).toBeNull();
  });
});

describe("checking Books' own bill", () => {
  it("matches NetSuite's bill line for line, once its ledger copy says the company", () => {
    const check = checkOwnBill(pair(expenseBill(), netsuite()), lists, SINCE);
    expect(check).toMatchObject({
      status: 'matches', summary: "Matches NetSuite's bill.", differing: 0, fleetsuiteCents: 125000, netsuiteCents: 125000,
      number: 'VI-1042', vendor: 'Northside Install Co.', madeFromText: 'a CNI vendor invoice', company: 'BMG', poId: null,
    });
    expect(check.fields.map((f) => [f.field, f.same])).toEqual([
      ['vendor', true], ['number', true], ['date', true], ['company', true], ['lines', true], ['total', true],
    ]);
    expect(check.lines).toEqual([{
      label: '61100 Subcontractors', description: 'Install', fleetsuite: { quantity: null, cents: 125000 }, netsuite: { quantity: null, cents: 125000 },
      same: true, why: null,
    }]);
    expect(check.workedOut[0]).toBe('Made by Create Bill in NetSuite on a CNI vendor invoice on Oct 21, 2026.');
    expect(check.workedOut[1]).toBe('One line: $1,250.00 to 61100 Subcontractors, as FleetSuite sent it.');
  });

  it("waits for NetSuite's bill, then for its ledger copy, and is gone once the bills copy has run since without it", () => {
    expect(checkOwnBill(pair(expenseBill(), null), lists, BEFORE)).toMatchObject({
      status: 'waiting', summary: "Waiting for NetSuite's bill: the copy of NetSuite's bills runs every two hours.", netsuiteCents: null,
    });
    expect(checkOwnBill(pair(expenseBill(), netsuite({ companies: [] })), lists, { bills: LATER, ledger: EARLIER })).toMatchObject({
      status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to say which company it's booked to.",
    });
    // The ledger copy has run since without an entry for it.
    expect(checkOwnBill(pair(expenseBill(), netsuite({ companies: [] })), lists, SINCE).status).toBe('incomplete');
    expect(checkOwnBill(pair(expenseBill(), null), lists, SINCE)).toMatchObject({
      status: 'voided', summary: "NetSuite's bill is gone from NetSuite: the copy of its bills, made since, doesn't have it.",
    });
    expect(checkOwnBill(pair(expenseBill(), netsuite({ voided: true })), lists, SINCE)).toMatchObject({ status: 'voided', summary: "NetSuite's bill is voided." });
    expect(checkOwnBill(pair(expenseBill(), netsuite({ gone: true })), lists, SINCE)).toMatchObject({ status: 'voided', netsuiteCents: null });
  });

  it('says what differs first, and what else differs too', () => {
    const recoded = netsuite({
      vendor_id: '413', vendor_name: 'Northside Installs LLC',
      lines: [{ line_id: '1', item: null, account: '612', amount: '-1250.00', own_amount: '-1250.00', quantity: null, tax: false }],
    });
    const check = checkOwnBill(pair(expenseBill(), recoded), lists, SINCE);
    expect(check.status).toBe('differs');
    expect(check.summary).toBe('Vendor: FleetSuite billed Northside Install Co., and NetSuite\'s bill is from Northside Installs LLC. The lines differ too.');
    expect(field(check, 'lines')).toMatchObject({
      same: false,
      why: "Books' copy has 61100 Subcontractors for $1,250.00, and NetSuite's bill has no line for it. 1 other line differs.",
    });
    // The total follows from the lines, and matches here.
    expect(field(check, 'total').same).toBe(true);
    expect(check.lines.map((l) => [l.label, l.same])).toEqual([['61100 Subcontractors', false], ['61200 Repairs', false]]);
    expect(check.differing).toBe(2);
  });

  it('tells a different amount, number, date and company apart', () => {
    const check = checkOwnBill(pair(expenseBill(), netsuite({
      number: 'VI-1043', date: '2026-10-23', total: '1300.00', companies: ['1084'],
      lines: [{ line_id: '1', item: null, account: SUBCONTRACTORS, amount: '-1300.00', own_amount: '-1300.00', quantity: null, tax: false }],
    })), lists, SINCE);
    expect(field(check, 'number')).toMatchObject({ same: false, why: "NetSuite's bill is numbered VI-1043 now. It was VI-1042 when FleetSuite made it." });
    expect(field(check, 'date')).toMatchObject({ same: false, why: "FleetSuite made it Oct 21, 2026, and NetSuite's bill is dated 2 days later." });
    expect(field(check, 'company')).toMatchObject({ same: false, netsuite: '1084', why: 'FleetSuite made it for BMG, and NetSuite books it to 1084.' });
    expect(check.lines[0].why).toBe("61100 Subcontractors: Books' copy says $1,250.00, and NetSuite's bill $1,300.00. NetSuite's is $50.00 more.");
    expect(field(check, 'total')).toMatchObject({ same: false, why: "NetSuite's is $50.00 more." });
    // The total isn't named on its own when the lines differ.
    expect(check.summary).toBe("Number: NetSuite's bill is numbered VI-1043 now. It was VI-1042 when FleetSuite made it. The date, the company and the lines differ too.");
  });

  it('reads a bill number as two people might type it', () => {
    expect(field(checkOwnBill(pair(expenseBill(), netsuite({ number: 'vi 1042' })), lists, SINCE), 'number').same).toBe(true);
  });

  it("pairs a Parts Mail bill's items, leaving out NetSuite's layout lines", () => {
    const check = checkOwnBill(pair(partsMailBill(), partsMailNetsuite()), lists, SINCE);
    expect(check).toMatchObject({ status: 'matches', fleetsuiteCents: 219997, netsuiteCents: 219997, invoiceCents: 219997, poNumber: 'PO453-ACME', poId: '5001' });
    expect(check.lines.map((l) => [l.label, l.fleetsuite, l.netsuite, l.same])).toEqual([
      ['RACK-48', { quantity: 12, cents: 214000 }, { quantity: 12, cents: 214000 }, true],
      ['BIN-10', { quantity: 3, cents: 5997 }, { quantity: 3, cents: 5997 }, true],
    ]);
    expect(check.workedOut).toEqual([
      'Made by Create bill on a Parts Mail invoice on Oct 21, 2026, from PO453-ACME.',
      "NetSuite bills a purchase order at its own prices, so the lines are what FleetSuite's copy of PO453-ACME still had to bill, each at the PO's price, to the cent.",
      "The vendor's invoice says $2,199.97.",
      'Dated the day FleetSuite made it, in Central time: FleetSuite sends NetSuite no date for a bill, so NetSuite dates it that day.',
    ]);
  });

  it("tells another quantity, and an item only one side has", () => {
    const ns = partsMailNetsuite({
      total: '1840.00',
      lines: [
        { line_id: '1', item: RACK, account: '210', amount: '1783.33', own_amount: '1783.33', quantity: '10', tax: false },
        { line_id: '4', item: '9003', account: '210', amount: '56.67', quantity: '1', tax: false },
      ],
    });
    const check = checkOwnBill(pair(partsMailBill(), ns), lists, SINCE);
    expect(check.status).toBe('differs');
    expect(check.lines.map((l) => [l.label, l.same, l.why])).toEqual([
      ['RACK-48', false, "Books' copy bills 12 of RACK-48, and NetSuite's bill 10. RACK-48: Books' copy says $2,140.00, and NetSuite's bill $1,783.33. NetSuite's is $356.67 less."],
      ['BIN-10', false, "Books' copy has BIN-10 for $59.97, and NetSuite's bill has no line for it."],
      ['NetSuite item 9003', false, "NetSuite's bill has NetSuite item 9003 for $56.67, and Books' copy has no line for it."],
    ]);
    expect(check.summary).toMatch(/^Lines: Books' copy bills 12 of RACK-48, .* 2 other lines differ\.$/);
  });

  it("is incomplete when FleetSuite didn't know the lines or a price, and compares the rest", () => {
    const noLines = checkOwnBill(pair(partsMailBill({ lines: [], unknowns: ['lines'] }), partsMailNetsuite()), lists, SINCE);
    expect(noLines).toMatchObject({ status: 'incomplete', fleetsuiteCents: null });
    expect(noLines.summary).toBe("Matches where it can be checked. FleetSuite didn't know what it billed (FleetSuite's copy of the purchase order didn't have the order).");
    expect(field(noLines, 'lines')).toMatchObject({ same: null, fleetsuite: null });
    expect(noLines.lines.every((l) => l.same === null)).toBe(true);

    const unpriced = partsMailBill({
      unknowns: ['prices'],
      lines: [{ ...partsMailBill().lines[0] }, { ...partsMailBill().lines[1], rate: null, amount: null }],
    });
    const check = checkOwnBill(pair(unpriced, partsMailNetsuite()), lists, SINCE);
    expect(check.status).toBe('incomplete');
    expect(check.lines[1]).toMatchObject({ same: null, why: "FleetSuite had no price for BIN-10, so its amount isn't compared." });
    expect(field(check, 'total')).toMatchObject({ same: null, fleetsuite: null });
    // A quantity that differs still differs.
    const fewer = partsMailNetsuite({ lines: [partsMailNetsuite().lines![0], { ...partsMailNetsuite().lines![1], quantity: '2' }] });
    expect(checkOwnBill(pair(unpriced, fewer), lists, SINCE).status).toBe('differs');
  });

  it("names a payout's bill and one with no number", () => {
    const payout = checkOwnBill(pair(expenseBill({ made_from: 'payout', number: null, reference_no: 'PP-3F2A91C0' }), null), lists, BEFORE);
    expect(payout).toMatchObject({ number: 'PP-3F2A91C0', madeFromText: 'an installer payout' });
    expect(checkOwnBill(pair(expenseBill({ number: null, reference_no: null }), null), lists, BEFORE).number).toBe('NetSuite 8801');
  });
});

describe('checking a month of them', () => {
  it('counts each status', () => {
    const data: BillPairsData = {
      bills: [pair(expenseBill(), netsuite()), pair(expenseBill({ netsuite_id: '8803' }), null), pair(partsMailBill(), partsMailNetsuite({ total: '1.00' }))],
      accounts: { [SUBCONTRACTORS]: { number: '61100', name: 'Subcontractors' } },
      items: { [RACK]: { number: 'RACK-48', type: 'InvtPart', display_name: null }, [BIN]: { number: 'BIN-10', type: 'InvtPart', display_name: null } },
    };
    const { bills, counts } = checkOwnBills(data, { bills: EARLIER, ledger: LATER });
    expect(bills.map((b) => b.status)).toEqual(['matches', 'waiting', 'differs']);
    expect(counts).toEqual({ differs: 1, incomplete: 0, waiting: 1, matches: 1, voided: 0 });
  });
});
