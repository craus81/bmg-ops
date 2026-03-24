'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface BottomNavProps {
  clockStatus: 'out' | 'in' | 'break';
}

type AppRole = 'admin' | 'installer' | 'production' | 'sales' | 'customer';

interface Tab {
  id: string;
  path: string;
  label: string;
  icon: string;
  roles?: AppRole[];
}

const allTabs: Tab[] = [
  { id: 'home', path: '/home', label: 'Home', icon: '🏠', roles: ['admin', 'installer', 'production', 'sales'] },
  { id: 'my-jobs', path: '/my-jobs', label: 'My Jobs', icon: '📋', roles: ['installer', 'production'] },
  { id: 'time', path: '/time', label: 'Time', icon: '⏰', roles: ['admin', 'installer', 'production', 'sales'] },
  { id: 'graphics', path: '/graphics', label: 'Graphics', icon: '🎨', roles: ['admin', 'production', 'sales'] },
  { id: 'fleet', path: '/fleet', label: 'Fleet', icon: '🚚', roles: ['admin', 'installer', 'production', 'sales'] },
  { id: 'tracking', path: '/tracking', label: 'Tracking', icon: '📋', roles: ['admin'] },
  { id: 'vehicles', path: '/vehicles', label: 'Vehicles', icon: '🚐', roles: ['admin', 'installer', 'production', 'sales'] },
  { id: 'messages', path: '/messages', label: 'Chat', icon: '💬' },
  { id: 'more', path: '/more', label: 'More', icon: '⋯', roles: ['admin', 'installer', 'production', 'sales'] },
  // Customer-only tabs
  { id: 'customer-dashboard', path: '/customer/dashboard', label: 'My Jobs', icon: '📋', roles: ['customer'] },
  { id: 'customer-settings', path: '/settings', label: 'Settings', icon: '⚙️', roles: ['customer'] },
];

export default function BottomNav({ clockStatus }: BottomNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { profile } = useAuth();

  // Multi-role: check roles[] array first, fall back to legacy role field
  const userRoles: AppRole[] = (profile?.roles && profile.roles.length > 0)
    ? profile.roles as AppRole[]
    : (profile?.role ? [profile.role as AppRole] : ['installer']);

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
    if (tab.path === '/graphics') return pathname.startsWith('/graphics');
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
