import { describe, it, expect } from 'vitest';
import {
  MAX_ADDED, billFacts, billFixAllows, billName, lineName, linesCents, ownCopyLines, parseFixBill, planBillFix,
  type BillAmounts, type BillFixEdit, type BillFixFacts, type FixBill,
} from './bill-fix';

// A made-up NetSuite bill as GET vendorBill/{id}?expandSubResources=true answers it, billed off purchase order 2001:
// two expense lines, then a stock part, NetSuite's subtotal, and another stock part.
const RECORD = {
  id: '3001', tranId: 'B-100', tranDate: '2026-12-01', dueDate: '2026-12-31', terms: { id: '2', refName: 'Net 30' },
  entity: { id: '4001', refName: 'Acme Supply Co' }, subsidiary: { id: '2', refName: 'BMG' }, location: { id: '1', refName: "O'Fallon" },
  memo: 'Shop supplies', createdFrom: { id: '2001', refName: 'Purchase Order #PO123' }, lastModifiedDate: '2026-12-01T15:04:05Z',
  userTotal: 545.1, status: { id: 'A', refName: 'Open' },
  expense: {
    items: [
      { line: 1, account: { id: '610', refName: '6100 Shop Supplies' }, amount: 200.05, memo: 'Gloves' },
      { line: 2, account: { id: '620', refName: '6200 Freight' }, amount: 45.05 },
    ],
  },
  item: {
    items: [
      { line: 1, item: { id: '55', refName: 'Racks : SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125, amount: 250, description: 'Shelf unit', orderDoc: { id: '2001' }, orderLine: 1 },
      { line: 2, item: { id: '-2', refName: 'Subtotal' }, itemType: 'Subtotal', amount: 250 },
      { line: 3, item: { id: '57', refName: 'LIGHT-2' }, itemType: 'InvtPart', quantity: 1, rate: 50, amount: 50, orderDoc: { id: '2001' }, orderLine: 2 },
    ],
  },
};
const AMOUNTS: BillAmounts = { totalCents: 54510, owedCents: 54510, status: 'Bill : Open', voided: false };

const parse = (over: Record<string, unknown> = {}, amounts: BillAmounts | null = AMOUNTS) => parseFixBill({ ...RECORD, ...over }, amounts);
const BILL = parse();

const ACCOUNTS = new Map([
  ['610', { id: '610', name: '6100 Shop Supplies' }],
  ['620', { id: '620', name: '6200 Freight' }],
  ['630', { id: '630', name: '6300 Tools' }],
]);

const facts = (bill: FixBill = BILL, over: Partial<BillFixFacts> = {}): BillFixFacts => ({
  allows: billFixAllows(bill, { creditedHere: false }), accounts: ACCOUNTS, termsDays: 30, ...over,
});

const plan = (edit: Partial<BillFixEdit>, bill: FixBill = BILL, over: Partial<BillFixFacts> = {}) =>
  planBillFix(bill, { reason: 'Wrong amount', ...edit }, facts(bill, over));

/** One expense line of $100 to 6100, nothing paid. */
const ONE = parse({ expense: { items: [{ line: 1, account: { id: '610', refName: '6100 Shop Supplies' }, amount: 100 }] }, item: { items: [] } },
  { ...AMOUNTS, totalCents: 10000, owedCents: 10000 });

describe('parseFixBill', () => {
  it('reads its header, and what SuiteQL says of its money', () => {
    expect(BILL).toMatchObject({
      id: '3001', number: 'B-100', vendorId: '4001', vendorName: 'Acme Supply Co', subsidiaryId: '2', locationId: '1',
      date: '2026-12-01', dueDate: '2026-12-31', termsId: '2', termsName: 'Net 30', memo: 'Shop supplies',
      status: 'Bill : Open', voided: false, poId: '2001', poNumber: 'PO123', lastModified: '2026-12-01T15:04:05Z',
      totalCents: 54510, owedCents: 54510,
    });
  });

  it('keeps every line, expenses then items, the ones that only lay it out too', () => {
    expect(BILL.lines.map((l) => [l.list, l.line, l.accountId, l.itemId, l.itemNumber, l.kind, l.quantity, l.rate, l.cents, l.orderId, l.orderLine])).toEqual([
      ['expense', 1, '610', null, '', 'expense', 0, null, 20005, null, null],
      ['expense', 2, '620', null, '', 'expense', 0, null, 4505, null, null],
      ['item', 1, null, '55', 'SHELF-1', 'quantity', 2, 125, 25000, '2001', 1],
      ['item', 2, null, '-2', 'Subtotal', 'layout', 0, null, 0, null, null],
      ['item', 3, null, '57', 'LIGHT-2', 'quantity', 1, 50, 5000, '2001', 2],
    ]);
    expect(BILL.lines.map((l) => [l.accountName, l.description, l.itemType])).toEqual([
      ['6100 Shop Supplies', 'Gloves', null],
      ['6200 Freight', '', null],
      ['', 'Shelf unit', 'InvtPart'],
      ['', '', 'Subtotal'],
      ['', '', 'InvtPart'],
    ]);
    expect(linesCents(BILL.lines)).toBe(54510);
  });

  it('keeps lines that take money off, or name no account or item, as they are', () => {
    const bill = parse({
      expense: {
        items: [
          { line: 1, account: { id: '610' }, amount: -20, memo: ' Rebate ' },
          { line: 2, amount: 15 },
          { account: { id: '610' }, amount: 1 },
          { line: 'abc', account: { id: '620' }, amount: 3 },
          { line: 3, account: { id: '620' }, amount: '' },
        ],
      },
      item: {
        items: [
          { line: 1, item: { id: '58', refName: 'DISCOUNT' }, itemType: 'Discount', rate: -26, amount: -26 },
          { line: 2, itemType: 'NonInvtPart', quantity: 1, rate: 10, amount: 10 },
          { line: 3, item: { id: '62', refName: 'FEE' }, itemType: 'Markup', rate: 12, amount: 12 },
          { line: 4, item: { id: '0' }, itemType: 'NonInvtPart', quantity: 1, amount: 0 },
          { line: 5, item: { id: '63', refName: 'Note' }, itemType: 'Description', description: 'Unit 12' },
          { line: 6, item: { id: '64', refName: 'Kit' }, itemType: 'Group' },
          { line: 7, item: { id: '65' }, itemType: 'EndGroup' },
          { line: 'x', item: { id: '67' }, itemType: 'InvtPart', quantity: 1, rate: 1, amount: 1 },
          { line: 8, item: { id: '68', refName: 'PART' }, itemType: { id: 'InvtPart' }, quantity: -2, rate: 5, orderLine: 2.5, orderdoc: { id: '2002' } },
          { line: 9, item: { id: '69', refName: 'CORE' }, itemType: 'NonInvtPart', quantity: 1, amount: -40 },
          { line: 10, item: { id: '70', refName: 'ODD' }, itemType: 'NonInvtPart', quantity: -2, rate: -5, amount: 10 },
          { line: 11, item: { id: '71', refName: 'NORATE' }, itemType: 'NonInvtPart', quantity: 3, amount: 30, orderline: '4' },
        ],
      },
    });
    expect(bill.lines.map((l) => [l.list, l.line, l.kind, l.quantity, l.rate, l.cents, l.orderId, l.orderLine])).toEqual([
      ['expense', 1, 'kept', 0, null, -2000, null, null],
      ['expense', 2, 'kept', 0, null, 1500, null, null],
      ['expense', 3, 'expense', 0, null, 0, null, null],
      ['item', 1, 'kept', 0, null, -2600, null, null],
      ['item', 2, 'kept', 1, null, 1000, null, null],
      ['item', 3, 'kept', 0, null, 1200, null, null],
      ['item', 4, 'layout', 0, null, 0, null, null],
      ['item', 5, 'layout', 0, null, 0, null, null],
      ['item', 6, 'layout', 0, null, 0, null, null],
      ['item', 7, 'layout', 0, null, 0, null, null],
      // No amount from NetSuite: its rate times its quantity, the quantity as a count.
      ['item', 8, 'quantity', 2, 5, 1000, '2002', null],
      ['item', 9, 'kept', 1, null, -4000, null, null],
      ['item', 10, 'kept', 2, null, 1000, null, null],
      ['item', 11, 'quantity', 3, null, 3000, null, 4],
    ]);
    expect(bill.lines[0].description).toBe('Rebate');
    expect(bill.lines[1]).toMatchObject({ accountId: null, accountName: '' });
    expect(bill.lines[10].itemType).toBe('InvtPart');
  });

  it("trims its number and memo, takes the day from a date and time, and keeps what's owed as SuiteQL says", () => {
    expect(parse({ tranId: ' B-100 ', memo: ' Shop supplies ', tranDate: '2026-12-01T06:00:00Z', dueDate: '2026-12-31T06:00:00Z' }))
      .toMatchObject({ number: 'B-100', memo: 'Shop supplies', date: '2026-12-01', dueDate: '2026-12-31' });
    expect(parse({ tranDate: '12/01/2026' }).date).toBeNull();
    expect(parse({}, { ...AMOUNTS, owedCents: 10000 })).toMatchObject({ totalCents: 54510, owedCents: 10000 });
  });

  it("takes its total from the bill when SuiteQL couldn't be asked, and doesn't guess what's owed", () => {
    expect(parse({}, null)).toMatchObject({ totalCents: 54510, owedCents: null, status: 'Open', voided: false });
    expect(parse({ userTotal: undefined, total: -12.5 }, null).totalCents).toBe(1250);
    expect(parse({ userTotal: undefined }, null).totalCents).toBeNull();
    expect(parse({ status: { refName: 'Voided' } }, null).voided).toBe(true);
    expect(parse({}, { ...AMOUNTS, status: 'Bill : Voided', voided: true })).toMatchObject({ status: 'Bill : Voided', voided: true });
  });

  it('reads no dates, terms, purchase order or change time when NetSuite gives none', () => {
    const bill = parse({ tranDate: null, dueDate: '12/31/2026', terms: null, createdFrom: null, lastModifiedDate: undefined, memo: null, entity: '4001', tranId: undefined });
    expect(bill).toMatchObject({
      number: '', date: null, dueDate: null, termsId: null, termsName: null, poId: null, poNumber: null, lastModified: null, memo: '',
      vendorId: '4001', vendorName: '',
    });
    expect(parse({ createdFrom: { id: '2001', refName: 'Old order' } }).poNumber).toBe('Old order');
    expect(parse({ terms: { id: '2' } })).toMatchObject({ termsId: '2', termsName: null });
    expect(parseFixBill(null, null)).toMatchObject({ id: '', lines: [], totalCents: null });
  });
});

describe('billFixAllows', () => {
  it('fixes everything on a bill nothing is paid on', () => {
    expect(billFixAllows(BILL, { creditedHere: false })).toEqual({ header: true, lines: true, why: null });
  });

  it('fixes only its number, memo and due date once money is on it, or FleetSuite can\'t tell', () => {
    const why = (over: Partial<FixBill>, creditedHere = false) => billFixAllows({ ...BILL, ...over }, { creditedHere });
    expect(why({ owedCents: null })).toEqual({ header: true, lines: false, why: "NetSuite didn't say what's still owed on it, so only its number, memo and due date can be fixed." });
    expect(why({ totalCents: null }).why).toBe("NetSuite didn't say what it comes to, so only its number, memo and due date can be fixed.");
    expect(why({ owedCents: 0 }).why).toBe("It's paid, so only its number, memo and due date can be fixed. To take money off it, make a vendor credit.");
    expect(why({ owedCents: 10000 }).why).toBe('Part of it is paid or credited, so only its number, memo and due date can be fixed. To take money off it, make a vendor credit.');
    expect(why({}, true).why).toBe('FleetSuite made a vendor credit against it, so only its number, memo and due date can be fixed. To take more off it, make another vendor credit.');
    expect(why({ totalCents: 50000, owedCents: 50000 }).why).toBe('Its lines come to $545.10, not the $500.00 NetSuite says, so only its number, memo and due date can be fixed.');
    expect(why({ totalCents: 0, owedCents: 0, lines: [] })).toEqual({ header: true, lines: true, why: null });
  });

  it('fixes nothing on a voided bill', () => {
    expect(billFixAllows({ ...BILL, voided: true }, { creditedHere: false }))
      .toEqual({ header: false, lines: false, why: "Bill B-100 is voided in NetSuite, so there's nothing to fix." });
    expect(billFixAllows({ ...BILL, number: '', voided: true }, { creditedHere: false }).why)
      .toBe("NetSuite bill 3001 is voided in NetSuite, so there's nothing to fix.");
  });
});

describe('planBillFix: the bill', () => {
  it('changes its number, memo and due date, and sends only what changed', () => {
    const p = plan({ header: { number: ' B-101 ', memo: 'Shop supplies, December', dueDate: '2027-01-15', date: '2026-12-01' } });
    expect(p).toMatchObject({
      problems: [], notes: [], replace: [],
      body: { tranId: 'B-101', dueDate: '2027-01-15', memo: 'Shop supplies, December' },
      changes: ['Number B-100 → B-101', 'Due Dec 31, 2026 → Jan 15, 2027', 'Memo changed'],
    });
    expect(p.fixed).toMatchObject({ number: 'B-101', date: '2026-12-01', dueDate: '2027-01-15', memo: 'Shop supplies, December', totalCents: 54510 });
    expect(p.fixed.lines.every((l) => l.state === 'as_was')).toBe(true);
    // Only a part has a quantity.
    expect(p.fixed.lines.map((l) => l.quantity)).toEqual([null, null, 2, null, 1]);
  });

  it("doesn't work the total out again when no line changes", () => {
    const untotalled = parse({ userTotal: undefined }, null);
    expect(plan({ header: { memo: 'Shop supplies, December' } }, untotalled)).toMatchObject({
      problems: [], body: { memo: 'Shop supplies, December' }, fixed: { totalCents: null },
    });
  });

  it('says a memo was added or taken off, and a number put on', () => {
    expect(plan({ header: { memo: '' } })).toMatchObject({ body: { memo: '' }, changes: ['Memo taken off'] });
    const bare = { ...BILL, memo: '', number: '' };
    expect(plan({ header: { memo: 'Note', number: 'B-7' } }, bare)).toMatchObject({ body: { memo: 'Note', tranId: 'B-7' }, changes: ['Number (none) → B-7', 'Memo added'] });
  });

  it('changes nothing for a box left as it was', () => {
    const p = plan({ header: { number: 'B-100 ', memo: ' Shop supplies', date: '2026-12-01', dueDate: '2026-12-31' } });
    expect(p).toMatchObject({ problems: ['Nothing has changed yet.'], changes: [], body: {} });
  });

  it("refuses a number or memo NetSuite wouldn't take, or a number the vendor's other bill has", () => {
    expect(plan({ header: { number: '  ' } }).problems).toEqual(["Enter the vendor's number for the bill."]);
    expect(plan({ header: { number: 'N'.repeat(41) } }).problems).toEqual(["The bill's number takes 40 characters at most."]);
    expect(plan({ header: { number: 'N'.repeat(40) } }).problems).toEqual([]);
    expect(plan({ header: { number: 'B-200' } }, BILL, { numberTaken: 'B-200' }).problems)
      .toEqual(["Acme Supply Co already has a bill numbered B-200 in NetSuite. Each of a vendor's bills has its own number."]);
    expect(plan({ header: { number: 'B-200' } }, { ...BILL, vendorName: '' }, { numberTaken: 'B-200' }).problems)
      .toEqual(["The vendor already has a bill numbered B-200 in NetSuite. Each of a vendor's bills has its own number."]);
    expect(plan({ header: { memo: 'M'.repeat(1000) } }).problems).toEqual(['The memo takes 999 characters at most.']);
    expect(plan({ header: { memo: 'M'.repeat(999) } }).problems).toEqual([]);
  });

  it('moves the due date with the date, by its terms', () => {
    expect(plan({ header: { date: '2026-12-05' } })).toMatchObject({
      problems: [], body: { tranDate: '2026-12-05', dueDate: '2027-01-04' },
      changes: ['Date Dec 1, 2026 → Dec 5, 2026', 'Due Dec 31, 2026 → Jan 4, 2027'],
    });
    expect(plan({ header: { date: '2026-12-05' } }, BILL, { termsDays: 0 }).body).toEqual({ tranDate: '2026-12-05', dueDate: '2026-12-05' });
    // A due date that comes out the same isn't sent.
    expect(plan({ header: { date: '2026-12-11' } }, BILL, { termsDays: 20 })).toMatchObject({ body: { tranDate: '2026-12-11' }, changes: ['Date Dec 1, 2026 → Dec 11, 2026'] });
    expect(plan({ header: { date: '2026-12-11' } }, BILL, { termsDays: 20 }).fixed.dueDate).toBe('2026-12-31');
    // A due date typed is the one it gets.
    expect(plan({ header: { date: '2026-12-05', dueDate: '2026-12-20' } })).toMatchObject({
      body: { tranDate: '2026-12-05', dueDate: '2026-12-20' }, changes: ['Date Dec 1, 2026 → Dec 5, 2026', 'Due Dec 31, 2026 → Dec 20, 2026'],
    });
  });

  it("leaves NetSuite's due date when FleetSuite can't tell the terms", () => {
    expect(plan({ header: { date: '2026-12-05' } }, BILL, { termsDays: null })).toMatchObject({
      problems: [], body: { tranDate: '2026-12-05' }, changes: ['Date Dec 1, 2026 → Dec 5, 2026'],
      notes: ["NetSuite keeps its due date, Dec 31, 2026: FleetSuite can't tell the bill's terms. Change the due date too if it should move."],
    });
    expect(plan({ header: { date: '2026-12-05', dueDate: '2027-01-05' } }, BILL, { termsDays: null }).notes).toEqual([]);
  });

  it('asks for real dates, a due date on or after the date, and changes no date once money is on it', () => {
    expect(plan({ header: { date: '2026-02-30' } }).problems).toEqual(['Pick the date.']);
    expect(plan({ header: { date: '12/05/2026' } }).problems).toEqual(['Pick the date.']);
    expect(plan({ header: { dueDate: '2026-13-01' } }).problems).toEqual(['Pick the due date.']);
    expect(plan({ header: { dueDate: '2026-11-30' } }).problems).toEqual(["The due date can't be before the bill's date."]);
    expect(plan({ header: { date: '2026-12-10', dueDate: '2026-12-09' } }).problems).toEqual(["The due date can't be before the bill's date."]);
    expect(plan({ header: { dueDate: '2026-12-01' } }).problems).toEqual([]);
    const paid = { ...BILL, owedCents: 0 };
    expect(plan({ header: { date: '2026-12-05', dueDate: '2027-01-30', number: 'B-101' } }, paid)).toMatchObject({
      problems: ["It's paid, so only its number, memo and due date can be fixed. To take money off it, make a vendor credit."],
      body: { tranId: 'B-101', dueDate: '2027-01-30' },
    });
  });

  it('fixes nothing on a voided bill', () => {
    const voided = { ...BILL, voided: true };
    expect(plan({ header: { number: 'B-101' }, add: [{ accountId: '630', amount: 5 }] }, voided)).toMatchObject({
      problems: ["Bill B-100 is voided in NetSuite, so there's nothing to fix."], changes: [], body: {}, replace: [],
    });
  });

  it('needs to say why, briefly', () => {
    expect(plan({ reason: ' ', header: { number: 'B-101' } }).problems).toEqual(["Say why it's being fixed."]);
    expect(plan({ reason: 'R'.repeat(301), header: { number: 'B-101' } }).problems).toEqual(["Why it's being fixed takes 300 characters at most."]);
    expect(plan({ reason: 'R'.repeat(300), header: { number: 'B-101' } }).problems).toEqual([]);
  });
});

describe('planBillFix: its lines', () => {
  it("changes an expense line's account, amount and memo by its key", () => {
    const p = plan({ lines: [{ list: 'expense', line: 1, accountId: '630', amount: 210.05, description: ' Gloves and rags ' }] });
    expect(p).toMatchObject({
      problems: [], replace: [],
      body: { expense: { items: [{ line: 1, account: { id: '630' }, amount: 210.05, memo: 'Gloves and rags' }] } },
      changes: ['6100 Shop Supplies → 6300 Tools', '6100 Shop Supplies $200.05 → $210.05', '6100 Shop Supplies memo changed'],
    });
    expect(p.fixed.totalCents).toBe(55510);
    expect(p.fixed.lines[0]).toMatchObject({ state: 'changed', accountId: '630', accountName: '6300 Tools', cents: 21005, description: 'Gloves and rags', quantity: null });
    expect(p.fixed.lines.slice(1).every((l) => l.state === 'as_was')).toBe(true);
  });

  it("changes a part's quantity and rate by its key, the amount sent with them to the cent", () => {
    const p = plan({ lines: [{ list: 'item', line: 1, quantity: 3, rate: 120 }] });
    expect(p).toMatchObject({
      problems: [], replace: [],
      body: { item: { items: [{ line: 1, quantity: 3, rate: 120, amount: 360 }] } },
      changes: ['SHELF-1 quantity 2 → 3', 'SHELF-1 rate $125.00 → $120.00'],
    });
    expect(p.fixed.totalCents).toBe(65510);
    expect(p.fixed.lines[2]).toMatchObject({ state: 'changed', quantity: 3, rate: 120, cents: 36000, orderId: '2001', orderLine: 1 });
    // A new rate alone sends the amount with it too.
    const rated = plan({ lines: [{ list: 'item', line: 1, rate: 130 }] });
    expect(rated).toMatchObject({ problems: [], changes: ['SHELF-1 rate $125.00 → $130.00'] });
    expect(rated.body).toEqual({ item: { items: [{ line: 1, rate: 130, amount: 260 }] } });
    expect(rated.fixed.totalCents).toBe(55510);
    // Half to even, the way NetSuite rounds.
    expect(plan({ lines: [{ list: 'item', line: 3, quantity: 2.5, rate: 0.33 }] }).body).toEqual({ item: { items: [{ line: 3, quantity: 2.5, rate: 0.33, amount: 0.82 }] } });
    expect(plan({ lines: [{ list: 'item', line: 1, description: 'Shelf unit, grey' }] })).toMatchObject({
      body: { item: { items: [{ line: 1, description: 'Shelf unit, grey' }] } }, changes: ['SHELF-1 description changed'],
    });
  });

  it('changes nothing for a line left as it was', () => {
    const p = plan({ lines: [
      { list: 'expense', line: 1, accountId: '610', amount: 200.05, description: 'Gloves' },
      { list: 'item', line: 1, quantity: 2, rate: 125, description: 'Shelf unit' },
    ] });
    expect(p).toMatchObject({ problems: ['Nothing has changed yet.'], changes: [], body: {} });
  });

  it('reads only what fits the line: an account and amount on an expense line, a quantity and rate on a part', () => {
    const p = plan({ lines: [
      { list: 'expense', line: 1, quantity: 5, rate: 9 },
      { list: 'item', line: 1, accountId: '630', amount: 50 },
      { list: 'item', line: 2, description: 'Sub', quantity: 2 },
    ] });
    expect(p).toMatchObject({ problems: ['Nothing has changed yet.'], body: {} });
    // A line kept as it is can only be taken off.
    const kept = parse({
      expense: { items: [{ line: 1, account: { id: '610' }, amount: -20 }, { line: 2, account: { id: '620', refName: '6200 Freight' }, amount: 120 }] },
      item: { items: [] },
    }, { ...AMOUNTS, totalCents: 10000, owedCents: 10000 });
    expect(plan({ lines: [{ list: 'expense', line: 1, accountId: '630', amount: 40, description: 'x' }] }, kept).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ lines: [{ list: 'expense', line: 1, remove: true }] }, kept)).toMatchObject({
      problems: [], changes: ['Took off Expense line 1 (-$20.00)'], replace: ['expense'], body: { expense: { items: [{ line: 2 }] } },
    });
  });

  it('refuses an account, amount, quantity or rate NetSuite or the books would get wrong', () => {
    expect(plan({ lines: [{ list: 'expense', line: 1, accountId: '999' }] }).problems).toEqual(["6100 Shop Supplies: pick an account this company's bills can go to."]);
    expect(plan({ lines: [{ list: 'expense', line: 1, accountId: '' }] }).problems).toEqual(["6100 Shop Supplies: pick an account this company's bills can go to."]);
    const amount = (a: number) => plan({ lines: [{ list: 'expense', line: 1, amount: a }] }).problems;
    expect(amount(0)).toEqual(['6100 Shop Supplies: enter an amount above $0. To drop the line, take it off.']);
    expect(amount(NaN)).toEqual(['6100 Shop Supplies: enter an amount above $0. To drop the line, take it off.']);
    expect(amount(-5)).toEqual(['6100 Shop Supplies: enter an amount above $0. To drop the line, take it off.']);
    expect(amount(10_000_000.01)).toEqual(['6100 Shop Supplies: the amount can be $10,000,000 at most.']);
    expect(amount(10_000_000)).toEqual([]);
    expect(amount(10.005)).toEqual(['6100 Shop Supplies: the amount goes to the cent.']);
    const q = (quantity: number) => plan({ lines: [{ list: 'item', line: 1, quantity }] }).problems;
    expect(q(NaN)).toEqual(['SHELF-1: enter the quantity.']);
    expect(q(0)).toEqual(['SHELF-1: the quantity has to be more than 0. To drop the line, take it off.']);
    expect(q(-1)).toEqual(['SHELF-1: the quantity has to be more than 0. To drop the line, take it off.']);
    expect(q(1_000_001)).toEqual(['SHELF-1: the quantity can be 1,000,000 at most.']);
    expect(q(1_000_000)).toEqual([]);
    expect(q(1.23456)).toEqual(['SHELF-1: the quantity takes 4 places at most.']);
    expect(q(1.2345)).toEqual([]);
    const rate = (r: number) => plan({ lines: [{ list: 'item', line: 1, rate: r }] }).problems;
    expect(rate(NaN)).toEqual(['SHELF-1: enter the rate.']);
    expect(rate(-0.01)).toEqual(["SHELF-1: the rate can't be less than $0."]);
    expect(rate(10_000_000.01)).toEqual(['SHELF-1: the rate can be $10,000,000 at most.']);
    expect(rate(10_000_000)).toEqual([]);
    expect(rate(1.23456)).toEqual(['SHELF-1: the rate takes 4 places at most.']);
    expect(rate(0)).toEqual([]);
    expect(plan({ lines: [{ list: 'item', line: 1, description: 'D'.repeat(4001) }] }).problems).toEqual(['SHELF-1: the description takes 4,000 characters at most.']);
    expect(plan({ lines: [{ list: 'item', line: 1, description: 'D'.repeat(4000) }] }).problems).toEqual([]);
    expect(plan({ lines: [{ list: 'expense', line: 1, description: 'D'.repeat(4001) }] }).problems).toEqual(['6100 Shop Supplies: the memo takes 4,000 characters at most.']);
  });

  it("won't change the quantity of a part NetSuite gave no rate for without one", () => {
    const noRate = parse({ expense: { items: [] }, item: { items: [{ line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, amount: 250 }] } },
      { ...AMOUNTS, totalCents: 25000, owedCents: 25000 });
    expect(noRate.lines[0]).toMatchObject({ kind: 'quantity', rate: null, cents: 25000 });
    expect(plan({ lines: [{ list: 'item', line: 1, quantity: 3 }] }, noRate).problems).toEqual(['SHELF-1: NetSuite gave no rate for it, so enter the rate too.']);
    const priced = plan({ lines: [{ list: 'item', line: 1, quantity: 3, rate: 125 }] }, noRate);
    expect(priced).toMatchObject({ problems: [], changes: ['SHELF-1 quantity 2 → 3', 'SHELF-1 rate (none) → $125.00'] });
    expect(priced.body).toEqual({ item: { items: [{ line: 1, quantity: 3, rate: 125, amount: 375 }] } });
    // A rate of $0 is a rate too.
    const free = parse({
      expense: { items: [{ line: 1, account: { id: '620', refName: '6200 Freight' }, amount: 45.05 }] },
      item: { items: [{ line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, amount: 250 }] },
    }, { ...AMOUNTS, totalCents: 29505, owedCents: 29505 });
    const zero = plan({ lines: [{ list: 'item', line: 1, rate: 0 }] }, free);
    expect(zero).toMatchObject({ problems: [], changes: ['SHELF-1 rate (none) → $0.00'], fixed: { totalCents: 4505 } });
    expect(zero.body).toEqual({ item: { items: [{ line: 1, rate: 0, amount: 0 }] } });
  });

  it('leaves a line it refuses as it was, and sends a number a hair off four places as its four places', () => {
    const refused = plan({ lines: [{ list: 'item', line: 1, quantity: 0 }] });
    expect(refused).toMatchObject({ body: {}, notes: [] });
    expect(refused.fixed.lines[2]).toMatchObject({ state: 'as_was', quantity: 2, cents: 25000 });
    expect(plan({ lines: [{ list: 'item', line: 1, quantity: 2.5000000000001, rate: 130.2500000000001 }] }).body)
      .toEqual({ item: { items: [{ line: 1, quantity: 2.5, rate: 130.25, amount: 325.62 }] } });
  });

  it('takes a line off by sending NetSuite every line it keeps on that list, by key', () => {
    const freight = plan({ lines: [{ list: 'expense', line: 2, remove: true }] });
    expect(freight).toMatchObject({
      problems: [], replace: ['expense'], changes: ['Took off 6200 Freight ($45.05)'], body: { expense: { items: [{ line: 1 }] } },
    });
    expect(freight.fixed.totalCents).toBe(50005);
    expect(freight.fixed.lines.map((l) => `${l.list}:${l.line}`)).toEqual(['expense:1', 'item:1', 'item:2', 'item:3']);
    // A part taken off: the order's billed quantity follows its key, and NetSuite's subtotal stays.
    const p = plan({ lines: [{ list: 'item', line: 3, remove: true }, { list: 'item', line: 1, quantity: 3 }, { list: 'expense', line: 1, amount: 100 }] });
    expect(p).toMatchObject({
      problems: [], replace: ['item'],
      changes: ['6100 Shop Supplies $200.05 → $100.00', 'SHELF-1 quantity 2 → 3', 'Took off LIGHT-2 (1 × $50.00)'],
      body: {
        expense: { items: [{ line: 1, amount: 100 }] },
        item: { items: [{ line: 1, quantity: 3, amount: 375 }, { line: 2 }] },
      },
    });
    expect(p.fixed.totalCents).toBe(54510 - 10005 + 12500 - 5000);
    expect(plan({ lines: [{ list: 'item', line: 3, remove: true }, { list: 'expense', line: 2, remove: true }] }).replace).toEqual(['expense', 'item']);
  });

  it("keeps the lines that only lay the bill out, and won't take its last line off", () => {
    expect(plan({ lines: [{ list: 'item', line: 2, remove: true }] }).problems).toEqual(['Subtotal only lays the bill out, so it stays as it is.']);
    expect(plan({ lines: [{ list: 'expense', line: 1, remove: true }] }, ONE).problems).toEqual([
      'A bill needs a line. To undo all of bill B-100, make a vendor credit for all of it.',
      'Bill B-100 has to come to more than $0. To undo all of it, make a vendor credit for all of it.',
    ]);
    const onlySubtotal = parse({
      expense: { items: [] },
      item: { items: [{ line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 1, rate: 50, amount: 50 }, { line: 2, item: { id: '-2' }, itemType: 'Subtotal', amount: 50 }] },
    }, { ...AMOUNTS, totalCents: 5000, owedCents: 5000 });
    expect(plan({ lines: [{ list: 'item', line: 1, remove: true }] }, onlySubtotal).problems[0])
      .toBe('A bill needs a line. To undo all of bill B-100, make a vendor credit for all of it.');
    // Taking one off and adding one is a bill with a line.
    expect(plan({ lines: [{ list: 'expense', line: 1, remove: true }], add: [{ accountId: '630', amount: 90 }] }, ONE)).toMatchObject({
      problems: [], replace: ['expense'], body: { expense: { items: [{ account: { id: '630' }, amount: 90 }] } },
    });
  });

  it('has to come to more than $0', () => {
    const credit = parse({
      expense: { items: [{ line: 1, account: { id: '610', refName: '6100 Shop Supplies' }, amount: 30 }, { line: 2, account: { id: '620' }, amount: -20 }] },
      item: { items: [] },
    }, { ...AMOUNTS, totalCents: 1000, owedCents: 1000 });
    expect(plan({ lines: [{ list: 'expense', line: 1, amount: 20 }] }, credit).problems)
      .toEqual(['Bill B-100 has to come to more than $0. To undo all of it, make a vendor credit for all of it.']);
    expect(plan({ lines: [{ list: 'expense', line: 1, amount: 20.01 }] }, credit).problems).toEqual([]);
  });

  it("says when a line isn't there any more, or is sent twice", () => {
    expect(plan({ lines: [{ list: 'expense', line: 9, amount: 5 }] }).problems).toEqual(["Expense line 9 isn't on bill B-100 any more. Reload and try again."]);
    expect(plan({ lines: [{ list: 'item', line: 9, quantity: 5 }] }).problems).toEqual(["Line 9 isn't on bill B-100 any more. Reload and try again."]);
    expect(plan({ lines: [{ list: 'expense', line: 1, amount: 5 }, { list: 'expense', line: 1, amount: 6 }] }).problems)
      .toEqual(['6100 Shop Supplies was sent twice.']);
  });

  it('changes no line once money is on the bill, saying why once', () => {
    const paid = { ...BILL, owedCents: 0 };
    const p = plan({
      header: { number: 'B-101' },
      lines: [{ list: 'expense', line: 1, amount: 5 }, { list: 'item', line: 3, remove: true }],
      add: [{ accountId: '630', amount: 5 }],
    }, paid);
    expect(p.problems).toEqual(["It's paid, so only its number, memo and due date can be fixed. To take money off it, make a vendor credit."]);
    expect(p.body).toEqual({ tranId: 'B-101' });
    expect(p.replace).toEqual([]);
    expect(p.fixed.lines.every((l) => l.state === 'as_was')).toBe(true);
    expect(plan({ lines: [{ list: 'expense', line: 1, amount: 5 }] }, paid, { allows: { header: true, lines: false, why: null } }).problems)
      .toEqual(["The date and lines of bill B-100 can't be fixed."]);
    expect(plan({ header: { number: 'B-101' } }, BILL, { allows: { header: false, lines: false, why: null } }).problems)
      .toEqual(["Bill B-100 can't be fixed."]);
  });
});

describe('planBillFix: lines added', () => {
  it('adds an expense line to any account the company can bill to', () => {
    const p = plan({ add: [{ accountId: '630', amount: 12.5, memo: ' Drill bits ' }, { accountId: '620', amount: 3 }] });
    expect(p).toMatchObject({
      problems: [], replace: [],
      body: { expense: { items: [{ account: { id: '630' }, amount: 12.5, memo: 'Drill bits' }, { account: { id: '620' }, amount: 3 }] } },
      changes: ['Added 6300 Tools ($12.50)', 'Added 6200 Freight ($3.00)'],
    });
    expect(p.fixed.totalCents).toBe(54510 + 1250 + 300);
    expect(p.fixed.lines.at(-2)).toEqual({
      list: 'expense', line: null, accountId: '630', accountName: '6300 Tools', itemId: null, itemNumber: '', itemType: null,
      description: 'Drill bits', kind: 'expense', quantity: null, rate: null, cents: 1250, orderId: null, orderLine: null, state: 'added',
    });
    // With a line changed on the same list, the change goes first.
    expect(plan({ lines: [{ list: 'expense', line: 2, amount: 50 }], add: [{ accountId: '630', amount: 1 }] }).body)
      .toEqual({ expense: { items: [{ line: 2, amount: 50 }, { account: { id: '630' }, amount: 1 }] } });
  });

  it("refuses an account the company can't bill to, or an amount or memo NetSuite wouldn't take", () => {
    const add = (n: { accountId: string; amount: number; memo?: string }) => plan({ add: [n] }).problems;
    expect(add({ accountId: '999', amount: 5 })).toEqual(["New line 1: pick an account this company's bills can go to."]);
    expect(add({ accountId: '630', amount: 0 })).toEqual(['New line 1: enter an amount above $0.']);
    expect(add({ accountId: '630', amount: NaN })).toEqual(['New line 1: enter an amount above $0.']);
    expect(add({ accountId: '630', amount: 10_000_000.01 })).toEqual(['New line 1: the amount can be $10,000,000 at most.']);
    expect(add({ accountId: '630', amount: 1.005 })).toEqual(['New line 1: the amount goes to the cent.']);
    expect(add({ accountId: '630', amount: 1, memo: 'M'.repeat(4001) })).toEqual(['New line 1: the memo takes 4,000 characters at most.']);
    expect(add({ accountId: '630', amount: 1, memo: 'M'.repeat(4000) })).toEqual([]);
    expect(plan({ add: [{ accountId: '630', amount: 1 }, { accountId: '999', amount: 1 }] }).problems)
      .toEqual(["New line 2: pick an account this company's bills can go to."]);
    const many = Array.from({ length: MAX_ADDED + 1 }, () => ({ accountId: '630', amount: 1 }));
    expect(plan({ add: many }).problems).toEqual(['One fix adds 50 lines at most.']);
    expect(plan({ add: many.slice(1) }).problems).toEqual([]);
  });
});

describe('billFacts', () => {
  it('changes when anything a fix is planned against changes in NetSuite', () => {
    const base = billFacts(BILL);
    expect(billFacts(parse())).toBe(base);
    expect(billFacts({ ...BILL, lastModified: '2026-12-02T09:00:00Z' })).not.toBe(base);
    expect(billFacts({ ...BILL, number: 'B-101' })).not.toBe(base);
    expect(billFacts({ ...BILL, dueDate: '2027-01-15' })).not.toBe(base);
    expect(billFacts({ ...BILL, owedCents: 100 })).not.toBe(base);
    expect(billFacts({ ...BILL, status: 'Bill : Paid In Full' })).not.toBe(base);
    expect(billFacts({ ...BILL, lines: BILL.lines.map((l, i) => (i === 0 ? { ...l, cents: 20006 } : l)) })).not.toBe(base);
    expect(billFacts({ ...BILL, lines: BILL.lines.map((l, i) => (i === 2 ? { ...l, orderLine: 9 } : l)) })).not.toBe(base);
    expect(billFacts({ ...BILL, lines: BILL.lines.map((l, i) => (i === 0 ? { ...l, accountId: '630' } : l)) })).not.toBe(base);
  });
});

describe('ownCopyLines', () => {
  it("gives Books' own copy the lines that come to something, as fixed", () => {
    const p = plan({ lines: [{ list: 'item', line: 1, quantity: 3 }, { list: 'expense', line: 2, remove: true }], add: [{ accountId: '630', amount: 5, memo: 'Bits' }] });
    expect(ownCopyLines(p.fixed)).toEqual([
      { accountId: '610', itemId: null, itemNumber: null, description: 'Gloves', quantity: null, rate: null, cents: 20005, orderId: null, orderLine: null },
      { accountId: null, itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 3, rate: 125, cents: 37500, orderId: '2001', orderLine: 1 },
      { accountId: null, itemId: '57', itemNumber: 'LIGHT-2', description: null, quantity: 1, rate: 50, cents: 5000, orderId: '2001', orderLine: 2 },
      { accountId: '630', itemId: null, itemNumber: null, description: 'Bits', quantity: null, rate: null, cents: 500, orderId: null, orderLine: null },
    ]);
    expect(ownCopyLines(p.fixed).reduce((s, l) => s + l.cents, 0)).toBe(p.fixed.totalCents);
    // An expense line names an account and no part; a part names its item and never an account.
    const shelf = p.fixed.lines.find((l) => l.itemId === '55')!;
    const crossed = { ...p.fixed, lines: [{ ...p.fixed.lines[0], itemId: '55', quantity: 2, rate: 5 }, { ...shelf, accountId: '610' }] };
    expect(ownCopyLines(crossed).map((l) => [l.accountId, l.itemId, l.quantity, l.rate])).toEqual([['610', null, null, null], [null, '55', 3, 125]]);
  });
});

describe('the words', () => {
  it('names the bill and its lines as the screen does', () => {
    expect(billName(BILL)).toBe('bill B-100');
    expect(billName({ id: '3001', number: '' })).toBe('NetSuite bill 3001');
    expect(lineName(BILL.lines[0])).toBe('6100 Shop Supplies');
    expect(lineName({ ...BILL.lines[1], accountName: '' })).toBe('Expense line 2');
    expect(lineName(BILL.lines[2])).toBe('SHELF-1');
    expect(lineName({ ...BILL.lines[4], itemNumber: '' })).toBe('Line 3');
  });
});
