import { describe, it, expect } from 'vitest';
import {
  MAX_ADDED, addDays, dayText, fixAllows, invoiceFacts, ownCopyLines, parseFixInvoice, planInvoiceFix, priceText,
  quantityText, termDays, type FixFacts, type FixInvoice, type FixItem, type InvoiceFixEdit,
} from './invoice-fix';

// A made-up NetSuite invoice as GET invoice/{id}?expandSubResources=true answers it, billed off sales order 6001: a
// stock part, labor, NetSuite's subtotal, a discount on the part, another stock part, and a $0 note line.
const RECORD = {
  id: '7001', tranId: 'INV9001', tranDate: '2026-12-01', dueDate: '2026-12-31', terms: { id: '2', refName: 'Net 30' },
  entity: { id: '9001', refName: 'Acme Fleet Services' }, location: { id: '1', refName: "O'Fallon" },
  otherRefNum: 'PO-77', memo: 'Invoice from BMG FleetSuite', custbody_vin_number_: '1ftfw1e50nfa00001',
  createdFrom: { id: '6001', refName: 'Sales Order #SO1001' }, lastModifiedDate: '2026-12-01T15:04:05Z',
  subtotal: 610, taxTotal: 27.58, total: 637.58, amountRemaining: 637.58, taxRate: 8.488, taxItem: { id: '77' },
  status: { id: 'A', refName: 'Open' },
  item: {
    items: [
      { line: 1, item: { id: '55', refName: 'Racks : SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, description: 'Shelf unit', isTaxable: true, orderLine: 1 },
      { line: 2, item: { id: '56', refName: 'LABOR' }, itemType: 'Service', quantity: 3, rate: 95, amount: 285, description: 'Install', isTaxable: false, orderLine: 2 },
      { line: 3, item: { id: '-2', refName: 'Subtotal' }, itemType: 'Subtotal', amount: 536 },
      { line: 4, item: { id: '58', refName: 'DISCOUNT' }, itemType: 'Discount', rate: -26, amount: -26, isTaxable: true, orderLine: 4 },
      { line: 5, item: { id: '57', refName: 'LIGHT-2' }, itemType: 'InvtPart', quantity: 1, rate: 100, amount: 100, isTaxable: true, orderLine: 5 },
      { line: 6, item: { id: '59', refName: 'NOTE' }, itemType: 'NonInvtPart', quantity: 1, rate: 0, amount: 0, description: 'Thanks' },
    ],
  },
};

const parse = (over: Record<string, unknown> = {}) => parseFixInvoice({ ...RECORD, ...over });
const INV = parse();

const ITEMS = new Map<string, FixItem>([
  ['501', { itemId: '501', itemNumber: 'BRK-100', itemType: 'InvtPart', taxableOverride: null, description: 'Bracket kit' }],
  ['502', { itemId: '502', itemNumber: 'HOURS', itemType: 'Service', taxableOverride: null, description: 'Shop labor' }],
  ['503', { itemId: '503', itemNumber: 'DISCOUNT', itemType: 'Discount', taxableOverride: null, description: 'Discount' }],
  ['504', { itemId: '504', itemNumber: 'DECAL-1', itemType: 'NonInvtPart', taxableOverride: false, description: 'Door decal' }],
  ['505', { itemId: '505', itemNumber: 'SUB', itemType: 'Subtotal', taxableOverride: null, description: '' }],
]);

const facts = (inv: FixInvoice = INV, over: Partial<FixFacts> = {}): FixFacts => ({
  allows: fixAllows(inv, { creditedHere: false }), items: ITEMS, untaxed: null, termsDays: 30, ...over,
});

const plan = (edit: Partial<InvoiceFixEdit>, inv: FixInvoice = INV, over: Partial<FixFacts> = {}) =>
  planInvoiceFix(inv, { reason: 'Wrong count', ...edit }, facts(inv, over));

describe('parseFixInvoice', () => {
  it('reads what the credit memo screen reads, and what a fix needs besides', () => {
    expect(INV).toMatchObject({
      id: '7001', number: 'INV9001', date: '2026-12-01', dueDate: '2026-12-31', termsId: '2', termsName: 'Net 30',
      customerId: '9001', customerName: 'Acme Fleet Services', poNumber: 'PO-77', memo: 'Invoice from BMG FleetSuite',
      vin: '1FTFW1E50NFA00001', salesOrderId: '6001', lastModified: '2026-12-01T15:04:05Z', locationId: '1',
      subtotalCents: 61000, taxCents: 2758, totalCents: 63758, owedCents: 63758, taxRate: 0.08488, voided: false,
    });
  });

  it('keeps every line, the ones that only lay it out and the $0 ones too', () => {
    expect(INV.lines.map((l) => [l.line, l.itemId, l.itemNumber, l.kind, l.quantity, l.rate, l.cents, l.taxable, l.orderLine])).toEqual([
      [1, '55', 'SHELF-1', 'quantity', 2, 125.5, 25100, true, 1],
      [2, '56', 'LABOR', 'quantity', 3, 95, 28500, false, 2],
      [3, '-2', 'Subtotal', 'layout', 0, null, 0, false, null],
      [4, '58', 'DISCOUNT', 'amount', 0, null, -2600, true, 4],
      [5, '57', 'LIGHT-2', 'quantity', 1, 100, 10000, true, 5],
      [6, '59', 'NOTE', 'quantity', 1, 0, 0, true, null],
    ]);
    expect(INV.lines[0].description).toBe('Shelf unit');
    expect(parse({ item: { items: [{ ...RECORD.item.items[0], description: '  Shelf unit \n' }] } }).lines[0].description).toBe('Shelf unit');
  });

  it('keeps lines that take money off without being a discount, or name no item, as they are', () => {
    const inv = parse({
      item: {
        items: [
          { line: 1, item: { id: '61', refName: 'TRADE-IN' }, itemType: 'NonInvtPart', quantity: 1, rate: -500, amount: -500 },
          { line: 2, itemType: 'NonInvtPart', quantity: 1, rate: 10, amount: 10 },
          { line: 3, item: { id: '62', refName: 'FEE' }, itemType: 'Markup', rate: 12, amount: 12 },
          { line: 4, item: { id: '0' }, itemType: 'NonInvtPart', quantity: 1, amount: 0 },
          { line: 5, item: { id: '63', refName: 'Note' }, itemType: 'Description', description: 'Unit 12' },
          { line: 6, item: { id: '64', refName: 'Kit' }, itemType: 'Group' },
          { line: 7, item: { id: '65' }, itemType: 'EndGroup' },
          { item: { id: '66' }, itemType: 'InvtPart', quantity: 1, rate: 1, amount: 1 },
          { line: 'x', item: { id: '67' }, itemType: 'InvtPart', quantity: 1, rate: 1, amount: 1 },
          { line: 8, item: { id: '68', refName: 'PART' }, itemType: { id: 'InvtPart' }, quantity: -2, rate: 5, orderLine: 2.5 },
          { line: 9, item: { id: '69', refName: 'CORE' }, itemType: 'NonInvtPart', quantity: 1, amount: -40 },
          { line: 10, item: { id: '70', refName: 'ODD' }, itemType: 'NonInvtPart', quantity: -2, rate: -5, amount: 10 },
        ],
      },
    });
    expect(inv.lines.map((l) => [l.line, l.kind, l.quantity, l.rate, l.cents, l.orderLine])).toEqual([
      [1, 'kept', 1, null, -50000, null],
      [2, 'kept', 1, null, 1000, null],
      [3, 'amount', 0, null, 1200, null],
      [4, 'layout', 0, null, 0, null],
      [5, 'layout', 0, null, 0, null],
      [6, 'layout', 0, null, 0, null],
      [7, 'layout', 0, null, 0, null],
      // No amount from NetSuite: its price each times its quantity, the quantity as a count.
      [8, 'quantity', 2, 5, 1000, null],
      [9, 'kept', 1, null, -4000, null],
      [10, 'kept', 2, null, 1000, null],
    ]);
    expect(inv.lines[7].itemType).toBe('InvtPart');
  });

  it("taxes nothing on an invoice that charged none, and falls back on FleetSuite's rule where NetSuite doesn't say", () => {
    expect(parse({ taxTotal: 0, total: 610 }).lines.every((l) => !l.taxable)).toBe(true);
    const inv = parse({
      item: {
        items: [
          { line: 1, item: { id: '55' }, itemType: 'InvtPart', quantity: 1, rate: 10, amount: 10 },
          { line: 2, item: { id: '56' }, itemType: 'Service', quantity: 1, rate: 10, amount: 10 },
          { line: 3, item: { id: '57' }, itemType: 'InvtPart', quantity: 1, rate: 10, amount: 10, isTaxable: 'F' },
          { line: 4, item: { id: '56' }, itemType: 'Service', quantity: 1, rate: 10, amount: 10, istaxable: 'T' },
        ],
      },
    });
    expect(inv.lines.map((l) => l.taxable)).toEqual([true, false, false, true]);
  });

  it('reads no due date, terms, VIN, sales order or change time when NetSuite gives none', () => {
    const inv = parse({ dueDate: '12/31/2026', terms: null, custbody_vin_number_: undefined, createdFrom: null, lastModifiedDate: undefined });
    expect(inv).toMatchObject({ dueDate: null, termsId: null, termsName: null, vin: '', salesOrderId: null, lastModified: null });
    expect(parse({ terms: '4', duedate: '2027-01-10', dueDate: undefined })).toMatchObject({ termsId: '4', termsName: null, dueDate: '2027-01-10' });
  });
});

describe('fixAllows', () => {
  it('fixes everything on an invoice nothing is paid on', () => {
    expect(fixAllows(INV, { creditedHere: false })).toEqual({ header: true, lines: true, why: null });
    // Nothing owed on an invoice of nothing is nothing paid.
    expect(fixAllows(parse({ subtotal: 0, taxTotal: 0, total: 0, amountRemaining: 0 }), { creditedHere: false }).lines).toBe(true);
  });

  it('fixes only the PO number, memo and VIN once money is on it, and nothing on a voided one', () => {
    expect(fixAllows(parse({ status: { id: 'V', refName: 'Voided' } }), { creditedHere: false }))
      .toEqual({ header: false, lines: false, why: "Invoice INV9001 is voided in NetSuite, so there's nothing to fix." });
    expect(fixAllows(parse({ amountRemaining: 0 }), { creditedHere: false }))
      .toEqual({ header: true, lines: false, why: "It's paid, so only its PO number, memo and VIN can be fixed. To take money off it, make a credit memo." });
    expect(fixAllows(parse({ amountRemaining: 100 }), { creditedHere: false }).why)
      .toBe('Part of it is paid or credited, so only its PO number, memo and VIN can be fixed. To take money off it, make a credit memo.');
    expect(fixAllows(parse({ amountRemaining: undefined }), { creditedHere: false }).why)
      .toBe("NetSuite didn't say what's still owed on it, so only its PO number, memo and VIN can be fixed.");
    expect(fixAllows(INV, { creditedHere: true }))
      .toEqual({
        header: true, lines: false,
        why: 'FleetSuite made a credit memo against it, so only its PO number, memo and VIN can be fixed. To take more off it, make another credit memo.',
      });
  });
});

describe('planInvoiceFix: the invoice', () => {
  it('changes its PO number, memo and VIN, and sends only what changed', () => {
    const p = plan({ header: { poNumber: ' PO-78 ', memo: 'Unit 12, second visit', vin: '' } });
    expect(p.problems).toEqual([]);
    expect(p.changes).toEqual(['PO number PO-77 → PO-78', 'Memo changed', 'VIN 1FTFW1E50NFA00001 → (none)']);
    expect(p.body).toEqual({ otherRefNum: 'PO-78', memo: 'Unit 12, second visit', custbody_vin_number_: null });
    expect(p.replace).toBe(false);
    expect(p.fixed).toMatchObject({ poNumber: 'PO-78', memo: 'Unit 12, second visit', vin: '', subtotalCents: 61000, taxCents: 2758, totalCents: 63758 });
    expect(p.notes).toEqual([]);
  });

  it('says a memo was added or taken off, and a VIN put on', () => {
    const blank = parse({ memo: '', custbody_vin_number_: '', otherRefNum: '' });
    expect(plan({ header: { memo: 'Unit 12', vin: '1ftfw1e50nfa00002', poNumber: 'PO-1' } }, blank).changes)
      .toEqual(['PO number (none) → PO-1', 'Memo added', 'VIN (none) → 1FTFW1E50NFA00002']);
    expect(plan({ header: { memo: '  ' } }).changes).toEqual(['Memo taken off']);
    expect(plan({ header: { memo: '  ' } }).body).toEqual({ memo: '' });
  });

  it('changes nothing for a box left as it was', () => {
    const p = plan({ header: { date: '2026-12-01', poNumber: 'PO-77 ', memo: 'Invoice from BMG FleetSuite', vin: '1ftfw1e50nfa00001' } });
    expect(p.problems).toEqual(['Nothing has changed yet.']);
    expect(p.body).toEqual({});
    expect(p.changes).toEqual([]);
  });

  it("refuses a PO number, memo or VIN NetSuite wouldn't take", () => {
    expect(plan({ header: { poNumber: 'P'.repeat(46) } }).problems).toEqual(['The PO number takes 45 characters at most.']);
    expect(plan({ header: { poNumber: 'P'.repeat(45) } }).problems).toEqual([]);
    expect(plan({ header: { memo: 'M'.repeat(1000) } }).problems).toEqual(['The memo takes 999 characters at most.']);
    expect(plan({ header: { memo: 'M'.repeat(999) } }).problems).toEqual([]);
    for (const vin of ['1FTFW1E50NFA0000', '1FTFW1E50NFA000011', '1FTFW1E50NFA0000I', '1FTFW1E50NFA0000O', '1FTFW1E50NFA0000Q', '1FTFW1E50NFA0000-']) {
      expect(plan({ header: { vin } }).problems).toEqual(['A VIN is 17 letters and numbers, with no I, O or Q.']);
    }
  });

  it('moves the due date with the date, by its terms', () => {
    const p = plan({ header: { date: '2026-12-05' } });
    expect(p.problems).toEqual([]);
    expect(p.changes).toEqual(['Date Dec 1, 2026 → Dec 5, 2026', 'Due Dec 31, 2026 → Jan 4, 2027']);
    expect(p.body).toEqual({ tranDate: '2026-12-05', dueDate: '2027-01-04' });
    expect(p.fixed).toMatchObject({ date: '2026-12-05', dueDate: '2027-01-04' });
    // Due the day it's billed with no terms.
    expect(plan({ header: { date: '2026-12-05' } }, INV, { termsDays: 0 }).body).toEqual({ tranDate: '2026-12-05', dueDate: '2026-12-05' });
    // A due date that doesn't move isn't sent.
    const odd = parse({ dueDate: '2027-01-04' });
    expect(plan({ header: { date: '2026-12-05' } }, odd).body).toEqual({ tranDate: '2026-12-05' });
    expect(plan({ header: { date: '2026-12-05' } }, odd).changes).toEqual(['Date Dec 1, 2026 → Dec 5, 2026']);
  });

  it("leaves NetSuite's due date when FleetSuite can't tell the terms", () => {
    const p = plan({ header: { date: '2026-12-05' } }, INV, { termsDays: null });
    expect(p.body).toEqual({ tranDate: '2026-12-05' });
    expect(p.fixed.dueDate).toBe('2026-12-31');
    expect(p.notes).toEqual(["NetSuite keeps its due date, Dec 31, 2026: FleetSuite can't tell the invoice's terms."]);
  });

  it('asks for a real date, and changes no date once money is on it', () => {
    for (const date of ['', '2026-02-30', '12/05/2026', '2026-13-01']) {
      expect(plan({ header: { date } }).problems).toEqual(['Pick the date.']);
    }
    const paid = parse({ amountRemaining: 0 });
    const p = plan({ header: { date: '2026-12-05', poNumber: 'PO-78' } }, paid);
    expect(p.problems).toEqual(["It's paid, so only its PO number, memo and VIN can be fixed. To take money off it, make a credit memo."]);
    expect(p.body).toEqual({ otherRefNum: 'PO-78' });
    // Its PO number alone can be fixed.
    expect(plan({ header: { poNumber: 'PO-78' } }, paid).problems).toEqual([]);
  });

  it('fixes nothing on a voided invoice', () => {
    const voided = parse({ status: { id: 'V', refName: 'Voided' } });
    const p = plan({ header: { poNumber: 'PO-78' } }, voided);
    expect(p.problems).toEqual(["Invoice INV9001 is voided in NetSuite, so there's nothing to fix."]);
    expect(p.body).toEqual({});
    expect(p.changes).toEqual([]);
  });

  it('needs to say why, briefly', () => {
    expect(plan({ reason: '  ', header: { poNumber: 'PO-78' } }).problems).toEqual(["Say why it's being fixed."]);
    expect(plan({ reason: 'R'.repeat(301), header: { poNumber: 'PO-78' } }).problems).toEqual(["Why it's being fixed takes 300 characters at most."]);
    expect(plan({ reason: 'R'.repeat(300), header: { poNumber: 'PO-78' } }).problems).toEqual([]);
    expect(plan({ reason: '' }).problems).toEqual(["Say why it's being fixed."]);
  });
});

describe('planInvoiceFix: its lines', () => {
  it("changes a line's quantity and price by its key, and works out the tax NetSuite should come to", () => {
    const p = plan({ lines: [{ line: 1, quantity: 3 }, { line: 2, price: 100 }] });
    expect(p.problems).toEqual([]);
    expect(p.changes).toEqual(['SHELF-1 quantity 2 → 3', 'LABOR price $95.00 → $100.00']);
    expect(p.body).toEqual({ item: { items: [{ line: 1, quantity: 3 }, { line: 2, price: { id: '-1' }, rate: 100 }] } });
    expect(p.replace).toBe(false);
    // 376.50 of shelf taxed at 8.488% is 31.96, where 251.00 was 21.30; labor isn't taxed.
    expect(p.fixed).toMatchObject({ subtotalCents: 61000 + 12550 + 1500, taxCents: 2758 + 1066, totalCents: 63758 + 14050 + 1066 });
    expect(p.fixed.lines.map((l) => [l.line, l.state, l.quantity, l.rate, l.cents])).toEqual([
      [1, 'changed', 3, 125.5, 37650],
      [2, 'changed', 3, 100, 30000],
      [3, 'as_was', null, null, 0],
      [4, 'as_was', null, null, -2600],
      [5, 'as_was', 1, 100, 10000],
      [6, 'as_was', 1, 0, 0],
    ]);
    expect(p.notes).toEqual(['NetSuite works the sales tax out again, so it can differ from this by a cent or so.']);
  });

  it('changes nothing for a line left as it was', () => {
    const p = plan({ lines: [{ line: 4, amount: 26, description: '' }, { line: 1, quantity: 2, price: 125.5, description: ' Shelf unit ' }] });
    expect(p.problems).toEqual(['Nothing has changed yet.']);
    expect(p.body).toEqual({});
  });

  it('changes a markup by its amount, and says no tax moves when only an untaxed line changes', () => {
    const marked = parse({ item: { items: [
      { line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, isTaxable: true },
      { line: 2, item: { id: '62', refName: 'FEE' }, itemType: 'Markup', rate: 12, amount: 12, isTaxable: false },
    ] }, subtotal: 263, taxTotal: 21.3, total: 284.3, amountRemaining: 284.3 });
    const p = plan({ lines: [{ line: 2, amount: 15 }] }, marked);
    expect(p.changes).toEqual(['FEE $12.00 → $15.00']);
    expect(p.body).toEqual({ item: { items: [{ line: 2, rate: 15 }] } });
    expect(p.fixed).toMatchObject({ subtotalCents: 26600, taxCents: 2130, totalCents: 28730 });
    expect(p.notes).toEqual([]);
    expect(plan({ lines: [{ line: 2, price: 100 }] }).notes).toEqual([]);
  });

  it("changes a discount by its amount, its sign kept, and a line's description", () => {
    const p = plan({ lines: [{ line: 4, amount: 30, description: ' 10% off the shelf ' }, { line: 1, description: 'Shelf unit, 4 ft' }] });
    expect(p.problems).toEqual([]);
    expect(p.changes).toEqual(['SHELF-1 description changed', 'DISCOUNT $26.00 → $30.00', 'DISCOUNT description changed']);
    expect(p.body).toEqual({
      item: { items: [{ line: 1, description: 'Shelf unit, 4 ft' }, { line: 4, rate: -30, description: '10% off the shelf' }] },
    });
    // 30.00 off taxed at 8.488% is 2.55 of tax off, where 26.00 off was 2.21.
    expect(p.fixed).toMatchObject({ subtotalCents: 60600, taxCents: 2724, totalCents: 63324 });
    expect(p.fixed.lines[3]).toMatchObject({ state: 'changed', cents: -3000, description: '10% off the shelf', quantity: null });
    // A description alone moves no money but tells NetSuite nothing new about tax.
    expect(plan({ lines: [{ line: 1, description: 'Shelf' }] }).fixed).toMatchObject({ subtotalCents: 61000, taxCents: 2758, totalCents: 63758 });
  });

  it('reads only what fits the line: a quantity and price each, or an amount', () => {
    const p = plan({ lines: [{ line: 4, quantity: 5, price: 9 }, { line: 1, amount: 50 }, { line: 3, description: 'Sub', quantity: 2 }] });
    expect(p.problems).toEqual(['Nothing has changed yet.']);
    expect(p.body).toEqual({});
    // A line kept as it is can only be taken off.
    const kept = parse({ item: { items: [
      { line: 1, item: { id: '61', refName: 'TRADE-IN' }, itemType: 'NonInvtPart', quantity: 1, rate: -500, amount: -500 },
      { line: 2, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 1, rate: 600, amount: 600, isTaxable: true },
    ] }, subtotal: 100, taxTotal: 0, total: 100, amountRemaining: 100 });
    expect(plan({ lines: [{ line: 1, quantity: 2, amount: 400, description: 'x' }] }, kept).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ lines: [{ line: 1, remove: true }] }, kept)).toMatchObject({
      problems: [], changes: ['Took off TRADE-IN (-$500.00)'], replace: true, body: { item: { items: [{ line: 2 }] } },
    });
  });

  it('refuses a quantity, price or amount NetSuite or the books would get wrong', () => {
    const q = (quantity: number) => plan({ lines: [{ line: 1, quantity }] }).problems;
    expect(q(NaN)).toEqual(['SHELF-1: enter the quantity.']);
    expect(q(0)).toEqual(['SHELF-1: the quantity has to be more than 0. To drop the line, take it off.']);
    expect(q(-1)).toEqual(['SHELF-1: the quantity has to be more than 0. To drop the line, take it off.']);
    expect(q(1_000_001)).toEqual(['SHELF-1: the quantity can be 1,000,000 at most.']);
    expect(q(1_000_000)).toEqual([]);
    expect(q(1.23456)).toEqual(['SHELF-1: the quantity takes 4 places at most.']);
    expect(q(1.2345)).toEqual([]);
    const price = (p: number) => plan({ lines: [{ line: 1, price: p }] }).problems;
    expect(price(NaN)).toEqual(['SHELF-1: enter the price each.']);
    expect(price(-0.01)).toEqual(["SHELF-1: the price can't be less than $0."]);
    expect(price(10_000_000.01)).toEqual(['SHELF-1: the price can be $10,000,000 at most.']);
    expect(price(10_000_000)).toEqual([]);
    expect(price(1.23456)).toEqual(['SHELF-1: the price takes 4 places at most.']);
    expect(price(0)).toEqual([]);
    const amount = (a: number) => plan({ lines: [{ line: 4, amount: a }] }).problems;
    expect(amount(0)).toEqual(['DISCOUNT: enter an amount above $0. To drop it, take it off.']);
    expect(amount(NaN)).toEqual(['DISCOUNT: enter an amount above $0. To drop it, take it off.']);
    expect(amount(-5)).toEqual(['DISCOUNT: enter an amount above $0. To drop it, take it off.']);
    expect(amount(10_000_000.01)).toEqual(['DISCOUNT: the amount can be $10,000,000 at most.']);
    expect(amount(10.005)).toEqual(['DISCOUNT: the amount goes to the cent.']);
    expect(plan({ lines: [{ line: 1, description: 'D'.repeat(4001) }] }).problems).toEqual(['SHELF-1: the description takes 4,000 characters at most.']);
    expect(plan({ lines: [{ line: 1, description: 'D'.repeat(4000) }] }).problems).toEqual([]);
  });

  it('leaves a line it refuses as it was, and sends a number a hair off four places as its four places', () => {
    const refused = plan({ lines: [{ line: 1, quantity: 0 }] });
    expect(refused).toMatchObject({ body: {}, notes: [] });
    expect(refused.fixed.lines[0]).toMatchObject({ state: 'as_was', quantity: 2, cents: 25100 });
    expect(plan({ lines: [{ line: 1, quantity: 2.5000000000001, price: 130.2500000000001 }] }).body)
      .toEqual({ item: { items: [{ line: 1, quantity: 2.5, price: { id: '-1' }, rate: 130.25 }] } });
  });

  it('shows a price each to the cent when it is whole cents, and to four places when it is not', () => {
    expect(plan({ lines: [{ line: 1, price: 12.3456 }] }).changes).toEqual(['SHELF-1 price $125.50 → $12.3456']);
    expect(plan({ lines: [{ line: 1, quantity: 2.5 }] }).changes).toEqual(['SHELF-1 quantity 2 → 2.5']);
    const noRate = parse({ item: { items: [{ line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, amount: 0 }] }, subtotal: 0, taxTotal: 0, total: 0, amountRemaining: 0 });
    expect(plan({ lines: [{ line: 1, price: 10 }] }, noRate).changes).toEqual(['SHELF-1 price (none) → $10.00']);
  });

  it("won't change the quantity of a line NetSuite gave no price each for without one", () => {
    const noRate = parse({ item: { items: [{ line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, amount: 251, isTaxable: true }] }, subtotal: 251, taxTotal: 0, total: 251, amountRemaining: 251 });
    expect(noRate.lines[0]).toMatchObject({ kind: 'quantity', rate: null, cents: 25100 });
    expect(plan({ lines: [{ line: 1, quantity: 3 }] }, noRate).problems).toEqual(['SHELF-1: NetSuite gave no price each for it, so enter the price each too.']);
    const priced = plan({ lines: [{ line: 1, quantity: 3, price: 125.5 }] }, noRate);
    expect(priced.problems).toEqual([]);
    expect(priced.fixed.lines[0]).toMatchObject({ quantity: 3, rate: 125.5, cents: 37650 });
  });

  it('takes a line off by sending NetSuite every line it keeps, by key', () => {
    const p = plan({ lines: [{ line: 2, remove: true }, { line: 1, quantity: 3 }] });
    expect(p.problems).toEqual([]);
    expect(p.changes).toEqual(['SHELF-1 quantity 2 → 3', 'Took off LABOR (3 × $95.00)']);
    expect(p.replace).toBe(true);
    expect(p.body).toEqual({ item: { items: [{ line: 1, quantity: 3 }, { line: 3 }, { line: 4 }, { line: 5 }, { line: 6 }] } });
    expect(p.fixed.lines.map((l) => l.line)).toEqual([1, 3, 4, 5, 6]);
    expect(p.fixed).toMatchObject({ subtotalCents: 61000 - 28500 + 12550, taxCents: 2758 + 1066 });
    // A discount taken off gives back the tax it took off.
    expect(plan({ lines: [{ line: 4, remove: true }] })).toMatchObject({
      changes: ['Took off DISCOUNT (-$26.00)'], fixed: { subtotalCents: 63600, taxCents: 2979, totalCents: 66579 },
    });
    // A line NetSuite gave no price each for is taken off by what it charged.
    const unpriced = parse({ item: { items: [RECORD.item.items[0], { line: 7, item: { id: '57', refName: 'LIGHT-2' }, itemType: 'InvtPart', quantity: 1, amount: 100, isTaxable: true }] } });
    expect(plan({ lines: [{ line: 7, remove: true }] }, unpriced).changes).toEqual(['Took off LIGHT-2 ($100.00)']);
  });

  it('keeps what else the invoice charges, its shipping say, in the total', () => {
    const shipped = parse({ total: 647.58, amountRemaining: 647.58 });
    expect(plan({ lines: [{ line: 2, quantity: 4 }] }, shipped).fixed).toMatchObject({ subtotalCents: 70500, taxCents: 2758, totalCents: 74258 });
  });

  it("keeps NetSuite's tax when only an untaxed line changes on an invoice whose rate FleetSuite can't tell", () => {
    const { taxRate: _rate, ...unrated } = RECORD;
    const inv = parseFixInvoice({ ...unrated, item: { items: RECORD.item.items.map((l) => ({ ...l, isTaxable: false })) } });
    expect(inv.taxRate).toBeNull();
    expect(plan({ lines: [{ line: 2, quantity: 4 }] }, inv).fixed).toMatchObject({ subtotalCents: 70500, taxCents: 2758, totalCents: 73258 });
    expect(plan({ add: [{ itemId: '501', quantity: 1, price: 10 }] }, inv)).toMatchObject({
      fixed: { subtotalCents: 62000, taxCents: null, totalCents: null },
      notes: ["NetSuite works the sales tax out again: FleetSuite can't tell this invoice's rate, so it can't say what it'll be."],
    });
  });

  it("keeps the lines that only lay the invoice out, and won't take its last line off", () => {
    expect(plan({ lines: [{ line: 3, remove: true }] }).problems).toEqual(['Subtotal only lays the invoice out, so it stays as it is.']);
    const one = parse({
      item: { items: [
        { line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, isTaxable: true },
        { line: 2, item: { id: '-2', refName: 'Subtotal' }, itemType: 'Subtotal', amount: 251 },
      ] },
      subtotal: 251, taxTotal: 21.3, total: 272.3, amountRemaining: 272.3,
    });
    expect(plan({ lines: [{ line: 1, remove: true }] }, one).problems).toEqual([
      'An invoice needs a line. To undo all of invoice INV9001, make a credit memo for all of it.',
      'Invoice INV9001 has to come to more than $0. To undo all of it, make a credit memo for all of it.',
    ]);
    // Taking enough off to bring it to nothing, too.
    expect(plan({ lines: [{ line: 1, quantity: 2, price: 0 }] }, one).problems)
      .toEqual(['Invoice INV9001 has to come to more than $0. To undo all of it, make a credit memo for all of it.']);
  });

  it("says when a line isn't there any more, or is sent twice", () => {
    expect(plan({ lines: [{ line: 9, quantity: 1 }] }).problems).toEqual(["Line 9 isn't on invoice INV9001 any more. Reload and try again."]);
    expect(plan({ lines: [{ line: 1, quantity: 3 }, { line: 1, quantity: 4 }] }).problems).toEqual(['SHELF-1 was sent twice.']);
  });

  it('changes no line once money is on the invoice, saying why once', () => {
    const paid = parse({ amountRemaining: 0 });
    const p = plan({ lines: [{ line: 1, quantity: 3 }, { line: 2, remove: true }], add: [{ itemId: '501', quantity: 1, price: 5 }] }, paid);
    expect(p.problems).toEqual(["It's paid, so only its PO number, memo and VIN can be fixed. To take money off it, make a credit memo."]);
    expect(p.body).toEqual({});
    expect(p.fixed.lines.map((l) => l.state)).toEqual(['as_was', 'as_was', 'as_was', 'as_was', 'as_was', 'as_was']);
    // A box left as it was says nothing.
    expect(plan({ lines: [{ line: 1, quantity: 2 }], header: { poNumber: 'PO-78' } }, paid).problems).toEqual([]);
  });
});

describe('planInvoiceFix: lines added', () => {
  it('adds a line of any item a new invoice bills, taxed by its item', () => {
    const p = plan({ add: [{ itemId: '501', quantity: 2, price: 10 }, { itemId: '502', quantity: 1.5, price: 90, description: 'Rewire' }] });
    expect(p.problems).toEqual([]);
    expect(p.changes).toEqual(['Added BRK-100 (2 × $10.00)', 'Added HOURS (1.5 × $90.00)']);
    expect(p.body).toEqual({
      item: {
        items: [
          { item: { id: '501' }, quantity: 2, price: { id: '-1' }, rate: 10, description: 'Bracket kit', isTaxable: true },
          { item: { id: '502' }, quantity: 1.5, price: { id: '-1' }, rate: 90, description: 'Rewire', isTaxable: false },
        ],
      },
    });
    // 20.00 taxed at 8.488% is 1.70; labor isn't taxed.
    expect(p.fixed).toMatchObject({ subtotalCents: 61000 + 2000 + 13500, taxCents: 2758 + 170, totalCents: 63758 + 15500 + 170 });
    expect(p.fixed.lines.slice(6).map((l) => [l.line, l.state, l.kind, l.itemNumber, l.quantity, l.rate, l.cents, l.taxable])).toEqual([
      [null, 'added', 'quantity', 'BRK-100', 2, 10, 2000, true],
      [null, 'added', 'quantity', 'HOURS', 1.5, 90, 13500, false],
    ]);
  });

  it("adds a discount by what it takes off, taxed as the line above it, and follows an admin's tax setting", () => {
    const p = plan({ add: [{ itemId: '502', quantity: 1, price: 50 }, { itemId: '503', quantity: 1, price: 5 }, { itemId: '504', quantity: 1, price: 40 }] });
    expect(p.problems).toEqual([]);
    expect(p.changes).toEqual(['Added HOURS (1 × $50.00)', 'Added DISCOUNT ($5.00 off)', 'Added DECAL-1 (1 × $40.00)']);
    expect((p.body.item as { items: unknown[] }).items).toEqual([
      { item: { id: '502' }, quantity: 1, price: { id: '-1' }, rate: 50, description: 'Shop labor', isTaxable: false },
      { item: { id: '503' }, rate: -5, description: 'Discount', isTaxable: false },
      { item: { id: '504' }, quantity: 1, price: { id: '-1' }, rate: 40, description: 'Door decal', isTaxable: false },
    ]);
    expect(p.fixed.lines[7]).toMatchObject({ kind: 'amount', quantity: null, rate: null, cents: -500, taxable: false });
    // Under a taxed line, a discount takes tax off with it.
    expect((plan({ add: [{ itemId: '501', quantity: 1, price: 50 }, { itemId: '503', quantity: 1, price: 5 }] }).body.item as { items: Array<{ isTaxable: boolean }> })
      .items.map((x) => x.isTaxable)).toEqual([true, true]);
  });

  it('taxes a discount added under a subtotal as the line above the subtotal', () => {
    const subtotalled = parse({
      item: { items: [
        { line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, isTaxable: true },
        { line: 2, item: { id: '-2', refName: 'Subtotal' }, itemType: 'Subtotal', amount: 251 },
      ] },
      subtotal: 251, taxTotal: 21.3, total: 272.3, amountRemaining: 272.3,
    });
    const p = plan({ add: [{ itemId: '503', quantity: 1, price: 5 }] }, subtotalled);
    expect((p.body.item as { items: Array<{ isTaxable: boolean }> }).items[0].isTaxable).toBe(true);
    expect(p.fixed).toMatchObject({ subtotalCents: 24600, taxCents: 2130 - 42, totalCents: 24600 + 2088 });
    // With no line above it at all it's taxed, as on a new invoice (and an invoice of only a discount can't be sent).
    const alone = plan({ lines: [{ line: 1, remove: true }], add: [{ itemId: '503', quantity: 1, price: 5 }] }, subtotalled);
    expect(alone.fixed.lines.at(-1)).toMatchObject({ itemNumber: 'DISCOUNT', taxable: true });
  });

  it("taxes nothing added for a tax-exempt customer or work at Social Circle", () => {
    for (const untaxed of ['exempt_customer', 'georgia'] as const) {
      const p = plan({ add: [{ itemId: '501', quantity: 2, price: 10 }, { itemId: '503', quantity: 1, price: 5 }] }, INV, { untaxed });
      expect((p.body.item as { items: Array<{ isTaxable: boolean }> }).items.map((x) => x.isTaxable)).toEqual([false, false]);
      expect(p.fixed.taxCents).toBe(2758);
    }
  });

  it("can't say the tax when a taxed line goes on an invoice that charged none", () => {
    const untaxed = parse({ taxTotal: 0, total: 610, amountRemaining: 610 });
    const p = plan({ add: [{ itemId: '501', quantity: 2, price: 10 }] }, untaxed);
    expect(p.problems).toEqual([]);
    expect(p.fixed).toMatchObject({ subtotalCents: 63000, taxCents: null, totalCents: null });
    expect(p.notes).toEqual(["NetSuite works the sales tax out again: FleetSuite can't tell this invoice's rate, so it can't say what it'll be."]);
    // A line it doesn't tax keeps it at none.
    expect(plan({ add: [{ itemId: '502', quantity: 1, price: 10 }] }, untaxed).fixed).toMatchObject({ taxCents: 0, totalCents: 62000 });
    expect(plan({ lines: [{ line: 1, quantity: 3 }] }, untaxed).fixed).toMatchObject({ taxCents: 0, totalCents: 73550 });
  });

  it("refuses an item that isn't in the parts list or can't be billed, and a quantity or price NetSuite wouldn't take", () => {
    const one = (n: Partial<{ itemId: string; quantity: number; price: number; description: string }>) =>
      plan({ add: [{ itemId: '501', quantity: 1, price: 10, ...n }] }).problems;
    expect(one({ itemId: '599' })).toEqual(["New line 1: that item isn't in the parts list. Take the line off and pick the item again."]);
    expect(one({ itemId: '505' })).toEqual(["SUB is a Subtotal item and can't be billed."]);
    expect(one({ quantity: 0 })).toEqual(['BRK-100: enter a quantity above 0.']);
    expect(one({ quantity: NaN })).toEqual(['BRK-100: enter a quantity above 0.']);
    expect(one({ quantity: 1_000_001 })).toEqual(['BRK-100: the quantity can be 1,000,000 at most.']);
    expect(one({ quantity: 1.23456 })).toEqual(['BRK-100: the quantity takes 4 places at most.']);
    expect(one({ quantity: 1_000_000 })).toEqual([]);
    expect(one({ price: 10_000_000 })).toEqual([]);
    expect(one({ price: 0 })).toEqual(['BRK-100: enter a price above $0.']);
    expect(one({ price: 10_000_000.01 })).toEqual(['BRK-100: the price can be $10,000,000 at most.']);
    expect(one({ price: 1.23456 })).toEqual(['BRK-100: the price takes 4 places at most.']);
    expect(one({ description: 'D'.repeat(4001) })).toEqual(['BRK-100: the description takes 4,000 characters at most.']);
    expect(one({ description: '   ' })).toEqual([]);
    // A description left empty is the item's.
    expect((plan({ add: [{ itemId: '501', quantity: 1, price: 10, description: '   ' }] }).body.item as { items: Array<{ description: string }> })
      .items[0].description).toBe('Bracket kit');
    const discount = (price: number) => plan({ add: [{ itemId: '503', quantity: 0, price }] }).problems;
    expect(discount(0)).toEqual(['DISCOUNT: enter how much the discount takes off.']);
    expect(discount(5.005)).toEqual(['DISCOUNT: the amount goes to the cent.']);
    expect(discount(5.01)).toEqual([]);
    const many = Array.from({ length: MAX_ADDED + 1 }, () => ({ itemId: '501', quantity: 1, price: 1 }));
    expect(plan({ add: many }).problems).toEqual(['One fix adds 50 lines at most.']);
    expect(plan({ add: many.slice(1) }).problems).toEqual([]);
  });
});

describe('invoiceFacts', () => {
  it('changes when anything a fix is planned against changes in NetSuite', () => {
    const facts0 = invoiceFacts(INV);
    expect(invoiceFacts(parse())).toBe(facts0);
    for (const over of [
      { lastModifiedDate: '2026-12-02T09:00:00Z' }, { tranDate: '2026-12-02' }, { dueDate: '2027-01-01' }, { otherRefNum: 'PO-78' },
      { memo: 'x' }, { custbody_vin_number_: '1FTFW1E50NFA00002' }, { status: { id: 'B', refName: 'Paid In Full' } },
      { subtotal: 611 }, { taxTotal: 27.59 }, { total: 637.59 }, { amountRemaining: 100 },
    ]) {
      expect(invoiceFacts(parse(over))).not.toBe(facts0);
    }
    const items = RECORD.item.items;
    for (const change of [{ quantity: 3 }, { rate: 126 }, { amount: 252 }, { description: 'Shelf' }, { isTaxable: false }, { item: { id: '54' } }]) {
      expect(invoiceFacts(parse({ item: { items: [{ ...items[0], ...change }, ...items.slice(1)] } }))).not.toBe(facts0);
    }
    expect(invoiceFacts(parse({ item: { items: items.slice(1) } }))).not.toBe(facts0);
  });
});

describe('ownCopyLines', () => {
  it("gives Books' own copy the lines that charge something, as fixed", () => {
    const p = plan({ lines: [{ line: 1, quantity: 3 }, { line: 2, remove: true }], add: [{ itemId: '503', quantity: 1, price: 5 }] });
    expect(ownCopyLines(p.fixed)).toEqual([
      { itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 3, rate: 125.5, cents: 37650, orderLine: 1 },
      { itemId: '58', itemNumber: 'DISCOUNT', description: null, quantity: null, rate: null, cents: -2600, orderLine: 4 },
      { itemId: '57', itemNumber: 'LIGHT-2', description: null, quantity: 1, rate: 100, cents: 10000, orderLine: 5 },
      { itemId: '503', itemNumber: 'DISCOUNT', description: 'Discount', quantity: null, rate: null, cents: -500, orderLine: null },
    ]);
    // A line of no item, which a fix can only take off, as it is.
    const kept = parse({ item: { items: [RECORD.item.items[0], { line: 2, itemType: 'NonInvtPart', quantity: 1, rate: 10, amount: 10 }] } });
    expect(ownCopyLines(plan({ lines: [{ line: 1, quantity: 3 }] }, kept).fixed)[1])
      .toEqual({ itemId: null, itemNumber: null, description: null, quantity: 1, rate: null, cents: 1000, orderLine: null });
  });
});

describe('the words', () => {
  it('writes days, quantities and prices as the screen shows them', () => {
    expect(dayText('2027-01-15')).toBe('Jan 15, 2027');
    expect(dayText(null)).toBe('(none)');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-02-27', 2)).toBe('2027-03-01');
    expect(addDays('2026-12-05', 0)).toBe('2026-12-05');
    expect(quantityText(2.50001)).toBe('2.5');
    expect(quantityText(3)).toBe('3');
    expect(priceText(95)).toBe('$95.00');
    expect(priceText(1250.5)).toBe('$1,250.50');
    expect(priceText(0.125)).toBe('$0.125');
  });

  it("reads a term's days as NetSuite's lists copy keeps them, and none it can't tell", () => {
    expect(termDays({ days_until_net_due: 30 })).toBe(30);
    expect(termDays({ days_until_net_due: '45' })).toBe(45);
    expect(termDays({ days_until_net_due: 0 })).toBe(0);
    // A term due on a day of the month gives no days; nor does one that's blank, partial, below nothing or not a number.
    for (const v of [undefined, null, '', ' ', 30.5, -5, '-5', 'soon', true]) expect(termDays({ days_until_net_due: v })).toBeNull();
    expect(termDays({})).toBeNull();
    expect(termDays(null)).toBeNull();
    expect(termDays(undefined)).toBeNull();
  });
});
