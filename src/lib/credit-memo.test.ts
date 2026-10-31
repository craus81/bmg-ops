import { describe, it, expect } from 'vitest';
import {
  CREDIT_TAX_RULE, NO_EARLIER, boxText, creditAllOf, earlierCredits, keptCreditLines, leftToCredit, lineTax,
  netsuiteCreditLines, parseInvoiceRecord, workOutCreditMemo, type CreditLineDraft, type InvoiceView,
} from './credit-memo';

// A made-up NetSuite invoice as GET invoice/{id}?expandSubResources=true answers it: a stock part, labor, a
// subtotal, a discount on the part, another stock part, and a $0 note line.
const RECORD = {
  id: '7001', tranId: 'INV9001', tranDate: '2026-10-20', entity: { id: '9001', refName: 'Acme Fleet Services' },
  location: { id: '1', refName: "O'Fallon" }, otherRefNum: 'PO-77', memo: 'Invoice from BMG FleetSuite',
  subtotal: 610, taxTotal: 27.58, total: 637.58, amountRemaining: 637.58, taxRate: 8.488, taxItem: { id: '77' },
  status: { id: 'A', refName: 'Open' },
  item: {
    items: [
      { line: 1, item: { id: '55', refName: 'Racks : SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, description: 'Shelf unit', isTaxable: true },
      { line: 2, item: { id: '56', refName: 'LABOR' }, itemType: 'Service', quantity: 3, rate: 95, amount: 285, description: 'Install', isTaxable: false },
      { line: 3, item: { id: '60', refName: 'Subtotal' }, itemType: 'Subtotal', amount: 536 },
      { line: 4, item: { id: '58', refName: 'DISCOUNT' }, itemType: 'Discount', rate: -26, amount: -26, isTaxable: true },
      { line: 5, item: { id: '57', refName: 'LIGHT-2' }, itemType: 'InvtPart', quantity: 1, rate: 100, amount: 100, isTaxable: true },
      { line: 6, item: { id: '59', refName: 'NOTE' }, itemType: 'NonInvtPart', quantity: 1, rate: 0, amount: 0 },
    ],
  },
};

const invoice = (over: Record<string, unknown> = {}, opts: { taxCodeRate?: number | null } = {}): InvoiceView =>
  parseInvoiceRecord({ ...RECORD, ...over }, opts);

const CREDIT_ITEM = { id: '900', itemNumber: 'CREDIT' };
const OPTS: Parameters<typeof workOutCreditMemo>[3] = { earlier: NO_EARLIER, creditItem: CREDIT_ITEM, reason: 'Returned' };

const all = (inv: InvoiceView): CreditLineDraft[] => inv.lines.map((l) => creditAllOf(l, NO_EARLIER)!).filter(Boolean);

describe('parseInvoiceRecord', () => {
  it('reads the invoice as NetSuite has it, leaving out layout lines and $0 lines', () => {
    const inv = invoice();
    expect(inv).toMatchObject({
      id: '7001', number: 'INV9001', date: '2026-10-20', customerId: '9001', customerName: 'Acme Fleet Services',
      locationId: '1', locationName: "O'Fallon", poNumber: 'PO-77', status: 'Open', voided: false,
      subtotalCents: 61000, taxCents: 2758, totalCents: 63758, owedCents: 63758,
      taxRate: 0.08488, taxRateFrom: 'invoice', taxItemId: '77',
    });
    expect(inv.lines.map((l) => [l.line, l.itemNumber, l.kind, l.rateOnly, l.quantity, l.rate, l.cents, l.taxable, l.stock])).toEqual([
      [1, 'SHELF-1', 'quantity', false, 2, 125.5, 25100, true, true],
      [2, 'LABOR', 'quantity', false, 3, 95, 28500, false, false],
      [4, 'DISCOUNT', 'amount', true, 0, null, -2600, true, false],
      [5, 'LIGHT-2', 'quantity', false, 1, 100, 10000, true, true],
    ]);
  });

  it('credits a line that took money off by its amount, as a discount is', () => {
    const inv = invoice({
      item: { items: [{ line: 1, item: { id: '61', refName: 'TRADE-IN' }, itemType: 'NonInvtPart', quantity: 1, rate: -500, amount: -500 }] },
    });
    expect(inv.lines[0]).toMatchObject({ kind: 'amount', rateOnly: false, quantity: 0, rate: null, cents: -50000 });
  });

  it("taxes nothing on an invoice that charged no tax, whatever NetSuite's boxes say", () => {
    const inv = invoice({ taxTotal: 0, total: 610, taxRate: 8.488 });
    expect(inv.lines.every((l) => !l.taxable)).toBe(true);
    expect(inv).toMatchObject({ taxRate: 0, taxRateFrom: 'untaxed' });
  });

  it("falls back on FleetSuite's rule for a line NetSuite doesn't say about", () => {
    const inv = invoice({
      item: { items: [
        { line: 1, item: { id: '55' }, itemType: 'InvtPart', quantity: 1, rate: 10, amount: 10 },
        { line: 2, item: { id: '56' }, itemType: 'Service', quantity: 1, rate: 10, amount: 10 },
        { line: 3, item: { id: '57' }, itemType: 'InvtPart', quantity: 1, rate: 10, amount: 10, isTaxable: 'F' },
      ] },
    });
    expect(inv.lines.map((l) => l.taxable)).toEqual([true, false, false]);
  });

  it("takes the rate from the invoice, then its tax code, then what its tax comes to", () => {
    expect(invoice({ taxRate: null }, { taxCodeRate: 0.0795 })).toMatchObject({ taxRate: 0.0795, taxRateFrom: 'tax_code' });
    // 27.58 of tax on 325.00 of taxed lines.
    expect(invoice({ taxRate: null })).toMatchObject({ taxRate: 0.084862, taxRateFrom: 'worked_out' });
    expect(invoice({ taxRate: 0 }, { taxCodeRate: 0.0795 }).taxRateFrom).toBe('tax_code');
    expect(invoice({ taxRate: 100 }).taxRateFrom).toBe('worked_out');
    // Tax with nothing taxed: no rate to tell.
    const untold = invoice({ taxRate: null, item: { items: [{ line: 1, item: { id: '56' }, itemType: 'Service', quantity: 1, rate: 10, amount: 10 }] } });
    expect(untold).toMatchObject({ taxRate: null, taxRateFrom: null });
  });

  it('knows a voided invoice, and an invoice with nothing owed', () => {
    expect(invoice({ status: { id: 'V', refName: 'Voided' } }).voided).toBe(true);
    expect(invoice({ amountRemaining: 0 }).owedCents).toBe(0);
    expect(invoice({ amountRemaining: undefined }).owedCents).toBeNull();
  });
});

describe('earlier credits', () => {
  it('adds up what each line was credited and how many went back on the shelf', () => {
    const e = earlierCredits([
      { invoiceLine: 1, cents: 12550, quantity: 1, backToStock: true },
      { invoiceLine: 1, cents: 5000, quantity: 1, backToStock: false },
      { invoiceLine: 4, cents: -1300, quantity: null, backToStock: false },
      { invoiceLine: null, cents: 2500, quantity: 1, backToStock: false },
    ]);
    expect([...e.cents]).toEqual([[1, 17550], [4, -1300]]);
    expect([...e.backToStock]).toEqual([[1, 1]]);
    const inv = invoice();
    expect(leftToCredit(inv.lines[0], e)).toBe(25100 - 17550);
    expect(leftToCredit(inv.lines[2], e)).toBe(-1300);
  });
});

describe('boxText', () => {
  it('starts a box at the number, never above it', () => {
    expect(boxText(45, 'money')).toBe('45.00');
    expect(boxText(125.5, 'money')).toBe('125.50');
    expect(boxText(12.3456, 'money')).toBe('12.3456');
    expect(boxText(0.1234567, 'money')).toBe('0.123456');
    expect(boxText(1.005, 'money')).toBe('1.005');
    expect(boxText(2, 'quantity')).toBe('2');
    expect(boxText(1.33335, 'quantity')).toBe('1.3333');
  });
});

describe('creditAllOf', () => {
  const [shelf, , discount] = invoice().lines;

  it('picks all of a line nothing has been credited on', () => {
    expect(creditAllOf(shelf, NO_EARLIER)).toEqual({ line: 1, quantity: 2, price: 125.5 });
    expect(creditAllOf(discount, NO_EARLIER)).toEqual({ line: 4, amount: 26 });
  });

  it('picks what is left of the quantity when earlier credits took whole ones', () => {
    const e = earlierCredits([{ invoiceLine: 1, cents: 12550, quantity: 1, backToStock: true }]);
    expect(creditAllOf(shelf, e)).toEqual({ line: 1, quantity: 1, price: 125.5 });
  });

  it("otherwise picks the whole quantity at the most each that doesn't come to more than what's left", () => {
    const e = earlierCredits([{ invoiceLine: 1, cents: 1001, quantity: 2, backToStock: false }]);
    // 240.99 left over 2: 120.49 each, a cent short rather than over.
    expect(creditAllOf(shelf, e)).toEqual({ line: 1, quantity: 2, price: 120.49 });
    // 1.5 hours at 80.00 with 20.00 credited before: 100.00 left, and 1.5 at 66.67 comes to just that.
    const [hours] = invoice({ item: { items: [{ line: 1, item: { id: '56' }, itemType: 'Service', quantity: 1.5, rate: 80, amount: 120 }] } }).lines;
    const fix = earlierCredits([{ invoiceLine: 1, cents: 2000, quantity: 1, backToStock: false }]);
    expect(creditAllOf(hours, fix)).toEqual({ line: 1, quantity: 1.5, price: 66.67 });
  });

  it("picks an amount NetSuite billed under its quantity times price, and nothing when it's all credited", () => {
    const [odd] = invoice({ item: { items: [{ line: 1, item: { id: '55' }, itemType: 'InvtPart', quantity: 2, rate: 50, amount: 90 }] } }).lines;
    expect(creditAllOf(odd, NO_EARLIER)).toEqual({ line: 1, quantity: 2, price: 45 });
    expect(creditAllOf(shelf, earlierCredits([{ invoiceLine: 1, cents: 25100, quantity: 2, backToStock: true }]))).toBeNull();
    expect(creditAllOf(discount, earlierCredits([{ invoiceLine: 4, cents: -2600, quantity: null, backToStock: false }]))).toBeNull();
  });
});

describe('workOutCreditMemo', () => {
  it("credits all of an invoice back to its own subtotal, tax and total", () => {
    const inv = invoice();
    const w = workOutCreditMemo(inv, all(inv), [], OPTS);
    expect(w.problems).toEqual([]);
    expect(w.subtotalCents).toBe(inv.subtotalCents);
    expect(w.taxCents).toBe(inv.taxCents);
    expect(w.totalCents).toBe(inv.totalCents);
    expect(w.lines.map((l) => [l.invoiceLine, l.itemId, l.cents, l.taxCents, l.backToStock, l.onCreditItem, l.rateOnly])).toEqual([
      [1, '55', 25100, 2130, true, false, false],
      [2, '56', 28500, 0, false, false, false],
      [4, '58', -2600, -221, false, false, true],
      [5, '57', 10000, 849, true, false, false],
    ]);
  });

  it('taxes each line at the invoice rate, rounded half to even', () => {
    expect(lineTax(1025, 0.08488)).toBe(87);
    expect(lineTax(1025, 0)).toBe(0);
  });

  it('puts a stock part with no part coming back on the credit item', () => {
    const inv = invoice();
    const w = workOutCreditMemo(inv, [{ line: 1, quantity: 1, price: 20, backToStock: false }], [], OPTS);
    expect(w.problems).toEqual([]);
    expect(w.lines[0]).toMatchObject({
      invoiceLine: 1, itemId: '900', itemNumber: 'CREDIT', description: 'SHELF-1 - Shelf unit', quantity: 1, price: 20,
      cents: 2000, taxable: true, taxCents: 170, backToStock: false, onCreditItem: true,
    });
    // Labor keeps its own item: it never comes back on a shelf.
    const labor = workOutCreditMemo(inv, [{ line: 2, quantity: 1, price: 95, backToStock: false }], [], OPTS);
    expect(labor.lines[0]).toMatchObject({ itemId: '56', backToStock: false, onCreditItem: false });
  });

  it('adds an amount of its own on the credit item, taxed only when the invoice charged tax', () => {
    const w = workOutCreditMemo(invoice(), [], [{ description: ' Goodwill ', amount: 50, taxable: true }], OPTS);
    expect(w.problems).toEqual([]);
    expect(w.lines[0]).toMatchObject({ invoiceLine: null, itemId: '900', description: 'Goodwill', quantity: 1, price: 50, cents: 5000, taxable: true, taxCents: 424 });
    const untaxed = invoice({ taxTotal: 0, total: 610 });
    expect(workOutCreditMemo(untaxed, [], [{ description: 'Goodwill', amount: 50, taxable: true }], OPTS).lines[0].taxable).toBe(false);
  });

  it('leaves off a line picked at nothing', () => {
    const w = workOutCreditMemo(invoice(), [{ line: 1, quantity: 0, price: 125.5 }, { line: 4, amount: 0 }, { line: 5, quantity: 1, price: 100 }], [], OPTS);
    expect(w.lines.map((l) => l.invoiceLine)).toEqual([5]);
  });

  it('says what stops the credit memo', () => {
    const inv = invoice();
    const problems = (drafts: CreditLineDraft[], opts: Partial<typeof OPTS> = {}, added: Parameters<typeof workOutCreditMemo>[2] = []) =>
      workOutCreditMemo(inv, drafts, added, { ...OPTS, ...opts }).problems;
    expect(problems([{ line: 5, quantity: 1, price: 100 }], { reason: '  ' })).toEqual(["Say why it's being credited."]);
    expect(problems([{ line: 9, quantity: 1, price: 1 }])).toEqual(["Line 9 isn't on invoice INV9001 any more. Reload and try again."]);
    expect(problems([{ line: 5, quantity: 1, price: 100 }, { line: 5, quantity: 1, price: 100 }])).toEqual(['LIGHT-2 was picked twice.']);
    expect(problems([{ line: 1, quantity: 3, price: 125.5 }])).toEqual([
      'SHELF-1: the invoice billed 2, so at most 2 can be credited.',
      "SHELF-1: that's more than the invoice charged for it ($251.00).",
    ]);
    expect(problems([{ line: 1, quantity: 1, price: 130 }])).toEqual(["SHELF-1: the invoice charged $125.50 each, so the price can't be more."]);
    expect(problems([{ line: 1, quantity: -1, price: 10 }])).toEqual(['SHELF-1: enter a quantity above 0.']);
    expect(problems([{ line: 1, quantity: 1, price: Number.NaN }])).toEqual(['SHELF-1: enter a price above $0.']);
    expect(problems([{ line: 4, amount: 30 }])).toEqual(["DISCOUNT: that's more than the invoice's $26.00.", 'The credit has to come to more than $0.']);
    expect(problems([{ line: 1, quantity: 1, price: 10, backToStock: false }], { creditItem: null })).toEqual([
      'SHELF-1: crediting money with no part coming back goes on the NetSuite Credit Item, and none is picked yet. A super admin picks it in Settings.',
    ]);
    expect(problems([], {}, [{ description: '', amount: 0, taxable: false }])).toEqual([
      "Added amount 1: say what it's for.",
      'Added amount 1: enter an amount above $0.',
    ]);
    expect(problems([])).toEqual(['Pick at least one line to credit.']);
    // A part and the discount on it, one against the other, come to nothing.
    expect(problems([{ line: 5, quantity: 1, price: 26 }, { line: 4, amount: 26 }])).toEqual(['The credit has to come to more than $0.']);
    expect(workOutCreditMemo(invoice({ status: { refName: 'Voided' } }), [{ line: 5, quantity: 1, price: 100 }], [], OPTS).problems)
      .toEqual(["Invoice INV9001 is voided in NetSuite, so there's nothing to credit."]);
    const untold = invoice({ taxRate: null, taxTotal: 1, item: { items: [{ line: 1, item: { id: '55' }, itemType: 'InvtPart', quantity: 1, rate: 10, amount: 10, isTaxable: true }] } });
    expect(workOutCreditMemo({ ...untold, taxRate: null }, [{ line: 1, quantity: 1, price: 10 }], [], OPTS).problems)
      .toEqual(["FleetSuite can't tell invoice INV9001's sales tax rate, so it can't work out the tax to give back."]);
  });

  it('counts earlier credit memos against what is left', () => {
    const inv = invoice();
    const earlier = earlierCredits([{ invoiceLine: 1, cents: 12550, quantity: 1, backToStock: true }]);
    const w = (d: CreditLineDraft) => workOutCreditMemo(inv, [d], [], { ...OPTS, earlier }).problems;
    expect(w({ line: 1, quantity: 1, price: 125.5 })).toEqual([]);
    expect(w({ line: 1, quantity: 2, price: 125.5 })).toEqual([
      'SHELF-1: only $125.50 of this line is left to credit.',
      'SHELF-1: 1 already went back on the shelf, so at most 1 more can.',
    ]);
    // Credited only, no part back: the shelf cap doesn't apply, the money cap does.
    expect(w({ line: 1, quantity: 2, price: 60, backToStock: false })).toEqual([]);
    const discount = earlierCredits([{ invoiceLine: 4, cents: -2000, quantity: null, backToStock: false }]);
    expect(workOutCreditMemo(inv, [{ line: 5, quantity: 1, price: 100 }, { line: 4, amount: 10 }], [], { ...OPTS, earlier: discount }).problems)
      .toEqual(['DISCOUNT: only $6.00 of it is left to credit.']);
  });
});

describe('netsuiteCreditLines', () => {
  const inv = invoice();
  const worked = workOutCreditMemo(inv, all(inv), [{ description: 'Goodwill', amount: 25, taxable: false }], OPTS);

  it("sends each line at the Custom price level, a discount as its rate alone, and an amount of its own at that amount", () => {
    expect(worked.problems).toEqual([]);
    expect(netsuiteCreditLines(worked.lines, { invoiceLocationId: '1' })).toEqual([
      { item: { id: '55' }, quantity: 2, price: { id: '-1' }, rate: 125.5, description: 'Shelf unit', isTaxable: true },
      { item: { id: '56' }, quantity: 3, price: { id: '-1' }, rate: 95, description: 'Install', isTaxable: false },
      { item: { id: '58' }, rate: -26, isTaxable: true },
      { item: { id: '57' }, quantity: 1, price: { id: '-1' }, rate: 100, isTaxable: true },
      { item: { id: '900' }, quantity: 1, price: { id: '-1' }, rate: 25, description: 'Goodwill', isTaxable: false },
    ]);
  });

  it("books a part coming back to O'Fallon when the invoice is from somewhere else", () => {
    const lines = netsuiteCreditLines(worked.lines, { invoiceLocationId: '2' });
    expect(lines.map((l) => ('location' in l ? l.location : null))).toEqual([{ id: '1' }, null, null, { id: '1' }, null]);
  });

  it('sends a line that took money off at its amount, quantity one', () => {
    const trade = invoice({ item: { items: [
      { line: 1, item: { id: '55' }, itemType: 'InvtPart', quantity: 1, rate: 900, amount: 900, isTaxable: true },
      { line: 2, item: { id: '61' }, itemType: 'NonInvtPart', quantity: 1, rate: -500, amount: -500, isTaxable: false },
    ] } });
    const w = workOutCreditMemo(trade, [{ line: 1, quantity: 1, price: 900 }, { line: 2, amount: 500 }], [], OPTS);
    expect(w.problems).toEqual([]);
    expect(netsuiteCreditLines(w.lines, { invoiceLocationId: '1' })[1]).toEqual({ item: { id: '61' }, quantity: 1, price: { id: '-1' }, rate: -500, isTaxable: false });
  });
});

describe('keptCreditLines', () => {
  it('keeps what each line credited, for the caps and the books', () => {
    const inv = invoice();
    const w = workOutCreditMemo(inv, [{ line: 1, quantity: 1, price: 125.5 }], [], OPTS);
    expect(keptCreditLines(w.lines)).toEqual([{
      invoiceLine: 1, itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 1, price: 125.5,
      cents: 12550, taxable: true, taxCents: 1065, backToStock: true, onCreditItem: false,
    }]);
    expect(CREDIT_TAX_RULE).toBe('credit_tax@1');
  });
});
