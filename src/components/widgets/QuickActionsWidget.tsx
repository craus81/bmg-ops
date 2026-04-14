'use client';

import { useRouter } from 'next/navigation';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

const ACTIONS = [
  { label: 'Jobs & Bills', path: '/jobs', desc: 'Review jobs' },
  { label: 'Scheduler', path: '/admin/schedule', desc: 'Assign work' },
  { label: 'Photo Reviews', path: '/admin/reviews', desc: 'Approve photos' },
  { label: 'CNI Dashboard', path: '/admin/cni', desc: 'Installer program' },
  { label: 'Customers', path: '/admin/customers', desc: 'Customer directory' },
  { label: 'Scan Log', path: '/admin/scans', desc: 'Export & invoice' },
];

export default function QuickActionsWidget() {
  const router = useRouter();

  return (
    <WidgetShell title="Quick Actions" icon="" loading={false}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        {ACTIONS.map(a => (
          <button key={a.path} onClick={() => router.push(a.path)} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
            padding: '10px 6px', borderRadius: '10px', border: 'none', textAlign: 'center',
            background: 'var(--subtle-bg)', cursor: 'pointer',
          }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: theme.textPrimary }}>{a.label}</span>
          </button>
        ))}
      </div>
    </WidgetShell>
  );
}
