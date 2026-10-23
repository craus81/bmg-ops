import { describe, it, expect } from 'vitest';
import { defaultBillNow, openOn, planFulfillInvoice, type SoBillingLine } from './so-fulfill-invoice';
import { shippedLines } from './books/own-fulfillments';

const line = (over: Partial<SoBillingLine>): SoBillingLine => ({
  lineSeq: 1, lineId: '101', itemId: '9001', itemNumber: 'RACK-1', description: '', itemType: 'InvtPart',
  ordered: 2, fulfilled: 0, billed: 0, rate: 100, amount: 200, onHand: 5, closed: false,
  ...over,
});

const order = (): SoBillingLine[] => [
  line({ lineSeq: 1, lineId: '101', itemNumber: 'RACK-1', ordered: 2, onHand: 5 }),
  line({ lineSeq: 2, lineId: '102', itemId: '9002', itemNumber: 'DRAWER-1', ordered: 4, onHand: 1 }),
  line({ lineSeq: 3, lineId: '103', itemId: '9003', itemNumber: 'FREIGHT', itemType: 'OthCharge', ordered: 1, onHand: null }),
];

describe('openOn / defaultBillNow', () => {
  it('starts a stock line at what is on hand, capped at what is open', () => {
    const [rack, drawer, freight] = order();
    expect(defaultBillNow(rack)).toBe(2);
    expect(defaultBillNow(drawer)).toBe(1);
    expect(defaultBillNow(freight)).toBe(1);
  });

  it('counts units shipped but not billed as billable without shipping', () => {
    const l = line({ ordered: 4, fulfilled: 3, billed: 1, onHand: 0 });
    expect(openOn(l)).toEqual({ toBill: 3, toShip: 1, shippedNotBilled: 2, vendorWaiting: 0 });
    expect(defaultBillNow(l)).toBe(2);
  });

  it('has nothing open on a closed line', () => {
    expect(openOn(line({ closed: true }))).toEqual({ toBill: 0, toShip: 0, shippedNotBilled: 0, vendorWaiting: 0 });
  });
});

describe('planFulfillInvoice', () => {
  it('ships and bills part of the order, leaving the rest open', () => {
    const plan = planFulfillInvoice(order(), { 1: 2, 2: 1, 3: 1 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.wholeRest).toBe(false);
    expect(plan.shipLines).toEqual([{ orderLine: 1, quantity: 2 }, { orderLine: 2, quantity: 1 }]);
    expect(plan.excludeOrderLines).toEqual([]);
    expect(plan.billLines).toEqual({ 1: 2, 2: 1, 3: 1 });
    expect(plan.units).toBe(4);
    expect(plan.shipped).toEqual([{ salesOrderLineId: '101', quantity: 2 }, { salesOrderLineId: '102', quantity: 1 }]);
  });

  it('sends untouched stock lines as not shipped', () => {
    const plan = planFulfillInvoice(order(), { 1: 1, 2: 0 });
    expect(plan.ok && plan.excludeOrderLines).toEqual([2]);
  });

  it('bills the whole rest off the order whole', () => {
    const plan = planFulfillInvoice(order(), { 1: 2, 2: 4, 3: 1 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.wholeRest).toBe(true);
    expect(plan.billLines).toEqual({});
    expect(plan.shipLines).toEqual([{ orderLine: 1, quantity: 2 }, { orderLine: 2, quantity: 4 }]);
  });

  it('does not ship units already shipped', () => {
    const lines = [line({ ordered: 4, fulfilled: 3, billed: 1 })];
    const plan = planFulfillInvoice(lines, { 1: 3 });
    expect(plan.ok && plan.shipLines).toEqual([{ orderLine: 1, quantity: 1 }]);
  });

  it('refuses more than is open', () => {
    const plan = planFulfillInvoice(order(), { 2: 5 });
    expect(plan).toEqual({ ok: false, error: 'DRAWER-1: billing 5 but only 4 is still open' });
  });

  it('refuses a line not on the order, and an all-zero request', () => {
    expect(planFulfillInvoice(order(), { 9: 1 }).ok).toBe(false);
    expect(planFulfillInvoice(order(), { 1: 0 })).toEqual({ ok: false, error: 'Nothing to invoice: every quantity is 0' });
  });

  it('only bills an order with a discount line all at once', () => {
    const lines = [...order(), line({ lineSeq: 4, lineId: '104', itemNumber: 'DISCOUNT', itemType: 'Discount', ordered: 0, onHand: null })];
    const partial = planFulfillInvoice(lines, { 1: 2 });
    expect(partial.ok).toBe(false);
    const whole = planFulfillInvoice(lines, { 1: 2, 2: 4, 3: 1 });
    expect(whole.ok && whole.wholeRest).toBe(true);
    expect(planFulfillInvoice(lines, { 4: 1 }).ok).toBe(false);
  });
});

describe('shippedLines', () => {
  it('cuts the open stock lines down to what shipped', () => {
    const open = [
      { itemId: '9001', itemNumber: 'RACK-1', description: null, itemType: 'InvtPart' as const, quantity: 2, salesOrderLineId: '101' },
      { itemId: '9002', itemNumber: 'DRAWER-1', description: null, itemType: 'InvtPart' as const, quantity: 4, salesOrderLineId: '102' },
    ];
    expect(shippedLines(open, [{ salesOrderLineId: '102', quantity: 1 }])).toEqual([{ ...open[1], quantity: 1 }]);
  });
});

describe('drop ship lines', () => {
  const ds = (over: Partial<SoBillingLine>) => line({ lineSeq: 2, lineId: '102', itemId: '9002', itemNumber: 'N5-RS60-4', ordered: 1, onHand: 7, dropShipPo: 'PO460-HOSEMATE', ...over });

  it('bills only what the vendor has shipped, never ships from stock', () => {
    expect(openOn(ds({}))).toEqual({ toBill: 0, toShip: 0, shippedNotBilled: 0, vendorWaiting: 1 });
    expect(defaultBillNow(ds({}))).toBe(0);
    expect(openOn(ds({ fulfilled: 1 }))).toEqual({ toBill: 1, toShip: 0, shippedNotBilled: 1, vendorWaiting: 0 });
    expect(defaultBillNow(ds({ fulfilled: 1 }))).toBe(1);
  });

  it('refuses to bill a drop ship line before the vendor ships it', () => {
    const plan = planFulfillInvoice([line({}), ds({})], { 1: 2, 2: 1 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toMatch(/drop shipped by the vendor on PO PO460-HOSEMATE/);
  });

  it('ships the other lines and keeps the waiting drop ship line off the fulfillment', () => {
    const plan = planFulfillInvoice([line({}), ds({})], { 1: 2 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.shipLines).toEqual([{ orderLine: 1, quantity: 2 }]);
    expect(plan.excludeOrderLines).toEqual([2]);
    expect(plan.wholeRest).toBe(false);
    expect(plan.billLines).toEqual({ 1: 2 });
  });

  it('bills a vendor-shipped line without shipping it again', () => {
    const plan = planFulfillInvoice([line({ fulfilled: 2, billed: 2 }), ds({ fulfilled: 1 })], { 2: 1 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.shipLines).toEqual([]);
    expect(plan.wholeRest).toBe(true);
  });
});
