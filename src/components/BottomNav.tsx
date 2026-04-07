'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import type { FeatureKey } from '@/lib/features';

interface BottomNavProps {
  clockStatus: 'out' | 'in' | 'break';
}

interface Tab {
  id: string;
  path: string;
  label: string;
  feature?: FeatureKey;
  alwaysShow?: boolean;
  priority: number; // lower = more important, shown first
}

// All possible tabs with priority — only top 5 + More will show
const allTabs: Tab[] = [
  { id: 'home', path: '/home', label: 'Home', feature: 'home', priority: 0 },
  { id: 'graphics', path: '/graphics', label: 'Graphics', feature: 'graphics', priority: 1 },
  { id: 'fleet', path: '/fleet', label: 'Check In', feature: 'fleet_checkin', priority: 2 },
  { id: 'tracking', path: '/tracking', label: 'In-Shop', feature: 'in_shop', priority: 3 },
  { id: 'time', path: '/time', label: 'Time', feature: 'time', priority: 4 },
  { id: 'scan-install', path: '/scan-install', label: 'Scan', feature: 'scan_install', priority: 5 },
  { id: 'vehicles', path: '/vehicles', label: 'Vehicles', feature: 'vehicles', priority: 6 },
  { id: 'estimates', path: '/estimates', label: 'Estimates', feature: 'estimates', priority: 7 },
  { id: 'installer-portal', path: '/installer', label: 'CNI Jobs', feature: 'cni_management', priority: 1 },
  { id: 'my-jobs', path: '/my-jobs', label: 'My Jobs', feature: 'vehicles', priority: 1 },
  // Customer-only
  { id: 'customer-dashboard', path: '/customer/dashboard', label: 'My Jobs', feature: 'home', priority: 0 },
];

const MAX_TABS = 5; // + More = 6 total

export default function BottomNav({ clockStatus }: BottomNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { hasFeature, isCustomer } = useAuth();

  // Filter by feature access
  let visibleTabs = allTabs.filter(tab => {
    if (!tab.feature) return true;
    if (tab.id === 'customer-dashboard') return isCustomer;
    if (isCustomer && tab.id !== 'customer-dashboard') return false;
    return hasFeature(tab.feature);
  });

  // Sort by priority, take top MAX_TABS
  visibleTabs.sort((a, b) => a.priority - b.priority);
  const tabs = visibleTabs.slice(0, MAX_TABS);

  // Always add More at the end (unless customer)
  if (!isCustomer) {
    tabs.push({ id: 'more', path: '/more', label: 'More', alwaysShow: true, priority: 99 });
  } else {
    tabs.push({ id: 'customer-settings', path: '/settings', label: 'Settings', alwaysShow: true, priority: 99 });
  }

  const isActive = (tab: Tab) => {
    if (tab.path === '/home') return pathname === '/home' || pathname === '/photos';
    if (tab.path === '/scan-install') return pathname === '/scan-install' || pathname === '/scan' || pathname === '/select-part';
    if (tab.path === '/fleet') return pathname === '/fleet' || pathname === '/fleet/update';
    if (tab.path === '/tracking') return pathname === '/tracking';
    if (tab.path === '/my-jobs') return pathname === '/my-jobs' || pathname.startsWith('/jobs/');
    if (tab.path === '/installer') return pathname.startsWith('/installer');
    if (tab.path === '/graphics') return pathname.startsWith('/graphics');
    if (tab.path === '/estimates') return pathname.startsWith('/estimates');
    if (tab.path === '/customer/dashboard') return pathname.startsWith('/customer');
    return pathname.startsWith(tab.path);
  };

  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      background: theme.navBg,
      borderTop: `1px solid ${theme.border}`,
      display: 'flex', alignItems: 'center', gap: '4px',
      zIndex: 100,
      padding: '6px 10px',
      paddingBottom: 'calc(6px + env(safe-area-inset-bottom, 0px))',
    }}>
      {tabs.map((tab) => {
        const active = isActive(tab);
        return (
          <button
            key={tab.id}
            onClick={() => router.push(tab.path)}
            style={{
              flex: 1, padding: '8px 4px', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              borderRadius: '8px',
              background: active ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.04)',
              border: active ? '1px solid rgba(59,130,246,0.35)' : '1px solid rgba(255,255,255,0.08)',
              color: active ? '#60a5fa' : theme.textMuted,
              fontSize: '9px',
              fontWeight: active ? 800 : 600,
              letterSpacing: '0.01em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
