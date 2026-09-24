import { isAdminRole, type FeatureKey } from '@/lib/features';

/**
 * Can this viewer open a mention's record page without bouncing?
 *
 * Mirrors each record page's own gate (useRequireFeature, or the role check
 * at the top of the page), so the mention screen (/mentions/<id>) only
 * offers "Open" when the click will actually land. Before this, a teammate
 * tagged on a page their role can't open (a PO, an estimate for Graphics
 * Production, the at-risk report) was bounced to /home and only ever saw
 * the notification's excerpt. Keep in step with the page gates when one
 * changes. Paths not listed here carry no gate we know of and count as
 * openable.
 */
export function canOpenMentionUrl(
  url: string | null | undefined,
  rawRoles: string[],
  hasFeature: (f: FeatureKey) => boolean,
): boolean {
  if (!url || url === '/home' || url.startsWith('/home?')) return false;
  const roles = rawRoles.map(r => (r === 'production' ? 'graphics_production' : r));
  const admin = isAdminRole(roles);
  const path = url.split(/[?#]/)[0];
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

  if (under('/admin/pos')) return admin;
  if (under('/admin/reports/at-risk')) return admin || roles.includes('sales');
  if (under('/admin/cni')) return hasFeature('cni_admin');
  if (under('/admin/prospects')) return admin || hasFeature('prospects');
  if (under('/admin/leads') || under('/quotes')) return admin || roles.includes('sales');
  if (under('/admin/wrap-quote')) return admin || roles.includes('sales') || roles.includes('graphics_production');
  if (under('/admin/credit-applications')) return hasFeature('credit_applications');
  if (under('/admin/receiving') || under('/admin/purchasing')) return hasFeature('parts_ordering');
  if (under('/admin/ap')) return admin || roles.includes('finance');
  if (under('/admin/schedule')) return hasFeature('schedule');
  if (under('/estimates')) return hasFeature('estimates');
  if (under('/tracking')) return hasFeature('in_shop') || hasFeature('fleet_checkin');
  if (under('/upfit')) return hasFeature('upfit_projects');
  if (path.startsWith('/graphics/')) {
    // graphics/[id] admits any internal floor/sales role (its isStaff check).
    return admin || ['graphics_production', 'sales', 'installer', 'field_tech', 'shop_tech']
      .some(r => roles.includes(r));
  }
  return true;
}
