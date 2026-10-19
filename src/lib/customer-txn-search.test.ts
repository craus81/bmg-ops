import { describe, expect, it } from 'vitest';
import { exactTerm, headerWhy } from './customer-txn-search';

describe('exactTerm', () => {
  it('keeps letters, digits and dashes only, so it rides a filter unquoted', () => {
    expect(exactTerm('PO# 4471-B')).toBe('PO4471-B');
    expect(exactTerm('a,b.c*(d)"')).toBe('abcd');
  });
});

describe('headerWhy', () => {
  it('names the VIN first, then the PO', () => {
    expect(headerWhy('a12345', { vin: '1FTBR1C82PKA12345', po: 'A12345' })).toBe('VIN: 1FTBR1C82PKA12345');
    expect(headerWhy('4471', { po: 'PO-4471', memo: 'rush' })).toBe('PO: PO-4471');
  });
  it('matches the memo loosely', () => {
    expect(headerWhy('st charles', { memo: 'Saint Charles fleet' })).toBe('Memo: Saint Charles fleet');
  });
  it('says nothing when no header field matches', () => {
    expect(headerWhy('ladder', { memo: 'rush', po: '12' })).toBeNull();
  });
});
