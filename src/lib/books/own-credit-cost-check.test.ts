import { describe, it, expect } from 'vitest';
import type { CopiesThrough, NetsuiteFulfilLineData } from './own-fulfillment-check';
import { checkOwnCreditCost, checkOwnCreditCosts, type CreditCostPairData, type CreditCostPairsData, type OwnCreditCostLineData } from './own-credit-cost-check';
import { invoiceCostLists } from './own-invoice-cost-check';

// Made-up items, locations and accounts.
const LADDER = '9001';
const BINS = '9002';
const RACK_KIT = '9200';
const ODD_KIT = '9202';
const INSTALL = '9300';
const OFALLON = '1';
const WENTZVILLE = '2';

const ITEMS: CreditCostPairsData['items'] = {
  [LADDER]: { number: 'LDR-24', type: 'InvtPart', display_name: 'Ladder rack 24 in', parts: null },
  [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null, parts: null },
  // A rack kit: a ladder rack and two bins.
  [RACK_KIT]: { number: 'RACK-KIT', type: 'Kit', display_name: 'Rack kit', parts: [{ item: LADDER, quantity: 1 }, { item: BINS, quantity: 2 }] },
  // A kit whose parts the copy can't read.
  [ODD_KIT]: { number: 'ODD-KIT', type: 'Kit', display_name: null, parts: 'not a list' },
  [INSTALL]: { number: '06-INSTALL', type: 'Service', display_name: 'Installation', parts: null },
};
const LISTS = invoiceCostLists({
  items: ITEMS,
  locations: { [OFALLON]: "O'Fallon", [WENTZVILLE]: 'Wentzville' },
  accounts: { 190: { number: '19000', name: 'Inventory Asset' }, 580: { number: '58000', name: 'Cost of Goods Sold' } },
});

const MADE_AT = '2026-10-26T15:00:00Z';
/** Neither copy has run since FleetSuite made it. */
const NOT_YET: CopiesThrough = { stock: '2026-10-26T14:00:00Z', ledger: '2026-10-26T14:30:00Z' };
/** Both have. */
const SINCE: CopiesThrough = { stock: '2026-10-26T17:00:00Z', ledger: '2026-10-26T17:30:00Z' };

const ownLine = (item: string, quantity: number | string, over: Partial<OwnCreditCostLineData> = {}): OwnCreditCostLineData => ({
  line_no: 1, item_id: item, item_number: ITEMS[item]?.number ?? null, description: null, item_type: ITEMS[item]?.type ?? null,
  quantity: String(quantity), ...over,
});
/** A line of NetSuite's credit memo as the copy of its stock moves has it: what came back, and what it posted to the inventory account. */
const nsLine = (line: string, item: string, quantity: number, value: string | null, moves = true, location = OFALLON): NetsuiteFulfilLineData => ({
  line_id: line, item_id: item, location_id: location, quantity: String(quantity), moves_stock: moves, value,
});
/** The cost lines of NetSuite's credit memo, putting `cents` back on inventory and taking it out of cost of goods sold. */
const entry = (cents: number) => ({
  posting_month: '2026-10-01',
  entry: [
    { account_id: '190', debit: (cents / 100).toFixed(2), credit: '0.00' },
    { account_id: '580', debit: '0.00', credit: (cents / 100).toFixed(2) },
  ],
});

/**
 * CM7401, made on the credit memo screen against INV7301: one ladder rack credited with Back to stock on, which comes
 * back at O'Fallon, where FleetSuite counted 12 worth $1,820.00 just before, so it's worth $151.67, and NetSuite's credit
 * memo put the same back: the item line moves stock, its cost lines don't.
 */
function pair(over: Partial<Omit<CreditCostPairData, 'own'>> & { own?: Partial<CreditCostPairData['own']> } = {}): CreditCostPairData {
  const { own, ...rest } = over;
  return {
    own: {
      netsuite_id: '7401', number: 'CM7401', invoice_id: '7301', invoice_number: 'INV7301', customer_netsuite_id: '9001',
      date: '2026-10-26', location_id: OFALLON, made_at: MADE_AT, lines: [ownLine(LADDER, 1)], ...own,
    },
    netsuite: {
      number: 'CM7401', type: 'CustCred', date: '2026-10-26', gone: false,
      lines: [nsLine('1', LADDER, 1, null), nsLine('4', LADDER, 1, null, false), nsLine('5', LADDER, 1, '151.67', false)],
    },
    netsuite_gl: entry(15167),
    before: [{ item_id: LADDER, location_id: OFALLON, quantity: '12', value: '1820.00' }],
    customer_name: 'Acme Fleet',
    ...rest,
  };
}

const check = (p: CreditCostPairData, copies: CopiesThrough = SINCE) => checkOwnCreditCost(p, LISTS, copies);
const field = (c: ReturnType<typeof check>, name: string) => c.fields.find((f) => f.field === name)!;
const MADE = "Made on Oct 26, 2026 against INV7301: a part credited with Back to stock on goes back on the shelf, as NetSuite's credit memo puts it back.";
const ITS_ITEMS = "Its items are the parts it credits with Back to stock on, as the copy of NetSuite's items has them. A part credited on the credit item stays with the customer.";
const AT_OFALLON = "Back at O'Fallon, where the credit memo screen puts every part that comes back on the shelf: it's the only location that keeps stock.";
const AVERAGE = 'Each item is worth its average at that location just before the credit memo: the value FleetSuite counted of it there over the count, '
  + 'from its count and value on December 31, 2024 and every NetSuite document since that comes before it, as Stock by item counts them. '
  + "A line is worth its quantity at that average, to the cent. Where NetSuite valued it otherwise, the two differ and the books post NetSuite's credit memo.";

describe("what FleetSuite's own credit memo put back on the shelf, next to NetSuite's credit memo", () => {
  it('matches when it put back what NetSuite put back, where, on the day, worth the same', () => {
    const c = check(pair());
    expect(c).toMatchObject({
      netsuiteId: '7401', number: 'CM7401', date: '2026-10-26', invoiceId: '7301', invoice: 'INV7301', customer: 'Acme Fleet',
      locationId: OFALLON, status: 'matches', summary: "Matches NetSuite's credit memo.", differing: 0, fleetsuiteCost: 15167, netsuiteCost: 15167,
      unknowns: [],
    });
    expect(c).not.toHaveProperty('places');
    expect(c).not.toHaveProperty('tookApart');
    expect(c.fields.map((f) => [f.field, f.fleetsuite, f.netsuite, f.same, f.why])).toEqual([
      ['date', 'Oct 26, 2026', 'Oct 26, 2026', true, null],
      ['location', "O'Fallon", "O'Fallon", true, null],
      ['items', '1 item', '1 item', true, null],
      ['cost', '$151.67', '$151.67', true, null],
    ]);
    expect(c.items).toEqual([{
      item: 'LDR-24', itemId: LADDER, description: null, partOf: null, same: true, why: null,
      fleetsuite: { quantity: 1, kind: 'stock', location: "O'Fallon", locationId: OFALLON, count: 12, valueCents: 182000, each: 182000 / 12, cents: 15167 },
      netsuite: { quantity: 1, locations: ["O'Fallon"], each: 15167, cents: 15167 },
    }]);
    expect(c.entry).toEqual([
      { account: '19000 Inventory Asset', debit: 15167, credit: 0 },
      { account: '58000 Cost of Goods Sold', debit: 0, credit: 15167 },
    ]);
    expect(c.workedOut).toEqual([MADE, ITS_ITEMS, AT_OFALLON, AVERAGE]);
  });

  it("goes by NetSuite's number, or its id, when the copy has none, and the invoice's id when it has no number", () => {
    expect(check(pair({ own: { number: null } })).number).toBe('CM7401');
    expect(check(pair({ own: { number: null }, netsuite: null }), NOT_YET).number).toBe('NetSuite 7401');
    const unnumbered = check(pair({ own: { invoice_number: null } }));
    expect(unnumbered.invoice).toBe('NetSuite 7301');
    expect(unnumbered.workedOut[0]).toBe("Made on Oct 26, 2026 against NetSuite 7301: a part credited with Back to stock on goes back on the shelf, as NetSuite's credit memo puts it back.");
    expect(check(pair({ customer_name: null })).customer).toBeNull();
    expect(check(pair({ customer_name: undefined as never })).customer).toBeNull();
  });

  it("leaves out a part that isn't kept in stock, as NetSuite does", () => {
    const c = check(pair({ own: { lines: [ownLine(LADDER, 1), ownLine(INSTALL, 1, { line_no: 2 })] } }));
    expect(c).toMatchObject({ status: 'matches', fleetsuiteCost: 15167 });
    expect(c.items.map((i) => i.item)).toEqual(['LDR-24']);
  });

  it("puts back a kit's parts, as NetSuite does, and says so", () => {
    const kits = pair({
      own: { lines: [ownLine(RACK_KIT, 1)] },
      netsuite: {
        number: 'CM7401', type: 'CustCred', date: '2026-10-26', gone: false,
        lines: [nsLine('1', RACK_KIT, 1, null, false), nsLine('2', LADDER, 1, '151.67'), nsLine('3', BINS, 2, '40.00')],
      },
      netsuite_gl: entry(19167),
      before: [
        { item_id: LADDER, location_id: OFALLON, quantity: '12', value: '1820.00' },
        { item_id: BINS, location_id: OFALLON, quantity: '20', value: '400.00' },
      ],
    });
    const c = check(kits);
    expect(c).toMatchObject({ status: 'matches', fleetsuiteCost: 19167, netsuiteCost: 19167 });
    expect(c.items.map((i) => [i.item, i.partOf, i.fleetsuite?.quantity, i.fleetsuite?.cents, i.netsuite?.cents])).toEqual([
      ['LDR-24', 'A part of RACK-KIT', 1, 15167, 15167],
      ['BIN-10', 'A part of RACK-KIT', 2, 4000, 4000],
    ]);
    expect(c.workedOut).toEqual([
      MADE, ITS_ITEMS,
      "A kit is taken apart into its parts, each the kit's quantity times what one kit holds, as the copy of NetSuite's items has them. "
        + "NetSuite puts a kit's parts back on the shelf, not the kit.",
      AT_OFALLON, AVERAGE,
    ]);
  });

  it('differs when NetSuite valued what came back otherwise, saying both', () => {
    // NetSuite put the rack back at what the invoice took it out at.
    const c = check(pair({
      netsuite: { ...pair().netsuite!, lines: [nsLine('1', LADDER, 1, null), nsLine('5', LADDER, 1, '140.00', false)] },
      netsuite_gl: entry(14000),
    }));
    expect(c).toMatchObject({ status: 'differs', fleetsuiteCost: 15167, netsuiteCost: 14000, differing: 1 });
    expect(field(c, 'cost')).toMatchObject({ fleetsuite: '$151.67', netsuite: '$140.00', same: false });
    expect(c.summary.startsWith('Cost: ')).toBe(true);
    expect(c.items[0]).toMatchObject({ same: false, netsuite: { quantity: 1, cents: 14000 } });
  });

  it('differs when NetSuite put the stock back somewhere else, saying where the credit memo screen puts it', () => {
    const c = check(pair({
      netsuite: { ...pair().netsuite!, lines: [nsLine('1', LADDER, 1, null, true, WENTZVILLE), nsLine('5', LADDER, 1, '151.67', false, WENTZVILLE)] },
      before: [{ item_id: LADDER, location_id: OFALLON, quantity: '12', value: '1820.00' }, { item_id: LADDER, location_id: WENTZVILLE, quantity: '3', value: '450.00' }],
    }));
    expect(c.status).toBe('differs');
    expect(field(c, 'location')).toMatchObject({
      fleetsuite: "O'Fallon", netsuite: 'Wentzville', same: false,
      why: "The credit memo screen puts every part that comes back on the shelf at O'Fallon, and NetSuite put stock back at Wentzville.",
    });
    expect(c.items[0].why).toBe("FleetSuite put it back at O'Fallon, and NetSuite at Wentzville.");
  });

  it('differs when NetSuite put back nothing, saying what FleetSuite put back', () => {
    const c = check(pair({ netsuite: null, netsuite_gl: null }));
    expect(c.status).toBe('differs');
    expect(c.summary).toBe("Items: NetSuite's credit memo put nothing back, or is gone from NetSuite: the copy of NetSuite's stock moves, made since, doesn't have it.");
    expect(c.items[0].why).toBe("FleetSuite put back 1 of LDR-24 ($151.67), and NetSuite's credit memo put none back.");
    expect(field(c, 'items')).toMatchObject({ fleetsuite: '1 item', netsuite: 'Nothing back' });
  });

  it('says what NetSuite put back that the copy doesn\'t, and how many each side put back', () => {
    const more = check(pair({
      netsuite: { ...pair().netsuite!, lines: [...pair().netsuite!.lines, nsLine('6', BINS, 1, '20.00')] },
      netsuite_gl: entry(17167),
    }));
    expect(more.status).toBe('differs');
    expect(field(more, 'items').why).toBe("NetSuite's credit memo put back 1 of BIN-10 ($20.00), and FleetSuite's copy of the credit memo doesn't put it back.");
    const two = check(pair({
      netsuite: { ...pair().netsuite!, lines: [nsLine('1', LADDER, 2, null), nsLine('5', LADDER, 2, '303.34', false)] },
      netsuite_gl: entry(30334),
    }));
    expect(two.items[0].why).toBe('FleetSuite put back 1 of LDR-24, and NetSuite 2.');
  });

  it("matches a credit memo that put nothing back when nor did NetSuite's, and puts it nowhere", () => {
    const c = check(pair({ own: { lines: [] }, netsuite: null, netsuite_gl: null }));
    expect(c).toMatchObject({
      status: 'matches', summary: "Put nothing back, and nor did NetSuite's credit memo.", fleetsuiteCost: 0, netsuiteCost: 0, locationId: null,
    });
    expect(field(c, 'location')).toMatchObject({ fleetsuite: 'None', netsuite: 'None' });
    expect(field(c, 'items')).toMatchObject({ fleetsuite: 'Nothing back', netsuite: 'Nothing back', same: true });
    expect(c.workedOut).toEqual(["Made on Oct 26, 2026 against INV7301. It puts nothing back on the shelf: none of its parts is credited with Back to stock on."]);
    // Only parts not kept in stock put nothing back either.
    expect(check(pair({ own: { lines: [ownLine(INSTALL, 1)] }, netsuite: null, netsuite_gl: null })).locationId).toBeNull();
  });

  it("is incomplete when a kit's parts aren't known, an item may be kept in stock, or none was counted there just before", () => {
    const odd = check(pair({ own: { lines: [ownLine(LADDER, 1), ownLine(ODD_KIT, 1, { line_no: 2 })] } }));
    expect(odd.status).toBe('incomplete');
    expect(odd.unknowns).toEqual(['the parts of ODD-KIT, a kit']);
    expect(odd.items.find((i) => i.itemId === ODD_KIT)?.why)
      .toBe("ODD-KIT is a kit FleetSuite couldn't take apart into its parts, so what NetSuite put back for it isn't compared.");

    const unknown = check(pair({ own: { lines: [ownLine(LADDER, 1), ownLine('9998', 1, { item_number: 'NEW-1', line_no: 2 })] } }));
    expect(unknown.status).toBe('incomplete');
    expect(unknown.items.find((i) => i.itemId === '9998')?.why)
      .toBe("FleetSuite didn't know whether NEW-1 is kept in stock (the copy of NetSuite's items doesn't have it yet), and NetSuite's credit memo put none of it back.");

    // None on the shelf just before: the average can't be worked out.
    const none = check(pair({ before: [] }));
    expect(none.status).toBe('incomplete');
    expect(none.unknowns).toEqual(["what LDR-24 cost: it counted none at O'Fallon just before"]);
    expect(field(none, 'cost').why).toBe("FleetSuite counted none of LDR-24 at O'Fallon just before, so it can't work out what it cost.");
  });

  it("is incomplete when it isn't known where the parts came back", () => {
    const c = check(pair({ own: { location_id: null } }));
    expect(c.status).toBe('incomplete');
    expect(c.locationId).toBeNull();
    expect(c.unknowns).toEqual(['where it put stock back, so what it cost']);
    expect(field(c, 'location').why).toBe("FleetSuite didn't know where the credit memo put stock back.");
    expect(field(c, 'cost').why).toBe("FleetSuite didn't know where it put stock back, so not what it cost.");
    expect(c.items[0].why).toBe("FleetSuite didn't know where it put LDR-24 back, so not what it cost.");
    expect(c.workedOut[2]).toBe("Where it put stock back isn't known.");
  });

  it('waits for the copies of NetSuite to have the credit memo, and its cost lines', () => {
    expect(check(pair({ netsuite: null }), NOT_YET)).toMatchObject({
      status: 'waiting', summary: "Waiting for NetSuite's credit memo: the copy of NetSuite's stock moves runs every two hours.",
    });
    expect(check(pair({ netsuite_gl: null }), NOT_YET)).toMatchObject({
      status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the credit memo.",
    });
  });

  it('is gone when NetSuite deleted its credit memo', () => {
    expect(check(pair({ netsuite: { ...pair().netsuite!, gone: true } }))).toMatchObject({ status: 'voided', summary: "NetSuite's credit memo is gone from NetSuite." });
  });

  it('checks every credit memo, counting each status', () => {
    const checked = checkOwnCreditCosts({
      credit_memos: [pair(), pair({ own: { netsuite_id: '7402' }, netsuite: null }), pair({ own: { netsuite_id: '7403' }, netsuite: { ...pair().netsuite!, gone: true } })],
      items: ITEMS,
      locations: { [OFALLON]: "O'Fallon" },
      accounts: {},
    }, SINCE);
    expect(checked.creditMemos.map((c) => [c.netsuiteId, c.status])).toEqual([['7401', 'matches'], ['7402', 'differs'], ['7403', 'voided']]);
    expect(checked.counts).toEqual({ differs: 1, incomplete: 0, waiting: 0, matches: 1, voided: 1 });
    expect(checkOwnCreditCosts({ credit_memos: undefined as never, items: {}, locations: {}, accounts: {} }, SINCE))
      .toEqual({ creditMemos: [], counts: { differs: 0, incomplete: 0, waiting: 0, matches: 0, voided: 0 } });
    // A copy without lines is one that puts nothing back.
    expect(checkOwnCreditCost(pair({ own: { lines: undefined as never }, netsuite: null, netsuite_gl: null }), LISTS, SINCE).status).toBe('matches');
  });
});
