import { describe, it, expect } from 'vitest';
import { orderSearchGroups, orderSearchResults } from './search-groups';

describe('orderSearchGroups', () => {
  it('puts FleetSuite first, then NetSuite, then QuickBooks', () => {
    expect(orderSearchGroups(['qb_history', 'invoices', 'ns_estimates', 'purchase_orders', 'estimates', 'ns_transactions', 'notes']))
      .toEqual(['estimates', 'purchase_orders', 'notes', 'invoices', 'ns_estimates', 'ns_transactions', 'qb_history']);
  });

  it('keeps unknown groups, last and in their given order', () => {
    expect(orderSearchGroups(['zeta', 'bills', 'alpha', 'customers'])).toEqual(['customers', 'bills', 'zeta', 'alpha']);
  });

  it('rebuilds a results object in that order', () => {
    expect(Object.keys(orderSearchResults({ ns_sales_orders: [1], estimates: [2] }))).toEqual(['estimates', 'ns_sales_orders']);
  });
});
