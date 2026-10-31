import { describe, it, expect } from 'vitest';
import { EMPTY_NEW_SO_SHIP_TO, centralToday, mirrorRow, shipToBlank, shipToForNetSuite, shipToProblem } from './new-sales-order';
import { workOutNewInvoice } from './new-invoice';

const whole = { name: 'Example Plumbing', address: '100 Main St', city: 'Dayton', state: 'oh', zip: '45402' };

describe('ship-to box', () => {
  it('blank means the customer default', () => {
    expect(shipToBlank(EMPTY_NEW_SO_SHIP_TO)).toBe(true);
    expect(shipToBlank({ ...EMPTY_NEW_SO_SHIP_TO, city: '  ' })).toBe(true);
    expect(shipToProblem(EMPTY_NEW_SO_SHIP_TO)).toBeNull();
    expect(shipToForNetSuite(EMPTY_NEW_SO_SHIP_TO)).toBeNull();
  });

  it('a started box needs every part', () => {
    expect(shipToProblem({ ...EMPTY_NEW_SO_SHIP_TO, address: '100 Main St' }))
      .toBe("Ship-to: add the name, city, state and ZIP, or clear the box to use the customer's address.");
    expect(shipToProblem({ ...whole, zip: '' }))
      .toBe("Ship-to: add the ZIP, or clear the box to use the customer's address.");
    expect(shipToProblem(whole)).toBeNull();
  });

  it('goes to NetSuite trimmed with the state upper-cased', () => {
    const s = shipToForNetSuite({ ...whole, name: ' Example Plumbing ' })!;
    expect(s).toMatchObject({ name: 'Example Plumbing', address: '100 Main St', city: 'Dayton', state: 'OH', zip: '45402', attention: '', phone: '' });
  });
});

describe('centralToday', () => {
  it("is O'Fallon's date, not UTC's", () => {
    expect(centralToday(new Date('2026-11-01T03:30:00Z'))).toBe('2026-10-31');
    expect(centralToday(new Date('2026-10-31T14:00:00Z'))).toBe('2026-10-31');
  });
});

describe('mirrorRow', () => {
  it('shows on the Open list right away', () => {
    expect(mirrorRow({
      netsuiteId: '9001', number: 'SO1205', customerNetsuiteId: '77', customerName: 'Example Plumbing',
      date: '2026-10-31', poNumber: '4471', memo: null, vin: null, totalCents: 422549,
    })).toEqual({
      netsuite_id: '9001', tranid: 'SO1205', customer_netsuite_id: '77', customer_name: 'Example Plumbing',
      trandate: '2026-10-31', status: 'B', status_label: null, memo: null, otherrefnum: '4471', vin: null, total: 4225.49,
    });
  });
});

describe('the lines use New invoice rules, named a sales order', () => {
  it('says sales order in its problems', () => {
    const w = workOutNewInvoice([], { taxRate: 0.08, taxExempt: false, hasCustomer: false, noun: 'sales order' });
    expect(w.problems).toEqual(['Pick the customer.', 'Add at least one line.']);
    const big = workOutNewInvoice(
      Array.from({ length: 101 }, () => ({ itemId: '1', itemNumber: 'A', itemType: 'InvtPart', taxableOverride: null, description: '', quantity: 1, price: 1 })),
      { taxRate: 0, taxExempt: false, hasCustomer: true, noun: 'sales order' },
    );
    expect(big.problems).toContain('A sales order can have at most 100 lines.');
  });
});
