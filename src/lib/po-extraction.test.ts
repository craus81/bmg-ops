import { describe, it, expect } from 'vitest';
import { buyerName, buyerEmail, lineNo } from './po-extraction';

// Field bug (PO 35050306). The PO PDF carries the buyer in a page-1 header
// block — "Name: Aleecia Brock … Email: abrock@masterack.com" — and the
// customer's AP mailbox in a page-2 footer line: "INVOICE TO: Masterack …
// Email: MSRAccountsPayable@masterack.com". The receipt confirmation reached
// AP instead of the buyer.
describe('buyerEmail — the AP decoy on the PO footer is never the buyer', () => {
  it('takes the Buyer Information address', () => {
    expect(buyerEmail({ buyer_email: 'abrock@masterack.com' })).toBe('abrock@masterack.com');
  });

  it('refuses the INVOICE TO address, so no buyer beats the wrong buyer', () => {
    expect(buyerEmail({ buyer_email: 'MSRAccountsPayable@masterack.com' })).toBeNull();
  });

  it('normalizes case, whitespace and a stray label', () => {
    expect(buyerEmail({ buyer_email: 'ABrock@Masterack.com' })).toBe('abrock@masterack.com');
    // The label strip is anchored, so it has to survive leading whitespace.
    expect(buyerEmail({ buyer_email: '  Email: ABrock@Masterack.com ' })).toBe('abrock@masterack.com');
  });

  it('reads a nested buyer object', () => {
    expect(buyerEmail({ buyer: { email: 'abrock@masterack.com' } })).toBe('abrock@masterack.com');
  });

  it('is null on junk, a missing block, or a non-address', () => {
    expect(buyerEmail({})).toBeNull();
    expect(buyerEmail({ buyer_email: null })).toBeNull();
    expect(buyerEmail({ buyer_email: 'Aleecia Brock' })).toBeNull();
  });
});

describe('buyerName', () => {
  it('takes the name and strips a stray label', () => {
    expect(buyerName({ buyer_name: 'Aleecia Brock' })).toBe('Aleecia Brock');
    expect(buyerName({ buyer_name: 'Name: Aleecia Brock' })).toBe('Aleecia Brock');
    expect(buyerName({ buyer_name: '  Name: Aleecia Brock  ' })).toBe('Aleecia Brock');
    expect(buyerName({ buyer: { name: 'Aleecia Brock' } })).toBe('Aleecia Brock');
  });

  it('is null when the block is absent', () => {
    expect(buyerName({})).toBeNull();
    expect(buyerName({ buyer_name: '   ' })).toBeNull();
  });
});

// po_line_items.id is a UUID, so the confirmation email used to list a PO's
// lines in an arbitrary order — line 3 above line 2 on PO 35050306.
describe('lineNo — lines come back in the order the customer sees them', () => {
  it('uses the PO’s printed line number', () => {
    expect(lineNo({ line_no: '1.000' }, 0)).toBe(1);
    expect(lineNo({ line_no: '2.000' }, 1)).toBe(2);
    expect(lineNo({ line_no: '10.500' }, 4)).toBe(10.5);
  });

  it('sorts numerically, not as text', () => {
    const nums = [{ line_no: '10.000' }, { line_no: '2.000' }].map((l, i) => lineNo(l, i));
    expect([...nums].sort((a, b) => a - b)).toEqual([2, 10]);
  });

  it('falls back to the line’s position when the PO prints no numbers', () => {
    expect(lineNo({}, 0)).toBe(1);
    expect(lineNo({ line_no: '' }, 2)).toBe(3);
    expect(lineNo({ line_no: 'n/a' }, 1)).toBe(2);
    expect(lineNo({ line_no: '0' }, 3)).toBe(4);
  });
});
