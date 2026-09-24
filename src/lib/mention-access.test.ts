import { describe, it, expect } from 'vitest';
import { canOpenMentionUrl } from './mention-access';
import { resolveFeatures, type FeatureKey } from './features';

const can = (url: string | null, roles: string[]) => {
  const f = resolveFeatures(roles.map(r => (r === 'production' ? 'graphics_production' : r)), []);
  return canOpenMentionUrl(url, roles, (k: FeatureKey) => f.has(k));
};

describe('canOpenMentionUrl', () => {
  it('never offers /home or a missing url as the record', () => {
    expect(can(null, ['admin'])).toBe(false);
    expect(can('/home', ['admin'])).toBe(false);
  });

  it('keeps PO notes admin-only', () => {
    expect(can('/admin/pos/abc?note=1', ['admin'])).toBe(true);
    expect(can('/admin/pos/abc', ['super_admin'])).toBe(true);
    expect(can('/admin/pos/abc', ['graphics_production'])).toBe(false);
    expect(can('/admin/pos/abc', ['sales'])).toBe(false);
  });

  it('follows the estimates feature', () => {
    expect(can('/estimates?id=abc', ['sales'])).toBe(true);
    expect(can('/estimates?id=abc', ['shop_tech'])).toBe(false);
    expect(can('/estimates?id=abc', ['finance'])).toBe(false);
  });

  it('lets floor roles open graphics jobs but not finance', () => {
    expect(can('/graphics/abc', ['graphics_production'])).toBe(true);
    expect(can('/graphics/abc', ['production'])).toBe(true); // legacy role value
    expect(can('/graphics/abc', ['field_tech'])).toBe(true);
    expect(can('/graphics/abc', ['finance'])).toBe(false);
  });

  it('matches the at-risk, CNI, schedule, In-Shop and upfit gates', () => {
    expect(can('/admin/reports/at-risk?customer=x', ['sales'])).toBe(true);
    expect(can('/admin/reports/at-risk?customer=x', ['graphics_production'])).toBe(false);
    expect(can('/admin/cni/installers/abc', ['sales'])).toBe(false);
    expect(can('/admin/schedule?event=abc', ['field_tech'])).toBe(true);
    expect(can('/admin/schedule?event=abc', ['finance'])).toBe(false);
    expect(can('/tracking?vehicle=abc', ['graphics_production'])).toBe(true);
    expect(can('/tracking?vehicle=abc', ['finance'])).toBe(false);
    expect(can('/upfit?project=abc', ['shop_tech'])).toBe(true);
  });

  it('treats ungated pages as openable', () => {
    expect(can('/installer/jobs/abc', ['installer'])).toBe(true);
  });
});
