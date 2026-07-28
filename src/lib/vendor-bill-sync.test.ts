import { describe, it, expect } from 'vitest';
import { findBillForRef } from './vendor-bill-match';

// netsuite_bill_id holds whatever the bill was recorded with: the numeric
// internal id (one-click create) or a hand-pasted bill number/tranid
// (Record Bill). The lookup must match either — and never cross-match.
describe('findBillForRef', () => {
  const bills = [
    { id: 4021, tranid: 'VI-568', status: 'B' },
    { id: 4022, tranid: 'BILL1042', status: 'A' },
    { id: 555, tranid: '4021', status: 'A' }, // tranid that LOOKS like another bill's id
  ];

  it('matches by internal id first', () => {
    // '4021' is bill 4021's id AND bill 555's tranid — the id wins, so a
    // one-click-created invoice never picks up someone else's bill.
    expect(findBillForRef('4021', bills)).toMatchObject({ id: 4021 });
  });

  it('matches tranid case-insensitively', () => {
    expect(findBillForRef('vi-568', bills)).toMatchObject({ id: 4021 });
    expect(findBillForRef('BILL1042', bills)).toMatchObject({ id: 4022 });
  });

  it('trims whitespace from the stored ref', () => {
    expect(findBillForRef('  VI-568 ', bills)).toMatchObject({ id: 4021 });
  });

  it('returns null for unknown or empty refs', () => {
    expect(findBillForRef('VI-999', bills)).toBeNull();
    expect(findBillForRef('', bills)).toBeNull();
    expect(findBillForRef('   ', bills)).toBeNull();
  });

  it('handles numeric ids returned as strings by SuiteQL', () => {
    expect(findBillForRef('77', [{ id: '77', tranid: null, status: 'B' }])).toMatchObject({ id: '77' });
  });
});
