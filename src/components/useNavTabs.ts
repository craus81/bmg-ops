'use client';

import { useAuth } from '@/components/AuthProvider';
import { ROLE_DEFAULT_FEATURES } from '@/lib/features';
import { allTabs, resolveNavTabs, AI_TAB_ID, type Tab } from '@/lib/nav-tabs';

// Every role that isn't 'customer'. Used to tell a customer-ONLY account
// (locked to the portal nav) from a staff account that merely also carries
// the customer role.
const STAFF_ROLES = Object.keys(ROLE_DEFAULT_FEATURES).filter(r => r !== 'customer');

/** Who gets FleetSuite AI (the chat panel and its bottom-bar tab). */
export function useAiChatAccess(): boolean {
  const { isAdmin, isSales, isGraphicsProduction, isInstaller } = useAuth();
  return isAdmin || isSales || isGraphicsProduction || isInstaller;
}

/**
 * The bottom bar for the signed-in user.
 *
 * `available` is every tab they may put in the bar; `tabs` is what the bar
 * shows (their saved choice, or the role default), without More.
 * `customerOnly` accounts get the fixed portal nav and cannot customize.
 */
export function useNavTabs(): { available: Tab[]; tabs: Tab[]; customerOnly: boolean; aiInBar: boolean } {
  const { hasFeature, isCustomer, hasRole, profile } = useAuth();
  const aiAccess = useAiChatAccess();

  // The portal nav (My Jobs + Settings) is for customer-ONLY accounts. An
  // admin/staff profile that also has the customer role (e.g. linked to a
  // NetSuite customer to use the portal) keeps the full staff nav —
  // 'customer' must not veto every other tab.
  const customerOnly = isCustomer && !STAFF_ROLES.some(r => hasRole(r));
  if (customerOnly) {
    const tabs = [{ id: 'customer-dashboard', path: '/customer/dashboard', label: 'My Jobs', feature: 'home' as const, priority: 0 }];
    return { available: tabs, tabs, customerOnly, aiInBar: false };
  }

  const available = allTabs.filter(tab => {
    if (tab.id === AI_TAB_ID) return aiAccess;
    if (!tab.feature) return true;
    // Check-In merged into In-Shop: either feature grants the In-Shop tab
    // (a user with only fleet_checkin still needs a way to the panel).
    if (tab.id === 'tracking') return hasFeature('in_shop') || hasFeature('fleet_checkin');
    return hasFeature(tab.feature);
  });
  const tabs = resolveNavTabs(available, profile?.nav_tabs);
  return { available, tabs, customerOnly, aiInBar: tabs.some(t => t.id === AI_TAB_ID) };
}
