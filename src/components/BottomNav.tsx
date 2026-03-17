'use client';

import { usePathname, useRouter } from 'next/navigation';
import { theme } from '@/lib/theme';

interface BottomNavProps {
  clockStatus: 'out' | 'in' | 'break';
}

const tabs = [
  { id: 'home', path: '/home', label: 'Home', icon: '🏠' },
  { id: 'time', path: '/time', label: 'Time', icon: '⏰' },
  { id: 'fleet', path: '/fleet', label: 'Fleet', icon: '🚚' },
  { id: 'tracking', path: '/tracking', label: 'Tracking', icon: '📋' },
  { id: 'vehicles', path: '/vehicles', label: 'Vehicles', icon: '🚐' },
  { id: 'more', path: '/more', label: 'More', icon: '⋯' },
];

export default function BottomNav({ clockStatus }: BottomNavProps) {
  const pathname = usePathname();
  const router = useRouter();

  const getIcon = (tab: typeof tabs[0]) => {
    if (tab.id === 'time') {
      if (clockStatus === 'in') return '🟢';
      if (clockStatus === 'break') return '🟡';
    }
    return tab.icon;
  };

  const isActive = (tab: typeof tabs[0]) => {
    if (tab.path === '/home') return pathname === '/home' || pathname === '/scan' || pathname === '/select-part' || pathname === '/photos';
    if (tab.path === '/fleet') return pathname === '/fleet' || pathname === '/fleet/update';
    if (tab.path === '/tracking') return pathname === '/tracking';
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
