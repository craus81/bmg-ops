import { describe, it, expect } from 'vitest';
import { parseSalesOrderRecord, planSalesOrderEdit, lineAllows, type SalesOrderView } from './sales-order-edit';

const record = {
  id: '9001',
  tranId: 'SO2418',
  entity: { id: '77', refName: "C-1042 Lunk's Heating & Cooling" },
  tranDate: '2026-10-14',
  status: { id: 'D', refName: 'Partially Fulfilled' },
  otherRefNum: '4471-B',
  memo: 'Shelving + ladder rack',
  custbody_vin_number_: '1FTBR2CM8KKA40217',
  shipDate: '2026-10-24',
  subtotal: 4000,
  taxTotal: 0,
  total: 4000,
  lastModifiedDate: '2026-10-20T14:00:00Z',
  item: {
    items: [
      // fully billed
      { line: 1, item: { id: '501', refName: 'Masterack : MR-SH-4836' }, itemType: { id: 'InvtPart' }, quantity: 2, quantityFulfilled: 2, quantityBilled: 2, rate: 689, amount: 1378, description: 'Shelf' },
      // untouched
      { line: 2, item: { id: '502', refName: 'MR-LR-TR250' }, itemType: 'InvtPart', quantity: 1, quantityFulfilled: 0, quantityBilled: 0, rate: 1245, amount: 1245 },
      // partly shipped, not billed
      { line: 3, item: { id: '503', refName: 'MR-DROP-2' }, itemType: 'InvtPart', quantity: 2, quantityFulfilled: 1, quantityBilled: 0, rate: 96.5, amount: 193 },
      // partly billed
      { line: 4, item: { id: '504', refName: 'LAB-INSTALL' }, itemType: 'Service', quantity: 5, quantityFulfilled: 0, quantityBilled: 3, rate: 125, amount: 625 },
      // discount
      { line: 5, item: { id: '900', refName: 'DISCOUNT' }, itemType: 'Discount', rate: -50, amount: -50 },
      // closed
      { line: 6, item: { id: '505', refName: 'MR-CLAMP' }, itemType: 'InvtPart', quantity: 4, quantityFulfilled: 0, quantityBilled: 0, rate: 10, amount: 40, isClosed: true },
    ],
  },
};

const view: SalesOrderView = parseSalesOrderRecord(record);
const line = (n: number) => view.lines.find(l => l.line === n)!;

describe('parseSalesOrderRecord', () => {
  it('reads the header', () => {
    expect(view.header).toMatchObject({
      id: '9001', tranId: 'SO2418', customerId: '77', status: 'Partially Fulfilled',
      poNumber: '4471-B', vin: '1FTBR2CM8KKA40217', shipDate: '2026-10-24', total: 4000,
      lastModified: '2026-10-20T14:00:00Z',
    });
  });
  it('reads lines with shipped, billed and the short item number', () => {
    expect(line(1)).toMatchObject({ itemNumber: 'MR-SH-4836', quantity: 2, quantityShipped: 2, quantityBilled: 2, editable: true });
    expect(line(3)).toMatchObject({ quantityShipped: 1, quantityBilled: 0 });
    expect(line(5).editable).toBe(false);
    expect(line(6).isClosed).toBe(true);
  });
});

describe('lineAllows', () => {
  it('locks a fully billed line and a discount', () => {
    expect(lineAllows(line(1))).toEqual({ quantity: false, price: false, close: false, reopen: false, remove: false });
    expect(lineAllows(line(5)).quantity).toBe(false);
  });
  it('allows everything on an untouched line', () => {
    expect(lineAllows(line(2))).toEqual({ quantity: true, price: true, close: true, reopen: false, remove: true });
  });
  it('a shipped line can close but not be removed; a billed one keeps its price', () => {
    expect(lineAllows(line(3))).toMatchObject({ quantity: true, price: true, close: true, remove: false });
    expect(lineAllows(line(4))).toMatchObject({ quantity: true, price: false, remove: false });
  });
  it('a closed line can only be reopened', () => {
    expect(lineAllows(line(6))).toEqual({ quantity: false, price: false, close: false, reopen: true, remove: false });
  });
});

describe('planSalesOrderEdit', () => {
  it('patches only what changed, by line key, without replace', () => {
    const plan = planSalesOrderEdit(view, {
      header: { poNumber: '4471-C', memo: 'Shelving + ladder rack', vin: '1ftbr2cm8kka40217' },
      lines: [{ line: 2, quantity: 2, rate: 1199 }, { line: 3, quantity: 2 }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.replace).toBe(false);
    expect(plan.body).toEqual({
      otherRefNum: '4471-C',
      item: { items: [{ line: 2, quantity: 2, price: { id: '-1' }, rate: 1199 }] },
    });
    expect(plan.changes).toEqual(['Customer PO # 4471-B → 4471-C', 'MR-LR-TR250 qty 1 → 2', 'MR-LR-TR250 price $1245.00 → $1199.00']);
  });

  it('refuses a quantity below what shipped or billed', () => {
    const plan = planSalesOrderEdit(view, { lines: [{ line: 3, quantity: 0.5 }, { line: 4, quantity: 2 }] });
    expect(plan).toEqual({ ok: false, errors: [
      'MR-DROP-2: 1 already shipped, so the quantity can\'t go below 1.',
      'LAB-INSTALL: 3 already billed, so the quantity can\'t go below 3.',
    ] });
  });

  it('refuses edits to a fully billed line and price on a partly billed one', () => {
    const plan = planSalesOrderEdit(view, { lines: [{ line: 1, quantity: 3 }, { line: 4, rate: 130 }] });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toEqual([
      'MR-SH-4836 is fully billed, so its quantity is locked.',
      'LAB-INSTALL is partly billed, so its price is locked.',
    ]);
  });

  it('closes the rest of a partly shipped line', () => {
    const plan = planSalesOrderEdit(view, { lines: [{ line: 3, close: true }] });
    expect(plan).toEqual({
      ok: true, replace: false,
      body: { item: { items: [{ line: 3, isClosed: true }] } },
      changes: ['Closed MR-DROP-2 (1 not shipped)'],
    });
  });

  it('reopens a closed line and changes its quantity in one save', () => {
    const plan = planSalesOrderEdit(view, { lines: [{ line: 6, reopen: true, quantity: 2 }] });
    expect(plan.ok && plan.body).toEqual({ item: { items: [{ line: 6, isClosed: false, quantity: 2 }] } });
  });

  it('removing a line replaces the sublist with every kept line by key', () => {
    const plan = planSalesOrderEdit(view, {
      lines: [{ line: 2, remove: true }, { line: 3, quantity: 3 }],
      add: [{ itemId: '777', itemNumber: 'MR-LR-TR350', quantity: 1, rate: 1300, description: 'Ladder rack 350' }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.replace).toBe(true);
    expect(plan.body.item).toEqual({ items: [
      { line: 1 }, { line: 3, quantity: 3 }, { line: 4 }, { line: 5 }, { line: 6 },
      { item: { id: '777' }, quantity: 1, price: { id: '-1' }, rate: 1300, description: 'Ladder rack 350' },
    ] });
  });

  it('refuses removing a shipped line', () => {
    const plan = planSalesOrderEdit(view, { lines: [{ line: 3, remove: true }] });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors[0]).toMatch(/can't be removed. Close the rest of it instead/);
  });

  it('checks the VIN and says when nothing changed', () => {
    expect(planSalesOrderEdit(view, { header: { vin: 'ABC' } })).toEqual({ ok: false, errors: ['VIN must be 17 letters and numbers (no I, O or Q).'] });
    expect(planSalesOrderEdit(view, { header: { poNumber: '4471-B ' } })).toEqual({ ok: false, errors: ['Nothing changed.'] });
  });

  it('refuses a line that is gone', () => {
    const plan = planSalesOrderEdit(view, { lines: [{ line: 42, quantity: 1 }] });
    expect(plan).toEqual({ ok: false, errors: ["Line 42 isn't on this order any more. Reload and try again."] });
  });
});
