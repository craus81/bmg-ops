'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { theme } from '@/lib/theme';
import { AI_TAB_ID, type Tab } from '@/lib/nav-tabs';
import { AI_CHAT_STATE_EVENT, AI_CHAT_TOGGLE_EVENT } from '@/lib/ai-chat-events';
import { useNavTabs } from '@/components/useNavTabs';
import {
  Home, Palette, ClipboardCheck, Warehouse, Users,
  CalendarDays, ScanLine, Clock, FileText, Briefcase,
  LayoutGrid, Settings, MoreHorizontal, Wrench, Receipt, Bot,
} from 'lucide-react';

export const TAB_ICONS: Record<string, React.ElementType> = {
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
  pos: Receipt,
  scans: ScanLine,
  [AI_TAB_ID]: Bot,
  'customer-dashboard': LayoutGrid,
  more: MoreHorizontal,
  'customer-settings': Settings,
};

export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  // Which tabs, in which order: the user's saved choice or the role default
  // (src/lib/nav-tabs.ts, More → Customize Bottom Bar).
  const { tabs: chosen, customerOnly } = useNavTabs();
  const tabs = [...chosen];

  // The AI tab has no page; it highlights while the chat panel is open.
  const [aiOpen, setAiOpen] = useState(false);
  useEffect(() => {
    const onState = (e: Event) => setAiOpen(!!(e as CustomEvent<{ open: boolean }>).detail?.open);
    window.addEventListener(AI_CHAT_STATE_EVENT, onState);
    return () => window.removeEventListener(AI_CHAT_STATE_EVENT, onState);
  }, []);

  // Always add More at the end (unless customer-only)
  if (!customerOnly) {
    tabs.push({ id: 'more', path: '/more', label: 'More', priority: 99 });
  } else {
    tabs.push({ id: 'customer-settings', path: '/settings', label: 'Settings', priority: 99 });
  }

  const isActive = (tab: Tab) => {
    if (tab.id === AI_TAB_ID) return aiOpen;
    if (tab.path === '/home') return pathname === '/home';
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
      display: 'flex', alignItems: 'center', gap: '2px',
      zIndex: 100,
      padding: '4px 6px',
      paddingBottom: 'calc(6px + env(safe-area-inset-bottom, 0px))',
      paddingLeft: 'calc(6px + env(safe-area-inset-left, 0px))',
      paddingRight: 'calc(6px + env(safe-area-inset-right, 0px))',
    }}>
      {tabs.map((tab) => {
        const active = isActive(tab);
        const Icon = TAB_ICONS[tab.id];
        return (
          <button
            key={tab.id}
            className={active ? undefined : 'bottom-nav-tab'}
            onClick={() => tab.id === AI_TAB_ID
              ? window.dispatchEvent(new Event(AI_CHAT_TOGGLE_EVENT))
              : router.push(tab.path)}
            style={{
              flex: 1, padding: '6px 2px', display: 'flex',
              flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: '2px',
              borderRadius: '6px',
              background: active ? 'rgba(59,130,246,0.15)' : 'transparent',
              border: active ? '1px solid rgba(59,130,246,0.35)' : '1px solid transparent',
              color: active ? '#60a5fa' : theme.textMuted,
              fontSize: '10px',
              fontWeight: active ? 800 : 600,
              letterSpacing: '0.01em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              minWidth: 0,
              transition: 'all 0.15s',
            }}
          >
            {Icon && <Icon size={22} strokeWidth={active ? 2.5 : 2} />}
            {/* Ellipsis guard: with 8 tabs on a narrow phone the longest
                labels (Customers, Estimates) can exceed their slot at 10px —
                clip visually, screen readers still get the full text. */}
            <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
