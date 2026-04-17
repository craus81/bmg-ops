'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import type { FeatureKey } from '@/lib/features';
import {
  Home, Palette, ClipboardCheck, Warehouse, Users,
  CalendarDays, ScanLine, Clock, FileText, Briefcase,
  LayoutGrid, Settings, MoreHorizontal, Wrench,
} from 'lucide-react';

interface BottomNavProps {
  clockStatus: 'out' | 'in' | 'break';
}

export interface Tab {
  id: string;
  path: string;
  label: string;
  feature?: FeatureKey;
  alwaysShow?: boolean;
  priority: number; // lower = more important, shown first
}

// All possible tabs with priority — only top 5 + More will show
export const allTabs: Tab[] = [
  { id: 'home', path: '/home', label: 'Home', feature: 'home', priority: 0 },
  { id: 'upfit', path: '/upfit', label: 'Upfit', feature: 'upfit_projects', priority: 0.5 },
  { id: 'graphics', path: '/graphics', label: 'Graphics', feature: 'graphics', priority: 1 },
  { id: 'fleet', path: '/fleet', label: 'Check In', feature: 'fleet_checkin', priority: 2 },
  { id: 'tracking', path: '/tracking', label: 'In-Shop', feature: 'in_shop', priority: 3 },
  { id: 'prospects', path: '/admin/prospects', label: 'CRM', feature: 'prospects', priority: 3.5 },
  { id: 'schedule', path: '/admin/schedule', label: 'Schedule', feature: 'schedule', priority: 4 },
  { id: 'scan', path: '/scan', label: 'Scan', feature: 'scan', priority: 5 },
  { id: 'time', path: '/time', label: 'Time', feature: 'time', priority: 6 },
  { id: 'estimates', path: '/estimates', label: 'Estimates', feature: 'estimates', priority: 7 },
  { id: 'installer-portal', path: '/installer', label: 'CNI Jobs', feature: 'cni_management', priority: 8 },
  // Customer-only
  { id: 'customer-dashboard', path: '/customer/dashboard', label: 'My Jobs', feature: 'home', priority: 0 },
];

const TAB_ICONS: Record<string, React.ElementType> = {
  home: Home,
  graphics: Palette,
  fleet: ClipboardCheck,
  tracking: Warehouse,
  prospects: Users,
  schedule: CalendarDays,
  scan: ScanLine,
  time: Clock,
  estimates: FileText,
  'installer-portal': Briefcase,
  upfit: Wrench,
  'customer-dashboard': LayoutGrid,
  more: MoreHorizontal,
  'customer-settings': Settings,
};

export const MAX_TABS = 5; // + More = 6 total

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
    if (tab.path === '/scan') return pathname === '/scan';
    if (tab.path === '/fleet') return pathname === '/fleet';
    if (tab.path === '/tracking') return pathname === '/tracking';
    if (tab.path === '/admin/prospects') return pathname.startsWith('/admin/prospects');
    if (tab.path === '/installer') return pathname.startsWith('/installer');
    if (tab.path === '/graphics') return pathname.startsWith('/graphics');
    if (tab.path === '/estimates') return pathname.startsWith('/estimates');
    if (tab.path === '/upfit') return pathname.startsWith('/upfit');
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
      padding: '6px 12px',
      paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
      paddingLeft: 'calc(12px + env(safe-area-inset-left, 0px))',
      paddingRight: 'calc(12px + env(safe-area-inset-right, 0px))',
    }}>
      {tabs.map((tab) => {
        const active = isActive(tab);
        const Icon = TAB_ICONS[tab.id];
        return (
          <button
            key={tab.id}
            className={active ? undefined : 'bottom-nav-tab'}
            onClick={() => router.push(tab.path)}
            style={{
              flex: 1, padding: '6px 4px', display: 'flex',
              flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: '2px',
              borderRadius: '8px',
              background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
              border: active ? '1px solid rgba(59,130,246,0.35)' : '1px solid transparent',
              color: active ? '#60a5fa' : theme.textMuted,
              fontSize: '9px',
              fontWeight: active ? 800 : 600,
              letterSpacing: '0.01em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              minWidth: 0,
              transition: 'all 0.15s',
            }}
          >
            {Icon && <Icon size={18} strokeWidth={active ? 2.5 : 2} />}
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
