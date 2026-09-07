import { describe, it, expect } from 'vitest';
import { isAdminRole, resolveFeatures, FEATURES, SUPER_ADMIN_FEATURES } from './features';

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
