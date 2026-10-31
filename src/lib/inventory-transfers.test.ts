import { describe, it, expect } from 'vitest';
import {
  MAX_LINES, MAX_QUANTITY, MEMO_MAX, itemLabel, keepsStock, keptLines, linesToKeep, netsuiteTransfer, quantityText, transferExternalId,
  workOutTransfer, type Transfer, type TransferFacts, type TransferItem,
} from './inventory-transfers';

// What a transfer needs before FleetSuite makes it in NetSuite, what NetSuite
// is sent, and how its lines are kept (Books part 38). Made-up data: a box of
// brackets and some wire moved from the shop to the van.

const item = (id: string, number: string, over: Partial<TransferItem> = {}): TransferItem => ({ id, number, name: null, type: 'InvtPart', active: true, ...over });
const ITEMS = new Map([
  ['501', item('501', 'BRK-100', { name: 'Bracket kit' })],
  ['502', item('502', 'WIRE-14', { name: '14 ga wire, feet' })],
  ['503', item('503', 'LABOR', { type: 'Service' })],
  ['504', item('504', 'OLD-1', { active: false })],
  ['505', item('505', 'NEW-1', { type: null })],
]);
const FACTS: TransferFacts = {
  company: { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }, { id: '7', name: 'Service van' }] },
  items: ITEMS,
};
const TRANSFER: Transfer = {
  date: '2027-01-15',
  fromLocationId: '1',
  toLocationId: '7',
  memo: ' Stock for the van ',
  lines: [{ itemId: '501', quantity: 4 }, { itemId: '502', quantity: 12.5 }],
};

describe('workOutTransfer', () => {
  it('works out a whole transfer, its memo trimmed, each line with its item number', () => {
    expect(workOutTransfer(TRANSFER, FACTS)).toEqual({
      date: '2027-01-15', fromLocationId: '1', toLocationId: '7', memo: 'Stock for the van',
      lines: [{ itemId: '501', itemNumber: 'BRK-100', quantity: 4 }, { itemId: '502', itemNumber: 'WIRE-14', quantity: 12.5 }],
      problems: [],
    });
    // An item whose kind the parts list doesn't say is taken, as Inventory Adjust takes it.
    expect(workOutTransfer({ ...TRANSFER, lines: [{ itemId: '505', quantity: 1 }] }, FACTS).problems).toEqual([]);
  });

  it('needs the company, its subsidiary, a day, a memo and somewhere to move from and to', () => {
    const problems = (t: Partial<Transfer>, f: Partial<TransferFacts> = {}) => workOutTransfer({ ...TRANSFER, ...t }, { ...FACTS, ...f }).problems;
    expect(problems({}, { company: null })).toEqual([
      'Pick the company.',
      "The location it's moving from isn't one FleetSuite knows.",
      "The location it's moving to isn't one FleetSuite knows.",
    ]);
    expect(problems({}, { company: { ...FACTS.company!, subsidiaryId: null } }))
      .toEqual(["BMG Fleet has no NetSuite subsidiary in Books, so NetSuite can't take its transfers."]);
    expect(problems({ date: '2027-02-30' })).toEqual(['Pick the date.']);
    expect(problems({ date: '' })).toEqual(['Pick the date.']);
    expect(problems({ memo: '   ' })).toEqual(['Say why the stock is moving in the memo.']);
    expect(problems({ memo: null })).toEqual(['Say why the stock is moving in the memo.']);
    expect(problems({ memo: 'm'.repeat(MEMO_MAX) })).toEqual([]);
    expect(problems({ memo: 'm'.repeat(MEMO_MAX + 1) })).toEqual([`The memo takes ${MEMO_MAX} characters at most.`]);
    expect(problems({ fromLocationId: null, toLocationId: '' })).toEqual(['Pick where the stock is now.', 'Pick where the stock is going.']);
    expect(problems({ fromLocationId: '9' })).toEqual(["The location it's moving from isn't one of BMG Fleet's."]);
    expect(problems({ toLocationId: '9' })).toEqual(["The location it's moving to isn't one of BMG Fleet's."]);
    expect(problems({ toLocationId: '1' })).toEqual(['It moves from one location to another, not to the same one.']);
  });

  it('needs a line or more, each an active inventory item on one line, moving more than 0 to four places', () => {
    const problems = (lines: Transfer['lines']) => workOutTransfer({ ...TRANSFER, lines }, FACTS).problems;
    expect(problems([])).toEqual(['Add the items that are moving.']);
    expect(problems(Array.from({ length: MAX_LINES }, (_, i) => ({ itemId: i === 0 ? '501' : null, quantity: 1 })))).toHaveLength(MAX_LINES - 1);
    expect(problems(Array.from({ length: MAX_LINES + 1 }, () => ({ itemId: '501', quantity: 1 })))[0])
      .toBe(`One transfer takes ${MAX_LINES} lines at most, not ${MAX_LINES + 1}.`);
    expect(problems([{ itemId: null, quantity: 1 }])).toEqual(['Line 1 has no item.']);
    expect(problems([{ itemId: '599', quantity: 1 }])).toEqual(["Line 1's item isn't in FleetSuite's parts list."]);
    expect(problems([{ itemId: '504', quantity: 1 }])).toEqual(["Line 1: OLD-1 isn't active in NetSuite."]);
    expect(problems([{ itemId: '503', quantity: 1 }])).toEqual(["Line 1: NetSuite keeps no stock of LABOR, so there's none to move."]);
    expect(problems([{ itemId: '501', quantity: 1 }, { itemId: '501', quantity: 2 }])).toEqual(['BRK-100 is on two lines: put it on one.']);
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(problems([{ itemId: '501', quantity }])).toEqual(['Line 1 needs how many of BRK-100 are moving.']);
    }
    expect(problems([{ itemId: '501', quantity: MAX_QUANTITY }])).toEqual([]);
    expect(problems([{ itemId: '501', quantity: MAX_QUANTITY + 1 }])).toEqual(['Line 1 moves more than 1,000,000.']);
    expect(problems([{ itemId: '502', quantity: 0.0001 }])).toEqual([]);
    expect(workOutTransfer({ ...TRANSFER, lines: [{ itemId: '502', quantity: 1.2345 }] }, FACTS).lines[0].quantity).toBe(1.2345);
    expect(problems([{ itemId: '502', quantity: 0.00015 }])).toEqual(["Line 1's quantity takes 4 places at most."]);
    // A quantity typed as 0.1 + 0.2 is still to four places.
    expect(workOutTransfer({ ...TRANSFER, lines: [{ itemId: '502', quantity: 0.1 + 0.2 }] }, FACTS).lines[0].quantity).toBe(0.3);
  });
});

describe('items, quantities and how lines are kept', () => {
  it('says which items keep stock, labels them, and writes a quantity as it is kept', () => {
    expect(keepsStock({ type: 'InvtPart' })).toBe(true);
    expect(keepsStock({ type: 'Assembly' })).toBe(true);
    // The parts list leaves some items' kind unsaid, as null or as nothing.
    expect(keepsStock({ type: null })).toBe(true);
    expect(keepsStock({ type: '' })).toBe(true);
    for (const type of ['NonInvtPart', 'Service', 'Kit', 'OthCharge']) expect(keepsStock({ type })).toBe(false);
    expect(itemLabel(ITEMS.get('501')!)).toBe('BRK-100 · Bracket kit');
    expect(itemLabel(item('9', 'X-1'))).toBe('X-1');
    expect(itemLabel(item('9', 'X-1', { name: 'X-1' }))).toBe('X-1');
    expect(quantityText(4)).toBe('4');
    expect(quantityText(12.5)).toBe('12.5');
    expect(quantityText(0.1 + 0.2)).toBe('0.3');
    expect(quantityText(Number.NaN)).toBe('');
  });

  it("keeps each line's item with its number as it was, and reads them back", () => {
    const kept = linesToKeep([{ itemId: '501', quantity: 4 }, { itemId: null, quantity: 0 }, { itemId: '599', quantity: 1 }], ITEMS);
    expect(kept).toEqual([
      { item_netsuite_id: '501', item_number: 'BRK-100', quantity: 4 },
      { item_netsuite_id: null, item_number: null, quantity: 0 },
      { item_netsuite_id: '599', item_number: null, quantity: 1 },
    ]);
    expect(keptLines(kept)).toEqual([{ itemId: '501', quantity: 4 }, { itemId: null, quantity: 0 }, { itemId: '599', quantity: 1 }]);
    // A blank item is none, and a quantity is kept to four places.
    expect(linesToKeep([{ itemId: '', quantity: 1.2345 }], ITEMS)).toEqual([{ item_netsuite_id: null, item_number: null, quantity: 1.2345 }]);
    // The database's numbers can come back as text, and a blank item is none.
    expect(keptLines([{ item_netsuite_id: '', item_number: null, quantity: '12.5000' }])).toEqual([{ itemId: null, quantity: 12.5 }]);
    expect(keptLines(null)).toEqual([]);
    expect(keptLines(undefined)).toEqual([]);
    expect(keptLines({} as never)).toEqual([]);
  });
});

describe('what NetSuite is sent', () => {
  it('names the transfer by its id, from and to its locations, each item and how many', () => {
    const id = 'f0000000-0000-4000-8000-000000000001';
    expect(transferExternalId(id)).toBe('fleetsuite-it-f0000000-0000-4000-8000-000000000001');
    expect(netsuiteTransfer(workOutTransfer(TRANSFER, FACTS), '2', id)).toEqual({
      subsidiaryId: '2',
      tranDate: '2027-01-15',
      memo: 'Stock for the van',
      externalId: 'fleetsuite-it-f0000000-0000-4000-8000-000000000001',
      fromLocationId: '1',
      toLocationId: '7',
      lines: [{ itemId: '501', quantity: 4 }, { itemId: '502', quantity: 12.5 }],
    });
  });
});
