'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function MyJobsWidget() {
  const router = useRouter();
  const supabase = createClient();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ assigned: 0, pending: 0, approved: 0 });
  const [recentJobs, setRecentJobs] = useState<any[]>([]);

  useEffect(() => { if (user?.id) load(); }, [user?.id]);

  const load = async () => {
    // Get jobs assigned to current user
    const { data: assignments } = await supabase
      .from('job_assignments')
      .select('job_id, job_type')
      .eq('user_id', user!.id)
      .order('assigned_at', { ascending: false })
      .limit(20);

    if (!assignments || assignments.length === 0) {
      setStats({ assigned: 0, pending: 0, approved: 0 });
      setRecentJobs([]);
      setLoading(false);
      return;
    }

    // Get vehicle jobs
    const vehicleIds = assignments.filter((a: any) => a.job_type === 'scanned_vehicle').map((a: any) => a.job_id);
    const graphicsIds = assignments.filter((a: any) => a.job_type === 'graphics_job').map((a: any) => a.job_id);

    const jobs: any[] = [];

    if (vehicleIds.length > 0) {
      const { data } = await supabase
        .from('scanned_vehicles')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, end_customer, review_status, scanned_at')
        .in('id', vehicleIds);
      (data || []).forEach((v: any) => jobs.push({ ...v, type: 'vehicle' }));
    }

    if (graphicsIds.length > 0) {
      const { data } = await supabase
        .from('graphics_jobs')
        .select('id, title, customer, status, created_at')
        .in('id', graphicsIds);
      (data || []).forEach((g: any) => jobs.push({ ...g, type: 'graphics' }));
    }

    const pending = jobs.filter(j => j.type === 'vehicle' ? j.review_status === 'pending' : !['shipped', 'picked_up', 'installed', 'cancelled'].includes(j.status)).length;
    const approved = jobs.filter(j => j.type === 'vehicle' && j.review_status === 'approved').length;

    setStats({ assigned: jobs.length, pending, approved });
    setRecentJobs(jobs.slice(0, 5));
    setLoading(false);
  };

  return (
    <WidgetShell title="My Jobs" icon="" loading={loading} onHeaderClick={() => router.push('/my-jobs')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.assigned}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Assigned</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--warning)' }}>{stats.pending}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Active</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.approved}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Done</div>
          </div>
        </div>

        {recentJobs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentJobs.map(job => (
              <button key={job.id} onClick={() => router.push(job.type === 'graphics' ? '/graphics' : '/my-jobs')} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: theme.textPrimary, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.type === 'graphics' ? job.title : [job.vehicle_year, job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ') || 'Unknown'}
                  </span>
                  <span style={{ fontSize: '9px', color: theme.textMuted, display: 'block' }}>
                    {job.type === 'graphics' ? (job.customer || 'Graphics') : (job.end_customer || job.vin)}
                  </span>
                </div>
                <span style={{
                  fontSize: '8px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px', flexShrink: 0,
                  background: job.type === 'graphics' ? 'rgba(167,139,250,0.1)' : 'rgba(59,130,246,0.1)',
                  color: job.type === 'graphics' ? '#a78bfa' : '#60a5fa',
                }}>{job.type === 'graphics' ? 'GFX' : 'VEH'}</span>
              </button>
            ))}
          </div>
        )}

        {recentJobs.length === 0 && !loading && (
          <div style={{ textAlign: 'center', padding: '8px', fontSize: '12px', color: theme.textMuted }}>
            No jobs assigned to you
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
