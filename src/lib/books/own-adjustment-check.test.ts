import { describe, it, expect } from 'vitest';
import {
  INVENTORY_ADJUST_ACCOUNT,
  changeWords,
  checkOwnAdjustment,
  checkOwnAdjustments,
  type AdjustPairData,
  type AdjustPairsData,
  type NetsuiteAdjustmentData,
  type OwnAdjustmentData,
} from './own-adjustment-check';
import type { CopiesThrough } from './own-fulfillment-check';

const BIN = '9002';
const HOOK = '9004';
const STRAP = '9005';
const ID = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c';

const MADE_AT = '2026-10-30T15:00:00.000Z';
/** Neither copy has run since the Inventory Adjust. */
const BEFORE: CopiesThrough = { stock: '2026-10-30T13:00:00.000Z', ledger: '2026-10-30T13:00:00.000Z' };
/** Both have, the ledger's more than ten minutes after it. */
const SINCE: CopiesThrough = { stock: '2026-10-30T17:00:00.000Z', ledger: '2026-10-30T17:30:00.000Z' };

// Made-up books: '190' inventory, '580' cost of goods, '520' Inventory Adjust's other side.
const LISTS: Omit<AdjustPairsData, 'adjustments'> = {
  items: {
    [BIN]: { number: 'BIN-10', type: 'InvtPart', display_name: 'Storage bin', asset_account: '190' },
    [HOOK]: { number: 'HOOK-1', type: 'InvtPart', display_name: null, asset_account: '190' },
    [STRAP]: { number: 'STRAP-2', type: 'NonInvtPart', display_name: null, asset_account: null },
  },
  locations: { 1: "O'Fallon", 3: 'Van stock' },
  accounts: { 190: { number: '19000', name: 'Inventory Asset' }, 580: { number: '58000', name: 'Cost of Goods Sold' } },
  account: { id: '520', number: '52000', name: 'Inventory Adjustment' },
};

/** Pat took two damaged bins off at O'Fallon, which had ten. */
const own = (over: Partial<OwnAdjustmentData> = {}): OwnAdjustmentData => ({
  id: ID, item_id: BIN, item_number: 'BIN-10', location_id: '1', mode: 'delta', entered_qty: '2.00', change: '-2.00',
  on_hand_before: '10.00', reason: 'Damaged', note: 'Cracked lids', netsuite_id: '7201', number: 'ADJ0143', made_by: 'Pat Example',
  date: '2026-10-30', made_at: MADE_AT, ...over,
});

type NetLine = NetsuiteAdjustmentData['lines'][number];
const binNet: NetLine = { line_id: '1', company: 'BMG', item_id: BIN, location_id: '1', quantity: '-2', moves_stock: true, value: '-30.00' };

/** NetSuite's adjustment as the stock copy has it, valued from the ledger copy. */
const netsuite = (over: Partial<NetsuiteAdjustmentData> = {}): NetsuiteAdjustmentData => ({
  number: 'ADJ0143', type: 'InvAdjst', date: '2026-10-30', gone: false, lines: [binNet], ...over,
});

/** What it posted: $30.00 off 19000, onto 52000. */
const GL: NonNullable<AdjustPairData['netsuite_gl']> = {
  posting_month: '2026-10-01',
  entry: [{ account_id: '190', debit: '0.00', credit: '30.00', inventory: true }, { account_id: '520', debit: '30.00', credit: '0.00', inventory: false }],
};
const glOf = (cents: number, other = '520'): AdjustPairData['netsuite_gl'] => {
  const amount = (Math.abs(cents) / 100).toFixed(2);
  const [onto, off] = cents > 0 ? [amount, '0.00'] : ['0.00', amount];
  return { posting_month: '2026-10-01', entry: [{ account_id: '190', debit: onto, credit: off, inventory: true }, { account_id: other, debit: off, credit: onto, inventory: false }] };
};

/** Ten bins at O'Fallon just before, $150.00 all told: $15.00 each. */
const pair = (o = own(), ns: NetsuiteAdjustmentData | null = netsuite(), over: Partial<AdjustPairData> = {}): AdjustPairData => ({
  own: o, netsuite: ns, netsuite_gl: ns ? GL : null, before: { quantity: '10', value: '150.00' }, ...over,
});

const check = (p: AdjustPairData = pair(), copies = SINCE, lists: Partial<Omit<AdjustPairsData, 'adjustments'>> = {}) =>
  checkOwnAdjustments({ ...LISTS, ...lists, adjustments: [p] }, copies).adjustments[0];
const field = (c: ReturnType<typeof check>, name: string) => c.fields.find((f) => f.field === name)!;

describe('an Inventory Adjust next to NetSuite\'s adjustment', () => {
  it("matches NetSuite's when it changed the same item by as many, there, on the day, for as much, against 52000", () => {
    const c = check();
    expect(c).toMatchObject({
      id: ID, netsuiteId: '7201', number: 'ADJ0143', date: '2026-10-30', itemId: BIN, item: 'BIN-10', description: 'Storage bin',
      assetAccount: '190', locationId: '1', location: "O'Fallon", change: -2, changeText: '2 fewer', mode: 'delta', entered: 2,
      onHandBefore: 10, reason: 'Damaged', note: 'Cracked lids', madeBy: 'Pat Example', status: 'matches',
      summary: "Matches NetSuite's adjustment.", differing: 0, fleetsuiteValue: -3000, netsuiteValue: -3000,
      before: { count: 10, valueCents: 15000 }, each: 1500, accountId: '520', unknowns: [],
    });
    expect(c.fields.map((f) => [f.field, f.fleetsuite, f.netsuite, f.same, f.why])).toEqual([
      ['date', 'Oct 30, 2026', 'Oct 30, 2026', true, null],
      ['location', "O'Fallon", "O'Fallon", true, null],
      ['change', '2 fewer', '2 fewer', true, null],
      ['value', '$30.00', '$30.00', true, null],
      ['account', '52000 Inventory Adjustment', '52000 Inventory Adjustment', true, null],
    ]);
    expect(c.entry).toEqual([
      { account: '19000 Inventory Asset', debit: 0, credit: 3000 },
      { account: '52000 Inventory Adjustment', debit: 3000, credit: 0 },
    ]);
    expect(c.workedOut).toEqual([
      'Pat Example used Inventory Adjust on Oct 30, 2026: Damaged, "Cracked lids".',
      "They took off 2, from the 10 NetSuite had on hand at O'Fallon.",
      "2 BIN-10 at $15.00 each, its average at O'Fallon just before ($150.00 for 10): $30.00.",
      "An item's average at a location just before is the value FleetSuite counted of it there over the count, from its count and value on "
        + 'December 31, 2024 and every NetSuite document since that comes before the adjustment, as Stock by item counts them. '
        + 'The change is valued at that average, to the cent.',
      'Its other side goes to 52000 Inventory Adjustment, the account Inventory Adjust posts to.',
    ]);
    expect(INVENTORY_ADJUST_ACCOUNT).toBe('52000');
  });

  it('values stock added onto the shelf the other way, and says how a count was entered', () => {
    const found = check(pair(own({ mode: 'count', entered_qty: '14.00', change: '4.00', reason: 'Found', note: null }),
      netsuite({ lines: [{ ...binNet, quantity: '4', value: '60.00' }] }), { netsuite_gl: glOf(6000) }));
    expect(found).toMatchObject({ status: 'matches', change: 4, changeText: '4 more', fleetsuiteValue: 6000, netsuiteValue: 6000, entered: 14 });
    expect(found.workedOut.slice(0, 3)).toEqual([
      'Pat Example used Inventory Adjust on Oct 30, 2026: Found.',
      "They counted 14 on the shelf at O'Fallon, where NetSuite had 10 on hand, so it's 4 more.",
      "4 BIN-10 at $15.00 each, its average at O'Fallon just before ($150.00 for 10): $60.00.",
    ]);
    const added = check(pair(own({ change: '4.00', made_by: null, on_hand_before: null }), netsuite({ lines: [{ ...binNet, quantity: '4', value: '60.00' }] }),
      { netsuite_gl: glOf(6000) }));
    expect(added.workedOut.slice(0, 2)).toEqual(['Someone used Inventory Adjust on Oct 30, 2026: Damaged, "Cracked lids".', 'They added 4.']);
  });

  it('values the change at the average to the cent, half away from zero', () => {
    // Three at $100.00: $33.333… each, so one of them is $33.33.
    const third = pair(own({ change: '-1.00' }), netsuite({ lines: [{ ...binNet, quantity: '-1', value: '-33.33' }] }),
      { before: { quantity: '3', value: '100.00' }, netsuite_gl: glOf(-3333) });
    expect(check(third)).toMatchObject({ status: 'matches', fleetsuiteValue: -3333, netsuiteValue: -3333 });
    expect(check(third).workedOut[2]).toBe("1 BIN-10 at $33.3333 each, its average at O'Fallon just before ($100.00 for 3): $33.33.");
    // Six at $100.01: $16.668… each, so one is $16.67.
    const sixth = pair(own({ change: '-1.00' }), netsuite({ lines: [{ ...binNet, quantity: '-1', value: '-16.67' }] }),
      { before: { quantity: '6', value: '100.01' }, netsuite_gl: glOf(-1667) });
    expect(check(sixth)).toMatchObject({ status: 'matches', fleetsuiteValue: -1667 });
  });

  it("names it by NetSuite's number, else NetSuite's id, else as Inventory Adjust", () => {
    expect(check(pair(own({ number: null }))).number).toBe('ADJ0143');
    expect(check(pair(own({ number: null }), netsuite({ number: null }))).number).toBe('NetSuite 7201');
    expect(check(pair(own({ number: null, netsuite_id: null }), null), SINCE).number).toBe('Inventory Adjust');
  });

  it('names the item as Inventory Adjust saved it, though NetSuite has renamed it since', () => {
    const renamed = check(pair(), SINCE, { items: { ...LISTS.items, [BIN]: { ...LISTS.items[BIN], number: 'BIN-10A' } } });
    expect(renamed).toMatchObject({ item: 'BIN-10', status: 'matches' });
    expect(renamed.workedOut[2]).toBe("2 BIN-10 at $15.00 each, its average at O'Fallon just before ($150.00 for 10): $30.00.");
    // One saved without its number takes NetSuite's, else NetSuite's id.
    expect(check(pair(own({ item_number: '' }))).item).toBe('BIN-10');
    expect(check(pair(own({ item_id: '9999', item_number: '' }), netsuite({ lines: [{ ...binNet, item_id: '9999' }] }))).item).toBe('NetSuite item 9999');
  });
});

describe('what differs', () => {
  it('the date, by how many days', () => {
    const c = check(pair(own(), netsuite({ date: '2026-10-31' })));
    expect(c).toMatchObject({ status: 'differs', differing: 1 });
    expect(c.summary).toBe("Date: Inventory Adjust made it Oct 30, 2026, and NetSuite's adjustment is dated 1 day later.");
    expect(check(pair(own(), netsuite({ date: '2026-10-27' }))).summary)
      .toBe("Date: Inventory Adjust made it Oct 30, 2026, and NetSuite's adjustment is dated 3 days earlier.");
  });

  it('where it changed stock', () => {
    const c = check(pair(own(), netsuite({ lines: [{ ...binNet, location_id: '3' }] })));
    expect(field(c, 'location')).toMatchObject({ fleetsuite: "O'Fallon", netsuite: 'Van stock', same: false });
    expect(c.summary).toBe("Location: Inventory Adjust changed BIN-10 at O'Fallon, and NetSuite's adjustment at Van stock.");
    const both = check(pair(own(), netsuite({ lines: [{ ...binNet, quantity: '-1', value: '-15.00' }, { ...binNet, line_id: '2', location_id: '3', quantity: '-1', value: '-15.00' }] })));
    expect(field(both, 'location')).toMatchObject({ netsuite: "O'Fallon and Van stock", same: false });
    // How many it changed all told is the same.
    expect(field(both, 'change').same).toBe(true);
  });

  it('by how many, saying the value only when nothing else explains it', () => {
    const c = check(pair(own(), netsuite({ lines: [{ ...binNet, quantity: '-3', value: '-45.00' }] }), { netsuite_gl: glOf(-4500) }));
    expect(c).toMatchObject({ status: 'differs', differing: 2 });
    expect(field(c, 'change')).toMatchObject({ fleetsuite: '2 fewer', netsuite: '3 fewer', same: false });
    expect(field(c, 'value')).toMatchObject({ fleetsuite: '$30.00', netsuite: '$45.00', same: false, why: "NetSuite's value is $15.00 more." });
    expect(c.summary).toBe("Change: Inventory Adjust made it 2 fewer BIN-10, and NetSuite's adjustment 3 fewer.");
  });

  it('an item NetSuite changed that Inventory Adjust didn\'t, or the other way round', () => {
    const more = check(pair(own(), netsuite({ lines: [binNet, { ...binNet, line_id: '2', item_id: HOOK, quantity: '1', value: '5.00' }] })));
    expect(field(more, 'change')).toMatchObject({ netsuite: '2 fewer BIN-10 and 1 more HOOK-1', same: false });
    // What it came to follows from what it changed, so the sentence doesn't say that too.
    expect(field(more, 'value')).toMatchObject({ netsuite: '$25.00', same: false });
    expect(more.summary).toBe("Change: NetSuite's adjustment also made it 1 more HOOK-1, which Inventory Adjust didn't.");
    const other = check(pair(own(), netsuite({ lines: [{ ...binNet, item_id: HOOK }] })));
    expect(field(other, 'change')).toMatchObject({
      netsuite: '2 fewer HOOK-1',
      why: "Inventory Adjust made it 2 fewer BIN-10, and NetSuite's adjustment didn't change BIN-10. "
        + "NetSuite's adjustment also made it 2 fewer HOOK-1, which Inventory Adjust didn't.",
    });
    // A line that moved nothing and posted nothing isn't a change.
    const idle = check(pair(own(), netsuite({ lines: [binNet, { ...binNet, line_id: '2', item_id: HOOK, quantity: '0', moves_stock: true, value: null }] })));
    expect(idle).toMatchObject({ status: 'matches', differing: 0 });
  });

  it('what it came to, either way', () => {
    const cents = check(pair(own(), netsuite({ lines: [{ ...binNet, value: '-31.00' }] }), { netsuite_gl: glOf(-3100) }));
    expect(cents).toMatchObject({ status: 'differs', differing: 1, netsuiteValue: -3100 });
    expect(cents.summary).toBe("Value: NetSuite's value is $1.00 more.");
    expect(check(pair(own(), netsuite({ lines: [{ ...binNet, value: '-29.00' }] }), { netsuite_gl: glOf(-2900) })).summary)
      .toBe("Value: NetSuite's value is $1.00 less.");
    const wrongWay = check(pair(own(), netsuite({ lines: [{ ...binNet, value: '30.00' }] }), { netsuite_gl: glOf(3000) }));
    expect(wrongWay.summary).toBe("Value: FleetSuite's copy takes $30.00 out of stock, and NetSuite's adjustment puts $30.00 into stock.");
  });

  it('the account on its other side', () => {
    const c = check(pair(own(), netsuite(), { netsuite_gl: glOf(-3000, '580') }));
    expect(field(c, 'account')).toMatchObject({ fleetsuite: '52000 Inventory Adjustment', netsuite: '58000 Cost of Goods Sold', same: false });
    expect(c.summary).toBe("Account: Inventory Adjust posts to 52000 Inventory Adjustment, and NetSuite's adjustment put its other side in 58000 Cost of Goods Sold.");
    // An account NetSuite put as much on as it took off isn't its other side.
    const netted = check(pair(own(), netsuite(), { netsuite_gl: { ...GL, entry: [...GL.entry, { account_id: '580', debit: '5.00', credit: '5.00', inventory: false }] } }));
    expect(field(netted, 'account')).toMatchObject({ netsuite: '52000 Inventory Adjustment', same: true });
    expect(netted.status).toBe('matches');
  });

  it('more than one thing, naming the first and the others after it', () => {
    const c = check(pair(own(), netsuite({ date: '2026-10-31' }), { netsuite_gl: glOf(-3000, '580') }));
    expect(c).toMatchObject({ status: 'differs', differing: 2 });
    expect(c.summary).toBe("Date: Inventory Adjust made it Oct 30, 2026, and NetSuite's adjustment is dated 1 day later. The account differs too.");
    const three = check(pair(own(), netsuite({ date: '2026-10-31', lines: [{ ...binNet, value: '-31.00' }] }), { netsuite_gl: glOf(-3100, '580') }));
    expect(three.summary).toMatch(/ The value and the account differ too\.$/);
  });

  it('nothing booked, once the ledger copy has run since without it', () => {
    const c = check(pair(own(), netsuite({ lines: [{ ...binNet, value: null }] }), { netsuite_gl: null }));
    expect(c).toMatchObject({ status: 'differs', netsuiteValue: 0 });
    expect(field(c, 'value').why).toBe("NetSuite's adjustment booked nothing: the copy of its general ledger, made since, has no entry for it.");
    expect(field(c, 'account')).toMatchObject({ netsuite: 'None', same: null });
  });
});

describe("what isn't checked yet", () => {
  it("is incomplete when NetSuite didn't say which adjustment it made", () => {
    const c = check(pair(own({ netsuite_id: null, number: null }), null));
    expect(c).toMatchObject({ status: 'incomplete', netsuiteId: null, number: 'Inventory Adjust', netsuiteValue: null });
    expect(c.summary).toBe("NetSuite didn't say which adjustment it made, so there's none to put this next to.");
    expect(c.unknowns[0]).toBe('which adjustment NetSuite made: it took the Inventory Adjust without saying');
  });

  it('waits for the stock copy to take the adjustment, then the ledger copy to value it', () => {
    const noStock = check(pair(own(), null), BEFORE);
    expect(noStock).toMatchObject({ status: 'waiting', summary: "Waiting for NetSuite's adjustment: the copy of NetSuite's stock moves runs every two hours." });
    expect(noStock.fields.map((f) => f.same)).toEqual([null, null, null, null, null]);
    const noLedger = check(pair(own(), netsuite({ lines: [{ ...binNet, value: null }] }), { netsuite_gl: null }), { stock: SINCE.stock, ledger: BEFORE.ledger });
    expect(noLedger).toMatchObject({ status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the adjustment.", netsuiteValue: null });
    // A ledger copy that finished within ten minutes of the Inventory Adjust began before it.
    const justAfter = check(pair(own(), netsuite({ lines: [{ ...binNet, value: null }] }), { netsuite_gl: null }), { stock: SINCE.stock, ledger: '2026-10-30T15:05:00.000Z' });
    expect(justAfter.status).toBe('waiting');
    // The ledger copy reaching it before the stock copy puts nothing next to it yet, the account included.
    const ledgerFirst = check(pair(own(), null, { netsuite_gl: glOf(-3000, '580') }), { stock: BEFORE.stock, ledger: SINCE.ledger });
    expect(ledgerFirst.status).toBe('waiting');
    expect(field(ledgerFirst, 'account')).toMatchObject({ netsuite: null, same: null, why: null });
  });

  it("is gone when NetSuite deleted its adjustment, or the stock copy has run since without it", () => {
    const gone = check(pair(own(), netsuite({ gone: true })));
    expect(gone).toMatchObject({ status: 'voided', summary: "NetSuite's adjustment is gone from NetSuite." });
    // Nothing is put next to a deleted adjustment, though the ledger copy still has what it posted.
    expect(gone.fields.map((f) => f.same)).toEqual([null, null, null, null, null]);
    expect(check(pair(own(), null), SINCE)).toMatchObject({
      status: 'voided', summary: "NetSuite's adjustment is gone from NetSuite: the copy of its stock moves, made since, doesn't have it.",
    });
  });

  it("is incomplete when FleetSuite can't work out where, or what it came to, but nothing else differs", () => {
    const nowhere = check(pair(own({ location_id: null }), netsuite(), { before: null }));
    expect(nowhere).toMatchObject({ status: 'incomplete', location: null, before: null, fleetsuiteValue: null });
    expect(field(nowhere, 'location')).toMatchObject({ same: null, why: "Inventory Adjust didn't save where it changed stock." });
    expect(field(nowhere, 'value').why).toBe("FleetSuite doesn't know where it changed stock, so not what that came to.");
    expect(nowhere.summary).toBe("Matches where it can be checked. FleetSuite didn't know where it changed stock, so what that came to.");

    const none = check(pair(own(), netsuite(), { before: { quantity: '0', value: '0.00' } }));
    expect(none).toMatchObject({ status: 'incomplete', fleetsuiteValue: null, each: null });
    expect(field(none, 'value').why).toBe("FleetSuite counted none of BIN-10 at O'Fallon just before, so it can't work out what the change came to.");

    const unlisted = check(pair(own({ item_id: '9999', item_number: 'NEW-1' }), netsuite({ lines: [{ ...binNet, item_id: '9999' }] })));
    expect(unlisted).toMatchObject({ status: 'incomplete', fleetsuiteValue: null, description: null, assetAccount: null });
    expect(unlisted.unknowns).toEqual(["whether NEW-1 is kept in stock (the copy of NetSuite's items doesn't have it yet)"]);

    const noAccount = check(pair(), SINCE, { account: null });
    expect(noAccount).toMatchObject({ status: 'incomplete', accountId: null });
    expect(field(noAccount, 'account')).toMatchObject({ fleetsuite: null, same: null, why: "The copy of NetSuite's accounts has no 52000, the account Inventory Adjust posts to." });
    expect(noAccount.workedOut[4]).toBe('Its other side goes to 52000, the account Inventory Adjust posts to.');
  });

  it("values an item NetSuite doesn't keep in stock at nothing", () => {
    const strap = check(pair(own({ item_id: STRAP, item_number: 'STRAP-2' }), netsuite({ lines: [{ ...binNet, item_id: STRAP, value: null }] }), { netsuite_gl: null }));
    expect(strap).toMatchObject({ fleetsuiteValue: 0, netsuiteValue: 0, status: 'matches' });
    expect(strap.workedOut[2]).toBe("STRAP-2 isn't kept in stock, so the change comes to nothing.");
  });
});

describe('the list', () => {
  it('checks each, counting how many have each status', () => {
    const checked = checkOwnAdjustments({
      ...LISTS,
      adjustments: [pair(), pair(own({ id: 'b', netsuite_id: null }), null), pair(own({ id: 'c' }), netsuite({ date: '2026-10-31' }))],
    }, SINCE);
    expect(checked.adjustments.map((a) => [a.id, a.status])).toEqual([[ID, 'matches'], ['b', 'incomplete'], ['c', 'differs']]);
    expect(checked.counts).toEqual({ matches: 1, differs: 1, incomplete: 1, waiting: 0, voided: 0 });
    expect(checkOwnAdjustments({ ...LISTS, adjustments: [] }, SINCE)).toEqual({ adjustments: [], counts: { matches: 0, differs: 0, incomplete: 0, waiting: 0, voided: 0 } });
  });

  it('says a change in words', () => {
    expect(changeWords(-2)).toBe('2 fewer');
    expect(changeWords(4)).toBe('4 more');
    expect(changeWords(1.5)).toBe('1.5 more');
    expect(changeWords(0)).toBe('none');
    expect(changeWords(0.00001)).toBe('none');
  });
});
