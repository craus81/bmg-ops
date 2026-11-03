import { describe, it, expect } from 'vitest';
import type { CopiesThrough, NetsuiteFulfilLineData } from './own-fulfillment-check';
import {
  checkOwnInvoiceCost,
  checkOwnInvoiceCosts,
  invoiceCostLists,
  invoiceTakenLines,
  type InvoiceCostPairData,
  type InvoiceCostPairsData,
  type OwnInvoiceCostLineData,
} from './own-invoice-cost-check';

// Made-up items, locations and accounts.
const LADDER = '9001';
const BINS = '9002';
const HOOKS = '9003';
const RACK_KIT = '9200';
const SHELF_KIT = '9201';
const ODD_KIT = '9202';
const INSTALL = '9300';
const OFALLON = '1';
const WENTZVILLE = '2';

const ITEMS: InvoiceCostPairsData['items'] = {
  [LADDER]: { number: 'LDR-24', type: 'InvtPart', display_name: 'Ladder rack 24 in', parts: null },
  [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null, parts: null },
  [HOOKS]: { number: 'HOOK-1', type: 'InvtPart', display_name: 'Cargo hook', parts: null },
  // A rack kit: a ladder rack and two bins.
  [RACK_KIT]: { number: 'RACK-KIT', type: 'Kit', display_name: 'Rack kit', parts: [{ item: LADDER, quantity: 1 }, { item: BINS, quantity: 2 }] },
  // A shelf kit holding a rack kit, a hook, and a part the copy of NetSuite's items doesn't have.
  [SHELF_KIT]: { number: 'SHELF-KIT', type: 'Kit', display_name: null, parts: [{ item: RACK_KIT, quantity: 1 }, { item: HOOKS, quantity: 4 }, { item: '9999', quantity: 1 }] },
  // A kit whose parts the copy can't read.
  [ODD_KIT]: { number: 'ODD-KIT', type: 'Kit', display_name: null, parts: 'not a list' },
  [INSTALL]: { number: '06-INSTALL', type: 'Service', display_name: 'Installation', parts: null },
};
const LISTS = invoiceCostLists({
  items: ITEMS,
  locations: { [OFALLON]: "O'Fallon", [WENTZVILLE]: 'Wentzville' },
  accounts: { 190: { number: '19000', name: 'Inventory Asset' }, 580: { number: '58000', name: 'Cost of Goods Sold' } },
});

const MADE_AT = '2026-10-21T15:00:00Z';
/** Neither copy has run since FleetSuite made it. */
const NOT_YET: CopiesThrough = { stock: '2026-10-21T14:00:00Z', ledger: '2026-10-21T14:30:00Z' };
/** Both have. */
const SINCE: CopiesThrough = { stock: '2026-10-21T17:00:00Z', ledger: '2026-10-21T17:30:00Z' };

const ownLine = (item: string, quantity: number | string, over: Partial<OwnInvoiceCostLineData> = {}): OwnInvoiceCostLineData => ({
  line_no: 1, item_id: item, item_number: ITEMS[item]?.number ?? null, description: null, item_type: ITEMS[item]?.type ?? null,
  quantity: String(quantity), ...over,
});
/** A line of NetSuite's invoice as the copy of its stock moves has it: what moved, and what it posted to the inventory account. */
const nsLine = (line: string, item: string, quantity: number, value: string | null, moves = true, location = WENTZVILLE): NetsuiteFulfilLineData => ({
  line_id: line, item_id: item, location_id: location, quantity: String(quantity), moves_stock: moves, value,
});
/** The cost lines of NetSuite's invoice, costing `cents`. */
const entry = (cents: number) => ({
  posting_month: '2026-10-01',
  entry: [
    { account_id: '190', debit: '0.00', credit: (cents / 100).toFixed(2) },
    { account_id: '580', debit: (cents / 100).toFixed(2), credit: '0.00' },
  ],
});

/**
 * INV7301, typed in FleetSuite: three ladder racks from Wentzville, where FleetSuite counted 14 worth $2,123.33 just
 * before, so 3 × $151.6664 = $455.00, and NetSuite's invoice took the same: the item line moves stock, its cost lines
 * don't.
 */
function pair(over: Partial<Omit<InvoiceCostPairData, 'own'>> & { own?: Partial<InvoiceCostPairData['own']> } = {}): InvoiceCostPairData {
  const { own, ...rest } = over;
  return {
    own: {
      netsuite_id: '7301', number: 'INV7301', made_from: 'typed', made_from_id: null, customer_netsuite_id: '9001',
      date: '2026-10-21', location_id: WENTZVILLE, location_from: 'sent', unknowns: [], made_at: MADE_AT, fixed_at: null,
      lines: [ownLine(LADDER, 3)], ...own,
    },
    netsuite: {
      number: 'INV7301', type: 'CustInvc', date: '2026-10-21', gone: false,
      lines: [nsLine('1', LADDER, -3, null), nsLine('3', LADDER, -3, null, false), nsLine('4', LADDER, -3, '-455.00', false)],
    },
    netsuite_gl: entry(45500),
    before: [{ item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' }],
    customer_name: 'Acme Fleet',
    ...rest,
  };
}

const check = (p: InvoiceCostPairData, copies: CopiesThrough = SINCE) => checkOwnInvoiceCost(p, LISTS, copies);
const field = (c: ReturnType<typeof check>, name: string) => c.fields.find((f) => f.field === name)!;
const AVERAGE = "Each item costs its average at the invoice's location just before the invoice: the value FleetSuite counted of it there over the count, "
  + 'from its count and value on December 31, 2024 and every NetSuite document since that comes before it, as Stock by item counts them. '
  + 'A line costs its quantity at that average, to the cent.';

describe('the lists and the lines', () => {
  it("takes each kit's parts from the copy of NetSuite's items, and knows a part it doesn't have as one it doesn't have", () => {
    expect(LISTS.listed.get(RACK_KIT)).toEqual({ number: 'RACK-KIT', type: 'Kit', displayName: 'Rack kit', parts: [{ item: LADDER, quantity: 1 }, { item: BINS, quantity: 2 }] });
    expect(LISTS.listed.get(ODD_KIT)?.parts).toBeNull();
    // Only a kit has parts.
    expect(invoiceCostLists({ items: { [LADDER]: { ...ITEMS[LADDER], parts: [{ item: BINS, quantity: 1 }] } }, locations: {}, accounts: {} }).listed.get(LADDER)?.parts).toBeNull();
    expect(LISTS.listed.get('9999')).toBeNull();
    expect(LISTS.listed.has('9998')).toBe(false);
    expect(LISTS.items.get(LADDER)).toEqual({ number: 'LDR-24', type: 'InvtPart', displayName: 'Ladder rack 24 in' });
    expect(LISTS.locations.get(WENTZVILLE)).toBe('Wentzville');
    expect(invoiceCostLists({ items: undefined as never, locations: undefined as never, accounts: undefined as never }).listed.size).toBe(0);
  });

  it('takes a kit apart into its parts, each the kit\'s quantity times what one kit holds, to four places', () => {
    expect(invoiceTakenLines([ownLine(RACK_KIT, '1.5', { line_no: 2 })], LISTS.listed)).toEqual([
      { line_no: 2, item_id: LADDER, item_number: 'LDR-24', description: 'Ladder rack 24 in', item_type: 'InvtPart', quantity: '1.5', sales_order_line_id: null, kit_id: RACK_KIT, location_id: null },
      { line_no: 2, item_id: BINS, item_number: 'BIN-10', description: null, item_type: 'InvtPart', quantity: '3', sales_order_line_id: null, kit_id: RACK_KIT, location_id: null },
    ]);
    expect(invoiceTakenLines([ownLine(RACK_KIT, '0.33333')], LISTS.listed).map((l) => l.quantity)).toEqual(['0.3333', '0.6667']);
    // A kit inside a kit too, and a part the copy doesn't have, which may be kept in stock.
    expect(invoiceTakenLines([ownLine(SHELF_KIT, 2)], LISTS.listed).map((l) => [l.item_id, l.item_type, l.quantity, l.kit_id])).toEqual([
      [LADDER, 'InvtPart', '2', SHELF_KIT], [BINS, 'InvtPart', '4', SHELF_KIT], [HOOKS, 'InvtPart', '8', SHELF_KIT], ['9999', null, '2', SHELF_KIT],
    ]);
  });

  it("keeps a kit whose parts aren't known whole, an item the copy doesn't type as it is, and leaves out what isn't kept in stock", () => {
    expect(invoiceTakenLines([ownLine(ODD_KIT, 1), ownLine('9998', 2, { item_number: 'NEW-1' }), ownLine(INSTALL, 1), ownLine(LADDER, '3.0000')], LISTS.listed)).toEqual([
      { line_no: 1, item_id: ODD_KIT, item_number: 'ODD-KIT', description: null, item_type: 'Kit', quantity: '1', sales_order_line_id: null, kit_id: null, location_id: null },
      { line_no: 1, item_id: '9998', item_number: 'NEW-1', description: null, item_type: null, quantity: '2', sales_order_line_id: null, kit_id: null, location_id: null },
      { line_no: 1, item_id: LADDER, item_number: 'LDR-24', description: null, item_type: 'InvtPart', quantity: '3.0000', sales_order_line_id: null, kit_id: null, location_id: null },
    ]);
    expect(invoiceTakenLines([ownLine(RACK_KIT, 'many')], LISTS.listed).map((l) => l.quantity)).toEqual(['0', '0']);
    expect(invoiceTakenLines([], LISTS.listed)).toEqual([]);
  });
});

describe("FleetSuite's own invoice's cost next to NetSuite's invoice's", () => {
  it('matches when the invoice took what NetSuite took, from where, on the day, at the same cost', () => {
    const c = check(pair());
    expect(c).toMatchObject({
      netsuiteId: '7301', number: 'INV7301', date: '2026-10-21', madeFrom: 'typed', madeFromText: 'a new invoice typed in FleetSuite',
      customer: 'Acme Fleet', locationId: WENTZVILLE, status: 'matches', summary: "Matches NetSuite's invoice.", differing: 0,
      fleetsuiteCost: 45500, netsuiteCost: 45500, unknowns: [],
    });
    expect(c).not.toHaveProperty('places');
    expect(c).not.toHaveProperty('tookApart');
    expect(c.fields.map((f) => [f.field, f.fleetsuite, f.netsuite, f.same, f.why])).toEqual([
      ['date', 'Oct 21, 2026', 'Oct 21, 2026', true, null],
      ['location', 'Wentzville', 'Wentzville', true, null],
      ['items', '1 item', '1 item', true, null],
      ['cost', '$455.00', '$455.00', true, null],
    ]);
    expect(c.items).toEqual([{
      item: 'LDR-24', itemId: LADDER, description: null, partOf: null, same: true, why: null,
      fleetsuite: { quantity: 3, kind: 'stock', location: 'Wentzville', locationId: WENTZVILLE, count: 14, valueCents: 212333, each: 212333 / 14, cents: 45500 },
      netsuite: { quantity: 3, locations: ['Wentzville'], each: 45500 / 3, cents: 45500 },
    }]);
    expect(c.entry).toEqual([
      { account: '19000 Inventory Asset', debit: 0, credit: 45500 },
      { account: '58000 Cost of Goods Sold', debit: 45500, credit: 0 },
    ]);
    expect(c.workedOut).toEqual([
      'Made without a sales order, so the invoice takes its stock itself, as NetSuite\'s does.',
      "Its items are the ones it bills that NetSuite keeps in stock, as the copy of NetSuite's items has them.",
      'From Wentzville, where FleetSuite told NetSuite to book the invoice.',
      AVERAGE,
    ]);
  });

  it("goes by NetSuite's number, or its id, when the copy has none", () => {
    expect(check(pair({ own: { number: null } })).number).toBe('INV7301');
    expect(check(pair({ own: { number: null }, netsuite: null }), NOT_YET).number).toBe('NetSuite 7301');
  });

  it("takes a kit's parts, as NetSuite does, and says so", () => {
    const kits = pair({
      own: { lines: [ownLine(RACK_KIT, 2)] },
      netsuite: {
        number: 'INV7301', type: 'CustInvc', date: '2026-10-21', gone: false,
        lines: [nsLine('1', RACK_KIT, -2, null, false), nsLine('2', LADDER, -2, '-303.33'), nsLine('3', BINS, -4, '-80.00')],
      },
      netsuite_gl: entry(38333),
      before: [
        { item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' },
        { item_id: BINS, location_id: WENTZVILLE, quantity: '20', value: '400.00' },
      ],
    });
    const c = check(kits);
    expect(c).toMatchObject({ status: 'matches', fleetsuiteCost: 38333, netsuiteCost: 38333 });
    expect(c.items.map((i) => [i.item, i.partOf, i.fleetsuite?.quantity, i.fleetsuite?.cents, i.netsuite?.cents])).toEqual([
      ['LDR-24', 'A part of RACK-KIT', 2, 30333, 30333],
      ['BIN-10', 'A part of RACK-KIT', 4, 8000, 8000],
    ]);
    expect(c.workedOut[2]).toBe("A kit is taken apart into its parts, each the kit's quantity times what one kit holds, as the copy of NetSuite's items has them. "
      + "NetSuite takes a kit's parts from stock, not the kit.");
    expect(c.workedOut).toHaveLength(5);
  });

  it("is incomplete when a kit's parts aren't known, or an item may be kept in stock", () => {
    const odd = check(pair({ own: { lines: [ownLine(LADDER, 3), ownLine(ODD_KIT, 1, { line_no: 2 })] } }));
    expect(odd.status).toBe('incomplete');
    expect(odd.unknowns).toEqual(['the parts of ODD-KIT, a kit']);
    expect(odd.summary).toBe("Matches where it can be checked. FleetSuite didn't know the parts of ODD-KIT, a kit.");
    expect(odd.items.find((i) => i.itemId === ODD_KIT)?.why).toBe("ODD-KIT is a kit FleetSuite couldn't take apart into its parts, so what NetSuite took for it isn't compared.");

    const unknown = check(pair({ own: { lines: [ownLine(LADDER, 3), ownLine('9998', 1, { item_number: 'NEW-1', line_no: 2 })] } }));
    expect(unknown.status).toBe('incomplete');
    expect(unknown.items.find((i) => i.itemId === '9998')?.why)
      .toBe("FleetSuite didn't know whether NEW-1 is kept in stock (the copy of NetSuite's items doesn't have it yet), and NetSuite's invoice took none of it from stock.");
  });

  it('waits for the copies of NetSuite to have the invoice, and its cost lines', () => {
    expect(check(pair({ netsuite: null }), NOT_YET)).toMatchObject({
      status: 'waiting', summary: "Waiting for NetSuite's invoice: the copy of NetSuite's stock moves runs every two hours.",
    });
    expect(check(pair({ netsuite_gl: null }), NOT_YET)).toMatchObject({
      status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the invoice.",
    });
  });

  it('waits for the copies made since FleetSuite fixed the invoice, not since it made it', () => {
    const fixed = pair({ own: { fixed_at: '2026-10-22T09:00:00Z' }, netsuite: null });
    expect(check(fixed).status).toBe('waiting');
    // Fixed before it was made is no fix to wait for.
    expect(check(pair({ own: { fixed_at: '2026-10-20T09:00:00Z' }, netsuite: null })).status).toBe('differs');
    expect(check(pair({ own: { fixed_at: '2026-10-22T09:00:00Z' } }), { stock: '2026-10-22T10:00:00Z', ledger: '2026-10-22T10:30:00Z' }).status).toBe('matches');
  });

  it('differs when NetSuite took nothing, saying what FleetSuite took', () => {
    const c = check(pair({ netsuite: null, netsuite_gl: null }));
    expect(c.status).toBe('differs');
    expect(c.summary).toBe("Items: NetSuite's invoice took nothing from stock, or is gone from NetSuite: the copy of NetSuite's stock moves, made since, doesn't have it.");
    expect(c.items[0].why).toBe("FleetSuite took 3 of LDR-24 from stock ($455.00), and NetSuite's invoice took none.");
    expect(field(c, 'date').why).toBe("NetSuite's invoice isn't in the copy of its stock moves, which takes only documents that move stock.");
  });

  it("matches an invoice that took nothing from stock when nor did NetSuite's", () => {
    const c = check(pair({ own: { lines: [] }, netsuite: null, netsuite_gl: null }));
    expect(c).toMatchObject({ status: 'matches', summary: "Took nothing from stock, and nor did NetSuite's invoice.", fleetsuiteCost: 0, netsuiteCost: 0 });
  });

  it("is gone when NetSuite deleted its invoice", () => {
    expect(check(pair({ netsuite: { ...pair().netsuite!, gone: true } }))).toMatchObject({ status: 'voided', summary: "NetSuite's invoice is gone from NetSuite." });
  });

  it("says what NetSuite took that the copy doesn't bill", () => {
    const c = check(pair({
      netsuite: { ...pair().netsuite!, lines: [...pair().netsuite!.lines, nsLine('5', BINS, -1, '-20.00')] },
      netsuite_gl: entry(47500),
    }));
    expect(c.status).toBe('differs');
    expect(field(c, 'items').why).toBe("NetSuite's invoice took 1 of BIN-10 ($20.00), and FleetSuite's copy of the invoice doesn't bill it.");
    expect(c.items[1]).toMatchObject({ item: 'BIN-10', fleetsuite: null, same: false, why: "NetSuite's invoice took 1 of BIN-10 ($20.00), and FleetSuite's copy of the invoice doesn't bill it." });
  });

  it('says where FleetSuite told NetSuite to book the invoice when NetSuite took stock from elsewhere', () => {
    const elsewhere = pair({
      own: { location_id: OFALLON },
      before: [{ item_id: LADDER, location_id: OFALLON, quantity: '10', value: '1500.00' }, { item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' }],
    });
    const c = check(elsewhere);
    expect(c.status).toBe('differs');
    expect(field(c, 'location').why).toBe("FleetSuite told NetSuite to book the invoice at O'Fallon, and NetSuite took stock from Wentzville.");
    expect(c.workedOut[2]).toBe("From O'Fallon, where FleetSuite told NetSuite to book the invoice.");
    const ruled = check(pair({ ...elsewhere, own: { ...elsewhere.own, location_from: 'rule' } }));
    expect(field(ruled, 'location').why).toBe("FleetSuite's invoice location rule puts it in O'Fallon, and NetSuite took stock from Wentzville.");
    expect(ruled.workedOut[2]).toBe("From O'Fallon, where FleetSuite's invoice location rule books Acme Fleet's invoices.");
    expect(check(pair({ ...elsewhere, own: { ...elsewhere.own, location_from: 'rule' }, customer_name: null })).workedOut[2])
      .toBe("From O'Fallon, where FleetSuite's invoice location rule books the customer's invoices.");
  });

  it("is incomplete when FleetSuite didn't know where the invoice books", () => {
    const c = check(pair({ own: { location_id: null, location_from: null, unknowns: ['location', 'terms'] } }));
    expect(c.status).toBe('incomplete');
    expect(c.unknowns).toEqual(['where it took stock from, so what it cost']);
    expect(field(c, 'location').why).toBe("FleetSuite didn't know where it took stock from: it didn't tell NetSuite where to book the invoice.");
    expect(c.workedOut[2]).toBe("Where it took stock from isn't known: FleetSuite didn't tell NetSuite where to book the invoice.");
    // Nothing taken, nowhere known.
    expect(check(pair({ own: { location_id: null, location_from: null, lines: [] }, netsuite: null, netsuite_gl: null })).workedOut[2])
      .toBe("Where it took stock from isn't known: FleetSuite didn't tell NetSuite where to book the invoice.");
  });

  it("says so when FleetSuite didn't know what the invoice billed", () => {
    const c = check(pair({ own: { lines: [], unknowns: ['lines'] } }));
    expect(c.status).toBe('incomplete');
    expect(c.unknowns).toEqual(["what it took from stock (FleetSuite didn't know what the invoice billed)"]);
    expect(field(c, 'items').why).toBe("FleetSuite didn't know what it took from stock (FleetSuite didn't know what the invoice billed).");
  });

  it('says when its cost lines in the copy of the general ledger booked no cost', () => {
    const c = check(pair({ netsuite_gl: null }));
    expect(field(c, 'cost').why).toBe("NetSuite's invoice booked no cost: the copy of its general ledger, made since, has no entry for it.");
  });

  it('checks every invoice, counting each status', () => {
    const checked = checkOwnInvoiceCosts({
      invoices: [pair(), pair({ own: { netsuite_id: '7302' }, netsuite: null }), pair({ own: { netsuite_id: '7303' }, netsuite: { ...pair().netsuite!, gone: true } })],
      items: ITEMS,
      locations: { [WENTZVILLE]: 'Wentzville' },
      accounts: {},
    }, SINCE);
    expect(checked.invoices.map((c) => [c.netsuiteId, c.status])).toEqual([['7301', 'matches'], ['7302', 'differs'], ['7303', 'voided']]);
    expect(checked.counts).toEqual({ differs: 1, incomplete: 0, waiting: 0, matches: 1, voided: 1 });
    expect(checkOwnInvoiceCosts({ invoices: undefined as never, items: {}, locations: {}, accounts: {} }, SINCE))
      .toEqual({ invoices: [], counts: { differs: 0, incomplete: 0, waiting: 0, matches: 0, voided: 0 } });
  });
});
