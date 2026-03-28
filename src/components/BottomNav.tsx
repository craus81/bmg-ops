'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface BottomNavProps {
  clockStatus: 'out' | 'in' | 'break';
}

import type { AppRole } from '@/lib/types';

interface Tab {
  id: string;
  path: string;
  label: string;
  icon: string;
  roles?: AppRole[];
}

// ── Role-based tab visibility ──
// admin:               everything
// field_tech:          home (VIN scanner), vehicles, time, chat, more
// shop_tech:           home, fleet, tracking, time, chat, more
// sales:              home, fleet (read-only), graphics, estimates, time, chat, more
// graphics_production: home, fleet (read-only), graphics, estimates, time, chat, more
// installer:           home, time, chat, more (pre-approval limited)
// customer:            customer dashboard, settings

const allTabs: Tab[] = [
  { id: 'home', path: '/home', label: 'Home', icon: '🏠', roles: ['admin', 'installer', 'field_tech', 'shop_tech', 'sales', 'graphics_production'] },
  { id: 'my-jobs', path: '/my-jobs', label: 'My Jobs', icon: '📋', roles: ['field_tech', 'shop_tech'] },
  { id: 'installer-portal', path: '/installer', label: 'CNI Jobs', icon: '👷', roles: ['installer'] },
  { id: 'time', path: '/time', label: 'Time', icon: '⏰', roles: ['admin', 'installer', 'field_tech', 'shop_tech', 'sales', 'graphics_production'] },
  { id: 'graphics', path: '/graphics', label: 'Graphics', icon: '🎨', roles: ['admin', 'graphics_production', 'sales'] },
  { id: 'fleet', path: '/fleet', label: 'Fleet', icon: '🚚', roles: ['admin', 'shop_tech', 'sales', 'graphics_production'] },
  { id: 'tracking', path: '/tracking', label: 'Tracking', icon: '📋', roles: ['admin', 'shop_tech'] },
  { id: 'vehicles', path: '/vehicles', label: 'Vehicles', icon: '🚐', roles: ['admin', 'field_tech'] },
  { id: 'estimates', path: '/estimates', label: 'Estimates', icon: '📝', roles: ['admin', 'sales', 'graphics_production'] },
  { id: 'messages', path: '/messages', label: 'Chat', icon: '💬' },
  { id: 'more', path: '/more', label: 'More', icon: '⋯', roles: ['admin', 'installer', 'field_tech', 'shop_tech', 'sales', 'graphics_production'] },
  // Customer-only tabs
  { id: 'customer-dashboard', path: '/customer/dashboard', label: 'My Jobs', icon: '📋', roles: ['customer'] },
  { id: 'customer-settings', path: '/settings', label: 'Settings', icon: '⚙️', roles: ['customer'] },
];

export default function BottomNav({ clockStatus }: BottomNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { profile } = useAuth();

  // Multi-role: check roles[] array first, fall back to legacy role field
  // Map legacy 'production' to 'graphics_production'
  const rawRoles: string[] = (profile?.roles && profile.roles.length > 0)
    ? profile.roles as string[]
    : (profile?.role ? [profile.role as string] : ['installer']);
  const userRoles: AppRole[] = rawRoles.map(r => (r === 'production' ? 'graphics_production' : r)) as AppRole[];

  // Filter tabs: show if tab has no role restriction, or user has any matching role
  const tabs = allTabs.filter(tab => !tab.roles || tab.roles.some(r => userRoles.includes(r)));

  const getIcon = (tab: Tab) => {
    if (tab.id === 'time') {
      if (clockStatus === 'in') return '🟢';
      if (clockStatus === 'break') return '🟡';
    }
    return tab.icon;
  };

  const isActive = (tab: Tab) => {
    if (tab.path === '/home') return pathname === '/home' || pathname === '/scan' || pathname === '/select-part' || pathname === '/photos';
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
      display: 'flex', zIndex: 100,
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    }}>
      {tabs.map((tab) => {
        const active = isActive(tab);
        return (
          <button
            key={tab.id}
            onClick={() => router.push(tab.path)}
            style={{
              flex: 1, padding: '8px 4px 10px', display: 'flex',
              flexDirection: 'column', alignItems: 'center', gap: '2px',
              color: active ? theme.textPrimary : theme.textMuted,
              position: 'relative',
            }}
          >
            {active && (
              <div style={{
                position: 'absolute', top: '-1px', left: '25%', right: '25%',
                height: '2px', background: theme.orange, borderRadius: '0 0 2px 2px',
              }} />
            )}
            <div style={{ fontSize: '16px' }}>{getIcon(tab)}</div>
            <div style={{ fontSize: '9px', fontWeight: active ? 700 : 600 }}>{tab.label}</div>
          </button>
        );
      })}
    </nav>
  );
}
