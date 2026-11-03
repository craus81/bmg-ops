import { describe, it, expect } from 'vitest';
import {
  checkOwnFulfillment,
  checkOwnFulfillments,
  checkTaken,
  costAt,
  eachText,
  fulfilLists,
  type CopiesThrough,
  type FulfilPairData,
  type NetsuiteFulfilLineData,
  type OwnFulfilLineData,
  type TakenWords,
} from './own-fulfillment-check';

const LADDER = '9001';
const BINS = '9002';
const HOOKS = '9003';
const RACK_KIT = '9200';
const OFALLON = '1';
const WENTZVILLE = '2';

const LISTS = fulfilLists({
  items: {
    [LADDER]: { number: 'LDR-24', type: 'InvtPart', display_name: 'Ladder rack 24 in' },
    [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null },
    [HOOKS]: { number: 'HOOK-1', type: 'InvtPart', display_name: 'Cargo hook' },
    [RACK_KIT]: { number: 'RACK-KIT', type: 'Kit', display_name: 'Rack kit' },
  },
  locations: { [OFALLON]: "O'Fallon", [WENTZVILLE]: 'Wentzville' },
  accounts: { 190: { number: '19000', name: 'Inventory Asset' }, 580: { number: '58000', name: 'Cost of Goods Sold' } },
});

const MADE_AT = '2026-10-19T15:00:00Z';
/** Neither copy has run since FleetSuite made it. */
const NOT_YET: CopiesThrough = { stock: '2026-10-19T14:00:00Z', ledger: '2026-10-19T14:30:00Z' };
/** Both have. */
const SINCE: CopiesThrough = { stock: '2026-10-19T17:00:00Z', ledger: '2026-10-19T17:30:00Z' };

const ownLine = (item: string, quantity: number, over: Partial<OwnFulfilLineData> = {}): OwnFulfilLineData => ({
  line_no: 1, item_id: item, item_number: null, description: null, item_type: 'InvtPart', quantity: String(quantity), sales_order_line_id: '1', ...over,
});
/** A line of NetSuite's fulfillment: what moved, and what it posted to the inventory account (debit positive). */
const nsLine = (line: string, item: string, quantity: number, value: string | null, moves = true, location = WENTZVILLE): NetsuiteFulfilLineData => ({
  line_id: line, item_id: item, location_id: location, quantity: String(quantity), moves_stock: moves, value,
});
/** NetSuite's entry for a fulfillment costing `cents`. */
const entry = (cents: number) => ({
  posting_month: '2026-10-01',
  entry: [
    { account_id: '190', debit: '0.00', credit: (cents / 100).toFixed(2) },
    { account_id: '580', debit: (cents / 100).toFixed(2), credit: '0.00' },
  ],
});

/**
 * Three ladder racks from Wentzville, where FleetSuite counted 14 worth $2,123.33 just before, so 3 × $151.6664 = $455.00,
 * and NetSuite's fulfillment the same.
 */
function pair(over: Partial<Omit<FulfilPairData, 'own'>> & { own?: Partial<FulfilPairData['own']> } = {}): FulfilPairData {
  const { own, ...rest } = over;
  return {
    own: {
      netsuite_id: '7001', number: 'IF7001', made_from: 'vehicle', made_from_id: 'checkin-1', sales_order_id: '6001',
      customer_netsuite_id: '9001', date: '2026-10-19', location_id: WENTZVILLE, location_from: 'customer_rule', unknowns: [],
      made_at: MADE_AT, lines: [ownLine(LADDER, 3)], ...own,
    },
    netsuite: {
      number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false,
      lines: [nsLine('1', LADDER, -3, '-455.00'), nsLine('2', LADDER, -3, null, false)],
    },
    netsuite_gl: entry(45500),
    before: [{ item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' }],
    sales_order: { number: 'SO6001', customer_name: 'Acme Fleet' },
    invoice: null,
    ...rest,
  };
}

const check = (p: FulfilPairData, copies: CopiesThrough = SINCE) => checkOwnFulfillment(p, LISTS, copies);
const field = (c: ReturnType<typeof check>, name: string) => c.fields.find((f) => f.field === name)!;

describe('costing what FleetSuite took from stock', () => {
  it('costs a quantity at the value over the count just before, to the cent half away from zero', () => {
    expect(costAt(3, 14, 212333)).toBe(45500);
    expect(costAt(1, 2, 1)).toBe(1);
    expect(costAt(1, 2, -1)).toBe(-1);
    expect(costAt(2.5, 10, 1001)).toBe(250);
    // Nothing counted, or less than nothing, costs nothing it can say.
    expect(costAt(1, 0, 100)).toBeNull();
    expect(costAt(1, -2, 100)).toBeNull();
    expect(Object.is(costAt(1, 3, -1), 0)).toBe(true);
  });

  it('writes a cost each to the cent when it is whole cents, else to four places', () => {
    expect(eachText(15000)).toBe('$150.00');
    expect(eachText(212333 / 14)).toBe('$151.6664');
    expect(eachText(15166.5)).toBe('$151.665');
    expect(eachText(123456789)).toBe('$1,234,567.89');
    expect(eachText(12345678.25)).toBe('$123,456.7825');
    expect(eachText(-50.5)).toBe('-$0.505');
  });
});

describe("FleetSuite's own fulfillment next to NetSuite's", () => {
  it('matches when FleetSuite took what NetSuite took, from where, on the day, at the same cost', () => {
    const c = check(pair());
    expect(c).toMatchObject({
      netsuiteId: '7001', number: 'IF7001', date: '2026-10-19', madeFrom: 'vehicle', madeFromText: 'a finished vehicle',
      customer: 'Acme Fleet', salesOrderId: '6001', salesOrder: 'SO6001', locationId: WENTZVILLE, invoice: null,
      status: 'matches', summary: "Matches NetSuite's fulfillment.", differing: 0, fleetsuiteCost: 45500, netsuiteCost: 45500, unknowns: [],
    });
    expect(c.fields.map((f) => [f.field, f.fleetsuite, f.netsuite, f.same, f.why])).toEqual([
      ['date', 'Oct 19, 2026', 'Oct 19, 2026', true, null],
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
    expect(c.workedOut[0]).toBe('Made when FleetSuite invoiced a finished vehicle on Oct 19, 2026: it fulfils a sales order before it bills it.');
    expect(c.workedOut[1]).toBe("Its items are what FleetSuite's copy of SO6001 still had to bill, of the items NetSuite keeps in stock.");
    expect(c.workedOut[2]).toBe("From Wentzville, where FleetSuite's invoice location rule books Acme Fleet's invoices.");
    expect(check(pair({ own: { made_from: 'sales_order', location_from: 'po_rule' } })).workedOut[2])
      .toBe("From Wentzville, where FleetSuite's PO location rule books the PO's invoice.");
  });

  it("leaves out a line of NetSuite's that moved nothing and posted nothing to stock", () => {
    const c = check(pair({
      netsuite: {
        number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false,
        lines: [nsLine('1', LADDER, -3, '-455.00'), nsLine('2', LADDER, -3, null, false), nsLine('3', '9700', -1, null, false)],
      },
    }));
    expect(c).toMatchObject({ status: 'matches', fleetsuiteCost: 45500, netsuiteCost: 45500 });
    expect(c.items.map((i) => i.itemId)).toEqual([LADDER]);
  });

  it('costs each line on its own and adds them up, as NetSuite does', () => {
    const c = check(pair({ own: { lines: [ownLine(LADDER, 1), ownLine(LADDER, 2, { line_no: 2, sales_order_line_id: '2' })] } }));
    // 151.66 → 151.67 and 303.33: 455.00.
    expect(c).toMatchObject({ status: 'matches', fleetsuiteCost: 45500 });
    expect(c.items).toHaveLength(1);
    expect(c.items[0].fleetsuite).toMatchObject({ quantity: 3, cents: 45500 });
  });

  it("differs on cost, saying what FleetSuite costed it at and how far NetSuite's is", () => {
    const c = check(pair({
      netsuite: { number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false, lines: [nsLine('1', LADDER, -3, '-460.00')] },
      netsuite_gl: entry(46000),
    }));
    expect(c).toMatchObject({ status: 'differs', summary: "Cost: NetSuite's is $5.00 more.", differing: 1, fleetsuiteCost: 45500, netsuiteCost: 46000 });
    expect(field(c, 'cost')).toMatchObject({ fleetsuite: '$455.00', netsuite: '$460.00', same: false });
    // It took the same, so the items match, though the item's own row says what it cost.
    expect(field(c, 'items')).toMatchObject({ same: true, why: null });
    expect(c.items[0]).toMatchObject({
      same: false,
      why: "FleetSuite's cost is $455.00 (3 at $151.6664 each, from the 14 worth $2,123.33 FleetSuite counted at Wentzville just before), "
        + "and NetSuite's $460.00 ($153.3333 each). NetSuite's is $5.00 more.",
    });
    expect(check(pair({
      netsuite: { number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false, lines: [nsLine('1', LADDER, -3, '-450.00')] },
      netsuite_gl: entry(45000),
    })).summary).toBe("Cost: NetSuite's is $5.00 less.");
  });

  it("differs on what it took: another quantity, an item NetSuite didn't take, one FleetSuite's copy didn't have", () => {
    const c = check(pair({
      own: { lines: [ownLine(LADDER, 3), ownLine(BINS, 1, { line_no: 2, sales_order_line_id: '2' })] },
      netsuite: {
        number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false,
        lines: [nsLine('1', LADDER, -2, '-303.33'), nsLine('2', HOOKS, -1, '-5.00')],
      },
      netsuite_gl: entry(30833),
      before: [
        { item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' },
        { item_id: BINS, location_id: WENTZVILLE, quantity: '4', value: '40.00' },
        { item_id: HOOKS, location_id: WENTZVILLE, quantity: '6', value: '30.00' },
      ],
    }));
    expect(c.status).toBe('differs');
    // The cost follows from what was taken, so the summary doesn't say it too.
    expect(c.summary).toBe('Items: FleetSuite took 3 of LDR-24 from stock, and NetSuite 2. 2 other items differ.');
    expect(c).toMatchObject({ differing: 2, fleetsuiteCost: 46500, netsuiteCost: 30833 });
    expect(c.items.map((i) => [i.item, i.same, i.why])).toEqual([
      ['LDR-24', false, 'FleetSuite took 3 of LDR-24 from stock, and NetSuite 2.'],
      ['BIN-10', false, "FleetSuite took 1 of BIN-10 from stock ($10.00), and NetSuite's fulfillment took none."],
      ['HOOK-1', false, "NetSuite's fulfillment took 1 of HOOK-1 ($5.00), and FleetSuite's copy of the sales order didn't have it still to bill."],
    ]);
    expect(c.items[2]).toMatchObject({ description: 'Cargo hook', fleetsuite: null, netsuite: { quantity: 1, locations: ['Wentzville'], cents: 500, each: 500 } });
    expect(field(c, 'items')).toMatchObject({ fleetsuite: '2 items', netsuite: '2 items', same: false });
  });

  it('differs on where it took stock from, and the items taken from there differ because of it', () => {
    const c = check(pair({
      own: { location_id: OFALLON },
      before: [
        { item_id: LADDER, location_id: OFALLON, quantity: '5', value: '750.00' },
        { item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' },
      ],
    }));
    expect(c.status).toBe('differs');
    expect(c.summary).toBe("Location: FleetSuite's invoice location rule puts it in O'Fallon, and NetSuite took stock from Wentzville.");
    expect(c).toMatchObject({ differing: 2, fleetsuiteCost: 45000, netsuiteCost: 45500 });
    expect(c.fields.map((f) => f.same)).toEqual([true, false, true, false]);
    expect(c.items[0].why).toBe(
      "FleetSuite took it from O'Fallon, and NetSuite from Wentzville. FleetSuite's cost is $450.00 (3 at $150.00 each, from the 5 worth "
        + "$750.00 FleetSuite counted at O'Fallon just before), and NetSuite's $455.00 ($151.6667 each). NetSuite's is $5.00 more.",
    );
    // Taken from elsewhere in another quantity, the items differ too.
    const more = check(pair({
      own: { location_id: OFALLON, location_from: 'po_rule', lines: [ownLine(LADDER, 2)] },
      before: [{ item_id: LADDER, location_id: OFALLON, quantity: '5', value: '750.00' }],
    }));
    expect(more.summary).toBe("Location: FleetSuite's PO location rule puts it in O'Fallon, and NetSuite took stock from Wentzville. The items differ too.");
  });

  it('differs on the date, and says what else differs too', () => {
    const c = check(pair({
      netsuite: { number: 'IF7001', type: 'ItemShip', date: '2026-10-20', gone: false, lines: [nsLine('1', LADDER, -3, '-455.00')] },
    }));
    expect(c).toMatchObject({ status: 'differs', differing: 1 });
    expect(c.summary).toBe("Date: FleetSuite made it Oct 19, 2026, and NetSuite's fulfillment is dated 1 day later.");
    const two = check(pair({
      own: { date: '2026-10-21' },
      netsuite: { number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false, lines: [nsLine('1', LADDER, -3, '-460.00')] },
      netsuite_gl: entry(46000),
    }));
    expect(two.summary).toBe("Date: FleetSuite made it Oct 21, 2026, and NetSuite's fulfillment is dated 2 days earlier. The cost differs too.");
  });

  it("waits for NetSuite's fulfillment until the copy of its stock moves has run since, then takes none as none", () => {
    const waiting = check(pair({ netsuite: null, netsuite_gl: null }), NOT_YET);
    expect(waiting).toMatchObject({
      status: 'waiting', summary: "Waiting for NetSuite's fulfillment: the copy of NetSuite's stock moves runs every two hours.",
      fleetsuiteCost: 45500, netsuiteCost: null, differing: 0,
    });
    expect(waiting.fields.map((f) => [f.field, f.netsuite, f.same])).toEqual([
      ['date', null, null], ['location', null, null], ['items', null, null], ['cost', null, null],
    ]);
    expect(waiting.items[0]).toMatchObject({ netsuite: null, same: null, why: null });
    // No copy at all yet waits too.
    expect(check(pair({ netsuite: null, netsuite_gl: null }), { stock: null, ledger: null }).status).toBe('waiting');

    // The stock copy takes only documents that move stock: one made since without it says NetSuite's took nothing.
    const none = check(pair({ netsuite: null, netsuite_gl: null }));
    expect(none.status).toBe('differs');
    expect(none.summary).toBe(
      "Items: NetSuite's fulfillment took nothing from stock, or is gone from NetSuite: the copy of NetSuite's stock moves, made since, doesn't have it.",
    );
    expect(none).toMatchObject({ fleetsuiteCost: 45500, netsuiteCost: 0 });
    expect(field(none, 'date')).toMatchObject({
      netsuite: null, same: null, why: "NetSuite's fulfillment isn't in the copy of its stock moves, which takes only documents that move stock.",
    });
    expect(field(none, 'location')).toMatchObject({ netsuite: 'None', same: null });
    expect(field(none, 'items')).toMatchObject({ fleetsuite: '1 item', netsuite: 'Nothing from stock', same: false });

    // And when FleetSuite took nothing either, they match, with or without a location.
    for (const location_id of [WENTZVILLE, null]) {
      const nothing = check(pair({
        own: { lines: [], location_id, location_from: location_id ? 'customer_rule' : null, unknowns: location_id ? [] : ['location'] },
        netsuite: null, netsuite_gl: null, before: [],
      }));
      expect(nothing).toMatchObject({ status: 'matches', summary: "Took nothing from stock, and nor did NetSuite's fulfillment.", fleetsuiteCost: 0, netsuiteCost: 0 });
    }
  });

  it("waits for the copy of NetSuite's ledger to reach the fulfillment, then takes no entry as no cost booked", () => {
    const unvalued = { number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false, lines: [nsLine('1', LADDER, -3, null)] };
    const waiting = check(pair({ netsuite: unvalued, netsuite_gl: null }), NOT_YET);
    expect(waiting).toMatchObject({ status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the fulfillment.", netsuiteCost: null });
    expect(waiting.items[0].netsuite).toMatchObject({ quantity: 3, cents: null, each: null });
    // A ledger copy that finished just after may have begun before.
    expect(check(pair({ netsuite: unvalued, netsuite_gl: null }), { ...SINCE, ledger: '2026-10-19T15:05:00Z' }).status).toBe('waiting');

    const booked = check(pair({ netsuite: unvalued, netsuite_gl: null }));
    expect(booked).toMatchObject({ status: 'differs', netsuiteCost: 0, fleetsuiteCost: 45500 });
    expect(field(booked, 'cost')).toMatchObject({
      netsuite: '$0.00', same: false, why: "NetSuite's fulfillment booked no cost: the copy of its general ledger, made since, has no entry for it.",
    });
    expect(Object.is(booked.items[0].netsuite!.cents, 0)).toBe(true);
    expect(booked.summary.startsWith("Cost: NetSuite's fulfillment booked no cost")).toBe(true);
  });

  it('is gone when NetSuite deleted its fulfillment', () => {
    const c = check(pair({ netsuite: { number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: true, lines: [nsLine('1', LADDER, -3, '-455.00')] } }));
    expect(c).toMatchObject({ status: 'voided', summary: "NetSuite's fulfillment is gone from NetSuite." });
  });

  it("doesn't compare a kit FleetSuite couldn't take apart, and says what NetSuite took may be its parts", () => {
    const c = check(pair({
      own: { lines: [ownLine(RACK_KIT, 1, { item_number: 'RACK-KIT', item_type: 'Kit' })] },
      netsuite: { number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false, lines: [nsLine('1', BINS, -4, '-40.00')] },
      netsuite_gl: entry(4000),
      before: [{ item_id: BINS, location_id: WENTZVILLE, quantity: '4', value: '40.00' }, { item_id: RACK_KIT, location_id: WENTZVILLE, quantity: '0', value: '0' }],
    }));
    expect(c).toMatchObject({
      status: 'incomplete', summary: "Matches where it can be checked. FleetSuite didn't know the parts of RACK-KIT, a kit.",
      fleetsuiteCost: null, netsuiteCost: 4000, unknowns: ['the parts of RACK-KIT, a kit'],
    });
    expect(c.items.map((i) => [i.item, i.same, i.why])).toEqual([
      ['RACK-KIT', null, "RACK-KIT is a kit FleetSuite couldn't take apart into its parts, so what NetSuite took for it isn't compared."],
      ['BIN-10', null, "NetSuite's fulfillment took 4 of BIN-10 ($40.00), which FleetSuite's copy doesn't have: it may be a part of RACK-KIT, a kit FleetSuite couldn't take apart."],
    ]);
    expect(c.items.map((i) => i.partOf)).toEqual([null, null]);
    expect(c.items[0].fleetsuite).toMatchObject({ kind: 'kit', count: null, valueCents: null, each: null, cents: null });
    expect(field(c, 'cost')).toMatchObject({ fleetsuite: null, same: null, why: "FleetSuite didn't know the parts of RACK-KIT, so not what they cost." });
    expect(field(c, 'items')).toMatchObject({ fleetsuite: '1 item', netsuite: '1 item', same: null });
    // No kit was taken apart, so how the copy was worked out doesn't say how one is.
    expect(c.workedOut.some((w) => w.startsWith('A kit is taken apart'))).toBe(false);

    // Two kits it couldn't take apart.
    const two = check(pair({
      own: { lines: [
        ownLine(RACK_KIT, 1, { item_number: 'RACK-KIT', item_type: 'Kit' }),
        ownLine('9201', 1, { line_no: 2, sales_order_line_id: '2', item_number: 'SHELF-KIT', item_type: 'Kit' }),
      ] },
      netsuite: { number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false, lines: [nsLine('1', BINS, -4, '-40.00')] },
      netsuite_gl: entry(4000),
      before: [{ item_id: BINS, location_id: WENTZVILLE, quantity: '4', value: '40.00' }],
    }));
    expect(two.summary).toBe("Matches where it can be checked. FleetSuite didn't know the parts of RACK-KIT and SHELF-KIT, kits.");
    expect(two.items[2].why).toBe(
      "NetSuite's fulfillment took 4 of BIN-10 ($40.00), which FleetSuite's copy doesn't have: it may be a part of RACK-KIT and SHELF-KIT, kits FleetSuite couldn't take apart.",
    );
  });

  it("compares a kit's parts FleetSuite took it apart into with what NetSuite took for it, and says which kit each is a part of", () => {
    // One rack kit is four bins and two hooks: NetSuite's fulfillment has the kit's own line, which moves nothing, and its parts'.
    const c = check(pair({
      own: { lines: [
        ownLine(BINS, 4, { item_number: 'BIN-10', kit_id: RACK_KIT }),
        ownLine(HOOKS, 2, { line_no: 2, item_number: 'HOOK-1', kit_id: RACK_KIT }),
      ] },
      netsuite: {
        number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false,
        lines: [nsLine('1', RACK_KIT, -1, null, false), nsLine('2', BINS, -4, '-40.00'), nsLine('3', HOOKS, -2, '-10.00')],
      },
      netsuite_gl: entry(5000),
      before: [
        { item_id: BINS, location_id: WENTZVILLE, quantity: '4', value: '40.00' },
        { item_id: HOOKS, location_id: WENTZVILLE, quantity: '6', value: '30.00' },
      ],
    }));
    expect(c).toMatchObject({ status: 'matches', summary: "Matches NetSuite's fulfillment.", fleetsuiteCost: 5000, netsuiteCost: 5000, unknowns: [] });
    expect(c.items.map((i) => [i.item, i.partOf, i.same, i.why])).toEqual([
      ['BIN-10', 'A part of RACK-KIT', true, null],
      ['HOOK-1', 'A part of RACK-KIT', true, null],
    ]);
    expect(field(c, 'items')).toMatchObject({ fleetsuite: '2 items', netsuite: '2 items', same: true });
    expect(c.workedOut[2]).toBe(
      "A kit is taken apart into its parts, each the kit's quantity times what one kit holds: the parts NetSuite's sales order lists for it, "
        + "or, when it lists none, the parts the copy of NetSuite's items has. NetSuite takes a kit's parts from stock, not the kit.",
    );
    expect(c.workedOut[3]).toBe("From Wentzville, where FleetSuite's invoice location rule books Acme Fleet's invoices.");

    // A part NetSuite took fewer of differs, as any item does.
    const fewer = check(pair({
      own: { lines: [ownLine(BINS, 4, { item_number: 'BIN-10', kit_id: RACK_KIT })] },
      netsuite: {
        number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false,
        lines: [nsLine('1', RACK_KIT, -1, null, false), nsLine('2', BINS, -3, '-30.00')],
      },
      netsuite_gl: entry(3000),
      before: [{ item_id: BINS, location_id: WENTZVILLE, quantity: '4', value: '40.00' }],
    }));
    expect(fewer).toMatchObject({ status: 'differs', summary: 'Items: FleetSuite took 4 of BIN-10 from stock, and NetSuite 3.' });
  });

  it('says when an item was also taken on a line of its own, or as a part of more than one kit', () => {
    const c = check(pair({
      own: { lines: [
        ownLine(BINS, 2),
        ownLine(BINS, 4, { line_no: 2, sales_order_line_id: '2', kit_id: RACK_KIT }),
        ownLine(HOOKS, 2, { line_no: 3, sales_order_line_id: '2', kit_id: RACK_KIT }),
        ownLine(HOOKS, 1, { line_no: 4, sales_order_line_id: '3', kit_id: '9201' }),
        ownLine(HOOKS, 1, { line_no: 5, sales_order_line_id: '4', kit_id: RACK_KIT }),
        ownLine(LADDER, 1, { line_no: 6, sales_order_line_id: '3', kit_id: '9201' }),
        ownLine(LADDER, 2, { line_no: 7, sales_order_line_id: '5' }),
      ] },
      netsuite: {
        number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false,
        lines: [nsLine('1', BINS, -6, '-60.00'), nsLine('2', HOOKS, -4, '-20.00'), nsLine('3', LADDER, -3, '-455.00')],
      },
      netsuite_gl: entry(53500),
      before: [
        { item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' },
        { item_id: BINS, location_id: WENTZVILLE, quantity: '6', value: '60.00' },
        { item_id: HOOKS, location_id: WENTZVILLE, quantity: '6', value: '30.00' },
      ],
    }));
    // Each line costed on its own: the ladder racks 151.67 and 303.33.
    expect(c).toMatchObject({ status: 'matches', fleetsuiteCost: 53500, netsuiteCost: 53500 });
    expect(c.items.map((i) => [i.item, i.partOf])).toEqual([
      ['BIN-10', 'On a line of its own, and a part of RACK-KIT'],
      // The second kit isn't in the lists copy, so it's named by NetSuite's id.
      ['HOOK-1', 'A part of RACK-KIT and NetSuite item 9201'],
      // A part first, then on a line of its own.
      ['LDR-24', 'On a line of its own, and a part of NetSuite item 9201'],
    ]);
  });

  it("keeps an item the lists copy doesn't have, and counts it neither way", () => {
    const c = check(pair({ own: { lines: [ownLine(LADDER, 3), ownLine('9500', 1, { line_no: 2, item_number: 'NEW-1', item_type: null })] } }));
    expect(c.status).toBe('incomplete');
    expect(c.summary).toBe("Matches where it can be checked. FleetSuite didn't know whether NEW-1 is kept in stock (the copy of NetSuite's items doesn't have it yet).");
    expect(c.items[1]).toMatchObject({
      item: 'NEW-1', same: null, fleetsuite: { kind: 'unknown', cents: null },
      why: "FleetSuite didn't know whether NEW-1 is kept in stock (the copy of NetSuite's items doesn't have it yet), and NetSuite's fulfillment took none of it from stock.",
    });
    expect(field(c, 'cost').why).toBe("FleetSuite didn't know whether NEW-1 is kept in stock, so not what it cost.");
  });

  it("says what it couldn't work out: an order it hadn't copied, where it took stock from, an item it counted none of", () => {
    const uncopied = check(pair({ own: { lines: [], unknowns: ['lines'] } }));
    expect(uncopied).toMatchObject({
      status: 'incomplete', fleetsuiteCost: null, netsuiteCost: 45500,
      summary: "Matches where it can be checked. FleetSuite didn't know what it took from stock (FleetSuite's copy of the sales order didn't have the order yet).",
    });
    expect(field(uncopied, 'items')).toMatchObject({ fleetsuite: null, netsuite: '1 item', same: null });
    expect(uncopied.items).toEqual([expect.objectContaining({ item: 'LDR-24', fleetsuite: null, same: null, why: null })]);

    const nowhere = check(pair({ own: { location_id: null, location_from: null, unknowns: ['location'] }, before: [] }));
    expect(nowhere).toMatchObject({
      status: 'incomplete', fleetsuiteCost: null, locationId: null,
      summary: "Matches where it can be checked. FleetSuite didn't know where it took stock from, so what it cost.",
    });
    expect(field(nowhere, 'location')).toMatchObject({
      fleetsuite: null, netsuite: 'Wentzville', same: null, why: "FleetSuite didn't know where it took stock from: its invoice location rule couldn't tell from Acme Fleet.",
    });
    expect(nowhere.items[0]).toMatchObject({ same: null, why: "FleetSuite didn't know where it took LDR-24 from, so not what it cost." });
    expect(nowhere.workedOut[2]).toBe("Where it took stock from isn't known: FleetSuite's invoice location rule couldn't tell from the customer.");

    const none = check(pair({ before: [{ item_id: LADDER, location_id: WENTZVILLE, quantity: '0', value: '0' }] }));
    expect(none).toMatchObject({
      status: 'incomplete', fleetsuiteCost: null,
      summary: "Matches where it can be checked. FleetSuite didn't know what LDR-24 cost: it counted none at Wentzville just before.",
    });
    expect(none.items[0]).toMatchObject({
      same: null, fleetsuite: { count: 0, valueCents: 0, each: null, cents: null },
      why: "FleetSuite counted none of LDR-24 at Wentzville just before, so it can't work out what it cost.",
    });
  });

  it("names what it can't name by NetSuite's ids, and links FleetSuite's own invoice off the order", () => {
    const c = check(pair({
      own: { number: null, lines: [ownLine('9600', 1, { item_type: 'InvtPart' })] },
      netsuite: { number: null, type: 'ItemShip', date: '2026-10-19', gone: false, lines: [nsLine('1', '9600', -1, '-10.00')] },
      netsuite_gl: { posting_month: '2026-10-01', entry: [{ account_id: '999', debit: '0.00', credit: '10.00' }] },
      before: [{ item_id: '9600', location_id: WENTZVILLE, quantity: '1', value: '10.00' }],
      sales_order: null,
      invoice: { netsuite_id: '8001', number: null },
    }));
    expect(c).toMatchObject({ number: 'NetSuite 7001', salesOrder: 'NetSuite 6001', customer: null, invoice: { netsuiteId: '8001', number: 'NetSuite 8001' } });
    expect(c.items[0].item).toBe('NetSuite item 9600');
    expect(c.entry).toEqual([{ account: 'NetSuite account 999', debit: 0, credit: 1000 }]);
  });
});

describe('where each line was taken from', () => {
  /** A copy made since migration 514 from NetSuite's order: each line where the order has it. */
  const fromOrder = (lines: OwnFulfilLineData[], over: Partial<FulfilPairData['own']> = {}) => ({
    location_id: null, location_from: 'order' as const, lines, ...over,
  });
  const ns = (...lines: NetsuiteFulfilLineData[]) => ({ number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false, lines });
  const FROM_ORDER = "Each line from where NetSuite's sales order has it, read from NetSuite as the copy was made: NetSuite fulfils a "
    + 'whole order line by line, each line from its own location.';
  const BEFORE = [
    { item_id: LADDER, location_id: OFALLON, quantity: '10', value: '1000.00' },
    { item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' },
    { item_id: BINS, location_id: OFALLON, quantity: '4', value: '40.00' },
    { item_id: BINS, location_id: WENTZVILLE, quantity: '4', value: '40.00' },
  ];

  it('matches a fulfillment NetSuite took from two locations, each item costed where it was taken from', () => {
    const c = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: WENTZVILLE }),
        ownLine(BINS, 2, { line_no: 2, sales_order_line_id: '2', item_number: 'BIN-10', location_id: OFALLON }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -3, '-455.00'), nsLine('2', BINS, -2, '-20.00', true, OFALLON)),
      netsuite_gl: entry(47500),
      before: BEFORE,
    }));
    expect(c).toMatchObject({ status: 'matches', summary: "Matches NetSuite's fulfillment.", locationId: null, fleetsuiteCost: 47500, netsuiteCost: 47500 });
    expect(field(c, 'location')).toEqual({
      field: 'location', label: 'Location', fleetsuite: "O'Fallon and Wentzville", netsuite: "O'Fallon and Wentzville", same: true, why: null,
    });
    expect(c.items.map((i) => [i.item, i.same, i.fleetsuite])).toEqual([
      ['LDR-24', true, { quantity: 3, kind: 'stock', location: 'Wentzville', locationId: WENTZVILLE, count: 14, valueCents: 212333, each: 212333 / 14, cents: 45500 }],
      ['BIN-10', true, { quantity: 2, kind: 'stock', location: "O'Fallon", locationId: OFALLON, count: 4, valueCents: 4000, each: 1000, cents: 2000 }],
    ]);
    expect(c.workedOut[2]).toBe(`${FROM_ORDER} This one took stock from O'Fallon and Wentzville.`);
    // One place: the copy's, and the order's.
    const one = check(pair({ own: fromOrder([ownLine(LADDER, 3, { location_id: WENTZVILLE })], { location_id: WENTZVILLE }) }));
    expect(one).toMatchObject({ status: 'matches', locationId: WENTZVILLE });
    expect(one.workedOut[2]).toBe(`${FROM_ORDER} This one took stock from Wentzville.`);
    // A cost that differs says where FleetSuite counted what it costed the item from.
    const dearer = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: WENTZVILLE }),
        ownLine(BINS, 2, { line_no: 2, sales_order_line_id: '2', item_number: 'BIN-10', location_id: OFALLON }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -3, '-460.00'), nsLine('2', BINS, -2, '-20.00', true, OFALLON)),
      netsuite_gl: entry(48000),
      before: BEFORE,
    }));
    expect(dearer.items[0].why).toContain('(3 at $151.6664 each, from the 14 worth $2,123.33 FleetSuite counted at Wentzville just before)');
  });

  it("takes a kit's parts from the kit's line, and says so", () => {
    const c = check(pair({
      own: fromOrder([
        ownLine(BINS, 4, { item_number: 'BIN-10', kit_id: RACK_KIT, location_id: WENTZVILLE }),
        ownLine(HOOKS, 2, { line_no: 2, item_number: 'HOOK-1', kit_id: RACK_KIT, location_id: WENTZVILLE }),
      ], { location_id: WENTZVILLE }),
      netsuite: ns(nsLine('1', RACK_KIT, -1, null, false), nsLine('2', BINS, -4, '-40.00'), nsLine('3', HOOKS, -2, '-10.00')),
      netsuite_gl: entry(5000),
      before: [{ item_id: BINS, location_id: WENTZVILLE, quantity: '4', value: '40.00' }, { item_id: HOOKS, location_id: WENTZVILLE, quantity: '2', value: '10.00' }],
    }));
    expect(c).toMatchObject({ status: 'matches', fleetsuiteCost: 5000 });
    expect(c.workedOut).toContain(
      "Each line from where NetSuite's sales order has it, read from NetSuite as the copy was made: NetSuite fulfils a whole order line by "
        + "line, each line from its own location, and a kit's parts from the kit's line. This one took stock from Wentzville.",
    );
  });

  it("takes a line from where it says before the copy's location", () => {
    const c = check(pair({
      own: { location_id: OFALLON, lines: [ownLine(LADDER, 3, { location_id: WENTZVILLE })] },
      before: BEFORE,
    }));
    expect(c).toMatchObject({ status: 'matches', fleetsuiteCost: 45500 });
    expect(c.items[0].fleetsuite).toMatchObject({ location: 'Wentzville', locationId: WENTZVILLE, count: 14 });
  });

  it("differs when NetSuite took an item from elsewhere than its order's line, saying where each side took it from", () => {
    const c = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: WENTZVILLE }),
        ownLine(BINS, 2, { line_no: 2, sales_order_line_id: '2', item_number: 'BIN-10', location_id: OFALLON }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -3, '-455.00'), nsLine('2', BINS, -2, '-20.00')),
      netsuite_gl: entry(47500),
      before: BEFORE,
    }));
    expect(c).toMatchObject({
      status: 'differs', differing: 1, fleetsuiteCost: 47500, netsuiteCost: 47500,
      summary: "Location: NetSuite's sales order has its lines at O'Fallon and Wentzville, and NetSuite took stock from Wentzville.",
    });
    expect(c.items.map((i) => [i.item, i.same, i.why])).toEqual([
      ['LDR-24', true, null],
      ['BIN-10', false, "FleetSuite took it from O'Fallon, and NetSuite from Wentzville."],
    ]);
    // Told where to take every line from.
    const sent = check(pair({
      own: { location_id: OFALLON, location_from: 'sent', made_from: 'sales_order', lines: [ownLine(LADDER, 3, { location_id: OFALLON })] },
      before: BEFORE,
    }));
    expect(sent).toMatchObject({
      status: 'differs', summary: "Location: FleetSuite told NetSuite to take every line from O'Fallon, and NetSuite took stock from Wentzville.",
    });
    expect(sent.workedOut[2]).toBe("From O'Fallon, where FleetSuite told NetSuite to take every line from.");
  });

  it('differs on where when NetSuite took an item from more places than FleetSuite did, whatever it took', () => {
    // NetSuite took more, and from two places: how many and where both differ.
    const c = check(pair({
      own: fromOrder([ownLine(LADDER, 3, { location_id: WENTZVILLE })], { location_id: WENTZVILLE }),
      netsuite: ns(nsLine('1', LADDER, -3, '-455.00'), nsLine('2', LADDER, -1, '-100.00', true, OFALLON)),
      netsuite_gl: entry(55500),
      before: BEFORE,
    }));
    expect(c.status).toBe('differs');
    expect(c.items[0].why).toBe("FleetSuite took 3 of LDR-24 from stock, and NetSuite 4. FleetSuite took it from Wentzville, and NetSuite from O'Fallon and Wentzville.");
    expect(field(c, 'location')).toMatchObject({ fleetsuite: 'Wentzville', netsuite: "O'Fallon and Wentzville", same: false });
    // An item only NetSuite took, from a place FleetSuite took nothing from.
    const extra = check(pair({
      own: fromOrder([ownLine(LADDER, 3, { location_id: WENTZVILLE })], { location_id: WENTZVILLE }),
      netsuite: ns(nsLine('1', LADDER, -3, '-455.00'), nsLine('2', BINS, -1, '-10.00', true, OFALLON)),
      netsuite_gl: entry(46500),
      before: BEFORE,
    }));
    expect(field(extra, 'location')).toMatchObject({
      fleetsuite: 'Wentzville', netsuite: "O'Fallon and Wentzville", same: false,
      why: "NetSuite's sales order has its lines at Wentzville, and NetSuite took stock from O'Fallon and Wentzville.",
    });
  });

  it("compares where a copy made before took stock from, though it didn't know what it took", () => {
    const c = check(pair({ own: { location_id: OFALLON, location_from: 'po_rule', made_from: 'sales_order', lines: [], unknowns: ['lines'] } }));
    expect(field(c, 'location')).toMatchObject({
      fleetsuite: "O'Fallon", netsuite: 'Wentzville', same: false,
      why: "FleetSuite's PO location rule puts it in O'Fallon, and NetSuite took stock from Wentzville.",
    });
  });

  it('differs when each side took the items from the same places but not the same item from each', () => {
    const c = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: OFALLON }),
        ownLine(BINS, 2, { line_no: 2, sales_order_line_id: '2', item_number: 'BIN-10', location_id: WENTZVILLE }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -3, '-300.00'), nsLine('2', BINS, -2, '-20.00', true, OFALLON)),
      netsuite_gl: entry(32000),
      before: BEFORE,
    }));
    // FleetSuite's costs where it took them from: 3 at $100.00 and 2 at $10.00.
    expect(c).toMatchObject({ status: 'differs', differing: 1, fleetsuiteCost: 32000, netsuiteCost: 32000 });
    expect(c.summary).toBe("Location: FleetSuite took LDR-24 from O'Fallon, and NetSuite from Wentzville. 1 other item differs on where it was taken from too.");
    expect(field(c, 'location')).toMatchObject({ fleetsuite: "O'Fallon and Wentzville", netsuite: "O'Fallon and Wentzville", same: false });
    expect(c.items.map((i) => i.why)).toEqual([
      "FleetSuite took it from O'Fallon, and NetSuite from Wentzville.",
      "FleetSuite took it from Wentzville, and NetSuite from O'Fallon.",
    ]);
    // More than one other.
    const three = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: OFALLON }),
        ownLine(BINS, 2, { line_no: 2, sales_order_line_id: '2', item_number: 'BIN-10', location_id: WENTZVILLE }),
        ownLine(HOOKS, 1, { line_no: 3, sales_order_line_id: '3', item_number: 'HOOK-1', location_id: WENTZVILLE }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -3, '-300.00'), nsLine('2', BINS, -2, '-20.00', true, OFALLON), nsLine('3', HOOKS, -1, '-5.00', true, OFALLON)),
      netsuite_gl: entry(32500),
      before: [...BEFORE, { item_id: HOOKS, location_id: OFALLON, quantity: '2', value: '10.00' }, { item_id: HOOKS, location_id: WENTZVILLE, quantity: '2', value: '10.00' }],
    }));
    expect(field(three, 'location').why).toBe(
      "FleetSuite took LDR-24 from O'Fallon, and NetSuite from Wentzville. 2 other items differ on where they were taken from too.",
    );
  });

  it('costs an item taken from two places line by line, and says how many each side took from each when that differs', () => {
    const c = check(pair({
      own: fromOrder([
        ownLine(LADDER, 2, { location_id: OFALLON }),
        ownLine(LADDER, 1, { line_no: 2, sales_order_line_id: '2', location_id: WENTZVILLE }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -1, '-100.00', true, OFALLON), nsLine('2', LADDER, -2, '-303.33')),
      netsuite_gl: entry(40333),
      before: BEFORE,
    }));
    // 2 at $100.00 and 1 at $151.6664: $351.67.
    expect(c).toMatchObject({ status: 'differs', fleetsuiteCost: 35167, netsuiteCost: 40333 });
    expect(c.items[0].fleetsuite).toEqual({
      quantity: 3, kind: 'stock', location: "O'Fallon and Wentzville", locationId: null, count: null, valueCents: null, each: null, cents: 35167,
    });
    expect(c.items[0].netsuite).toMatchObject({ quantity: 3, locations: ["O'Fallon", 'Wentzville'] });
    expect(c.items[0].why).toBe(
      "FleetSuite took 2 from O'Fallon and 1 from Wentzville, and NetSuite 1 from O'Fallon and 2 from Wentzville. "
        + "FleetSuite's cost is $351.67, and NetSuite's $403.33 ($134.4433 each). NetSuite's is $51.66 more.",
    );
    // The cost follows from where it was taken from, so the summary doesn't say it too.
    expect(c.summary).toBe("Location: FleetSuite took 2 of LDR-24 from O'Fallon and 1 from Wentzville, and NetSuite 1 from O'Fallon and 2 from Wentzville.");
    // As many from each, it matches.
    const same = check(pair({
      own: fromOrder([
        ownLine(LADDER, 2, { location_id: OFALLON }),
        ownLine(LADDER, 1, { line_no: 2, sales_order_line_id: '2', location_id: WENTZVILLE }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -2, '-200.00', true, OFALLON), nsLine('2', LADDER, -1, '-151.67')),
      netsuite_gl: entry(35167),
      before: BEFORE,
    }));
    expect(same).toMatchObject({ status: 'matches', fleetsuiteCost: 35167 });
    // Each side's places are named in the same order, whichever line comes first.
    const flipped = check(pair({
      own: fromOrder([
        ownLine(LADDER, 1, { location_id: WENTZVILLE }),
        ownLine(LADDER, 2, { line_no: 2, sales_order_line_id: '2', location_id: OFALLON }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -2, '-303.33'), nsLine('2', LADDER, -1, '-100.00', true, OFALLON)),
      netsuite_gl: entry(40333),
      before: BEFORE,
    }));
    expect(flipped.items[0].why).toBe(c.items[0].why);
    expect(flipped.summary).toBe(c.summary);
    // Two lines of an item taken from one place add up on both sides.
    const twoLines = check(pair({
      own: fromOrder([
        ownLine(LADDER, 2, { location_id: OFALLON }),
        ownLine(LADDER, 1, { line_no: 2, sales_order_line_id: '2', location_id: OFALLON }),
      ], { location_id: OFALLON }),
      netsuite: ns(nsLine('1', LADDER, -2, '-200.00', true, OFALLON), nsLine('2', LADDER, -1, '-100.00', true, OFALLON)),
      netsuite_gl: entry(30000),
      before: BEFORE,
    }));
    expect(twoLines).toMatchObject({ status: 'matches', fleetsuiteCost: 30000, netsuiteCost: 30000 });
    // Another quantity is told about as such, not as where from.
    const fewer = check(pair({
      own: fromOrder([
        ownLine(LADDER, 2, { location_id: OFALLON }),
        ownLine(LADDER, 1, { line_no: 2, sales_order_line_id: '2', location_id: WENTZVILLE }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -1, '-100.00', true, OFALLON), nsLine('2', LADDER, -1, '-151.67')),
      netsuite_gl: entry(25167),
      before: BEFORE,
    }));
    expect(fewer.items[0].why).toBe('FleetSuite took 3 of LDR-24 from stock, and NetSuite 2.');
    expect(field(fewer, 'location')).toMatchObject({ same: true, why: null });
  });

  it("says when it doesn't know where NetSuite's order has the lines, or some of them", () => {
    const c = check(pair({ own: fromOrder([ownLine(LADDER, 3)], { unknowns: ['location'] }), before: [] }));
    expect(c).toMatchObject({
      status: 'incomplete', fleetsuiteCost: null, locationId: null,
      summary: "Matches where it can be checked. FleetSuite didn't know where it took stock from, so what it cost.",
    });
    expect(field(c, 'location')).toMatchObject({
      fleetsuite: null, netsuite: 'Wentzville', same: null,
      why: "FleetSuite didn't know where it took stock from: NetSuite's sales order couldn't be read as the copy was made, or doesn't say where each line is.",
    });
    expect(c.items[0]).toMatchObject({ same: null, why: "FleetSuite didn't know where it took LDR-24 from, so not what it cost.", fleetsuite: { location: null, locationId: null } });
    expect(c.workedOut[2]).toBe(`${FROM_ORDER} Where they were taken from isn't known: the order couldn't be read, or doesn't say.`);

    const some = check(pair({
      own: fromOrder([ownLine(LADDER, 2, { location_id: WENTZVILLE }), ownLine(LADDER, 1, { line_no: 2, sales_order_line_id: '2' })], { unknowns: ['location'] }),
      before: BEFORE,
    }));
    expect(some).toMatchObject({ status: 'incomplete', fleetsuiteCost: null });
    expect(some.items[0]).toMatchObject({ same: null, why: "FleetSuite didn't know where it took some of LDR-24 from, so not what it cost.", fleetsuite: { location: null } });
    expect(some.workedOut[2]).toBe(`${FROM_ORDER} Where some were taken from isn't known: the order couldn't be read, or doesn't say.`);
    // So nor is what it cost, whatever FleetSuite counted where the rest was taken from.
    const someNone = check(pair({
      own: fromOrder([ownLine(LADDER, 2, { location_id: OFALLON }), ownLine(LADDER, 1, { line_no: 2, sales_order_line_id: '2' })], { unknowns: ['location'] }),
      before: [{ item_id: LADDER, location_id: OFALLON, quantity: '0', value: '0' }],
    }));
    expect(field(someNone, 'cost').why).toBe("FleetSuite didn't know where it took stock from, so not what it cost.");
    expect(someNone.unknowns).toEqual(some.unknowns);
  });

  it('says which items it counted none of, at which locations', () => {
    const empty = [
      { item_id: LADDER, location_id: OFALLON, quantity: '0', value: '0' },
      { item_id: BINS, location_id: WENTZVILLE, quantity: '0', value: '0' },
      { item_id: BINS, location_id: OFALLON, quantity: '0', value: '0' },
    ];
    const c = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: OFALLON }),
        ownLine(BINS, 2, { line_no: 2, sales_order_line_id: '2', item_number: 'BIN-10', location_id: WENTZVILLE }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -3, '-300.00', true, OFALLON), nsLine('2', BINS, -2, '-20.00')),
      netsuite_gl: entry(32000),
      before: empty,
    }));
    expect(c).toMatchObject({ status: 'incomplete', fleetsuiteCost: null });
    expect(field(c, 'cost').why).toBe("FleetSuite counted none of LDR-24 at O'Fallon and none of BIN-10 at Wentzville just before, so it can't work out what they cost.");
    expect(c.unknowns).toEqual(["what LDR-24 and BIN-10 cost: it counted none of LDR-24 at O'Fallon and none of BIN-10 at Wentzville just before"]);
    expect(c.items[1].why).toBe("FleetSuite counted none of BIN-10 at Wentzville just before, so it can't work out what it cost.");
    // At one place, as before.
    const one = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: OFALLON }),
        ownLine(BINS, 2, { line_no: 2, sales_order_line_id: '2', item_number: 'BIN-10', location_id: OFALLON }),
      ], { location_id: OFALLON }),
      netsuite: ns(nsLine('1', LADDER, -3, '-300.00', true, OFALLON), nsLine('2', BINS, -2, '-20.00', true, OFALLON)),
      netsuite_gl: entry(32000),
      before: empty,
    }));
    expect(field(one, 'cost').why).toBe("FleetSuite counted none of LDR-24 and BIN-10 at O'Fallon just before, so it can't work out what they cost.");
    expect(one.unknowns).toEqual(["what LDR-24 and BIN-10 cost: it counted none at O'Fallon just before"]);
    // An item counted at one place it was taken from and not the other.
    const half = check(pair({
      own: fromOrder([
        ownLine(BINS, 1, { item_number: 'BIN-10', location_id: OFALLON }),
        ownLine(BINS, 1, { line_no: 2, sales_order_line_id: '2', item_number: 'BIN-10', location_id: WENTZVILLE }),
      ]),
      netsuite: ns(nsLine('1', BINS, -1, '-10.00', true, OFALLON), nsLine('2', BINS, -1, '-10.00')),
      netsuite_gl: entry(2000),
      before: [BEFORE[2], empty[1]],
    }));
    expect(half.items[0].why).toBe("FleetSuite counted none of BIN-10 at Wentzville just before, so it can't work out what it cost.");
    // An item on two lines taken from one place is named once.
    const twice = check(pair({
      own: fromOrder([
        ownLine(LADDER, 2, { location_id: OFALLON }),
        ownLine(LADDER, 1, { line_no: 2, sales_order_line_id: '2', location_id: OFALLON }),
      ], { location_id: OFALLON }),
      netsuite: ns(nsLine('1', LADDER, -2, '-200.00', true, OFALLON), nsLine('2', LADDER, -1, '-100.00', true, OFALLON)),
      netsuite_gl: entry(30000),
      before: empty,
    }));
    expect(field(twice, 'cost').why).toBe("FleetSuite counted none of LDR-24 at O'Fallon just before, so it can't work out what it cost.");
    expect(twice.unknowns).toEqual(["what LDR-24 cost: it counted none at O'Fallon just before"]);
  });

  it("took from nowhere when it took nothing, and doesn't count where an item not known to be kept in stock was", () => {
    const nothing = check(pair({ own: fromOrder([]), netsuite: null, netsuite_gl: null, before: [] }));
    expect(nothing).toMatchObject({ status: 'matches', summary: "Took nothing from stock, and nor did NetSuite's fulfillment." });
    expect(field(nothing, 'location')).toMatchObject({ fleetsuite: 'None', netsuite: 'None', same: null });
    expect(nothing.workedOut[2]).toBe(FROM_ORDER);

    const unlisted = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: WENTZVILLE }),
        ownLine('9500', 1, { line_no: 2, sales_order_line_id: '2', item_number: 'NEW-1', item_type: null, location_id: OFALLON }),
      ]),
    }));
    expect(unlisted.status).toBe('incomplete');
    expect(field(unlisted, 'location')).toMatchObject({ fleetsuite: 'Wentzville', same: true });
    // Unless NetSuite took it from stock.
    const taken = check(pair({
      own: fromOrder([
        ownLine(LADDER, 3, { location_id: WENTZVILLE }),
        ownLine('9500', 1, { line_no: 2, sales_order_line_id: '2', item_number: 'NEW-1', item_type: null, location_id: OFALLON }),
      ]),
      netsuite: ns(nsLine('1', LADDER, -3, '-455.00'), nsLine('2', '9500', -1, '-5.00', true, OFALLON)),
      netsuite_gl: entry(46000),
      before: [...BEFORE, { item_id: '9500', location_id: OFALLON, quantity: '1', value: '5.00' }],
    }));
    expect(field(taken, 'location')).toMatchObject({ fleetsuite: "O'Fallon and Wentzville", same: true });
  });
});

describe('the same check the other way round, for a document that puts stock back', () => {
  // A credit memo, as checkTaken words one that puts stock back on the shelf; its lines can each say where.
  const BACK: TakenWords = {
    theirs: "NetSuite's credit memo",
    the: 'the credit memo',
    notOnCopy: "FleetSuite's copy didn't credit it with Back to stock on",
    linesUnknown: 'what the copy put back',
    whereUnknown: "FleetSuite didn't know where the credit memo put stock back.",
    whereDiffers: (ours, theirs) => `FleetSuite put stock back at ${ours}, and NetSuite at ${theirs}.`,
    back: true,
  };
  // $100 a rack and $10 a bin at both places just before.
  const before = [LADDER, BINS].flatMap((item) => [OFALLON, WENTZVILLE].map((location_id) => ({
    item_id: item, location_id, quantity: '10', value: item === LADDER ? '1000.00' : '100.00',
  })));
  const back = (lines: OwnFulfilLineData[], netsuite: NetsuiteFulfilLineData[], cents: number) => checkTaken({
    own: { netsuite_id: '8001', date: '2026-10-19', location_id: null, unknowns: [], made_at: MADE_AT, lines },
    netsuite: { number: 'CM8001', type: 'CustCred', date: '2026-10-19', gone: false, lines: netsuite },
    netsuite_gl: {
      posting_month: '2026-10-01',
      entry: [
        { account_id: '190', debit: (cents / 100).toFixed(2), credit: '0.00' },
        { account_id: '580', debit: '0.00', credit: (cents / 100).toFixed(2) },
      ],
    },
    before,
  }, LISTS, SINCE, BACK);

  it('says how many each side put back at each place when that differs', () => {
    const c = back(
      [ownLine(LADDER, 2, { location_id: OFALLON }), ownLine(LADDER, 1, { line_no: 2, sales_order_line_id: '2', location_id: WENTZVILLE })],
      [nsLine('1', LADDER, 1, '100.00', true, OFALLON), nsLine('2', LADDER, 2, '200.00')],
      30000,
    );
    expect(c).toMatchObject({ status: 'differs', fleetsuiteCost: 30000, netsuiteCost: 30000 });
    expect(c.items[0].why).toBe("FleetSuite put back 2 at O'Fallon and 1 at Wentzville, and NetSuite 1 at O'Fallon and 2 at Wentzville.");
    expect(c.summary).toBe("Location: FleetSuite put back 2 of LDR-24 at O'Fallon and 1 at Wentzville, and NetSuite 1 at O'Fallon and 2 at Wentzville.");
  });

  it('says where each side put an item back, and how many other items differ on it', () => {
    const c = back(
      [ownLine(LADDER, 1, { location_id: OFALLON }), ownLine(BINS, 1, { line_no: 2, sales_order_line_id: '2', location_id: WENTZVILLE })],
      [nsLine('1', LADDER, 1, '100.00'), nsLine('2', BINS, 1, '10.00', true, OFALLON)],
      11000,
    );
    expect(c.items.map((i) => i.why)).toEqual([
      "FleetSuite put it back at O'Fallon, and NetSuite at Wentzville.",
      "FleetSuite put it back at Wentzville, and NetSuite at O'Fallon.",
    ]);
    expect(c.fields.find((f) => f.field === 'location')!.why)
      .toBe("FleetSuite put LDR-24 back at O'Fallon, and NetSuite at Wentzville. 1 other item differs on where it was put back too.");
  });
});

describe('every own fulfillment of a month', () => {
  it('checks each and counts them by how they compare', () => {
    const mk = (id: string, over: Partial<FulfilPairData> = {}) => {
      const p = pair(over);
      return { ...p, own: { ...p.own, netsuite_id: id } };
    };
    const checked = checkOwnFulfillments({
      fulfillments: [mk('7003'), mk('7002', { netsuite: null, netsuite_gl: null }), mk('7001', { netsuite_gl: entry(46000) })],
      items: { [LADDER]: { number: 'LDR-24', type: 'InvtPart', display_name: null } },
      locations: { [WENTZVILLE]: 'Wentzville' },
      accounts: {},
    }, NOT_YET);
    expect(checked.fulfillments.map((f) => [f.netsuiteId, f.status])).toEqual([['7003', 'matches'], ['7002', 'waiting'], ['7001', 'matches']]);
    expect(checked.counts).toEqual({ matches: 2, differs: 0, incomplete: 0, waiting: 1, voided: 0 });
    expect(checkOwnFulfillments({ fulfillments: [], items: {}, locations: {}, accounts: {} }, SINCE).counts)
      .toEqual({ matches: 0, differs: 0, incomplete: 0, waiting: 0, voided: 0 });
  });
});
