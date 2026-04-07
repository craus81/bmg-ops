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
// field_tech:          home, vehicles, time, chat, more
// shop_tech:           home, scan & install, vehicle check in, in-shop, time, chat, more
// sales:              home, scan & install, vehicle check in (read-only), graphics production, estimates, time, chat, more
// graphics_production: home, vehicle check in (read-only), graphics production, estimates, time, chat, more
// installer:           home, time, chat, more (pre-approval limited)
// customer:            customer dashboard, settings

const allTabs: Tab[] = [
  { id: 'home', path: '/home', label: 'Home', icon: '', roles: ['admin', 'installer', 'field_tech', 'shop_tech', 'sales', 'graphics_production'] },
  { id: 'my-jobs', path: '/my-jobs', label: 'My Jobs', icon: '', roles: ['field_tech', 'shop_tech'] },
  { id: 'installer-portal', path: '/installer', label: 'CNI Jobs', icon: '', roles: ['installer'] },
  { id: 'scan-install', path: '/scan-install', label: 'Scan & Install', icon: '', roles: ['sales', 'shop_tech'] },
  { id: 'time', path: '/time', label: 'Time', icon: '', roles: ['admin', 'installer', 'field_tech', 'shop_tech', 'sales', 'graphics_production'] },
  { id: 'graphics', path: '/graphics', label: 'Graphics', icon: '', roles: ['admin', 'graphics_production', 'sales'] },
  { id: 'fleet', path: '/fleet', label: 'Check In', icon: '', roles: ['admin', 'shop_tech', 'sales', 'graphics_production'] },
  { id: 'tracking', path: '/tracking', label: 'In-Shop', icon: '', roles: ['admin', 'shop_tech'] },
  { id: 'vehicles', path: '/vehicles', label: 'Vehicles', icon: '', roles: ['admin', 'field_tech'] },
  { id: 'estimates', path: '/estimates', label: 'Estimates', icon: '', roles: ['admin', 'sales', 'graphics_production'] },
  { id: 'more', path: '/more', label: 'More', icon: '⋯', roles: ['admin', 'installer', 'field_tech', 'shop_tech', 'sales', 'graphics_production'] },
  // Customer-only tabs
  { id: 'customer-dashboard', path: '/customer/dashboard', label: 'My Jobs', icon: '', roles: ['customer'] },
  { id: 'customer-settings', path: '/settings', label: 'Settings', icon: '', roles: ['customer'] },
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
      if (clockStatus === 'in') return '';
      if (clockStatus === 'break') return '';
    }
    return tab.icon;
  };

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
