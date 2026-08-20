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
  bulk_upload: 'Bulk Upload (Templates)',
  proof_hygiene: 'Proof Search', // legacy key — now gates the Proof Search page only
  all_jobs: 'CNI Jobs',
  catalog_management: 'Part Catalog Management',
  prospects: 'Customers (Sales CRM)',
  upfit_projects: 'Upfit Projects',
  upfit_configurator: 'Upfit Designer (3D)',
  audit_log: 'Audit Log',
  system_health: 'System Health',
  ai_instructions: 'AI Instructions',
  financials: 'Financials (Executive)',
} as const;

export type FeatureKey = keyof typeof FEATURES;

// Owner-level pages: super admins only by default. Regular admins don't see
// these, but can be granted individual ones via per-user feature overrides.
// `financials` is here so the executive P&L view (A/R, A/P, cash) is walled
// off from regular admins — only super_admin (all features) and the
// executive role (explicit default below) get it.
export const SUPER_ADMIN_FEATURES: FeatureKey[] = [
  'user_management', 'audit_log', 'system_health', 'ai_instructions', 'knowledge_base', 'financials',
];

// Default features per role — what each role can access out of the box
export const ROLE_DEFAULT_FEATURES: Record<string, FeatureKey[]> = {
  super_admin: Object.keys(FEATURES) as FeatureKey[], // everything, no exceptions

  // Everything except the owner-level pages above
  admin: (Object.keys(FEATURES) as FeatureKey[]).filter(f => !SUPER_ADMIN_FEATURES.includes(f)),

  sales: [
    'home', 'fleet_checkin', 'in_shop', 'graphics', 'estimates',
    'time', 'messages', 'customers', 'parts_catalog', 'schedule', 'prospects', 'upfit_projects',
    'upfit_configurator',
  ],

  graphics_production: [
    'home', 'in_shop', 'graphics', 'estimates',
    'time', 'messages', 'customers', 'parts_catalog', 'schedule',
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

  // AP/bookkeeping: the payment queue plus enough context to verify what's
  // being paid — without admin's user management or data tools.
  finance: [
    'home', 'messages', 'time', 'reports', 'vendor_payments', 'customers',
  ],

  // Leadership: the Home dashboard's Financials tab and nothing else — no
  // settings, user management, or ops tooling. `financials` is otherwise
  // super-admin-only, so this explicit grant is what lets an executive see it.
  executive: [
    'home', 'financials',
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

  // Admin gets everything except the super-admin-only pages (so features
  // added later default on for admins without a role-list edit); super
  // admin gets everything, no exceptions.
  if (roles.includes('admin')) {
    for (const key of Object.keys(FEATURES) as FeatureKey[]) {
      if (!SUPER_ADMIN_FEATURES.includes(key)) features.add(key);
    }
  }
  if (roles.includes('super_admin')) {
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
