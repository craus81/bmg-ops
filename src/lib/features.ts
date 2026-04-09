/**
 * Feature Access System
 *
 * Each feature maps to a page/capability in the app.
 * Roles have default features, but admins can override per user.
 */

export const FEATURES = {
  // Core tabs
  home: 'Home Dashboard',
  scan: 'Scan & Log',
  fleet_checkin: 'Vehicle Check-In',
  in_shop: 'In-Shop Tracking',
  graphics: 'Graphics Production',
  estimates: 'Estimates',
  time: 'Time Tracking',
  messages: 'Messages / Chat',

  // Admin / More menu
  purchase_orders: 'Purchase Orders',
  customers: 'Customers & Contacts',
  parts_catalog: 'Parts Catalog',
  schedule: 'Schedule',
  reports: 'Reports',
  photo_reviews: 'Photo Reviews',
  user_management: 'User Management',
  cni_management: 'CNI Management',
  knowledge_base: 'Knowledge Base',
  vendor_payments: 'Vendor Payments',
  bulk_vin: 'Bulk VIN Upload',
  bulk_upload: 'Bulk Upload (Templates)',
  proof_hygiene: 'Proof Hygiene',
  quoting: 'Estimating / Quoting',
  all_jobs: 'CNI Jobs',
  catalog_management: 'Part Catalog Management',
  prospects: 'Prospects / Sales CRM',
} as const;

export type FeatureKey = keyof typeof FEATURES;

// Default features per role — what each role can access out of the box
export const ROLE_DEFAULT_FEATURES: Record<string, FeatureKey[]> = {
  admin: Object.keys(FEATURES) as FeatureKey[], // everything

  sales: [
    'home', 'fleet_checkin', 'in_shop', 'graphics', 'estimates',
    'time', 'messages', 'customers', 'parts_catalog', 'quoting', 'schedule', 'prospects',
  ],

  graphics_production: [
    'home', 'in_shop', 'graphics', 'estimates',
    'time', 'messages', 'customers', 'parts_catalog', 'quoting', 'schedule',
  ],

  shop_tech: [
    'home', 'scan', 'fleet_checkin', 'in_shop',
    'time', 'messages', 'schedule',
  ],

  field_tech: [
    'home', 'scan', 'time', 'messages',
  ],

  installer: [
    'home', 'scan', 'time', 'messages', 'cni_management',
  ],

  customer: ['home'],
};

/**
 * Resolve the effective features for a user.
 * Starts with role defaults, then applies per-user overrides.
 */
export function resolveFeatures(
  roles: string[],
  overrides: { feature: string; granted: boolean }[]
): Set<FeatureKey> {
  const features = new Set<FeatureKey>();

  // Collect defaults from all roles
  for (const role of roles) {
    const defaults = ROLE_DEFAULT_FEATURES[role] || [];
    for (const f of defaults) features.add(f);
  }

  // Admin gets everything
  if (roles.includes('admin')) {
    for (const key of Object.keys(FEATURES) as FeatureKey[]) {
      features.add(key);
    }
  }

  // Apply overrides
  for (const override of overrides) {
    const key = override.feature as FeatureKey;
    if (key in FEATURES) {
      if (override.granted) {
        features.add(key);
      } else {
        features.delete(key);
      }
    }
  }

  return features;
}
