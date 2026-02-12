'use client';

import { usePathname, useRouter } from 'next/navigation';

interface BottomNavProps {
  clockStatus: 'out' | 'in' | 'break';
}

const tabs = [
  { id: 'home', path: '/home', label: 'Home', icon: '🏠' },
  { id: 'time', path: '/time', label: 'Time Clock', icon: '⏰' },
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
    return pathname.startsWith(tab.path);
  };

  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      background: '#141e2b', borderTop: '1px solid #1e2d3d',
      display: 'flex', zIndex: 100,
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => router.push(tab.path)}
          style={{
            flex: 1, padding: '8px 4px 10px', display: 'flex',
            flexDirection: 'column', alignItems: 'center', gap: '2px',
            color: isActive(tab) ? '#60a5fa' : '#4a5f78',
          }}
        >
          <div style={{ fontSize: '18px' }}>{getIcon(tab)}</div>
          <div style={{ fontSize: '10px', fontWeight: 700 }}>{tab.label}</div>
        </button>
      ))}
    </nav>
  );
}
