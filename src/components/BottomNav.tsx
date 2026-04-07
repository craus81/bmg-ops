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
  feature?: FeatureKey;
  alwaysShow?: boolean;
}

const allTabs: Tab[] = [
  { id: 'home', path: '/home', feature: 'home' },
  { id: 'my-jobs', path: '/my-jobs', feature: 'vehicles' },
  { id: 'installer-portal', path: '/installer', feature: 'cni_management' },
  { id: 'scan-install', path: '/scan-install', feature: 'scan_install' },
  { id: 'time', path: '/time', feature: 'time' },
  { id: 'graphics', path: '/graphics', feature: 'graphics' },
  { id: 'fleet', path: '/fleet', feature: 'fleet_checkin' },
  { id: 'tracking', path: '/tracking', feature: 'in_shop' },
  { id: 'vehicles', path: '/vehicles', feature: 'vehicles' },
  { id: 'estimates', path: '/estimates', feature: 'estimates' },
  { id: 'more', path: '/more', alwaysShow: true },
  // Customer-only
  { id: 'customer-dashboard', path: '/customer/dashboard', feature: 'home' },
  { id: 'customer-settings', path: '/settings', alwaysShow: true },
];

// Labels defined separately so tabs render cleanly
const TAB_LABELS: Record<string, string> = {
  home: 'Home', 'my-jobs': 'My Jobs', 'installer-portal': 'CNI Jobs',
  'scan-install': 'Scan & Install', time: 'Time', graphics: 'Graphics',
  fleet: 'Check In', tracking: 'In-Shop', vehicles: 'Vehicles',
  estimates: 'Estimates', more: 'More',
  'customer-dashboard': 'My Jobs', 'customer-settings': 'Settings',
};

export default function BottomNav({ clockStatus }: BottomNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { hasFeature, isCustomer } = useAuth();

  // Filter tabs by feature access
  const tabs = allTabs.filter(tab => {
    if (tab.alwaysShow) return true;
    if (!tab.feature) return true;
    // Customer-only tabs
    if (tab.id === 'customer-dashboard' || tab.id === 'customer-settings') {
      return isCustomer;
    }
    // Hide customer tabs for non-customers
    if (isCustomer && tab.id !== 'customer-dashboard' && tab.id !== 'customer-settings') {
      return false;
    }
    return hasFeature(tab.feature);
  });

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
            {TAB_LABELS[tab.id] || tab.id}
          </button>
        );
      })}
    </nav>
  );
}
