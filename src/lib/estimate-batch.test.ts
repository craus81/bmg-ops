import { describe, it, expect } from 'vitest';
import { estimateCustomerKey, groupByCustomer, canSendForApproval } from './estimate-batch';

describe('estimateCustomerKey', () => {
  it('prefers the customer record, then the lead, then NetSuite, then the name', () => {
    expect(estimateCustomerKey({ id: '1', customer_id: 'c1', prospect_id: 'p1' })).toBe('c:c1');
    expect(estimateCustomerKey({ id: '1', prospect_id: 'p1', customer_netsuite_id: '9' })).toBe('p:p1');
    expect(estimateCustomerKey({ id: '1', customer_netsuite_id: '9' })).toBe('n:9');
    expect(estimateCustomerKey({ id: '1', customer_name: '  Metro Plumbing ' })).toBe('name:metro plumbing');
  });

  it('never groups two estimates that have no customer at all', () => {
    expect(estimateCustomerKey({ id: 'a' })).not.toBe(estimateCustomerKey({ id: 'b' }));
  });
});

describe('groupByCustomer', () => {
  it('keeps one group per customer in the order first picked', () => {
    const groups = groupByCustomer([
      { id: '1', customer_id: 'gateway' },
      { id: '2', customer_id: 'metro' },
      { id: '3', customer_id: 'gateway' },
    ]);
    expect(groups.map(g => g.map(e => e.id))).toEqual([['1', '3'], ['2']]);
  });
});

describe('canSendForApproval', () => {
  it('leaves out approved estimates and ones on a sales order', () => {
    expect(canSendForApproval({ status: 'draft' })).toBe(true);
    expect(canSendForApproval({ status: 'sent' })).toBe(true);
    expect(canSendForApproval({ customer_approved: true })).toBe(false);
    expect(canSendForApproval({ status: 'accepted' })).toBe(false);
    expect(canSendForApproval({ netsuite_so_id: '123' })).toBe(false);
  });
});
