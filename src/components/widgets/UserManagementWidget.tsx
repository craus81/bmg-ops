'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function UserManagementWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ active: 0, pending: 0 });
  const [pendingUsers, setPendingUsers] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, status')
      .limit(1000);

    const all = profiles || [];
    const active = all.filter((p: any) => p.status === 'approved');
    const pending = all.filter((p: any) => p.status === 'pending');

    setStats({ active: active.length, pending: pending.length });
    setPendingUsers(pending.slice(0, 3));
    setLoading(false);
  };

  return (
    <WidgetShell title="User Management" icon="" loading={loading} onHeaderClick={() => router.push('/admin/users')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.active}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Active Users</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#fbbf24' }}>{stats.pending}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Pending Approval</div>
          </div>
        </div>

        {pendingUsers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {pendingUsers.map(u => (
              <button key={u.id} onClick={() => router.push('/admin/users')} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                  {u.full_name || 'Unnamed User'}
                </span>
                <span style={{
                  fontSize: '9px', fontWeight: 700, textTransform: 'uppercase',
                  color: '#fbbf24', padding: '2px 6px', borderRadius: '4px', background: '#fbbf2418',
                }}>Pending</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
