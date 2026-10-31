import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChartAccount } from './invoice-check';
import { workOutStockMonth, type StockDocument } from './stock-check';
import type { FulfilItemPair, FulfilPairData, FulfilPairsData, OwnFulfillmentCheck } from './own-fulfillment-check';
import type { OwnReceiptCheck, ReceiptItemPair, ReceiptPairData, ReceiptPairsData } from './own-receipt-check';
import type { AdjustPairData, AdjustPairsData, OwnAdjustmentCheck } from './own-adjustment-check';
import {
  ADJUSTMENT_BOOKS,
  FULFILLMENT_BOOKS,
  OWN_ADJUSTMENT_RULE,
  OWN_FULFILLMENT_RULE,
  OWN_RECEIPT_RULE,
  RECEIPT_BOOKS,
  accountsApart,
  chartNames,
  entryRows,
  listed,
  movements,
  ownStockPick,
  ownStockRule,
  readOwnStockAccounts,
  readOwnStockCopies,
  readOwnStockSince,
  type LearnedCost,
  type OwnStockAccountsData,
  type OwnStockCopies,
} from './own-stock-posting';

// Made-up books: '190' inventory, '580' and '585' cost of goods, '210' and '211' hold received stock until it's billed,
// '520' takes the other side of an Inventory Adjust.
const chartAccount = (id: string | null, number: string | null, name: string, type: string): ChartAccount => ({
  netsuite_account_id: id, number, name, account_type: type, company: null, active: true, is_summary: false,
});
const CHART: ChartAccount[] = [
  chartAccount('190', '19000', 'Inventory Asset', 'other_current_asset'),
  chartAccount('580', '58000', 'Cost of Goods Sold', 'cost_of_goods_sold'),
  chartAccount('585', '58500', 'Cost of Goods Sold - Racks', 'cost_of_goods_sold'),
  chartAccount('210', '21000', 'Received Not Billed', 'other_current_liability'),
  chartAccount('211', '21100', 'Accrued Purchases', 'other_current_liability'),
  chartAccount('200', '20000', 'Accounts Payable', 'accounts_payable'),
  chartAccount('520', '52000', 'Inventory Adjustment', 'cost_of_goods_sold'),
];
const NAMES = chartNames(CHART);

const LADDER = '9001';
const BINS = '9002';
const HOOKS = '9003';
const RACK_KIT = '9200';
const KEY = '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f60';
const ADJUST_ID = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c';

/** One of a document's lines in the copy of NetSuite's GL, debit positive. */
const gl = (line: string, account: string, cents: number, name: string | null = null): StockDocument['lines'][number] => ({
  line_id: line, account, debit: cents > 0 ? (cents / 100).toFixed(2) : '0.00', credit: cents < 0 ? (-cents / 100).toFixed(2) : '0.00',
  memo: null, entity_id: null, name, customer_id: null,
});

/** NetSuite's fulfillment IF7001: three ladder racks, their $455.00 off inventory and onto 58500. */
const shipDoc = (over: Partial<StockDocument> = {}): StockDocument => ({
  netsuite_id: '7001', type: 'ItemShip', number: 'IF7001', date: '2026-10-19', posting_month: '2026-10-01', companies: ['BMG'],
  lines: [gl('1', '190', -45500, 'Acme Fleet'), gl('2', '585', 45500, 'Acme Fleet')],
  ...over,
});

/** NetSuite's item receipt IR7101: four bins at $25.00 onto inventory, held against 21000 until they're billed. */
const receiptDoc = (over: Partial<StockDocument> = {}): StockDocument => ({
  netsuite_id: '7101', type: 'ItemRcpt', number: 'IR7101', date: '2026-10-22', posting_month: '2026-10-01', companies: ['BMG'],
  lines: [gl('1', '190', 10000, 'Northside Supply'), gl('2', '210', -10000, 'Northside Supply')],
  ...over,
});

/** NetSuite's inventory adjustment ADJ7201: two bins fewer, their $30.00 off inventory and onto 52000. */
const adjustDoc = (over: Partial<StockDocument> = {}): StockDocument => ({
  netsuite_id: '7201', type: 'InvAdjst', number: 'ADJ7201', date: '2026-10-30', posting_month: '2026-10-01', companies: ['BMG'],
  lines: [gl('1', '190', -3000), gl('2', '520', 3000)],
  ...over,
});

/** The document as the stock rule works it out for the month's posting run. */
const worked = (doc: StockDocument) => workOutStockMonth({ documents: [doc] }, { company: 'BMG', chart: CHART }).documents[0];

/** An item of Books' own copy of a fulfillment: three of it, costing `cents` all told. */
const shipped = (item: string, itemId: string, cents: number | null, kind: 'stock' | 'kit' | 'unknown' = 'stock'): FulfilItemPair => ({
  item, itemId, description: null,
  fleetsuite: { quantity: 3, kind, location: '2', count: 14, valueCents: 212333, each: cents === null ? null : cents / 3, cents },
  netsuite: { quantity: 3, locations: ['2'], each: cents === null ? null : cents / 3, cents },
  same: true, why: null,
});
const LADDERS = shipped('LDR-24', LADDER, 45500);

/** Books' own copy of IF7001 as Own fulfillments checked it: only what the pick reads matters here. */
const fulfillment = (over: Partial<OwnFulfillmentCheck> = {}): OwnFulfillmentCheck => ({
  netsuiteId: '7001', number: 'IF7001', date: '2026-10-19', customer: 'Acme Fleet', status: 'matches', summary: 'Matches NetSuite.',
  unknowns: [], items: [LADDERS], ...over,
} as OwnFulfillmentCheck);

/** An item of Books' own copy of a receipt: four of it, at `cents` all told. */
const received = (item: string, itemId: string | null, cents: number | null, stock: boolean | null = true): ReceiptItemPair => ({
  item, itemId, description: null,
  fleetsuite: { quantity: 4, rate: cents === null ? null : cents / 400, cents, stock },
  netsuite: { quantity: 4, locations: ['1'], movesStock: stock === true, cents },
  same: true, why: null,
});
const BINS_IN = received('BIN-10', BINS, 10000);

/** Books' own copy of IR7101 as Own receipts checked it. */
const receipt = (over: Partial<OwnReceiptCheck> = {}): OwnReceiptCheck => ({
  receiptKey: KEY, netsuiteId: '7101', number: 'IR7101', date: '2026-10-22', company: 'BMG', vendor: 'Northside Supply',
  status: 'matches', summary: 'Matches NetSuite.', unknowns: [], items: [BINS_IN], ...over,
} as OwnReceiptCheck);

/** IF5002, a month before, shipped ladder racks and put their cost in 58500, as IF7001 does. */
const FROM_5002: LearnedCost = { cost: '585', from: { netsuite_id: '5002', number: 'IF5002', date: '2026-09-10' }, netsuite: '585' };
const ACCOUNTS: OwnStockAccountsData = {
  items: { [LADDER]: '190', [BINS]: '190', [HOOKS]: '190' },
  fulfillments: { 7001: { [LADDER]: FROM_5002 } },
  usual_cost: '580',
  received: [{ account: '210', documents: 12 }],
};

/** The Inventory Adjust that made ADJ7201 as Own adjustments checked it: two bins fewer, at $15.00 each. */
const adjustment = (over: Partial<OwnAdjustmentCheck> = {}): OwnAdjustmentCheck => ({
  id: ADJUST_ID, netsuiteId: '7201', number: 'ADJ7201', date: '2026-10-30', itemId: BINS, item: 'BIN-10', assetAccount: '190',
  change: -2, changeText: '2 fewer', reason: 'Damaged', status: 'matches', summary: "Matches NetSuite's adjustment.", unknowns: [],
  fleetsuiteValue: -3000, accountId: '520', ...over,
} as OwnAdjustmentCheck);

const copies = (over: Partial<OwnStockCopies> = {}): OwnStockCopies => ({
  fulfillments: new Map(), receipts: new Map(), adjustments: new Map(), accounts: ACCOUNTS, ...over,
});

/** What the books post for a fulfillment, given Books' copy of it. */
const pickShip = (check: OwnFulfillmentCheck | null = fulfillment(), doc = shipDoc(), accounts = ACCOUNTS, company = 'BMG') =>
  ownStockPick(worked(doc), copies({ fulfillments: new Map(check ? [[check.netsuiteId, check]] : []), accounts }), { company, names: NAMES });

/** What the books post for an item receipt, given Books' copy of it. */
const pickReceipt = (check: OwnReceiptCheck | null = receipt(), doc = receiptDoc(), accounts = ACCOUNTS, company = 'BMG') =>
  ownStockPick(worked(doc), copies({ receipts: new Map(check ? [[check.netsuiteId ?? '', check]] : []), accounts }), { company, names: NAMES });

/** What the books post for an inventory adjustment, given the Inventory Adjust that made it. */
const pickAdjust = (check: OwnAdjustmentCheck | null = adjustment(), doc = adjustDoc(), company = 'BMG') =>
  ownStockPick(worked(doc), copies({ adjustments: new Map(check ? [[check.netsuiteId ?? '', check]] : []) }), { company, names: NAMES });

/** A copy's line: debit positive, with its item. */
const line = (lineId: string, account: string, cents: number, memo: string | null, itemNumber: string | null) => ({
  lineId, account, cents, memo, customerId: null, vendorRef: null, itemNumber,
});
const RACK_COST = line(`own:${LADDER}:cost`, '585', 45500, 'Acme Fleet · LDR-24', 'LDR-24');
const RACK_ASSET = line(`own:${LADDER}:asset`, '190', -45500, 'Acme Fleet · LDR-24', 'LDR-24');
const BINS_ASSET = line(`own:${BINS}:asset`, '190', 10000, 'Northside Supply · BIN-10', 'BIN-10');
const held = (cents: number, account = '210') => line('own:received', account, -cents, 'Northside Supply', null);

const NOTHING = { entry: null, why: null, own: null, differs: null, learned: [], costs: null };
const SAID_RACKS = "Each item's cost comes out of its asset account and goes to the cost account NetSuite's last fulfillment of it used: "
  + '58500 Cost of Goods Sold - Racks for it.';
const SHIP_DIFFERS = "FleetSuite's own copy matches NetSuite's fulfillment, but its entry doesn't match NetSuite's, so the books post NetSuite's: ";

describe('the rules and the accounts', () => {
  it("is a fulfillment's, an item receipt's or an adjustment's own rule, and no other document's", () => {
    expect(ownStockRule('ItemShip')).toBe(OWN_FULFILLMENT_RULE);
    expect(ownStockRule('ItemRcpt')).toBe(OWN_RECEIPT_RULE);
    expect(ownStockRule('InvAdjst')).toBe(OWN_ADJUSTMENT_RULE);
    expect([OWN_FULFILLMENT_RULE, OWN_RECEIPT_RULE, OWN_ADJUSTMENT_RULE]).toEqual(['own_fulfillment@1', 'own_receipt@1', 'own_adjustment@1']);
    expect(ownStockRule('InvTrnfr')).toBeNull();
    expect(ownStockRule('VendBill')).toBeNull();
  });

  it("names each account in full and by its number, as the chart has it, and NetSuite's id for one it hasn't", () => {
    const names = chartNames([...CHART, chartAccount('700', null, 'Freight', 'expense'), chartAccount(null, '99999', 'Not in NetSuite', 'expense')]);
    expect(names.account('585')).toBe('58500 Cost of Goods Sold - Racks');
    expect(names.number('585')).toBe('58500');
    expect(names.account('700')).toBe('Freight');
    expect(names.number('700')).toBe('Freight');
    expect(names.account('999')).toBe('NetSuite account 999');
    expect(names.number('999')).toBe('NetSuite account 999');
    expect(names.types.get('210')).toBe('other_current_liability');
    expect(names.types.size).toBe(CHART.length + 1);
  });

  it('lists things as people do', () => {
    expect(listed([])).toBe('');
    expect(listed(['LDR-24'])).toBe('LDR-24');
    expect(listed(['LDR-24', 'BIN-10'])).toBe('LDR-24 and BIN-10');
    expect(listed(['LDR-24', 'BIN-10', 'HOOK-1'])).toBe('LDR-24, BIN-10 and HOOK-1');
  });

  it('says what an entry puts in each account, leaving out any it puts $0 in', () => {
    const lines = [
      { account: '190', cents: -100 }, { account: '585', cents: 100 }, { account: '190', cents: -50 }, { account: '585', cents: 50 },
      { account: '580', cents: 30 }, { account: '580', cents: -30 },
    ];
    expect([...movements(lines)]).toEqual([['190', -150], ['585', 150]]);
    expect(movements([]).size).toBe(0);
  });

  it("says which accounts two entries put different amounts in, in NetSuite's order of ids", () => {
    const mine = [{ account: '585', cents: 100 }, { account: '190', cents: -100 }];
    expect(accountsApart(mine, [{ account: '580', cents: 100 }, { account: '190', cents: -100 }])).toEqual(['580', '585']);
    expect(accountsApart(mine, [{ account: '190', cents: -60 }, { account: '585', cents: 60 }, { account: '190', cents: -40 }, { account: '585', cents: 40 }])).toEqual([]);
    // An account one side comes to $0 in is one it puts nothing in.
    expect(accountsApart([...mine, { account: '580', cents: 5 }, { account: '580', cents: -5 }], mine)).toEqual([]);
    // By number, not by letter, and by letter only for an id that isn't a number.
    expect(accountsApart([{ account: '1000', cents: 5 }], [{ account: '585', cents: 5 }])).toEqual(['585', '1000']);
    expect(accountsApart([{ account: 'b', cents: 5 }], [{ account: 'a', cents: 5 }])).toEqual(['a', 'b']);
  });

  it('lays two entries out account by account, the debits first, each where its account first comes', () => {
    const mine = [{ account: '190', cents: -45500 }, { account: '585', cents: 45500 }, { account: '211', cents: 7 }, { account: '211', cents: -7 }];
    const theirs = [{ account: '190', cents: -45500 }, { account: '580', cents: 45500 }];
    expect(entryRows(mine, theirs, NAMES.account)).toEqual([
      { account: '58500 Cost of Goods Sold - Racks', fleetsuite: 45500, netsuite: null, same: false },
      { account: '58000 Cost of Goods Sold', fleetsuite: null, netsuite: 45500, same: false },
      { account: '19000 Inventory Asset', fleetsuite: -45500, netsuite: -45500, same: true },
    ]);
    expect(entryRows([], [], NAMES.account)).toEqual([]);
  });

  it('reads what the journal holds for each kind from the stock postings, by its own rule', () => {
    expect(FULFILLMENT_BOOKS).toEqual({ fn: 'gl_stock_postings', list: 'documents', sourceType: 'item_fulfillment', ownRule: 'own_fulfillment@1' });
    expect(RECEIPT_BOOKS).toEqual({ fn: 'gl_stock_postings', list: 'documents', sourceType: 'item_receipt', ownRule: 'own_receipt@1' });
    expect(ADJUSTMENT_BOOKS).toEqual({ fn: 'gl_stock_postings', list: 'documents', sourceType: 'inventory_adjustment', ownRule: 'own_adjustment@1' });
  });
});

describe("what the books post for a fulfillment FleetSuite made", () => {
  it("posts the copy's entry when it moves each account as NetSuite's does, on the same day", () => {
    const entry = { lines: [RACK_COST, RACK_ASSET], date: '2026-10-19' };
    expect(pickShip()).toEqual({ entry, why: null, own: entry, differs: null, learned: [], costs: SAID_RACKS });
  });

  it("is the same entry however NetSuite splits its lines", () => {
    const hooks = shipped('HOOK-1', HOOKS, 12000);
    const accounts = { ...ACCOUNTS, fulfillments: { 7001: { [LADDER]: FROM_5002, [HOOKS]: FROM_5002 } } };
    const doc = shipDoc({ lines: [gl('1', '190', -57500), gl('2', '585', 57500)] });
    expect(pickShip(fulfillment({ items: [LADDERS, hooks] }), doc, accounts)?.entry?.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([
      [`own:${LADDER}:cost`, '585', 45500], [`own:${LADDER}:asset`, '190', -45500],
      [`own:${HOOKS}:cost`, '585', 12000], [`own:${HOOKS}:asset`, '190', -12000],
    ]);
  });

  it("dates it as NetSuite's, in the month NetSuite booked it into", () => {
    // Shipped in November, booked into October: the last of October, both of them.
    const late = pickShip(fulfillment({ date: '2026-11-02' }), shipDoc({ date: '2026-11-02' }));
    expect(late?.entry?.date).toBe('2026-10-31');
    // Shipped in September, booked into October: the first of October.
    expect(pickShip(fulfillment({ date: '2026-09-28' }), shipDoc({ date: '2026-09-28' }))?.entry?.date).toBe('2026-10-01');
  });

  it('leaves out what it took that FleetSuite doesn\'t keep in stock, or that cost nothing', () => {
    const items: FulfilItemPair[] = [
      LADDERS,
      shipped('RACK-KIT', RACK_KIT, 1200, 'kit'),
      shipped('NEW-1', RACK_KIT, 800, 'unknown'),
      shipped('HOOK-1', HOOKS, 0),
      shipped('HOOK-1', HOOKS, null),
      { ...shipped('BIN-10', BINS, 100), fleetsuite: null },
    ];
    expect(pickShip(fulfillment({ items }))?.entry?.lines).toEqual([RACK_COST, RACK_ASSET]);
  });

  it("says where it put each item's cost: where NetSuite's last fulfillment of it did, else where most do", () => {
    const hooks = shipped('HOOK-1', HOOKS, 12000);
    const bins = shipped('BIN-10', BINS, 2000);
    const learned = (fulfillments: Record<string, LearnedCost>) => ({ ...ACCOUNTS, fulfillments: { 7001: fulfillments } });
    const lines = (...costs: Array<[string, number]>) => costs.flatMap(([account, cents], i) => [gl(`${i}a`, '190', -cents), gl(`${i}b`, account, cents)]);
    const lead = "Each item's cost comes out of its asset account and goes to the cost account NetSuite's last fulfillment of it used: ";

    const both = pickShip(fulfillment({ items: [LADDERS, hooks] }), shipDoc({ lines: lines(['585', 45500], ['585', 12000]) }),
      learned({ [LADDER]: FROM_5002, [HOOKS]: FROM_5002 }));
    expect(both?.costs).toBe(`${lead}58500 Cost of Goods Sold - Racks for both.`);

    const three = pickShip(fulfillment({ items: [LADDERS, hooks, bins] }), shipDoc({ lines: lines(['585', 45500], ['585', 12000], ['585', 2000]) }),
      learned({ [LADDER]: FROM_5002, [HOOKS]: FROM_5002, [BINS]: FROM_5002 }));
    expect(three?.costs).toBe(`${lead}58500 Cost of Goods Sold - Racks for all three.`);

    const ids = Array.from({ length: 12 }, (_, i) => String(9500 + i));
    const twelve = pickShip(fulfillment({ items: ids.map((id) => shipped(`PART-${id}`, id, 100)) }), shipDoc({ lines: lines(['585', 1200]) }),
      { ...learned(Object.fromEntries(ids.map((id) => [id, FROM_5002]))), items: Object.fromEntries(ids.map((id) => [id, '190'])) });
    expect(twelve?.costs).toBe(`${lead}58500 Cost of Goods Sold - Racks for all 12.`);
    expect(twelve?.entry?.lines).toHaveLength(24);

    const FROM_5003: LearnedCost = { cost: '580', from: { netsuite_id: '5003', number: 'IF5003', date: '2026-09-14' }, netsuite: '580' };
    const apart = pickShip(fulfillment({ items: [LADDERS, bins] }), shipDoc({ lines: lines(['585', 45500], ['580', 2000]) }),
      learned({ [LADDER]: FROM_5002, [BINS]: FROM_5003 }));
    expect(apart?.costs).toBe(`${lead}58500 Cost of Goods Sold - Racks for LDR-24 and 58000 Cost of Goods Sold for BIN-10.`);

    // BIN-10 hasn't been shipped before.
    const usual = pickShip(fulfillment({ items: [LADDERS, bins] }), shipDoc({ lines: lines(['585', 45500], ['580', 2000]) }),
      learned({ [LADDER]: FROM_5002, [BINS]: { cost: null, from: null, netsuite: '580' } }));
    expect(usual?.entry).not.toBeNull();
    expect(usual?.costs).toBe(`${lead}58500 Cost of Goods Sold - Racks for LDR-24. `
      + "FleetSuite hadn't seen BIN-10 shipped before, so its cost goes to 58000 Cost of Goods Sold, where most fulfillments put theirs.");
    const only = pickShip(fulfillment({ items: [bins] }), shipDoc({ lines: lines(['580', 2000]) }), learned({}));
    expect(only?.entry?.lines.map((l) => l.account)).toEqual(['580', '190']);
    expect(only?.costs).toBe("FleetSuite hadn't seen BIN-10 shipped before, so its cost goes to 58000 Cost of Goods Sold, where most fulfillments put theirs.");
  });

  it("posts NetSuite's when the copy put an item's cost elsewhere, and learns where NetSuite put it", () => {
    const doc = shipDoc({ lines: [gl('1', '190', -45500), gl('2', '580', 45500)] });
    const accounts = { ...ACCOUNTS, fulfillments: { 7001: { [LADDER]: { ...FROM_5002, netsuite: '580' } } } };
    const differs = "FleetSuite put LDR-24's $455.00 in 58500 Cost of Goods Sold - Racks, where NetSuite's last fulfillment of it, IF5002 on Sep 10, 2026, "
      + 'put it, and NetSuite put it in 58000 Cost of Goods Sold';
    expect(pickShip(fulfillment(), doc, accounts)).toEqual({
      entry: null,
      why: `${SHIP_DIFFERS}${differs}.`,
      own: { lines: [RACK_COST, RACK_ASSET], date: '2026-10-19' },
      differs,
      learned: ["From now on FleetSuite puts LDR-24's cost in 58000, as NetSuite did here."],
      costs: SAID_RACKS,
    });
    // NetSuite's earlier fulfillment without a number goes by its id.
    const unnumbered = { ...ACCOUNTS, fulfillments: { 7001: { [LADDER]: { ...FROM_5002, from: { ...FROM_5002.from!, number: null }, netsuite: '580' } } } };
    expect(pickShip(fulfillment(), doc, unnumbered)?.differs).toContain("NetSuite's last fulfillment of it, NetSuite 5002 on Sep 10, 2026, put it");
  });

  it("posts NetSuite's when an item it hadn't seen shipped went somewhere else than most do", () => {
    const bins = shipped('BIN-10', BINS, 2000);
    const doc = shipDoc({ lines: [gl('1', '190', -2000), gl('2', '580', 2000)] });
    const accounts = { ...ACCOUNTS, usual_cost: '585', fulfillments: { 7001: { [BINS]: { cost: null, from: null, netsuite: '580' } } } };
    const p = pickShip(fulfillment({ items: [bins] }), doc, accounts);
    expect(p?.entry).toBeNull();
    expect(p?.why).toBe(`${SHIP_DIFFERS}FleetSuite hadn't seen BIN-10 shipped before, so it put its $20.00 in 58500 Cost of Goods Sold - Racks, `
      + 'where most fulfillments put theirs, and NetSuite put it in 58000 Cost of Goods Sold.');
    expect(p?.learned).toEqual(["From now on FleetSuite puts BIN-10's cost in 58000, as NetSuite did here."]);
    expect(p?.costs).toBe("FleetSuite hadn't seen BIN-10 shipped before, so its cost goes to 58500 Cost of Goods Sold - Racks, where most fulfillments put theirs.");
  });

  it("names the accounts when it can't say where NetSuite put an item's cost, or the amounts differ", () => {
    // Nothing says where NetSuite's fulfillment put it.
    const unsaid = pickShip(fulfillment(), shipDoc(), { ...ACCOUNTS, fulfillments: {} });
    expect(unsaid?.differs).toBe('it posts differently to 58000 Cost of Goods Sold and 58500 Cost of Goods Sold - Racks');
    expect(unsaid?.learned).toEqual([]);
    // Another cost than NetSuite's, to the same account.
    const cost = pickShip(fulfillment({ items: [shipped('LDR-24', LADDER, 45000)] }));
    expect(cost?.why).toBe(`${SHIP_DIFFERS}it posts differently to 19000 Inventory Asset and 58500 Cost of Goods Sold - Racks.`);
    expect(cost?.own?.lines.map((l) => l.cents)).toEqual([45000, -45000]);
    // Two items' costs each where the other's went: the same accounts, the same amounts, the same entry.
    const hooks = shipped('HOOK-1', HOOKS, 45500);
    const swapped = pickShip(fulfillment({ items: [LADDERS, hooks] }),
      shipDoc({ lines: [gl('1', '190', -91000), gl('2', '580', 45500), gl('3', '585', 45500)] }),
      { ...ACCOUNTS, fulfillments: { 7001: { [LADDER]: { ...FROM_5002, netsuite: '580' }, [HOOKS]: { cost: '580', from: FROM_5002.from, netsuite: '585' } } } });
    expect(swapped?.entry).not.toBeNull();
  });

  it("posts NetSuite's when the copy's dated another day, saying both", () => {
    expect(pickShip(fulfillment({ date: '2026-10-20' }))?.why).toBe(`${SHIP_DIFFERS}it's dated Oct 20, 2026, and NetSuite's Oct 19, 2026.`);
    expect(pickShip(fulfillment({ date: '2026-10-20', items: [shipped('LDR-24', LADDER, 45000)] }))?.differs)
      .toBe("it's dated Oct 20, 2026, and NetSuite's Oct 19, 2026; it posts differently to 19000 Inventory Asset and 58500 Cost of Goods Sold - Racks");
  });

  it("posts NetSuite's, saying why, when the copy doesn't match or isn't complete", () => {
    expect(pickShip(fulfillment({ status: 'waiting' }))).toEqual({
      ...NOTHING, why: "FleetSuite's own copy is waiting for NetSuite's fulfillment to be copied, so the books post NetSuite's for now.",
    });
    expect(pickShip(fulfillment({ status: 'differs' }))).toEqual({ ...NOTHING, why: "FleetSuite's own copy differs from NetSuite's fulfillment, so the books post NetSuite's." });
    expect(pickShip(fulfillment({ status: 'incomplete', unknowns: ["LDR-24's cost", 'where it took stock from'] }))?.why).toBe(
      "FleetSuite's own copy matches where it can be checked but is incomplete, so the books post NetSuite's fulfillment: "
        + "FleetSuite didn't know LDR-24's cost and where it took stock from.",
    );
    expect(pickShip(fulfillment({ status: 'incomplete', summary: "LDR-24's cost isn't known yet." }))?.why)
      .toBe("FleetSuite's own copy is incomplete, so the books post NetSuite's fulfillment. LDR-24's cost isn't known yet.");
  });

  it("says nothing when NetSuite voided its fulfillment, or its own lines don't balance", () => {
    expect(pickShip(fulfillment({ status: 'voided' }))).toEqual(NOTHING);
    expect(pickShip(fulfillment(), shipDoc({ lines: [gl('1', '190', -45500), gl('2', '585', 45000)] }))).toEqual(NOTHING);
    expect(pickShip(fulfillment(), shipDoc({ lines: [{ ...gl('1', '190', -45500), credit: 'a lot' }, gl('2', '585', 45500)] }))).toEqual(NOTHING);
  });

  it("posts NetSuite's when the copy's entry can't be worked out, saying why", () => {
    const lead = "FleetSuite's own copy matches NetSuite's fulfillment, but its entry can't be worked out, so the books post NetSuite's. ";
    expect(pickShip(fulfillment(), shipDoc(), { ...ACCOUNTS, items: {} }))
      .toEqual({ ...NOTHING, why: `${lead}LDR-24 has no asset account in the copy of NetSuite's items.` });
    const noCost = `${lead}FleetSuite doesn't know which account LDR-24's cost goes to: no fulfillment in the copy of NetSuite's GL has debited a cost yet.`;
    expect(pickShip(fulfillment(), shipDoc(), { ...ACCOUNTS, fulfillments: {}, usual_cost: null })).toEqual({ ...NOTHING, why: noCost });
    expect(pickShip(fulfillment(), shipDoc(), { ...ACCOUNTS, fulfillments: { 7001: { [LADDER]: { cost: null, from: null, netsuite: '585' } } }, usual_cost: null })?.why)
      .toBe(noCost);
    // Its asset first; and any item it can't work out stops the whole entry.
    expect(pickShip(fulfillment(), shipDoc(), { ...ACCOUNTS, items: {}, fulfillments: {}, usual_cost: null })?.why)
      .toBe(`${lead}LDR-24 has no asset account in the copy of NetSuite's items.`);
    const rackKit = shipped('RACK-KIT', RACK_KIT, 1200);
    expect(pickShip(fulfillment({ items: [LADDERS, rackKit] }))?.why).toBe(`${lead}RACK-KIT has no asset account in the copy of NetSuite's items.`);
  });

  it("posts nothing when neither entry has anything in it", () => {
    const kit = fulfillment({ items: [shipped('RACK-KIT', RACK_KIT, 1200, 'kit')] });
    expect(pickShip(kit, shipDoc({ lines: [] }))).toEqual({ ...NOTHING, own: { lines: [], date: '2026-10-19' } });
    // NetSuite's has something in it: that's an entry that differs.
    expect(pickShip(kit)?.differs).toBe('it posts differently to 19000 Inventory Asset and 58500 Cost of Goods Sold - Racks');
  });

  it("has no say when there's no copy, or the document is another kind, company or more than one company's", () => {
    expect(pickShip(null)).toBeNull();
    expect(pickShip(fulfillment({ netsuiteId: '7009' }))).toBeNull();
    const both = copies({ fulfillments: new Map([['7001', fulfillment()]]), receipts: new Map([['7101', receipt()]]) });
    expect(ownStockPick(worked(shipDoc({ type: 'InvAdjst' })), both, { company: 'BMG', names: NAMES })).toBeNull();
    // A copy of a receipt says nothing of a fulfillment with its id, nor the other way round.
    expect(ownStockPick(worked(shipDoc({ netsuite_id: '7101' })), both, { company: 'BMG', names: NAMES })).toBeNull();
    expect(ownStockPick(worked(receiptDoc({ netsuite_id: '7001' })), both, { company: 'BMG', names: NAMES })).toBeNull();
    // FleetSuite's fulfillments are BMG's.
    expect(pickShip(fulfillment(), shipDoc({ companies: ['1084'] }), ACCOUNTS, '1084')).toBeNull();
    expect(pickShip(fulfillment(), shipDoc({ companies: ['BMG', '1084'] }))).toBeNull();
    expect(pickShip(fulfillment(), shipDoc({ companies: [] }))).toBeNull();
    expect(pickShip(fulfillment(), shipDoc({ companies: ['1084'] }))).toBeNull();
  });
});

describe('what the books post for an item receipt from Receiving', () => {
  it("posts the copy's entry, each stock item onto its asset account and what they come to off where received stock waits for its bill", () => {
    const entry = { lines: [BINS_ASSET, held(10000)], date: '2026-10-22' };
    expect(pickReceipt()).toEqual({ entry, why: null, own: entry, differs: null, learned: [], costs: null, receiptKey: KEY });
  });

  it("leaves out what NetSuite doesn't keep in stock, or what cost nothing", () => {
    const items: ReceiptItemPair[] = [
      BINS_IN,
      received('STRAP-2', '9004', 3000, false),
      received('HOOK-1', HOOKS, 1500, null),
      received('HOOK-1', HOOKS, 0),
      received('HOOK-1', HOOKS, null),
      { ...received('LDR-24', LADDER, 45500), fleetsuite: null },
    ];
    expect(pickReceipt(receipt({ items }))?.entry?.lines).toEqual([BINS_ASSET, held(10000)]);
  });

  it('takes received stock off the account most of the company\'s receipts credit', () => {
    const accounts = { ...ACCOUNTS, received: [{ account: '211', documents: 3 }, { account: '210', documents: 12 }] };
    expect(pickReceipt(receipt(), receiptDoc(), accounts)?.entry?.lines).toEqual([BINS_ASSET, held(10000)]);
    // NetSuite's credited the other one.
    expect(pickReceipt(receipt(), receiptDoc({ lines: [gl('1', '190', 10000), gl('2', '211', -10000)] }), accounts)?.why).toBe(
      "FleetSuite's own copy matches NetSuite's receipt, but its entry doesn't match NetSuite's, so the books post NetSuite's: "
        + 'it posts differently to 21000 Received Not Billed and 21100 Accrued Purchases.',
    );
  });

  it("posts NetSuite's when the copy's entry can't be worked out, saying why", () => {
    const lead = "FleetSuite's own copy matches NetSuite's receipt, but its entry can't be worked out, so the books post NetSuite's. ";
    expect(pickReceipt(receipt({ items: [received('HOOK-1', null, 1500)] }))).toEqual({
      ...NOTHING, why: `${lead}HOOK-1 has no asset account in the copy of NetSuite's items.`, receiptKey: KEY,
    });
    expect(pickReceipt(receipt({ items: [received('RACK-KIT', RACK_KIT, 1500)] }))?.why).toBe(`${lead}RACK-KIT has no asset account in the copy of NetSuite's items.`);
    const nowhere = `${lead}FleetSuite doesn't know which account holds received stock until it's billed: `
      + "none of BMG's item receipts in the copy of NetSuite's GL credits one.";
    expect(pickReceipt(receipt(), receiptDoc(), { ...ACCOUNTS, received: [] })?.why).toBe(nowhere);
    // Payables never hold received stock.
    expect(pickReceipt(receipt(), receiptDoc(), { ...ACCOUNTS, received: [{ account: '200', documents: 40 }] })?.why).toBe(nowhere);
  });

  it("posts another company's receipt for that company", () => {
    const theirs = receipt({ company: '1084' });
    expect(pickReceipt(theirs, receiptDoc({ companies: ['1084'] }), ACCOUNTS, '1084')?.entry?.lines).toEqual([BINS_ASSET, held(10000)]);
    expect(pickReceipt(theirs, receiptDoc({ companies: ['1084'] }), { ...ACCOUNTS, received: [] }, '1084')?.why)
      .toContain("none of 1084's item receipts in the copy of NetSuite's GL credits one");
    expect(pickReceipt(theirs, receiptDoc({ companies: ['1084'] }))).toBeNull();
    expect(pickReceipt(receipt(), receiptDoc({ companies: ['1084'] }), ACCOUNTS, '1084')).toBeNull();
    expect(pickReceipt(receipt(), receiptDoc({ companies: ['BMG', '1084'] }))).toBeNull();
  });

  it("posts NetSuite's, saying why, when the copy doesn't match, and nothing when NetSuite didn't take it or voided it", () => {
    expect(pickReceipt(receipt({ status: 'waiting' }))).toEqual({
      ...NOTHING, why: "FleetSuite's own copy is waiting for NetSuite's receipt to be copied, so the books post NetSuite's for now.", receiptKey: KEY,
    });
    expect(pickReceipt(receipt({ status: 'differs' }))?.why).toBe("FleetSuite's own copy differs from NetSuite's receipt, so the books post NetSuite's.");
    expect(pickReceipt(receipt({ status: 'incomplete', unknowns: ['what BIN-10 cost'] }))?.why).toBe(
      "FleetSuite's own copy matches where it can be checked but is incomplete, so the books post NetSuite's receipt: FleetSuite didn't know what BIN-10 cost.",
    );
    expect(pickReceipt(receipt({ status: 'not_in_netsuite' }))).toEqual({ ...NOTHING, receiptKey: KEY });
    expect(pickReceipt(receipt({ status: 'voided' }))).toEqual({ ...NOTHING, receiptKey: KEY });
  });

  it('posts nothing for a receipt of nothing NetSuite keeps in stock', () => {
    const strap = receipt({ items: [received('STRAP-2', '9004', 3000, false)] });
    expect(pickReceipt(strap, receiptDoc({ lines: [] }))).toEqual({ ...NOTHING, own: { lines: [], date: '2026-10-22' }, receiptKey: KEY });
  });
});

describe('what the books post for an Inventory Adjust', () => {
  const BINS_OFF = line(`own:${BINS}:asset`, '190', -3000, 'Damaged · BIN-10', 'BIN-10');
  const ADJUSTED = line('own:adjustment', '520', 3000, 'Damaged · BIN-10', 'BIN-10');

  it("posts what the change came to off the item's asset account and onto Inventory Adjust's, when NetSuite's does the same", () => {
    const entry = { lines: [BINS_OFF, ADJUSTED], date: '2026-10-30' };
    expect(pickAdjust()).toEqual({ entry, why: null, own: entry, differs: null, learned: [], costs: null, adjustmentId: ADJUST_ID });
  });

  it('puts stock added onto the asset account, the other way round', () => {
    const found = adjustment({ change: 4, changeText: '4 more', reason: 'Found', fleetsuiteValue: 6000 });
    const doc = adjustDoc({ lines: [gl('1', '520', -6000), gl('2', '190', 6000)] });
    expect(pickAdjust(found, doc)?.entry?.lines.map((l) => [l.lineId, l.account, l.cents, l.memo])).toEqual([
      [`own:${BINS}:asset`, '190', 6000, 'Found · BIN-10'], ['own:adjustment', '520', -6000, 'Found · BIN-10'],
    ]);
  });

  it("dates it as NetSuite's, in the month NetSuite booked it into", () => {
    expect(pickAdjust(adjustment({ date: '2026-11-02' }), adjustDoc({ date: '2026-11-02' }))?.entry?.date).toBe('2026-10-31');
  });

  it("posts NetSuite's when its entry isn't the same, saying how", () => {
    const cent = adjustDoc({ lines: [gl('1', '190', -3001), gl('2', '520', 3001)] });
    expect(pickAdjust(adjustment(), cent)).toEqual({
      ...NOTHING,
      why: "FleetSuite's own copy matches NetSuite's adjustment, but its entry doesn't match NetSuite's, so the books post NetSuite's: "
        + 'it posts differently to 19000 Inventory Asset and 52000 Inventory Adjustment.',
      own: { lines: [BINS_OFF, ADJUSTED], date: '2026-10-30' },
      differs: 'it posts differently to 19000 Inventory Asset and 52000 Inventory Adjustment',
      adjustmentId: ADJUST_ID,
    });
    expect(pickAdjust(adjustment({ date: '2026-10-29' }))?.differs).toBe("it's dated Oct 29, 2026, and NetSuite's Oct 30, 2026");
  });

  it("posts NetSuite's, saying why, when the Inventory Adjust doesn't match, or its entry can't be worked out", () => {
    expect(pickAdjust(adjustment({ status: 'differs' }))?.why).toBe("FleetSuite's own copy differs from NetSuite's adjustment, so the books post NetSuite's.");
    expect(pickAdjust(adjustment({ status: 'waiting' }))?.why)
      .toBe("FleetSuite's own copy is waiting for NetSuite's adjustment to be copied, so the books post NetSuite's for now.");
    expect(pickAdjust(adjustment({ status: 'incomplete', unknowns: ['whether BIN-10 is kept in stock'] }))?.why).toBe(
      "FleetSuite's own copy matches where it can be checked but is incomplete, so the books post NetSuite's adjustment: "
        + "FleetSuite didn't know whether BIN-10 is kept in stock.",
    );
    expect(pickAdjust(adjustment({ assetAccount: null }))).toEqual({
      ...NOTHING,
      why: "FleetSuite's own copy matches NetSuite's adjustment, but its entry can't be worked out, so the books post NetSuite's. "
        + "BIN-10 has no asset account in the copy of NetSuite's items.",
      adjustmentId: ADJUST_ID,
    });
  });

  it("makes no entry for a change that came to nothing, posting NetSuite's when it booked something", () => {
    const strap = adjustment({ item: 'STRAP-2', fleetsuiteValue: 0 });
    expect(pickAdjust(strap, adjustDoc({ lines: [] }))).toEqual({ ...NOTHING, own: { lines: [], date: '2026-10-30' }, adjustmentId: ADJUST_ID });
    expect(pickAdjust(adjustment({ accountId: null }))?.differs).toBe('it posts differently to 19000 Inventory Asset and 52000 Inventory Adjustment');
  });

  it("says nothing when NetSuite voided its adjustment, and has no say on another company's or another kind", () => {
    expect(pickAdjust(adjustment({ status: 'voided' }))).toEqual({ ...NOTHING, adjustmentId: ADJUST_ID });
    expect(pickAdjust(null)).toBeNull();
    // Inventory Adjust adjusts O'Fallon's stock, which is BMG's.
    expect(pickAdjust(adjustment(), adjustDoc({ companies: ['1084'] }), '1084')).toBeNull();
    expect(pickAdjust(adjustment(), adjustDoc({ companies: ['BMG', '1084'] }))).toBeNull();
    // An adjustment's copy says nothing of a transfer or a fulfillment with its id.
    const theirs = copies({ adjustments: new Map([['7201', adjustment()]]) });
    expect(ownStockPick(worked(adjustDoc({ type: 'InvTrnfr' })), theirs, { company: 'BMG', names: NAMES })).toBeNull();
    expect(ownStockPick(worked(shipDoc({ netsuite_id: '7201' })), theirs, { company: 'BMG', names: NAMES })).toBeNull();
  });
});

describe('reading the copies and their accounts', () => {
  type Answer = { data: unknown; error: { message: string } | null };
  const service = (answers: Record<string, Answer>, calls: unknown[] = []) =>
    ({
      rpc: async (fn: string, args?: unknown) => {
        calls.push(args === undefined ? [fn] : [fn, args]);
        return answers[fn] ?? { data: null, error: null };
      },
    }) as unknown as SupabaseClient;
  const failing = (message: string): Answer => ({ data: null, error: { message } });

  it('finds the first month Books has each kind of copy in', async () => {
    const calls: unknown[] = [];
    expect(await readOwnStockSince(service({
      gl_own_fulfillment_months: { data: [{ month: '2026-10-01' }, { month: '2026-09-01' }], error: null },
      gl_own_receipt_months: { data: [], error: null },
      gl_own_adjustment_months: { data: [{ month: '2026-10-01', adjustments: 3 }], error: null },
    }, calls))).toEqual({ fulfillments: '2026-09-01', receipts: null, adjustments: '2026-10-01' });
    expect(calls).toEqual([['gl_own_fulfillment_months'], ['gl_own_receipt_months'], ['gl_own_adjustment_months']]);
    expect(await readOwnStockSince(service({}))).toEqual({ fulfillments: null, receipts: null, adjustments: null });
    await expect(readOwnStockSince(service({ gl_own_fulfillment_months: failing('statement timeout') }))).rejects.toThrow('statement timeout');
    await expect(readOwnStockSince(service({ gl_own_receipt_months: failing('permission denied') }))).rejects.toThrow('permission denied');
    await expect(readOwnStockSince(service({ gl_own_adjustment_months: failing('canceling statement') }))).rejects.toThrow('canceling statement');
  });

  it('reads the accounts only the matching copies post to, and nothing when none matches', async () => {
    const calls: unknown[] = [];
    const none = await readOwnStockAccounts(service({}, calls), 'BMG', new Map([['7001', fulfillment({ status: 'differs' })]]), new Map([['7101', receipt({ status: 'waiting' })]]));
    expect(none).toEqual({ items: {}, fulfillments: {}, usual_cost: null, received: [] });
    expect(calls).toEqual([]);

    const answer = { items: { [LADDER]: '190' }, usual_cost: '580', received: [{ account: 210, documents: '12' }, { account: '211', documents: null }] };
    const got = await readOwnStockAccounts(service({ gl_own_stock_accounts: { data: answer, error: null } }, calls), 'BMG',
      new Map([['7001', fulfillment()], ['7002', fulfillment({ netsuiteId: '7002', status: 'incomplete' })]]),
      new Map([['7101', receipt()]]));
    expect(calls).toEqual([['gl_own_stock_accounts', { p_company: 'BMG', p_fulfillments: ['7001'], p_receipts: ['7101'] }]]);
    expect(got).toEqual({ items: { [LADDER]: '190' }, fulfillments: {}, usual_cost: '580', received: [{ account: '210', documents: 12 }, { account: '211', documents: 0 }] });
    expect(await readOwnStockAccounts(service({}), 'BMG', new Map(), new Map([['7101', receipt()]]))).toEqual({ items: {}, fulfillments: {}, usual_cost: null, received: [] });
    await expect(readOwnStockAccounts(service({ gl_own_stock_accounts: failing('statement timeout') }), 'BMG', new Map([['7001', fulfillment()]]), new Map()))
      .rejects.toThrow('statement timeout');
  });

  // Books' own copies as gl_own_fulfillment_pairs and gl_own_receipt_pairs return them, NetSuite's documents the same.
  const fulfilPair = (netsuiteId: string, date: string): FulfilPairData => ({
    own: {
      netsuite_id: netsuiteId, number: `IF${netsuiteId}`, made_from: 'vehicle', made_from_id: 'checkin-1', sales_order_id: '6001',
      customer_netsuite_id: '9001', date, location_id: '2', location_from: 'customer_rule', unknowns: [], made_at: `${date}T15:00:00Z`,
      lines: [{ line_no: 1, item_id: LADDER, item_number: null, description: null, item_type: 'InvtPart', quantity: '3', sales_order_line_id: '1' }],
    },
    netsuite: {
      number: `IF${netsuiteId}`, type: 'ItemShip', date, gone: false,
      lines: [
        { line_id: '1', item_id: LADDER, location_id: '2', quantity: '-3', moves_stock: true, value: '-455.00' },
        { line_id: '2', item_id: LADDER, location_id: '2', quantity: '-3', moves_stock: false, value: null },
      ],
    },
    netsuite_gl: { posting_month: '2026-10-01', entry: [{ account_id: '190', debit: '0.00', credit: '455.00' }, { account_id: '585', debit: '455.00', credit: '0.00' }] },
    before: [{ item_id: LADDER, location_id: '2', quantity: '14', value: '2123.33' }],
    sales_order: { number: 'SO6001', customer_name: 'Acme Fleet' },
    invoice: null,
  });
  const receiptPair = (netsuiteId: string | null, key: string, date: string, company = 'BMG'): ReceiptPairData => ({
    own: {
      receipt_key: key, netsuite_id: netsuiteId, number: netsuiteId && `IR${netsuiteId}`, company, po_id: '5001', po_number: 'PO453-ACME',
      vendor_id: '77', vendor_name: 'Northside Supply', date, netsuite_error: null, unknowns: [], made_at: `${date}T15:00:00.000Z`,
      lines: [{ line_no: 1, item_id: BINS, item_number: 'BIN-10', description: null, quantity: '4.0000', rate: '25.0000', po_line_id: '3', po_receipt_id: key }],
    },
    netsuite: netsuiteId === null ? null : {
      number: `IR${netsuiteId}`, type: 'ItemRcpt', date, gone: false,
      lines: [{ line_id: '1', company, item_id: BINS, location_id: '1', quantity: '4', moves_stock: true, value: '100.00' }],
    },
    in_ledger: netsuiteId !== null,
    receiving: { posted: 1, manual_needed: 0, manual_done: 0 },
  });
  const FULFIL_PAIRS: FulfilPairsData = {
    fulfillments: [fulfilPair('7001', '2026-10-19'), fulfilPair('7002', '2026-10-12')],
    items: { [LADDER]: { number: 'LDR-24', type: 'InvtPart', display_name: 'Ladder rack 24 in' } },
    locations: { 2: 'Wentzville' },
    accounts: { 190: { number: '19000', name: 'Inventory Asset' }, 585: { number: '58500', name: 'Cost of Goods Sold - Racks' } },
  };
  const RECEIPT_PAIRS: ReceiptPairsData = {
    receipts: [
      receiptPair('7101', KEY, '2026-10-21'),
      // Not one of the month's documents; one NetSuite didn't take; and another company's.
      receiptPair('7102', '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', '2026-10-23'),
      receiptPair(null, '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a', '2026-10-24'),
      receiptPair('7103', '3e4f5a6b-7c8d-4e9f-0a1b-2c3d4e5f6a7b', '2026-10-28', '1084'),
    ],
    items: { [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null } },
    locations: { 1: "O'Fallon" },
  };
  // An Inventory Adjust as gl_own_adjustment_pairs returns it, next to NetSuite's adjustment.
  const adjustPair = (id: string, netsuiteId: string | null, date: string): AdjustPairData => ({
    own: {
      id, item_id: BINS, item_number: 'BIN-10', location_id: '1', mode: 'delta', entered_qty: '2', change: '-2', on_hand_before: '10',
      reason: 'Damaged', note: null, netsuite_id: netsuiteId, number: netsuiteId && `ADJ${netsuiteId}`, made_by: 'Pat Example', date,
      made_at: `${date}T15:00:00Z`,
    },
    netsuite: netsuiteId === null ? null : {
      number: `ADJ${netsuiteId}`, type: 'InvAdjst', date, gone: false,
      lines: [{ line_id: '1', company: 'BMG', item_id: BINS, location_id: '1', quantity: '-2', moves_stock: true, value: '-30.00' }],
    },
    netsuite_gl: netsuiteId === null ? null : {
      posting_month: '2026-10-01',
      entry: [{ account_id: '190', debit: '0.00', credit: '30.00', inventory: true }, { account_id: '520', debit: '30.00', credit: '0.00', inventory: false }],
    },
    before: { quantity: '10', value: '150.00' },
  });
  const ADJUST_PAIRS: AdjustPairsData = {
    adjustments: [
      adjustPair(ADJUST_ID, '7201', '2026-10-30'),
      // Not one of the month's documents, and one NetSuite didn't say it made.
      adjustPair('5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', '7202', '2026-10-30'),
      adjustPair('6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e', null, '2026-10-30'),
    ],
    items: { [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null, asset_account: '190' } },
    locations: { 1: "O'Fallon" },
    accounts: { 190: { number: '19000', name: 'Inventory Asset' } },
    account: { id: '520', number: '52000', name: 'Inventory Adjustment' },
  };
  const THROUGH = { stock: '2026-10-31T12:00:00Z', ledger: '2026-10-31T12:30:00Z' };
  const DOCUMENTS: Array<Pick<StockDocument, 'netsuite_id' | 'type' | 'date'>> = [
    { netsuite_id: '7001', type: 'ItemShip', date: '2026-10-19' },
    { netsuite_id: '7003', type: 'ItemShip', date: '2026-10-05' },
    { netsuite_id: '7101', type: 'ItemRcpt', date: '2026-10-21' },
    { netsuite_id: '7103', type: 'ItemRcpt', date: '2026-10-28' },
    { netsuite_id: '7201', type: 'InvAdjst', date: '2026-10-30' },
  ];

  it("checks the copies of the days the month's documents are dated across, keeping those of its documents, and reads their accounts", async () => {
    const calls: unknown[] = [];
    const read = await readOwnStockCopies(service({
      gl_own_fulfillment_pairs: { data: FULFIL_PAIRS, error: null },
      gl_own_receipt_pairs: { data: RECEIPT_PAIRS, error: null },
      gl_own_adjustment_pairs: { data: ADJUST_PAIRS, error: null },
      gl_own_stock_accounts: { data: { items: { [LADDER]: '190', [BINS]: '190' } }, error: null },
    }, calls), 'BMG', DOCUMENTS, { fulfillments: '2026-10-01', receipts: '2026-10-01', adjustments: '2026-10-01' }, THROUGH);
    expect(calls).toEqual([
      ['gl_own_fulfillment_pairs', { p_from: '2026-10-05', p_to: '2026-10-19', p_netsuite_id: null }],
      ['gl_own_receipt_pairs', { p_from: '2026-10-21', p_to: '2026-10-28', p_key: null }],
      ['gl_own_adjustment_pairs', { p_from: '2026-10-30', p_to: '2026-10-30', p_id: null, p_account: '52000' }],
      // An adjustment's check has its accounts already.
      ['gl_own_stock_accounts', { p_company: 'BMG', p_fulfillments: ['7001'], p_receipts: ['7101'] }],
    ]);
    expect([...read.fulfillments].map(([id, f]) => [id, f.status])).toEqual([['7001', 'matches']]);
    expect([...read.receipts].map(([id, r]) => [id, r.status, r.receiptKey])).toEqual([['7101', 'matches', KEY]]);
    expect([...read.adjustments].map(([id, a]) => [id, a.status, a.id, a.fleetsuiteValue])).toEqual([['7201', 'matches', ADJUST_ID, -3000]]);
    expect(read.accounts).toEqual({ items: { [LADDER]: '190', [BINS]: '190' }, fulfillments: {}, usual_cost: null, received: [] });
  });

  it("reads none from before Books had any, and no fulfillments for another company", async () => {
    const calls: unknown[] = [];
    const read = await readOwnStockCopies(service({}, calls), '1084', DOCUMENTS, { fulfillments: '2026-10-01', receipts: '2026-10-25', adjustments: '2026-10-01' }, THROUGH);
    expect(calls).toEqual([['gl_own_receipt_pairs', { p_from: '2026-10-25', p_to: '2026-10-28', p_key: null }]]);
    expect(read).toEqual({
      fulfillments: new Map(), receipts: new Map(), adjustments: new Map(), accounts: { items: {}, fulfillments: {}, usual_cost: null, received: [] },
    });

    const later: unknown[] = [];
    await readOwnStockCopies(service({}, later), 'BMG', DOCUMENTS, { fulfillments: '2026-10-10', receipts: null, adjustments: null }, THROUGH);
    expect(later).toEqual([['gl_own_fulfillment_pairs', { p_from: '2026-10-10', p_to: '2026-10-19', p_netsuite_id: null }]]);
    const none: unknown[] = [];
    await readOwnStockCopies(service({}, none), 'BMG', DOCUMENTS, { fulfillments: '2026-10-20', receipts: '2026-10-29', adjustments: '2026-11-01' }, THROUGH);
    expect(none).toEqual([]);
  });

  it("says why when the copies can't be read", async () => {
    const since = { fulfillments: '2026-10-01', receipts: '2026-10-01', adjustments: '2026-10-01' };
    await expect(readOwnStockCopies(service({ gl_own_fulfillment_pairs: failing('statement timeout') }), 'BMG', DOCUMENTS, since, THROUGH))
      .rejects.toThrow('statement timeout');
    await expect(readOwnStockCopies(service({ gl_own_receipt_pairs: failing('permission denied') }), 'BMG', DOCUMENTS, since, THROUGH))
      .rejects.toThrow('permission denied');
    await expect(readOwnStockCopies(service({ gl_own_adjustment_pairs: failing('canceling statement') }), 'BMG', DOCUMENTS, since, THROUGH))
      .rejects.toThrow('canceling statement');
  });
});
