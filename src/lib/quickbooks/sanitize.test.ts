import { describe, it, expect } from 'vitest';
import { DROP_KEY_FUZZY_RE, DROP_KEY_RE, DROP_SUBTREE_KEYS, sanitizeQboPayload } from './sanitize';

/**
 * Owner requirement 11: card numbers, CVV and bank routing/account numbers
 * are DROPPED at intake, not masked. These fixtures are the shapes
 * QuickBooks actually returns them in.
 */

const PAYMENT = {
  Id: '42',
  TotalAmt: 1200.5,
  PaymentRefNum: 'CHK-8891',
  CreditCardPayment: {
    CreditChargeInfo: { Number: '4111111111111111', CcExpiryMonth: 11, CcExpiryYear: 2029, NameOnAcct: 'A Buyer' },
    CreditChargeResponse: { CCTransId: 'abc', Status: 'Completed' },
  },
  CheckPayment: { BankName: 'First National', AcctNum: '000123456789', NameOnAcct: 'BMG Fleet' },
  Line: [{ Amount: 1200.5, LinkedTxn: [{ TxnId: '9', TxnType: 'Invoice' }] }],
};

describe('sanitizeQboPayload — payment instruments', () => {
  it('removes the CreditCardPayment and CheckPayment subtrees whole', () => {
    const { clean, dropped } = sanitizeQboPayload('Payment', PAYMENT);
    expect(clean).not.toHaveProperty('CreditCardPayment');
    expect(clean).not.toHaveProperty('CheckPayment');
    expect(dropped).toContain('CreditCardPayment');
    expect(dropped).toContain('CheckPayment');
  });

  it('keeps the header PaymentRefNum — a cheque number is not an instrument', () => {
    const { clean } = sanitizeQboPayload('Payment', PAYMENT);
    expect((clean as any).PaymentRefNum).toBe('CHK-8891');
  });

  it('leaves no 13–19 digit run anywhere in the clean JSON', () => {
    // The blunt version of the rule: whatever the shape, no PAN survives.
    expect(JSON.stringify(PAYMENT)).toMatch(/\d{13,19}/);
    const { clean } = sanitizeQboPayload('Payment', PAYMENT);
    expect(JSON.stringify(clean)).not.toMatch(/\d{13,19}/);
  });

  it('keeps the applications — dropping instruments must not drop the money trail', () => {
    const { clean } = sanitizeQboPayload('Payment', PAYMENT);
    expect((clean as any).Line[0].LinkedTxn[0]).toEqual({ TxnId: '9', TxnType: 'Invoice' });
  });
});

describe('sanitizeQboPayload — tax identifiers', () => {
  it('drops a Customer PrimaryTaxIdentifier', () => {
    const { clean, dropped } = sanitizeQboPayload('Customer', {
      Id: '1', DisplayName: 'Broadway Ford', PrimaryTaxIdentifier: '12-3456789',
    });
    expect(clean).not.toHaveProperty('PrimaryTaxIdentifier');
    expect(dropped).toContain('PrimaryTaxIdentifier');
    expect((clean as any).DisplayName).toBe('Broadway Ford');
  });

  it('drops a Vendor TaxIdentifier', () => {
    const { clean, dropped } = sanitizeQboPayload('Vendor', { Id: '7', DisplayName: 'Masterack', TaxIdentifier: '98-7654321' });
    expect(clean).not.toHaveProperty('TaxIdentifier');
    expect(dropped).toContain('TaxIdentifier');
  });
});

describe('sanitizeQboPayload — what must survive', () => {
  it('KEEPS Account.AcctNum: it is the chart number, not a bank account', () => {
    // The bank/card AcctNum only ever lives under CheckPayment/BankAccount,
    // and those go whole — so this key can stay and feed
    // ledger_accounts.account_number.
    const { clean, dropped } = sanitizeQboPayload('Account', {
      Id: '33', Name: 'Sales', AcctNum: '4000', Classification: 'Revenue',
    });
    expect((clean as any).AcctNum).toBe('4000');
    expect(dropped).not.toContain('AcctNum');
  });

  it('drops TempDownloadUri — a short-lived credential-bearing URL', () => {
    const { clean, dropped } = sanitizeQboPayload('Attachable', {
      Id: '5', FileName: 'po.pdf', TempDownloadUri: 'https://intuit.example/tmp?sig=secret',
    });
    expect(clean).not.toHaveProperty('TempDownloadUri');
    expect(dropped).toContain('TempDownloadUri');
    expect((clean as any).FileName).toBe('po.pdf');
  });
});

describe('sanitizeQboPayload — idempotence', () => {
  it('sanitizing twice is a no-op, so appendEvents can re-run it safely', () => {
    const once = sanitizeQboPayload('Payment', PAYMENT).clean;
    const twice = sanitizeQboPayload('Payment', once).clean;
    expect(twice).toEqual(once);
    expect(sanitizeQboPayload('Payment', once).dropped).toEqual([]);
  });

  it('walks arrays and nested objects', () => {
    const { clean } = sanitizeQboPayload('Bill', {
      Id: '1',
      Line: [{ Amount: 5, CreditCardPayment: { CreditChargeInfo: { Number: '4111111111111111' } } }],
    });
    expect((clean as any).Line[0]).toEqual({ Amount: 5 });
  });

  it('the fuzzy net only fires on primitive-valued keys', () => {
    const { clean } = sanitizeQboPayload('Custom', {
      cardHolder: '4111111111111111',
      CardTerminalRef: { value: 'T1', name: 'Front desk' },
    });
    expect(clean).not.toHaveProperty('cardHolder');
    // An object survives: the subtree rules cover containers, and eating one
    // by name would silently drop structure.
    expect((clean as any).CardTerminalRef).toEqual({ value: 'T1', name: 'Front desk' });
  });
});

describe('the policy constants themselves', () => {
  it('names every subtree that exists only to carry an instrument', () => {
    // Removing the SUBTREE, not its leaves, is what keeps the rule robust
    // when Intuit adds a field inside one.
    expect([...DROP_SUBTREE_KEYS].sort()).toEqual([
      'BankAccount', 'BankAccountRef', 'CheckPayment',
      'CreditCardPayment', 'CreditChargeInfo', 'CreditChargeResponse',
    ]);
  });

  it('matches the exact key names, and deliberately NOT AcctNum', () => {
    for (const key of ['TaxIdentifier', 'RoutingNumber', 'CardNumber', 'Cvv', 'TempDownloadUri']) {
      expect(DROP_KEY_RE.test(key), key).toBe(true);
    }
    // Account.AcctNum is the chart number the ledger needs.
    expect(DROP_KEY_RE.test('AcctNum')).toBe(false);
  });

  it('the fuzzy net covers the words a future field would use', () => {
    for (const key of ['cardHolder', 'bankRouting', 'cvvCheck', 'ssnLast4', 'taxIdMasked']) {
      expect(DROP_KEY_FUZZY_RE.test(key), key).toBe(true);
    }
    expect(DROP_KEY_FUZZY_RE.test('DocNumber')).toBe(false);
  });
});
