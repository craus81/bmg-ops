/**
 * Bottom-bar tabs, and which of them a given user sees.
 *
 * The bar holds MAX_TABS tabs plus a fixed More button. With no saved choice
 * a user gets the role default: the highest-priority tabs they have access
 * to, with FleetSuite AI in the last slot. A user can pick and order their
 * own tabs (More → Customize Bottom Bar); that choice is saved on their
 * profile (`profiles.nav_tabs`, migration 325) so it follows them from the
 * iPhone app to the desktop.
 *
 * A saved choice can only NARROW or REORDER what the role allows: every id
 * is re-checked against the tabs the user can see right now, so losing a
 * feature (or an admin using View As) quietly drops that tab rather than
 * showing a dead one.
 */
import type { FeatureKey } from '@/lib/features';

export interface Tab {
  id: string;
  /** Route to open. The AI tab has none: it opens the chat panel instead. */
  path: string;
  label: string;
  feature?: FeatureKey;
  priority: number; // lower = more important, shown first
}

/** The AI tab opens the chat panel over the current page. */
export const AI_TAB_ID = 'ai';

export const MAX_TABS = 7; // + More = 8 total

// Every tab a staff user can put in the bar, in default priority order.
export const allTabs: Tab[] = [
  { id: 'home', path: '/home', label: 'Home', feature: 'home', priority: 0 },
  { id: 'upfit', path: '/upfit', label: 'Upfit', feature: 'upfit_projects', priority: 0.5 },
  { id: 'graphics', path: '/graphics', label: 'Graphics', feature: 'graphics', priority: 1 },
  { id: 'tracking', path: '/tracking', label: 'In-Shop', feature: 'in_shop', priority: 3 },
  // POs and Scans go after In-Shop so they slot in on the right of the
  // existing visible tabs without displacing anything.
  { id: 'pos', path: '/admin/pos', label: 'POs', feature: 'purchase_orders', priority: 3.2 },
  { id: 'scans', path: '/admin/scans', label: 'Scans', feature: 'reports', priority: 3.3 },
  { id: 'prospects', path: '/admin/prospects', label: 'Customers', feature: 'prospects', priority: 3.5 },
  { id: 'schedule', path: '/admin/schedule', label: 'Schedule', feature: 'schedule', priority: 4 },
  { id: 'scan', path: '/scan', label: 'Scan', feature: 'scan', priority: 5 },
  { id: 'estimates', path: '/estimates', label: 'Estimates', feature: 'estimates', priority: 7 },
  { id: 'installer-portal', path: '/installer', label: 'CNI Jobs', feature: 'cni_portal', priority: 8 },
  { id: AI_TAB_ID, path: '', label: 'AI', priority: 9 },
];

/**
 * The tabs for a user's bar, in display order (More is added by the caller).
 *
 * @param available  tabs this user may see right now (already access-filtered)
 * @param saved      the user's saved tab ids, or null/empty for the default
 */
export function resolveNavTabs(available: Tab[], saved: string[] | null | undefined): Tab[] {
  if (saved && saved.length > 0) {
    const byId = new Map(available.map(t => [t.id, t]));
    const seen = new Set<string>();
    const picked: Tab[] = [];
    for (const id of saved) {
      const tab = byId.get(id);
      if (!tab || seen.has(id)) continue;
      seen.add(id);
      picked.push(tab);
      if (picked.length === MAX_TABS) break;
    }
    // Every saved tab lost its access: fall back to the default rather than
    // leave a bar with nothing but More.
    if (picked.length > 0) return picked;
  }
  return defaultNavTabs(available);
}

/** The role default: top tabs by priority, with AI kept in the last slot. */
export function defaultNavTabs(available: Tab[]): Tab[] {
  const ai = available.find(t => t.id === AI_TAB_ID);
  const rest = available
    .filter(t => t.id !== AI_TAB_ID)
    .sort((a, b) => a.priority - b.priority);
  return ai ? [...rest.slice(0, MAX_TABS - 1), ai] : rest.slice(0, MAX_TABS);
}
