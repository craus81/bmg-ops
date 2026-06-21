'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePopout } from '@/components/Popout';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import { GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS } from '@/lib/types';
import type { GraphicsJobStatus } from '@/lib/types';
import WidgetShell from './WidgetShell';

const ACTIVE_STATUSES = ['received', 'designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing', 'ready', 'shipped'];
const DONE_STATUSES = ['installed', 'picked_up'];

export default function ActiveJobsWidget() {
  const router = useRouter();
  const { open: openPopout } = usePopout();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ received: 0, active: 0, ready: 0 });
  const [recentJobs, setRecentJobs] = useState<any[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: jobs } = await supabase
      .from('graphics_jobs')
      .select('id, title, status, customer, part_number, quantity, due_date, created_at')
      .in('status', ACTIVE_STATUSES)
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(100);

    const all = jobs || [];
    const received = all.filter((j: any) => j.status === 'received');
    const inProd = all.filter((j: any) => ['designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing'].includes(j.status));
    const ready = all.filter((j: any) => j.status === 'ready' || j.status === 'shipped');

    setStats({
      received: received.length,
      active: inProd.length,
      ready: ready.length,
    });
    setRecentJobs(all.slice(0, 6));
    setLoading(false);
  };

  return (
    <WidgetShell title="Active Jobs" icon="" loading={loading} onHeaderClick={() => router.push('/graphics')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.received}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Received</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--warning)' }}>{stats.active}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>In Production</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.ready}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Ready/Shipped</div>
          </div>
        </div>

        {recentJobs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentJobs.map(job => {
              const statusColor = GRAPHICS_STATUS_COLORS[job.status as GraphicsJobStatus] || 'var(--text-muted)';
              const statusLabel = GRAPHICS_STATUS_LABELS[job.status as GraphicsJobStatus] || job.status;
              return (
                <button key={job.id} onClick={() => openPopout('graphics_jobs', job.id)} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                  padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                  background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
                }}>
                  <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
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
