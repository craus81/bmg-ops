import { describe, it, expect } from 'vitest';
import {
  checkOwnReceipt,
  checkOwnReceipts,
  receiptLists,
  type NetsuiteReceiptData,
  type OwnReceiptData,
  type ReceiptCopiesThrough,
  type ReceiptPairData,
} from './own-receipt-check';

const RACK = '9001';
const BIN = '9002';
const STRAP = '9003';
const HOOK = '9004';
const KEY = '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f60';

const MADE_AT = '2026-10-21T15:00:00.000Z';
const LATER = '2026-10-21T17:00:00.000Z';
const EARLIER = '2026-10-21T13:00:00.000Z';
/** Neither copy has run since the Receive. */
const BEFORE: ReceiptCopiesThrough = { stock: EARLIER, ledger: EARLIER };
/** Both have. */
const SINCE: ReceiptCopiesThrough = { stock: LATER, ledger: LATER };

const data = {
  items: {
    [RACK]: { number: 'RACK-48', type: 'InvtPart', display_name: 'Ladder rack' },
    [BIN]: { number: 'BIN-10', type: 'InvtPart', display_name: null },
    [STRAP]: { number: 'STRAP-2', type: 'NonInvtPart', display_name: null },
    [HOOK]: { number: 'HOOK-1', type: 'InvtPart', display_name: 'Cargo hook' },
  },
  locations: { '1': 'Main warehouse', '3': 'Van stock' },
};
const lists = receiptLists(data);

type OwnLine = OwnReceiptData['lines'][number];
const rackLine: OwnLine = { line_no: 1, item_id: RACK, item_number: 'RACK-48', description: 'Ladder rack', quantity: '12.0000', rate: '178.3333', po_line_id: '2', po_receipt_id: KEY };
const binLine: OwnLine = { line_no: 2, item_id: BIN, item_number: 'BIN-10', description: null, quantity: '4.0000', rate: '19.9900', po_line_id: '3', po_receipt_id: null };

/** A Receive of 12 racks and 4 bins against PO453-ACME. */
const own = (over: Partial<OwnReceiptData> = {}): OwnReceiptData => ({
  receipt_key: KEY,
  netsuite_id: '7101',
  number: 'IR-2288',
  company: 'BMG',
  po_id: '5001',
  po_number: 'PO453-ACME',
  vendor_id: '77',
  vendor_name: 'Acme Truck Racks',
  date: '2026-10-21',
  netsuite_error: null,
  unknowns: [],
  made_at: MADE_AT,
  lines: [rackLine, binLine],
  ...over,
});

type NetLine = NetsuiteReceiptData['lines'][number];
const rackNet: NetLine = { line_id: '1', company: 'BMG', item_id: RACK, location_id: '1', quantity: '12', moves_stock: true, value: '2140.00' };
const binNet: NetLine = { line_id: '2', company: 'BMG', item_id: BIN, location_id: '1', quantity: '4', moves_stock: true, value: '79.96' };

/** NetSuite's item receipt as the stock copy has it, valued from the ledger copy. */
const netsuite = (over: Partial<NetsuiteReceiptData> = {}): NetsuiteReceiptData => ({
  number: 'IR-2288',
  type: 'ItemRcpt',
  date: '2026-10-21',
  gone: false,
  lines: [rackNet, binNet],
  ...over,
});

const pair = (o: OwnReceiptData, ns: NetsuiteReceiptData | null, over: Partial<ReceiptPairData> = {}): ReceiptPairData => ({
  own: o,
  netsuite: ns,
  in_ledger: !!ns,
  receiving: { posted: 2, manual_needed: 0, manual_done: 0 },
  ...over,
});
const field = (check: ReturnType<typeof checkOwnReceipt>, name: string) => check.fields.find((f) => f.field === name)!;
const item = (check: ReturnType<typeof checkOwnReceipt>, name: string) => check.items.find((i) => i.item === name)!;

describe("checking Books' own receipt", () => {
  it("matches NetSuite's item receipt item for item, at the PO's prices", () => {
    const check = checkOwnReceipt(pair(own(), netsuite()), lists, SINCE);
    expect(check).toMatchObject({
      receiptKey: KEY, netsuiteId: '7101', number: 'IR-2288', poId: '5001', poNumber: 'PO453-ACME', vendor: 'Acme Truck Racks',
      location: 'Main warehouse', what: '2 items', status: 'matches', differing: 0, fleetsuiteCents: 221996, netsuiteCents: 221996,
      summary: "NetSuite's receipt IR-2288 has the same items, counts and cost.",
      netsuiteError: null, receiving: { posted: 2, manualNeeded: 0, manualDone: 0 }, unknowns: [],
    });
    expect(check.fields.map((f) => [f.field, f.fleetsuite, f.netsuite, f.same])).toEqual([
      ['date', 'Oct 21, 2026', 'Oct 21, 2026', true],
      ['company', 'BMG', 'BMG', true],
      ['items', '2 items', '2 items', true],
      ['cost', '$2,219.96', '$2,219.96', true],
    ]);
    expect(item(check, 'RACK-48')).toEqual({
      item: 'RACK-48', itemId: RACK, description: 'Ladder rack',
      fleetsuite: { quantity: 12, rate: 178.3333, cents: 214000, stock: true },
      netsuite: { quantity: 12, locations: ['Main warehouse'], movesStock: true, cents: 214000 },
      same: true, why: null,
    });
    expect(check.workedOut[0]).toBe('Made by Receive on the Receiving page on Oct 21, 2026, against PO453-ACME from Acme Truck Racks.');
    expect(check.workedOut[4]).toBe("It's kept for BMG: FleetSuite's copy of the purchase order doesn't say the company, and NetSuite makes the receipt in the PO's.");
  });

  it('says what came in, in a few words', () => {
    expect(checkOwnReceipt(pair(own({ lines: [rackLine] }), netsuite({ lines: [rackNet] })), lists, SINCE).what).toBe('12 RACK-48');
    const split = checkOwnReceipt(pair(
      own({ lines: [{ ...rackLine, quantity: '6' }, { ...rackLine, line_no: 2, quantity: '6', rate: '180' }] }),
      netsuite({ lines: [{ ...rackNet, location_id: '3', quantity: '6', value: '1070.00' }, { ...rackNet, line_id: '2', quantity: '6', value: '1080.00' }] }),
    ), lists, SINCE);
    expect(split).toMatchObject({ what: '12 RACK-48', location: 'Main warehouse and Van stock', status: 'matches', fleetsuiteCents: 215000 });
    // Two prices for the item: no one price each.
    expect(split.items[0].fleetsuite).toEqual({ quantity: 12, rate: null, cents: 215000, stock: true });
    expect(split.items[0].netsuite!.locations).toEqual(['Main warehouse', 'Van stock']);
  });

  it("names the receipt and the PO from NetSuite's when Books' copy doesn't have them", () => {
    const check = checkOwnReceipt(pair(own({ number: null, po_number: null, vendor_name: null }), netsuite({ number: 'IR-2290' })), lists, SINCE);
    expect(check).toMatchObject({ number: 'IR-2290', poNumber: 'NetSuite PO 5001', summary: "NetSuite's receipt IR-2290 has the same items, counts and cost." });
    expect(check.workedOut[0]).toBe('Made by Receive on the Receiving page on Oct 21, 2026, against NetSuite PO 5001.');
    expect(checkOwnReceipt(pair(own({ po_number: null, po_id: null }), null), lists, BEFORE).poNumber).toBe('A purchase order');
  });

  it("isn't checked without NetSuite's receipt: still to enter by hand, entered by hand, or NetSuite didn't say", () => {
    const refused = own({ netsuite_id: null, number: null, netsuite_error: 'Invalid line item' });
    const at = (receiving: ReceiptPairData['receiving']) => checkOwnReceipt(pair(refused, null, { receiving }), lists, SINCE);
    expect(at({ posted: 0, manual_needed: 2, manual_done: 0 })).toMatchObject({
      status: 'not_in_netsuite', summary: "NetSuite didn't take it, so it's on Receiving's list to enter by hand there.",
      netsuiteError: 'Invalid line item', number: null, location: null, netsuiteCents: null,
      receiving: { posted: 0, manualNeeded: 2, manualDone: 0 },
    });
    expect(at({ posted: 0, manual_needed: 0, manual_done: 2 })).toMatchObject({
      status: 'incomplete', summary: "Entered in NetSuite by hand. Receiving doesn't say which item receipt that is, so it isn't checked.",
    });
    expect(at({ posted: 2, manual_needed: 0, manual_done: 0 })).toMatchObject({
      status: 'incomplete', summary: "NetSuite took it but didn't say which item receipt it made, so it isn't checked.",
    });
    expect(at(null)).toMatchObject({
      status: 'incomplete', summary: "NetSuite didn't say which item receipt it made, and Receiving no longer has it, so it isn't checked.",
      receiving: { posted: 0, manualNeeded: 0, manualDone: 0 },
    });
    // What NetSuite said is kept only for one it didn't take.
    expect(checkOwnReceipt(pair(own({ netsuite_error: 'Invalid line item' }), netsuite()), lists, SINCE).netsuiteError).toBeNull();
  });

  it('waits for the copy of NetSuite\'s stock moves, and is gone once that ran since without it', () => {
    expect(checkOwnReceipt(pair(own(), null), lists, BEFORE)).toMatchObject({
      status: 'waiting', summary: "Waiting for NetSuite's receipt: the copy of NetSuite's stock moves runs every two hours.",
      netsuiteCents: null, fleetsuiteCents: 221996,
    });
    const missing = checkOwnReceipt(pair(own(), null), lists, SINCE);
    expect(missing).toMatchObject({
      status: 'voided', summary: "NetSuite's receipt is gone from NetSuite: the copy of its stock moves, made since, doesn't have it.",
    });
    expect(missing.fields.map((f) => f.same)).toEqual([null, null, null, null]);
    expect(missing.items.map((i) => [i.item, i.netsuite, i.same])).toEqual([['RACK-48', null, null], ['BIN-10', null, null]]);
    expect(checkOwnReceipt(pair(own(), netsuite({ gone: true })), lists, SINCE)).toMatchObject({
      status: 'voided', summary: "NetSuite's receipt is gone from NetSuite.", location: null, netsuiteCents: null,
    });
  });

  it("isn't checked when nothing on it is known to be kept in stock, as the stock copy never has one of those", () => {
    const strapLine: OwnLine = { ...rackLine, item_id: STRAP, item_number: 'STRAP-2', description: null, quantity: '5', rate: '3.00' };
    const unknownLine: OwnLine = { ...rackLine, item_id: '9999', item_number: 'LED-7', description: null, quantity: '2', rate: '25' };
    for (const lines of [[strapLine], [strapLine, unknownLine]]) {
      expect(checkOwnReceipt(pair(own({ lines }), null), lists, SINCE)).toMatchObject({
        status: 'incomplete',
        summary: "Nothing on it is known to be kept in stock, so NetSuite's receipt isn't in the copy of its stock moves to check against.",
      });
    }
  });

  it("waits for the copy of NetSuite's general ledger to value it, counting only a run that began after the Receive", () => {
    const justAfter: ReceiptCopiesThrough = { stock: LATER, ledger: '2026-10-21T15:05:00.000Z' };
    const check = checkOwnReceipt(pair(own(), netsuite(), { in_ledger: false }), lists, justAfter);
    expect(check).toMatchObject({
      status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the receipt.",
      location: 'Main warehouse', fleetsuiteCents: 221996, netsuiteCents: null, differing: 0,
    });
    expect(field(check, 'cost')).toMatchObject({ fleetsuite: '$2,219.96', netsuite: null, same: null, why: null });
    expect(item(check, 'RACK-48')).toMatchObject({ netsuite: { quantity: 12, cents: null }, same: null });
    // What came in differs before the ledger copy gets there: that's told now.
    expect(checkOwnReceipt(pair(own(), netsuite({ date: '2026-10-22' }), { in_ledger: false }), lists, justAfter).status).toBe('differs');
  });

  it('tells a receipt the ledger copy has run since without, as adding nothing to stock', () => {
    const check = checkOwnReceipt(pair(own(), netsuite({ lines: [{ ...rackNet, value: null }, { ...binNet, value: null }] }), { in_ledger: false }), lists, SINCE);
    expect(check).toMatchObject({ status: 'differs', differing: 1, netsuiteCents: 0 });
    expect(check.summary).toBe("Added to stock: NetSuite's receipt added nothing to stock: the copy of its general ledger, made since, has no entry for it.");
    expect(item(check, 'BIN-10').why).toBe("BIN-10 added $79.96 to stock in FleetSuite (4 at the PO's $19.99), and $0.00 in NetSuite. NetSuite's is $79.96 less.");
  });

  it('tells a different count, a missing item and an extra one', () => {
    const fewer = checkOwnReceipt(pair(own(), netsuite({ lines: [{ ...rackNet, quantity: '10', value: '1783.33' }, binNet] })), lists, SINCE);
    expect(fewer).toMatchObject({ status: 'differs', differing: 2, netsuiteCents: 186329 });
    // The cost follows from the count, so it isn't told about again.
    expect(fewer.summary).toBe("NetSuite's receipt IR-2288 has 10 of RACK-48. FleetSuite received 12.");
    expect(item(fewer, 'RACK-48')).toMatchObject({ same: false, why: "NetSuite's receipt IR-2288 has 10 of RACK-48. FleetSuite received 12." });
    expect(field(fewer, 'cost')).toMatchObject({ same: false, why: "NetSuite's is $356.67 less." });

    const swapped = checkOwnReceipt(pair(own(), netsuite({ lines: [rackNet, { ...binNet, item_id: HOOK, quantity: '2', value: '15.00' }] })), lists, SINCE);
    expect(field(swapped, 'items')).toMatchObject({
      same: false, fleetsuite: '2 items', netsuite: '2 items',
      why: "NetSuite's receipt IR-2288 has none of BIN-10. FleetSuite received 4. 1 other item differs.",
    });
    expect(swapped.summary).toBe(field(swapped, 'items').why);
    expect(swapped.items.map((i) => [i.item, i.same])).toEqual([['RACK-48', true], ['BIN-10', false], ['HOOK-1', false]]);
    expect(item(swapped, 'BIN-10').netsuite).toBeNull();
    expect(item(swapped, 'HOOK-1')).toMatchObject({
      itemId: HOOK, description: 'Cargo hook', fleetsuite: null,
      netsuite: { quantity: 2, locations: ['Main warehouse'], movesStock: true, cents: 1500 },
      why: "NetSuite's receipt IR-2288 has 2 of HOOK-1 ($15.00). FleetSuite received none.",
    });
  });

  it("tells a different cost for the same count, at the PO's price", () => {
    const check = checkOwnReceipt(pair(own(), netsuite({ lines: [{ ...rackNet, value: '2152.00' }, binNet] })), lists, SINCE);
    expect(check).toMatchObject({ status: 'differs', differing: 1, summary: "Added to stock: NetSuite's is $12.00 more." });
    expect(item(check, 'RACK-48')).toMatchObject({
      same: false,
      why: "RACK-48 added $2,140.00 to stock in FleetSuite (12 at the PO's $178.3333), and $2,152.00 in NetSuite. NetSuite's is $12.00 more.",
    });
    expect(field(check, 'items').same).toBe(true);
  });

  it('tells a different date and company', () => {
    const check = checkOwnReceipt(pair(own(), netsuite({ date: '2026-10-22', lines: [{ ...rackNet, company: '1084' }, { ...binNet, company: '1084' }] })), lists, SINCE);
    expect(field(check, 'date')).toMatchObject({ same: false, why: "FleetSuite dated it Oct 21, 2026, and NetSuite's receipt is dated 1 day later." });
    expect(field(check, 'company')).toMatchObject({
      fleetsuite: 'BMG', netsuite: '1084', same: false,
      why: "FleetSuite kept it for BMG, as its copy of the purchase order doesn't say the company, and NetSuite's receipt is 1084's.",
    });
    expect(check).toMatchObject({
      status: 'differs', differing: 2,
      summary: "Date: FleetSuite dated it Oct 21, 2026, and NetSuite's receipt is dated 1 day later. The company differs too.",
    });
    expect(field(checkOwnReceipt(pair(own(), netsuite({ date: '2026-10-19' })), lists, SINCE), 'date').why)
      .toBe("FleetSuite dated it Oct 21, 2026, and NetSuite's receipt is dated 2 days earlier.");
  });

  it("matches an item that isn't kept in stock on its count alone, with or without a price", () => {
    const strapLine: OwnLine = { ...binLine, item_id: STRAP, item_number: 'STRAP-2', quantity: '5', rate: '3.00' };
    const strapNet: NetLine = { ...binNet, item_id: STRAP, location_id: null, quantity: '5', moves_stock: false, value: null };
    const check = checkOwnReceipt(pair(own({ lines: [rackLine, strapLine] }), netsuite({ lines: [rackNet, strapNet] })), lists, SINCE);
    expect(check).toMatchObject({ status: 'matches', fleetsuiteCents: 214000, netsuiteCents: 214000, location: 'Main warehouse' });
    expect(item(check, 'STRAP-2')).toMatchObject({
      fleetsuite: { quantity: 5, rate: 3, cents: 1500, stock: false },
      netsuite: { quantity: 5, locations: [], movesStock: false, cents: 0 },
      same: true, why: "STRAP-2 isn't kept in stock, so it adds nothing to stock on either side.",
    });
    const unpriced = checkOwnReceipt(pair(own({ lines: [rackLine, { ...strapLine, rate: null }] }), netsuite({ lines: [rackNet, strapNet] })), lists, SINCE);
    expect(unpriced).toMatchObject({ status: 'matches', fleetsuiteCents: 214000, unknowns: [] });
  });

  it("compares what an item added to stock when NetSuite's receipt moved it, though the copy of its items says it isn't kept", () => {
    const strapLine: OwnLine = { ...binLine, item_id: STRAP, item_number: 'STRAP-2', quantity: '5', rate: '3.00' };
    const check = checkOwnReceipt(pair(
      own({ lines: [rackLine, strapLine] }),
      netsuite({ lines: [rackNet, { ...binNet, item_id: STRAP, quantity: '5', value: '15.00' }] }),
    ), lists, SINCE);
    expect(item(check, 'STRAP-2')).toMatchObject({ fleetsuite: { stock: false, cents: 1500 }, netsuite: { movesStock: true, cents: 1500 }, same: true, why: null });
    // FleetSuite doesn't count it in what it added to stock, so the receipt's cost differs.
    expect(check).toMatchObject({ status: 'differs', fleetsuiteCents: 214000, netsuiteCents: 215500, summary: "Added to stock: NetSuite's is $15.00 more." });
  });

  it("counts what NetSuite's lines that move stock brought in, not a line that names the item for its cost", () => {
    const check = checkOwnReceipt(pair(
      own({ lines: [rackLine] }),
      netsuite({ lines: [rackNet, { ...rackNet, line_id: '2', location_id: null, moves_stock: false, value: null }] }),
    ), lists, SINCE);
    expect(check).toMatchObject({ status: 'matches', location: 'Main warehouse' });
    expect(check.items[0].netsuite).toEqual({ quantity: 12, locations: ['Main warehouse'], movesStock: true, cents: 214000 });
  });

  it("pairs a line with no item id by its number, as the Receiving page keeps it", () => {
    const check = checkOwnReceipt(pair(
      own({ lines: [{ ...rackLine, item_id: null, item_number: ' Racks : rack-48 ' }, { ...binLine, item_id: null, item_number: 'WIDGET', quantity: '1' }] }),
      netsuite({ lines: [rackNet] }),
    ), lists, SINCE);
    expect(check.items.map((i) => [i.item, i.itemId, i.fleetsuite?.stock, i.same])).toEqual([
      [' Racks : rack-48 ', RACK, true, true],
      ['WIDGET', null, null, false],
    ]);
    expect(item(check, 'WIDGET').why).toBe("NetSuite's receipt IR-2288 has none of WIDGET. FleetSuite received 1.");
  });

  it("takes whether an item is kept in stock from NetSuite's receipt when the copy of its items doesn't have it yet", () => {
    const ledLine: OwnLine = { ...rackLine, item_id: '9999', item_number: 'LED-7', quantity: '2', rate: '25' };
    const led = (value: string) => checkOwnReceipt(pair(own({ lines: [ledLine] }), netsuite({ lines: [{ ...rackNet, item_id: '9999', quantity: '2', value }] })), lists, SINCE);
    expect(led('50.00')).toMatchObject({ status: 'matches', fleetsuiteCents: 5000, netsuiteCents: 5000, unknowns: [] });
    expect(led('50.00').items[0].fleetsuite).toEqual({ quantity: 2, rate: 25, cents: 5000, stock: true });
    expect(led('60.00')).toMatchObject({ status: 'differs', differing: 1, summary: "Added to stock: NetSuite's is $10.00 more." });
    expect(item(led('60.00'), 'LED-7').why)
      .toBe("LED-7 added $50.00 to stock in FleetSuite (2 at the PO's $25.00), and $60.00 in NetSuite. NetSuite's is $10.00 more.");

    // Not on NetSuite's receipt either: what it added to stock isn't known.
    const unlisted = checkOwnReceipt(pair(own({ lines: [rackLine, ledLine] }), netsuite({ lines: [rackNet] })), lists, SINCE);
    expect(unlisted).toMatchObject({
      status: 'differs', fleetsuiteCents: null, netsuiteCents: 214000,
      summary: "NetSuite's receipt IR-2288 has none of LED-7. FleetSuite received 2.",
      unknowns: ["whether LED-7 is kept in stock (the copy of NetSuite's items doesn't have it yet)"],
    });
    expect(field(unlisted, 'cost')).toMatchObject({
      fleetsuite: null, netsuite: '$2,140.00', same: null,
      why: "FleetSuite didn't know whether LED-7 is kept in stock (the copy of NetSuite's items doesn't have it yet).",
    });
    expect(item(unlisted, 'LED-7').fleetsuite).toMatchObject({ stock: null, cents: 5000 });
  });

  it("is incomplete where it matches but FleetSuite didn't know a price", () => {
    const unpriced = checkOwnReceipt(pair(own({ lines: [{ ...rackLine, rate: null }, binLine], unknowns: ['prices'] }), netsuite()), lists, SINCE);
    expect(unpriced).toMatchObject({
      status: 'incomplete', fleetsuiteCents: null,
      summary: "Matches where it can be checked. FleetSuite didn't know the price of RACK-48 (FleetSuite's copy of the purchase order had none), so what it added to stock.",
    });
    expect(item(unpriced, 'RACK-48')).toMatchObject({
      fleetsuite: { rate: null, cents: null }, same: null,
      why: "FleetSuite's copy of the purchase order had no price for RACK-48, so what it added to stock isn't compared.",
    });
    expect(field(unpriced, 'cost')).toMatchObject({ same: null, why: "FleetSuite's copy of the purchase order had no price for RACK-48." });
  });
});

describe('checking every own receipt', () => {
  it('counts them by status, every status there', () => {
    const { receipts, counts } = checkOwnReceipts({
      ...data,
      receipts: [
        pair(own(), netsuite()),
        pair(own({ receipt_key: 'k-2', netsuite_id: '7102' }), netsuite({ date: '2026-10-22' })),
        pair(own({ receipt_key: 'k-3', netsuite_id: null }), null, { receiving: { posted: 0, manual_needed: 1, manual_done: 0 } }),
        pair(own({ receipt_key: 'k-4', netsuite_id: '7104', made_at: LATER }), null),
      ],
    }, SINCE);
    expect(receipts.map((r) => [r.receiptKey, r.status])).toEqual([
      [KEY, 'matches'], ['k-2', 'differs'], ['k-3', 'not_in_netsuite'], ['k-4', 'waiting'],
    ]);
    expect(counts).toEqual({ differs: 1, not_in_netsuite: 1, incomplete: 0, waiting: 1, matches: 1, voided: 0 });
    expect(checkOwnReceipts({ receipts: [], items: {}, locations: {} }, SINCE).counts.matches).toBe(0);
  });
});
