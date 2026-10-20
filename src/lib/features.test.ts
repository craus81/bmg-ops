import { describe, it, expect } from 'vitest';
import { isAdminRole, resolveFeatures, canGrantToRole, FEATURES, SUPER_ADMIN_FEATURES, INTERNAL_STAFF_ROLES } from './features';
import { canSeeMoney } from './money-visibility';

describe('isAdminRole — super_admin is a strict superset of admin', () => {
  it('accepts admin, super_admin, and both', () => {
    expect(isAdminRole(['admin'])).toBe(true);
    expect(isAdminRole(['super_admin'])).toBe(true);
    expect(isAdminRole(['admin', 'super_admin'])).toBe(true);
    // The pure-super_admin account is the case the 2026-09-07 decision
    // exists for: before it, 66 requireAdmin routes 403'd this role set.
    expect(isAdminRole(['super_admin', 'sales'])).toBe(true);
  });

  it('rejects every non-admin role set', () => {
    expect(isAdminRole([])).toBe(false);
    expect(isAdminRole(['sales'])).toBe(false);
    expect(isAdminRole(['graphics_production', 'shop_tech'])).toBe(false);
    expect(isAdminRole(['installer'])).toBe(false);
    expect(isAdminRole(['customer'])).toBe(false);
    // The feature keys that merely contain the substring are not roles.
    expect(isAdminRole(['cni_admin', 'invoice_admin'])).toBe(false);
  });
});

describe('resolveFeatures admin tiers', () => {
  it('super_admin gets every feature, owner-level keys included', () => {
    const features = resolveFeatures(['super_admin'], []);
    for (const key of Object.keys(FEATURES)) expect(features.has(key as any)).toBe(true);
  });

  it('admin gets everything EXCEPT the super-admin-only keys', () => {
    const features = resolveFeatures(['admin'], []);
    for (const key of SUPER_ADMIN_FEATURES) expect(features.has(key)).toBe(false);
    const regular = (Object.keys(FEATURES) as (keyof typeof FEATURES)[])
      .filter(k => !SUPER_ADMIN_FEATURES.includes(k as any));
    for (const key of regular) expect(features.has(key as any)).toBe(true);
  });
});

describe('the ledger feature', () => {
  it('is a default for finance and executive, and admins inherit it', () => {
    expect(FEATURES.ledger).toBeTruthy();
    expect(resolveFeatures(['finance'], []).has('ledger')).toBe(true);
    expect(resolveFeatures(['executive'], []).has('ledger')).toBe(true);
    expect(resolveFeatures(['admin'], []).has('ledger')).toBe(true);
    expect(resolveFeatures(['super_admin'], []).has('ledger')).toBe(true);
  });

  it('is NOT super-admin-only — a finance viewer must be able to open the page', () => {
    expect(SUPER_ADMIN_FEATURES).not.toContain('ledger');
  });

  it('is not handed to the shop-floor roles', () => {
    for (const role of ['sales', 'shop_tech', 'field_tech', 'graphics_production', 'installer', 'customer']) {
      expect(resolveFeatures([role], []).has('ledger'), role).toBe(false);
    }
  });
});

describe('role settings (Permissions screen)', () => {
  it('turns a feature on for a staff role', () => {
    const f = resolveFeatures(['shop_tech'], [], [{ role: 'shop_tech', feature: 'parts_catalog', granted: true }]);
    expect(f.has('parts_catalog')).toBe(true);
  });

  it('turns a default feature off for a role', () => {
    const f = resolveFeatures(['sales'], [], [{ role: 'sales', feature: 'estimates', granted: false }]);
    expect(f.has('estimates')).toBe(false);
  });

  it('only applies a setting to the role it names', () => {
    const f = resolveFeatures(['field_tech'], [], [{ role: 'shop_tech', feature: 'parts_catalog', granted: true }]);
    expect(f.has('parts_catalog')).toBe(false);
  });

  it('unions across roles after each role is resolved', () => {
    const settings = [{ role: 'installer', feature: 'scan', granted: false }];
    expect(resolveFeatures(['installer'], [], settings).has('scan')).toBe(false);
    expect(resolveFeatures(['installer', 'shop_tech'], [], settings).has('scan')).toBe(true);
  });

  it('never widens an outside role past its defaults', () => {
    const f = resolveFeatures(['installer'], [], [{ role: 'installer', feature: 'estimates', granted: true }]);
    expect(f.has('estimates')).toBe(false);
    expect(canGrantToRole('installer', 'estimates')).toBe(false);
    expect(canGrantToRole('customer', 'graphics')).toBe(false);
  });

  it('keeps owner-level pages off role switches', () => {
    expect(canGrantToRole('admin', 'user_management')).toBe(false);
    expect(resolveFeatures(['admin'], [], [{ role: 'admin', feature: 'audit_log', granted: true }]).has('audit_log')).toBe(false);
    expect(canGrantToRole('executive', 'financials')).toBe(true);
  });

  it('ignores settings for super_admin', () => {
    const f = resolveFeatures(['super_admin'], [], [{ role: 'super_admin', feature: 'books' as any, granted: false }, { role: 'super_admin', feature: 'home', granted: false }]);
    expect(f.has('home')).toBe(true);
  });

  it('applies a person’s own override after the role setting', () => {
    const f = resolveFeatures(['sales'], [{ feature: 'estimates', granted: true }], [{ role: 'sales', feature: 'estimates', granted: false }]);
    expect(f.has('estimates')).toBe(true);
  });
});

describe('keys added for pages that were gated by role in code', () => {
  const ALL = ['admin', 'super_admin', 'sales', 'graphics_production', 'shop_tech', 'field_tech', 'finance', 'executive', 'installer', 'customer'];
  const has = (role: string, key: string) => resolveFeatures([role], []).has(key as any);

  it('see_prices defaults to exactly the money roles', () => {
    for (const r of ALL) expect(has(r, 'see_prices')).toBe(canSeeMoney([r]));
  });

  it('staff tools default to exactly the internal staff roles', () => {
    for (const k of ['client_files', 'completion_photos', 'after_hours_calls', 'qc_fixes']) {
      for (const r of ALL) expect(has(r, k)).toBe(INTERNAL_STAFF_ROLES.includes(r) || r === 'super_admin');
    }
  });

  it('page keys default to who could open each page before', () => {
    const who: Record<string, string[]> = {
      graphics_builder: ['admin', 'super_admin', 'sales', 'graphics_production'],
      install_guides: ['admin', 'super_admin', 'sales', 'graphics_production'],
      quotes: ['admin', 'super_admin', 'sales'],
      invoicing: ['admin', 'super_admin', 'sales', 'finance'],
      vendor_payments: ['admin', 'super_admin', 'finance'],
      part_admin: ['admin', 'super_admin'],
    };
    for (const [k, roles] of Object.entries(who)) {
      for (const r of ALL) expect(has(r, k)).toBe(roles.includes(r));
    }
  });

  it('turning see_prices on for graphics production shows prices to that role', () => {
    const f = resolveFeatures(['graphics_production'], [], [{ role: 'graphics_production', feature: 'see_prices', granted: true }]);
    expect(f.has('see_prices')).toBe(true);
  });
});
