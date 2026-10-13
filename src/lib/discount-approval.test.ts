import { describe, it, expect } from 'vitest';
import { discountApprovalStatus } from './discount-approval';

const lines = [{ quantity: 1, unit_price: 1000 }];

describe('discountApprovalStatus', () => {
  it('lets a discount at or under the limit through', () => {
    const s = discountApprovalStatus({ discount_type: 'percent', discount_value: 5 }, lines, 5);
    expect(s).toMatchObject({ pct: 5, amount: 50, overLimit: false, blocked: false });
  });

  it('blocks a discount over the limit with no approval', () => {
    const s = discountApprovalStatus({ discount_type: 'amount', discount_value: 60 }, lines, 5);
    expect(s).toMatchObject({ pct: 6, overLimit: true, approved: false, blocked: true });
  });

  it('holds an approval while the discount stays at or under the approved percent', () => {
    const approved = { discount_approved_at: '2026-10-13T00:00:00Z', discount_approved_pct: 10 };
    expect(discountApprovalStatus({ discount_type: 'percent', discount_value: 10, ...approved }, lines, 5).blocked).toBe(false);
    expect(discountApprovalStatus({ discount_type: 'percent', discount_value: 8, ...approved }, lines, 5).blocked).toBe(false);
    // Raised past what the admin saw: asks again.
    expect(discountApprovalStatus({ discount_type: 'percent', discount_value: 12, ...approved }, lines, 5).blocked).toBe(true);
  });

  it('counts line discounts toward the limit', () => {
    const s = discountApprovalStatus({}, [{ quantity: 1, unit_price: 1000, discount_type: 'percent', discount_value: 7 }], 5);
    expect(s).toMatchObject({ pct: 7, blocked: true });
  });

  it('falls back to the default limit when the setting is unusable', () => {
    expect(discountApprovalStatus({ discount_type: 'percent', discount_value: 6 }, lines, NaN).limitPct).toBe(5);
  });
});
