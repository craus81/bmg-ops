import { describe, it, expect } from 'vitest';
import { isApMailbox } from './po-confirmation';

// The field bug this guards: PO 35050306's receipt confirmation went to
// MSRAccountsPayable@masterack.com instead of the buyer, because the
// recipient fell back to the customer's *invoice* list. No derived
// recipient may be an accounts-payable mailbox any more.
describe('isApMailbox — accounts-payable mailboxes never get a PO receipt', () => {
  it('catches the address from the field bug', () => {
    expect(isApMailbox('MSRAccountsPayable@masterack.com')).toBe(true);
  });

  it('catches the usual AP / invoicing shapes', () => {
    for (const e of [
      'accountspayable@acme.com',
      'accounts.payable@acme.com',
      'accounts-payable@acme.com',
      'accountpayable@acme.com',
      'payables@acme.com',
      'ap@acme.com',
      'AP@acme.com',
      'msr.ap@acme.com',
      'fleet-ar@acme.com',
      'acctspay@acme.com',
      'invoices@acme.com',
      'invoice@acme.com',
      'invoicing@acme.com',
      'billing@acme.com',
      'remit@acme.com',
      'remittance@acme.com',
    ]) {
      expect(isApMailbox(e), e).toBe(true);
    }
  });

  it('leaves people alone — a name is not a department', () => {
    for (const e of [
      'abrock@masterack.com',
      'aparker@acme.com',   // starts with "ap"
      'arnold@acme.com',    // starts with "ar"
      'apollo@acme.com',
      'a.brock@acme.com',
      'billings@acme.com',  // surname, not the billing desk
      'purchasing@acme.com',
      'buyer@acme.com',
      'j.remington@acme.com',
    ]) {
      expect(isApMailbox(e), e).toBe(false);
    }
  });

  it('handles junk without throwing', () => {
    expect(isApMailbox('')).toBe(false);
    expect(isApMailbox('@acme.com')).toBe(false);
  });
});
