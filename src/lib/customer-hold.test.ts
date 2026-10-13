import { describe, it, expect } from 'vitest';
import { isOnHold, holdReason, holdTransitions, holdChangeLines, type CustomerHoldRow } from './customer-hold';


const row = (over: Partial<CustomerHoldRow> = {}): CustomerHoldRow => ({
  netsuite_customer_id: '1', customer_id: null, customer_name: 'Acme',
  auto_hold: false, auto_since: null, oldest_days: null, past_due_amount: null,
  manual: null, manual_note: null, manual_by: null, manual_at: null, ...over,
});

describe('isOnHold', () => {
  it('follows the sweep when nobody has set it by hand', () => {
    expect(isOnHold(row({ auto_hold: true }))).toBe(true);
    expect(isOnHold(row({ auto_hold: false }))).toBe(false);
    expect(isOnHold(null)).toBe(false);
  });
  it('a manual hold or release wins over the sweep', () => {
    expect(isOnHold(row({ auto_hold: false, manual: 'hold' }))).toBe(true);
    expect(isOnHold(row({ auto_hold: true, manual: 'release' }))).toBe(false);
  });
});

describe('holdReason', () => {
  it('names the days and amount, or the manual note', () => {
    expect(holdReason(row({ auto_hold: true, oldest_days: 72, past_due_amount: '1234.5' }))).toBe('Invoice 72 days past due ($1,234.50 past due)');
    expect(holdReason(row({ manual: 'hold', manual_note: 'Bounced check' }))).toBe('Put on hold by hand: Bounced check');
  });
});

describe('holdTransitions', () => {
  it('reports customers crossing in and out of the auto hold', () => {
    const before = new Map([
      ['a', { auto_hold: false, manual: null }],
      ['b', { auto_hold: true, manual: null }],
      ['c', { auto_hold: true, manual: null }],
    ] as const);
    const after = new Map([['a', { auto_hold: true }], ['b', { auto_hold: false }], ['c', { auto_hold: true }], ['d', { auto_hold: true }]]);
    const t = holdTransitions(new Map(before), after);
    expect(t.placed.sort()).toEqual(['a', 'd']);
    expect(t.lifted).toEqual(['b']);
  });
  it('stays quiet about customers a person held or released', () => {
    const before = new Map<string, { auto_hold: boolean; manual: 'hold' | 'release' | null }>([
      ['a', { auto_hold: false, manual: 'release' }],
      ['b', { auto_hold: true, manual: 'hold' }],
    ]);
    const t = holdTransitions(before, new Map([['a', { auto_hold: true }], ['b', { auto_hold: false }]]));
    expect(t).toEqual({ placed: [], lifted: [] });
  });
});

describe('holdChangeLines', () => {
  it('one line per change', () => {
    const lines = holdChangeLines(
      [{ netsuiteId: '1', customerId: null, customer: 'Acme', oldestDays: 61, pastDue: 500 }],
      [{ netsuiteId: '2', customerId: null, customer: 'Beta', oldestDays: 0, pastDue: 0 }],
    );
    expect(lines).toEqual([
      '⛔ Acme is now ON HOLD (oldest invoice 61 days late, $500.00 past due)',
      '✅ Beta is off hold (nothing past due any more)',
    ]);
  });
});
