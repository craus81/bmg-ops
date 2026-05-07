'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS } from '@/lib/types';
import type { GraphicsJobStatus } from '@/lib/types';
import WidgetShell from './WidgetShell';

interface AccountJob {
  id: string;
  title: string;
  customer: string | null;
  status: GraphicsJobStatus;
  due_date: string | null;
  type: 'graphics';
}

export default function MyAccountsWidget() {
  const router = useRouter();
  const { user } = useAuth();
  const supabase = createClient();
  const [jobs, setJobs] = useState<AccountJob[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    loadJobs();
  }, [user]);

  const loadJobs = async () => {
    // Get active graphics jobs (not shipped/installed/cancelled)
    const { data: graphicsJobs } = await supabase
      .from('graphics_jobs')
      .select('id, title, customer, status, due_date')
      .not('status', 'in', '("shipped","installed","cancelled")')
      .order('due_date', { ascending: true, nullsFirst: false });

    const mapped: AccountJob[] = (graphicsJobs || []).map((j: any) => ({
      id: j.id,
      title: j.title,
      customer: j.customer,
      status: j.status,
      due_date: j.due_date,
      type: 'graphics' as const,
    }));

    setJobs(mapped);
    setLoading(false);
  };

  // Group by customer
  const byCustomer: Record<string, AccountJob[]> = {};
  for (const job of jobs) {
    const key = job.customer || 'Unknown';
    if (!byCustomer[key]) byCustomer[key] = [];
    byCustomer[key].push(job);
  }
  const customerEntries = Object.entries(byCustomer).sort((a, b) => b[1].length - a[1].length);

  return (
    <WidgetShell title={`Active Jobs (${jobs.length})`} icon="" onHeaderClick={() => router.push('/graphics')}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>Loading...</div>
      ) : jobs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>No active jobs</div>
      ) : (
        <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
          {customerEntries.map(([customer, custJobs]) => (
            <div key={customer} style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', padding: '2px 4px', marginBottom: '2px' }}>
                {customer} ({custJobs.length})
              </div>
              {custJobs.map(job => {
                const statusColor = GRAPHICS_STATUS_COLORS[job.status] || '#6b7280';
                const isOverdue = job.due_date && new Date(job.due_date) < new Date();
                return (
                  <div key={job.id} onClick={() => router.push('/graphics')} style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '5px 6px', borderRadius: '6px', cursor: 'pointer',
                    background: 'var(--bg)', marginBottom: '2px',
                  }}>
                    <div style={{
                      width: '6px', height: '6px', borderRadius: '50%',
                      background: statusColor, flexShrink: 0,
                    }} />
                    <div style={{ flex: 1, fontSize: '11px', fontWeight: 600, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.title}
                    </div>
                    <span style={{ fontSize: '9px', fontWeight: 700, color: statusColor, whiteSpace: 'nowrap' }}>
                      {GRAPHICS_STATUS_LABELS[job.status]?.replace('Job ', '') || job.status}
                    </span>
                    {isOverdue && <span style={{ fontSize: '9px', fontWeight: 800, color: '#ef4444' }}>LATE</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}
