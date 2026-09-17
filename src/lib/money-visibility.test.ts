import { describe, it, expect } from 'vitest';
import { canSeeMoney, formatMoney, MONEY_ROLES, MONEY_HIDDEN } from './money-visibility';
import { ROLE_DEFAULT_FEATURES, INTERNAL_STAFF_ROLES } from './features';

describe('canSeeMoney', () => {
  it('lets the people whose job is money see it', () => {
    for (const role of ['admin', 'super_admin', 'sales', 'finance', 'executive']) {
      expect(canSeeMoney([role]), `${role} should see money`).toBe(true);
    }
  });

  it('keeps it from the shop floor', () => {
    for (const role of ['graphics_production', 'shop_tech', 'field_tech', 'installer', 'customer']) {
      expect(canSeeMoney([role]), `${role} should not see money`).toBe(false);
    }
  });

  it('grants it on ANY held role — a tech who also sells still quotes', () => {
    expect(canSeeMoney(['shop_tech', 'sales'])).toBe(true);
  });

  it('denies an unknown, empty or missing role list rather than defaulting open', () => {
    expect(canSeeMoney([])).toBe(false);
    expect(canSeeMoney(null)).toBe(false);
    expect(canSeeMoney(undefined)).toBe(false);
    expect(canSeeMoney(['bookkeeper_2'])).toBe(false);
  });

  it('covers every staff role explicitly — a new role must choose a side', () => {
    // INTERNAL_STAFF_ROLES is the set that can reach staff surfaces at all.
    // If someone adds one, this fails until they decide whether it sees money.
    const decided = new Set([...MONEY_ROLES, 'graphics_production', 'shop_tech', 'field_tech']);
    const undecided = INTERNAL_STAFF_ROLES.filter(r => !decided.has(r));
    expect(undecided, `undecided staff roles: ${undecided.join(', ')}`).toEqual([]);
  });

  it('matches the roles that actually hold money-shaped features', () => {
    // finance holds vendor_payments and ledger; it must be on the money side
    // or the role is gated out of the only pages it has.
    expect(ROLE_DEFAULT_FEATURES.finance).toContain('vendor_payments');
    expect(canSeeMoney(['finance'])).toBe(true);
  });
});

describe('formatMoney', () => {
  it('formats a visible amount as dollars', () => {
    expect(formatMoney(1234.5, true)).toBe('$1,234.50');
    expect(formatMoney('89', true)).toBe('$89.00');
    expect(formatMoney(1234.5, true, { cents: false })).toBe('$1,235');
  });

  it('shows the placeholder, never a zero, when hidden', () => {
    // "$0.00" would read as "this job is free", which is worse than silence.
    expect(formatMoney(1234.5, false)).toBe(MONEY_HIDDEN);
    expect(formatMoney(0, false)).toBe(MONEY_HIDDEN);
    expect(MONEY_HIDDEN).not.toContain('0');
  });

  it('shows the placeholder for an amount that is not a number', () => {
    expect(formatMoney(null, true)).toBe(MONEY_HIDDEN);
    expect(formatMoney(undefined, true)).toBe(MONEY_HIDDEN);
    expect(formatMoney('n/a', true)).toBe(MONEY_HIDDEN);
    expect(formatMoney(Number.NaN, true)).toBe(MONEY_HIDDEN);
  });
});

describe('the money-shaped pages match the money roles', () => {
  it('keeps the estimates page away from graphics production', () => {
    // The estimates page is a quoting page — line prices, totals, margin,
    // the customer send. Production needs the job, not what it was quoted at.
    expect(ROLE_DEFAULT_FEATURES.graphics_production).not.toContain('estimates');
    expect(ROLE_DEFAULT_FEATURES.sales).toContain('estimates');
  });

  it('leaves the floor its own work', () => {
    // The point of the rule is money, not access. Taking the board away
    // would be a different (and wrong) change.
    expect(ROLE_DEFAULT_FEATURES.graphics_production).toContain('graphics');
    expect(ROLE_DEFAULT_FEATURES.shop_tech).toContain('parts_ordering');
  });

  it('never lands a money-shaped page on a role that cannot see money', () => {
    const moneyPages = ['vendor_payments', 'ledger', 'financials', 'purchase_orders', 'credit_applications'];
    for (const [role, features] of Object.entries(ROLE_DEFAULT_FEATURES)) {
      if (canSeeMoney([role])) continue;
      const held = (features as string[]).filter(f => moneyPages.includes(f));
      expect(held, `${role} holds money-shaped pages: ${held.join(', ')}`).toEqual([]);
    }
  });
});
