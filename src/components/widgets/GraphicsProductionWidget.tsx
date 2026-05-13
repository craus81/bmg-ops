'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

const STATUS_COLORS: Record<string, string> = {
  received: '#60a5fa',
  designing: '#a78bfa',
  revision: '#f97316',
  printing: '#34d399',
  outgassing: '#67e8f9',
  cutting: '#fbbf24',
  packing: '#c084fc',
  ready: '#4ade80',
  shipped: '#3b82f6',
};

const IN_PRODUCTION_STATUSES = ['designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing'];

export default function GraphicsProductionWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ received: 0, inProduction: 0, readyShipped: 0 });
  const [recentJobs, setRecentJobs] = useState<any[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: jobs } = await supabase
      .from('graphics_jobs')
      .select('id, title, status, customer, created_at')
      .order('created_at', { ascending: false });

    const all = (jobs || []).filter((j: any) => !['installed', 'picked_up', 'cancelled'].includes(j.status || ''));
    const received = all.filter((j: any) => j.status === 'received').length;
    const inProduction = all.filter((j: any) => IN_PRODUCTION_STATUSES.includes(j.status)).length;
    const readyShipped = all.filter((j: any) => j.status === 'ready' || j.status === 'shipped').length;

    setStats({ received, inProduction, readyShipped });
    setRecentJobs(all.slice(0, 5));
    setLoading(false);
  };

  return (
    <WidgetShell title="Graphics Production" icon="" loading={loading} onHeaderClick={() => router.push('/graphics')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.received}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Received</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--warning)' }}>{stats.inProduction}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>In Production</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.readyShipped}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Ready/Shipped</div>
          </div>
        </div>

        {recentJobs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentJobs.map(job => {
              const statusColor = STATUS_COLORS[job.status] || 'var(--text-muted)';
              const statusLabel = job.status;
              return (
                <button key={job.id} onClick={() => router.push(`/graphics?id=${job.id}`)} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                  padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                  background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
                }}>
                  <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>
                    {job.title || job.customer || 'Untitled'}
                  </span>
                  <span style={{
                    fontSize: '9px', fontWeight: 700, textTransform: 'uppercase',
                    color: statusColor,
                    padding: '2px 6px', borderRadius: '4px',
                    background: `${statusColor}18`,
                  }}>{statusLabel}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
