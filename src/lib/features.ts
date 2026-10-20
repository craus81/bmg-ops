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
  messages: 'Messages / Chat',

  // Admin / More menu
  purchase_orders: 'Purchase Orders',
  customers: 'Customers & Contacts',
  parts_catalog: 'Parts Catalog',
  installer_parts: 'Installer Parts (no prices)',
  parts_ordering: 'Parts Ordering',
  schedule: 'Schedule',
  reports: 'Reports',
  user_management: 'User Management',
  cni_portal: 'CNI Portal',
  cni_admin: 'CNI Admin Console',
  knowledge_base: 'Knowledge Base',
  vendor_payments: 'Vendor Payments',
  bulk_upload: 'Bulk Upload (Templates)',
  proof_search: 'Proof Search',
  payroll: 'Payroll & Pay Rates',
  part_admin: 'Part Admin (rules, dimensions, interiors)',
  invoice_admin: 'Invoice Locations',
  data_import: 'Data Import',
  proof_admin: 'Proof Sweep',
  install_admin: 'Install Checklist Templates',
  prospects: 'Customers (Sales CRM)',
  credit_applications: 'Credit Applications',
  upfit_projects: 'Jobs',
  upfit_configurator: 'Upfit Designer (3D)',
  audit_log: 'Audit Log',
  system_health: 'System Health',
  ai_instructions: 'AI Instructions',
  financials: 'Financials (Executive)',
  ledger: 'Ledger (QuickBooks & NetSuite history)',

  // Pages that were gated by role in code until the Permissions screen
  // (owner ask 2026-10-20). Each one's role defaults below match exactly
  // who could open it before, so adding the key changed nobody's access.
  graphics_builder: 'Graphics Builder',
  quotes: 'Quotes & Unmatched Sales Orders',
  invoicing: 'Invoicing',
  install_guides: 'Install Guides',
  client_files: 'Client Files',
  completion_photos: 'Completion Photos',
  after_hours_calls: 'After-hours Calls',
  qc_fixes: 'QC Fixes',
  // Prices, cost and margin anywhere in the app (src/lib/money-visibility.ts).
  see_prices: 'See prices, cost & margin',
} as const;

export type FeatureKey = keyof typeof FEATURES;

// Roles that belong to internal BMG staff. Excludes 'customer' accounts,
// external CNI 'installer' accounts, and 'executive' — the same set
// requireStaff() gates the company-wide routes on, and the DB's
// is_internal_staff() allowlist (migration 224). It lives here rather than in
// api-auth.ts so CLIENT components can ask the same question without pulling
// server-only code into the bundle: a surface whose API is staff-only (the
// universal search) must not render for an account the API will 403.
export const INTERNAL_STAFF_ROLES: string[] = [
  'admin', 'super_admin', 'sales', 'graphics_production', 'shop_tech', 'field_tech', 'finance',
];

// Owner-level pages: super admins only by default. Regular admins don't see
// these, but can be granted individual ones via per-user feature overrides.
// `financials` is here so the executive P&L view (A/R, A/P, cash) is walled
// off from regular admins — only super_admin (all features) and the
// executive role (explicit default below) get it.
export const SUPER_ADMIN_FEATURES: FeatureKey[] = [
  'user_management', 'audit_log', 'system_health', 'ai_instructions', 'knowledge_base', 'financials',
];

// Every internal staff role could open these four before they had keys
// (the More menu showed them to INTERNAL_STAFF_ROLES).
const STAFF_TOOLS: FeatureKey[] = ['client_files', 'completion_photos', 'after_hours_calls', 'qc_fixes'];

// Default features per role — what each role can access out of the box
export const ROLE_DEFAULT_FEATURES: Record<string, FeatureKey[]> = {
  super_admin: Object.keys(FEATURES) as FeatureKey[], // everything, no exceptions

  // Everything except the owner-level pages above
  admin: (Object.keys(FEATURES) as FeatureKey[]).filter(f => !SUPER_ADMIN_FEATURES.includes(f)),

  sales: [
    'home', 'fleet_checkin', 'in_shop', 'graphics', 'estimates',
    'messages', 'customers', 'parts_catalog', 'schedule', 'prospects', 'upfit_projects',
    'upfit_configurator', 'parts_ordering',
    'graphics_builder', 'quotes', 'invoicing', 'install_guides', 'see_prices', ...STAFF_TOOLS,
  ],

  // upfit_projects: graphics and both tech roles get assigned upfit tasks and
  // are @mentioned in project notes — their notification deep links land on
  // /upfit, so they must hold its key (found by the gate audit: task-assignment
  // pushes bounced every non-admin/sales assignee once /upfit was gated).
  // estimates REMOVED (owner decision 2026-09-17): the estimates page is a
  // quoting page — line prices, totals, margin, the customer send. Graphics
  // production needs the job, not what it was quoted at, and the pieces they
  // genuinely used (proof files attached to an estimate) are managed from the
  // graphics job record, not here. An individual who needs it back can be
  // granted it with a per-user feature override.
  graphics_production: [
    'home', 'in_shop', 'graphics',
    'messages', 'customers', 'parts_catalog', 'schedule', 'upfit_projects',
    'graphics_builder', 'install_guides', ...STAFF_TOOLS,
  ],

  // parts_ordering: shop techs are the ones staring at a short readiness
  // card — raising the purchase request is exactly their moment.
  // installer_parts (Craig, 2026-10-20): the price-free parts list — part
  // photo, description, labor hours, install files and installed photos —
  // for techs and outside installers. Prices never leave the server.
  shop_tech: [
    'home', 'scan', 'fleet_checkin', 'in_shop',
    'messages', 'schedule', 'upfit_projects', 'parts_ordering', 'installer_parts', ...STAFF_TOOLS,
  ],

  // schedule: install events are about field techs and calendar-note mentions
  // deep-link them to /admin/schedule (shop_tech already held it).
  field_tech: [
    'home', 'scan', 'in_shop', 'fleet_checkin', 'messages', 'schedule',
    'upfit_projects', 'installer_parts', ...STAFF_TOOLS,
  ],

  installer: [
    'home', 'scan', 'messages', 'cni_portal', 'installer_parts',
  ],

  // AP/bookkeeping: the payment queue plus enough context to verify what's
  // being paid — without admin's user management or data tools.
  // invoicing: the Invoicing page already admitted finance (its menu entry
  // just never showed it).
  finance: [
    'home', 'messages', 'reports', 'vendor_payments', 'customers',
    'credit_applications', 'ledger', 'invoicing', 'see_prices', ...STAFF_TOOLS,
  ],

  // Leadership: the Home dashboard's Financials tab and nothing else — no
  // settings, user management, or ops tooling. `financials` is otherwise
  // super-admin-only, so this explicit grant is what lets an executive see it.
  executive: [
    'home', 'financials', 'ledger', 'see_prices',
  ],

  customer: ['home'],
};

/**
 * Does this role set carry admin authority? super_admin is a strict SUPERSET
 * of admin (owner decision 2026-09-07): everywhere the app accepts an admin
 * it accepts a super_admin, matching what the DB policies (233/234/248/250),
 * `is_internal_staff()` (224), and the feature resolver below already do.
 * The only walls that stay narrower are the deliberate ones — requireSuperAdmin
 * (owner-level) and requireFinancials (super_admin/executive, NOT admin).
 * Use this instead of `roles.includes('admin')` for any authorization or
 * admin-audience decision; a literal check is correct only when the question
 * is about the 'admin' role VALUE itself (role pickers, chip styling).
 */
export function isAdminRole(roles: string[]): boolean {
  return roles.includes('admin') || roles.includes('super_admin');
}

/**
 * A super admin's change to one role's default for one feature, saved on
 * More → Admin → Permissions (table role_feature_settings, migration 418).
 * Applied on top of ROLE_DEFAULT_FEATURES, under each person's own
 * user_feature_overrides — so the order is: code default → role setting →
 * per-person exception.
 */
export interface RoleFeatureSetting {
  role: string;
  feature: string;
  granted: boolean;
}

/** Roles the Permissions screen edits. super_admin always has everything. */
export const EDITABLE_ROLES: string[] = [
  'admin', 'sales', 'graphics_production', 'shop_tech', 'field_tech', 'finance', 'executive', 'installer', 'customer',
];

/** A role's out-of-the-box features, before any saved role setting. */
export function roleDefaultFeatures(role: string): Set<FeatureKey> {
  if (role === 'super_admin') return new Set(Object.keys(FEATURES) as FeatureKey[]);
  if (role === 'admin') {
    // Everything except the super-admin-only pages, so features added
    // later default on for admins without a role-list edit.
    return new Set((Object.keys(FEATURES) as FeatureKey[]).filter(f => !SUPER_ADMIN_FEATURES.includes(f)));
  }
  return new Set((ROLE_DEFAULT_FEATURES[role] || []) as FeatureKey[]);
}

/**
 * May the Permissions screen turn `feature` ON for `role`? Turning a feature
 * OFF is always allowed. Two walls stay:
 *   * Owner-level pages (SUPER_ADMIN_FEATURES) can't be handed to a whole
 *     role here — their APIs are super-admin-only, so the switch would open
 *     a page that then refuses every request. One person can still be given
 *     one through their own override on the Users page.
 *   * Roles outside BMG staff (CNI installers from other companies,
 *     customers, executive) can only keep what they ship with: the APIs
 *     behind every other page refuse non-staff logins, and those walls are
 *     what keep company-wide data away from outside accounts.
 * The resolver enforces this too, so a stray row can never widen access.
 */
export function canGrantToRole(role: string, feature: string): boolean {
  if (!(feature in FEATURES)) return false;
  const key = feature as FeatureKey;
  if (roleDefaultFeatures(role).has(key)) return true;
  if (SUPER_ADMIN_FEATURES.includes(key)) return false;
  return INTERNAL_STAFF_ROLES.includes(role);
}

/** One role's features once its saved settings are applied. */
export function roleFeatures(role: string, roleSettings: RoleFeatureSetting[] = []): Set<FeatureKey> {
  const features = roleDefaultFeatures(role);
  if (role === 'super_admin') return features; // no exceptions, so nobody can be locked out
  for (const s of roleSettings) {
    if (s.role !== role || !(s.feature in FEATURES)) continue;
    const key = s.feature as FeatureKey;
    if (s.granted) {
      if (canGrantToRole(role, key)) features.add(key);
    } else {
      features.delete(key);
    }
  }
  return features;
}

/**
 * Resolve the effective features for a user: each role's defaults with that
 * role's saved settings applied, unioned across their roles, then their own
 * per-user overrides.
 */
export function resolveFeatures(
  roles: string[],
  overrides: { feature: string; granted: boolean }[],
  roleSettings: RoleFeatureSetting[] = [],
): Set<FeatureKey> {
  const features = new Set<FeatureKey>();

  for (const role of roles) {
    for (const f of roleFeatures(role, roleSettings)) features.add(f);
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
