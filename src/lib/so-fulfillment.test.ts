import { describe, it, expect } from 'vitest';
import { decideFulfillment, describeFulfillmentError, isShipStatusRejection } from './so-fulfillment';

const inputs = (soStatus: string, existingFulfillments = 0, shippedFulfillments = existingFulfillments, soStatusLabel?: string) =>
  ({ soStatus, existingFulfillments, shippedFulfillments, soStatusLabel });

describe('decideFulfillment', () => {
  it('fulfills an order waiting to ship', () => {
    expect(decideFulfillment(inputs('B'))).toEqual({ action: 'fulfill' });
  });

  it('fulfills the remainder of a partially fulfilled order with no fulfillment records', () => {
    expect(decideFulfillment(inputs('D'))).toEqual({ action: 'fulfill' });
    expect(decideFulfillment(inputs('E'))).toEqual({ action: 'fulfill' });
  });

  // The whole point of the guard: relieving inventory twice is a real
  // accounting error, so an existing fulfillment beats every status.
  it('never fulfills twice, whatever the status says', () => {
    for (const status of ['B', 'D', 'E', 'F']) {
      expect(decideFulfillment(inputs(status, 1)).action).toBe('skip');
    }
    expect(decideFulfillment(inputs('B', 2)).action).toBe('skip');
  });

  it('blocks — rather than fulfilling again — when the existing fulfillment is not shipped', () => {
    // Picked/Packed relieves nothing, so the parts still are not billable;
    // creating a second fulfillment would double-relieve the stock.
    const d = decideFulfillment(inputs('D', 1, 0));
    expect(d.action).toBe('block');
    expect(d.action === 'block' && d.error).toMatch(/Shipped/);
  });

  it('invoices straight through when nothing is left to fulfill', () => {
    const d = decideFulfillment(inputs('F'));
    expect(d.action).toBe('skip');
  });

  it('blocks an unapproved, cancelled, billed or closed order', () => {
    expect(decideFulfillment(inputs('A')).action).toBe('block');
    expect(decideFulfillment(inputs('C')).action).toBe('block');
    expect(decideFulfillment(inputs('G')).action).toBe('block');
    expect(decideFulfillment(inputs('H')).action).toBe('block');
  });

  it('blocks — never guesses — on an unrecognized status', () => {
    const d = decideFulfillment(inputs('Z', 0, 0, 'Something New'));
    expect(d.action).toBe('block');
    expect(d.action === 'block' && d.error).toContain('Something New');
  });
});

describe('describeFulfillmentError', () => {
  it('names the missing role permission', () => {
    expect(describeFulfillmentError('Permission Violation: You need the Fulfill Sales Orders permission'))
      .toMatch(/Fulfill Sales Orders/);
  });

  it('explains a stock shortfall', () => {
    expect(describeFulfillmentError('Insufficient quantity on hand for item 06CS901033'))
      .toMatch(/not enough on hand/);
  });

  it('explains a concurrent edit', () => {
    expect(describeFulfillmentError('RCRD_HAS_BEEN_CHANGED')).toMatch(/changed in NetSuite/);
  });

  it('falls back rather than inventing a cause', () => {
    expect(describeFulfillmentError('Some unmapped NetSuite text')).toBe('NetSuite refused the item fulfillment.');
  });
});

describe('isShipStatusRejection', () => {
  it('spots the field-shape rejection the string retry is for', () => {
    expect(isShipStatusRejection('Invalid value for field shipStatus')).toBe(true);
    expect(isShipStatusRejection('Error: shipstatus is not a valid enum')).toBe(true);
  });

  it('does not treat a real refusal as a shape problem', () => {
    expect(isShipStatusRejection('Permission Violation')).toBe(false);
    expect(isShipStatusRejection('Insufficient quantity on hand')).toBe(false);
    // Mentions the field, but nothing about its shape — retrying the other
    // form would not help.
    expect(isShipStatusRejection('shipStatus cannot be set once billed')).toBe(false);
  });
});
