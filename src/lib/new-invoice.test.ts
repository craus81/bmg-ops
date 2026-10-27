import { describe, it, expect } from 'vitest';
import { booksLines, netsuiteLines, workOutNewInvoice, type NewInvoiceLineDraft } from './new-invoice';

const line = (p: Partial<NewInvoiceLineDraft>): NewInvoiceLineDraft => ({
  itemId: '1', itemNumber: 'AR-2000', itemType: 'InvtPart', taxableOverride: null, description: 'Rack', quantity: 1, price: 100, ...p,
});
const RATE = 0.0795;

describe('workOutNewInvoice', () => {
  it('taxes parts, not service items, at the Settings rate', () => {
    const w = workOutNewInvoice([
      line({ quantity: 2, price: 150 }),
      line({ itemId: '2', itemNumber: 'LABOR', itemType: 'Service', quantity: 3, price: 125 }),
    ], { taxRate: RATE, taxExempt: false, hasCustomer: true });
    expect(w.problems).toEqual([]);
    expect(w.subtotalCents).toBe(30000 + 37500);
    expect(w.taxCents).toBe(2385); // 300.00 × 7.95%
    expect(w.totalCents).toBe(67500 + 2385);
    expect(w.lines.map(l => l.taxable)).toEqual([true, false]);
  });

  it('honors an admin tax override on the part', () => {
    const w = workOutNewInvoice([line({ taxableOverride: false })], { taxRate: RATE, taxExempt: false, hasCustomer: true });
    expect(w.taxCents).toBe(0);
  });

  it('takes a discount off and taxes it like the line above', () => {
    const w = workOutNewInvoice([
      line({ price: 200 }),
      line({ itemId: '9', itemNumber: 'DISCOUNT', itemType: 'Discount', quantity: 0, price: 20 }),
    ], { taxRate: RATE, taxExempt: false, hasCustomer: true });
    expect(w.problems).toEqual([]);
    expect(w.lines[1].cents).toBe(-2000);
    expect(w.lines[1].taxable).toBe(true);
    expect(w.subtotalCents).toBe(18000);
    expect(w.taxCents).toBe(1590 - 159);
  });

  it('charges no tax to a tax-exempt customer', () => {
    const w = workOutNewInvoice([line({})], { taxRate: RATE, taxExempt: true, hasCustomer: true });
    expect(w.taxCents).toBe(0);
    expect(netsuiteLines(w.lines, { taxExempt: true })[0].taxable).toBe(false);
  });

  it('says what stops the invoice', () => {
    const w = workOutNewInvoice([
      line({ itemNumber: 'DISC', itemType: 'Discount', price: 0 }),
      line({ itemNumber: 'X', quantity: 0 }),
      line({ itemNumber: 'Y', price: 0 }),
      line({ itemNumber: 'S', itemType: 'Subtotal' }),
    ], { taxRate: RATE, taxExempt: false, hasCustomer: false });
    expect(w.problems).toEqual(expect.arrayContaining([
      'Pick the customer.',
      'DISC: enter how much the discount takes off.',
      'DISC: a discount goes under the line it takes money off.',
      'X: enter a quantity above 0.',
      'Y: enter a price above $0.',
      "S is a Subtotal item and can't be billed.",
    ]));
    expect(workOutNewInvoice([], { taxRate: RATE, taxExempt: false, hasCustomer: true }).problems).toEqual(['Add at least one line.']);
  });

  it('refuses a total of $0 or less', () => {
    const w = workOutNewInvoice([
      line({ price: 10 }),
      line({ itemId: '9', itemNumber: 'DISCOUNT', itemType: 'Discount', price: 15 }),
    ], { taxRate: RATE, taxExempt: false, hasCustomer: true });
    expect(w.problems).toContain('The invoice total has to be more than $0.');
  });
});

describe('netsuiteLines / booksLines', () => {
  const w = workOutNewInvoice([
    line({ quantity: 2, price: 50, description: '  Rack  ' }),
    line({ itemId: '2', itemNumber: 'LABOR', itemType: 'Service', quantity: 1, price: 125 }),
    line({ itemId: '9', itemNumber: 'DISCOUNT', itemType: 'Discount', price: 10, description: '' }),
  ], { taxRate: RATE, taxExempt: false, hasCustomer: true });

  it('sends tax flags the way the estimate push does and a discount as a negative rate', () => {
    expect(netsuiteLines(w.lines, { taxExempt: false })).toEqual([
      { itemId: '1', quantity: 2, rate: 50, description: 'Rack', partNumber: 'AR-2000', taxable: undefined },
      { itemId: '2', quantity: 1, rate: 125, description: 'Rack', partNumber: 'LABOR', taxable: false },
      { itemId: '9', quantity: 1, rate: -10, description: undefined, partNumber: 'DISCOUNT', taxable: false, discountItem: true },
    ]);
  });

  it('gives Books the discount as cents', () => {
    expect(booksLines(w.lines)[2]).toEqual({ itemId: '9', itemNumber: 'DISCOUNT', description: null, quantity: null, rate: null, cents: -1000 });
    expect(booksLines(w.lines)[0]).toMatchObject({ quantity: 2, rate: 50, description: 'Rack' });
  });
});
