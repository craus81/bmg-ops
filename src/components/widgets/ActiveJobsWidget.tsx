'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function ActiveJobsWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, inProgress: 0, pending: 0, completed: 0 });
  const [recentJobs, setRecentJobs] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: jobs } = await supabase
      .from('graphics_jobs')
      .select('id, title, status, customer, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    const all = jobs || [];
    const inProgress = all.filter(j => j.status === 'in_progress' || j.status === 'assigned');
    const pending = all.filter(j => j.status === 'pending' || j.status === 'queued');
    const completed = all.filter(j => j.status === 'completed' || j.status === 'approved');

    setStats({
      total: all.length,
      inProgress: inProgress.length,
      pending: pending.length,
      completed: completed.length,
    });
    setRecentJobs(all.filter(j => j.status !== 'completed' && j.status !== 'approved' && j.status !== 'cancelled').slice(0, 5));
    setLoading(false);
  };

  return (
    <WidgetShell title="Active Jobs" icon="" loading={loading}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--warning)' }}>{stats.pending}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Pending</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--navy-light)' }}>{stats.inProgress}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Active</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--success)' }}>{stats.completed}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Done</div>
          </div>
        </div>

        {recentJobs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentJobs.map(job => (
              <button key={job.id} onClick={() => router.push(`/jobs/${job.id}`)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                  {job.title || job.customer || 'Untitled'}
                </span>
                <span style={{
                  fontSize: '9px', fontWeight: 700, textTransform: 'uppercase',
                  color: job.status === 'in_progress' ? 'var(--navy-light)' : 'var(--warning)',
                  padding: '2px 6px', borderRadius: '4px',
                  background: job.status === 'in_progress' ? 'rgba(42,97,120,0.1)' : 'var(--warning-bg)',
                }}>{job.status?.replace(/_/g, ' ')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
