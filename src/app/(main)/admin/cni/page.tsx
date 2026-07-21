'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface CniJobSummary {
  id: string;
  job_number: string;
  title: string;
  status: string;
  customer_name: string | null;
  deadline: string | null;
  assigned_installer_id: string | null;
  installer_name?: string;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  awaiting_assignment: 'Awaiting Assignment',
  bidding_open: 'Bidding Open',
  assigned_awaiting_scheduling: 'Assigned — Awaiting Scheduling',
  scheduling_proposed: 'Scheduling Proposed',
  scheduled_pending_confirmation: 'Scheduled — Pending Confirmation',
  scheduled_confirmed: 'Scheduled (Confirmed)',
  in_progress: 'In Progress',
  completed_pending_review: 'Completed — Pending Review',
  approved_closed: 'Approved / Closed',
};

const STATUS_COLORS: Record<string, string> = {
  awaiting_assignment: 'var(--warning)',
  bidding_open: '#f59e0b',
  assigned_awaiting_scheduling: 'var(--text-secondary)',
  scheduling_proposed: '#60a5fa',
  scheduled_pending_confirmation: '#a78bfa',
  scheduled_confirmed: 'var(--success)',
  in_progress: 'var(--orange)',
  completed_pending_review: '#fbbf24',
  approved_closed: 'var(--success)',
};

// List filters: real statuses plus the tile/attention pseudo-filters.
type Filter = 'active' | 'all' | 'overdue' | 'needs_photos' | string;

export default function CniDashboardPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const supabase = createClient();
  const [jobs, setJobs] = useState<CniJobSummary[]>([]);
  const [installerCount, setInstallerCount] = useState(0);
  const [photoJobIds, setPhotoJobIds] = useState<Set<string>>(new Set());
  const [pendingPhotos, setPendingPhotos] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Filter>('active');
  // When on, group the job list by assigned installer (A–Z); unassigned last.
  const [sortByInstaller, setSortByInstaller] = useState(false);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin]);

  const loadData = async () => {
    // Load jobs with installer names
    const { data: jobsData } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, customer_name, deadline, assigned_installer_id, created_at')
      .order('created_at', { ascending: false });

    if (jobsData) {
      // Get installer names for assigned jobs
      const installerIds = [...new Set(jobsData.filter((j: any) => j.assigned_installer_id).map((j: any) => j.assigned_installer_id))];
      let nameMap: Record<string, string> = {};
      if (installerIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', installerIds);
        if (profiles) {
          profiles.forEach((p: any) => { nameMap[p.id] = p.full_name; });
        }
      }
      setJobs(jobsData.map((j: any) => ({
        ...j,
        installer_name: j.assigned_installer_id ? nameMap[j.assigned_installer_id] || 'Unknown' : undefined,
      })));
    }

    // Count CNI installers — anyone tagged installer in user management,
    // whether or not they've completed a cni_profiles onboarding record.
    const { count } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .or('role.eq.installer,roles.cs.{installer}');
    setInstallerCount(count || 0);

    // Pending photo reviews — keep the job ids so the attention line can
    // filter the list to exactly the jobs with photos waiting.
    const { data: photoRows } = await supabase
      .from('cni_job_photos')
      .select('job_id')
      .eq('review_status', 'pending');
    setPendingPhotos((photoRows || []).length);
    setPhotoJobIds(new Set((photoRows || []).map((p: any) => p.job_id).filter(Boolean)));

    setLoading(false);
  };

  const now = new Date();
  const isOverdue = (j: CniJobSummary) => !!j.deadline && new Date(j.deadline) < now && j.status !== 'approved_closed';

  const filteredJobs = jobs.filter(j => {
    if (statusFilter === 'active') return j.status !== 'approved_closed';
    if (statusFilter === 'all') return true;
    if (statusFilter === 'overdue') return isOverdue(j);
    if (statusFilter === 'needs_photos') return photoJobIds.has(j.id);
    return j.status === statusFilter;
  });

  // '~' sorts after any letter, so unassigned jobs fall to the bottom.
  const displayJobs = sortByInstaller
    ? [...filteredJobs].sort((a, b) => (a.installer_name || '~~~').localeCompare(b.installer_name || '~~~'))
    : filteredJobs;

  const statusCounts = jobs.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const activeCount = jobs.filter(j => j.status !== 'approved_closed').length;
  const needsReview = statusCounts['completed_pending_review'] || 0;
  const unassigned = statusCounts['awaiting_assignment'] || 0;
  const biddingJobs = statusCounts['bidding_open'] || 0;
  const overdue = jobs.filter(isOverdue).length;

  if (loading) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading CNI Dashboard...
      </div>
    );
  }

  const navPill = (label: string, path: string, sub?: string) => (
    <button
      key={path}
      onClick={() => router.push(path)}
      title={sub}
      style={{
        padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
        background: 'var(--subtle-bg)', border: '1px solid var(--border)',
        color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            Certified Network Installers
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {activeCount} active job{activeCount !== 1 ? 's' : ''} · {installerCount} installer{installerCount !== 1 ? 's' : ''} in the network
          </div>
        </div>
        <button
          onClick={() => router.push('/admin/cni/jobs/new')}
          style={{
            padding: '10px 18px', borderRadius: '10px', flexShrink: 0,
            background: 'var(--orange)', color: '#fff',
            fontSize: '13px', fontWeight: 700, border: 'none',
          }}
        >
          + New Job
        </button>
      </div>

      {/* Section nav — one compact row instead of a grid of jumbo cards */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {navPill('Installers', '/admin/cni/installers', `${installerCount} registered`)}
        {navPill('Companies', '/admin/cni/companies', 'Installer companies')}
        {navPill('Vendor IDs', '/admin/cni/vendor-ids', 'NetSuite payout IDs')}
        {navPill('Pay Rates', '/admin/pay-rates', 'Per-vehicle pay')}
        {navPill('Payroll', '/admin/payroll', 'Field install pay')}
        {navPill('Installer Portal ↗', '/installer', 'See the installer view')}
      </div>

      {/* Stat tiles — click to filter the job list */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '14px' }}>
        {[
          { id: 'active' as Filter, label: 'Active', value: activeCount, color: 'var(--orange)' },
          { id: 'awaiting_assignment' as Filter, label: 'Unassigned', value: unassigned, color: unassigned > 0 ? '#60a5fa' : 'var(--text-muted)' },
          { id: 'completed_pending_review' as Filter, label: 'Needs Review', value: needsReview, color: needsReview > 0 ? 'var(--warning)' : 'var(--text-muted)' },
          { id: 'overdue' as Filter, label: 'Overdue', value: overdue, color: overdue > 0 ? 'var(--error)' : 'var(--success)' },
        ].map(t => {
          const active = statusFilter === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setStatusFilter(active && t.id !== 'active' ? 'active' : t.id)}
              title={active && t.id !== 'active' ? 'Back to all active jobs' : 'Show only these jobs'}
              style={{
                padding: '10px 12px', borderRadius: '12px', textAlign: 'left', cursor: 'pointer',
                background: active ? `color-mix(in srgb, ${t.color} 10%, var(--card))` : 'var(--card)',
                border: `1px solid ${active ? t.color : 'var(--border)'}`,
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div style={{ fontSize: '20px', fontWeight: 800, color: t.color, letterSpacing: '-1px' }}>{t.value}</div>
              <div style={{ fontSize: '10px', color: active ? t.color : 'var(--text-muted)', fontWeight: 700, marginTop: '1px', whiteSpace: 'nowrap' }}>{t.label}</div>
            </button>
          );
        })}
      </div>

      {/* Pending actions — every line is a link to the work itself */}
      {(pendingPhotos > 0 || needsReview > 0 || biddingJobs > 0) && (
        <div style={{
          padding: '10px 12px', borderRadius: '12px', marginBottom: '14px',
          background: 'color-mix(in srgb, var(--warning) 6%, var(--card))',
          border: '1px solid var(--warning-border)',
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '4px' }}>Needs your attention</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {pendingPhotos > 0 && (
              <button onClick={() => setStatusFilter('needs_photos')} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 2px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}><strong>{pendingPhotos}</strong> photo{pendingPhotos !== 1 ? 's' : ''} awaiting review</span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>Show jobs →</span>
              </button>
            )}
            {needsReview > 0 && (
              <button onClick={() => setStatusFilter('completed_pending_review')} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 2px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}><strong>{needsReview}</strong> job{needsReview !== 1 ? 's' : ''} pending completion review</span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>Show jobs →</span>
              </button>
            )}
            {biddingJobs > 0 && (
              <button onClick={() => setStatusFilter('bidding_open')} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 2px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}><strong>{biddingJobs}</strong> job{biddingJobs !== 1 ? 's' : ''} with open bidding</span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>Show jobs →</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Filter pills + sort, one row */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', overflowX: 'auto', paddingBottom: '4px', alignItems: 'center' }}>
        {[
          { id: 'active', label: `Active (${activeCount})` },
          { id: 'awaiting_assignment', label: `Unassigned (${unassigned})` },
          { id: 'bidding_open', label: `Bidding (${biddingJobs})` },
          { id: 'in_progress', label: `In Progress (${statusCounts['in_progress'] || 0})` },
          { id: 'completed_pending_review', label: `Review (${needsReview})` },
          { id: 'all', label: 'All' },
        ].map(f => (
          <button
            key={f.id}
            onClick={() => setStatusFilter(f.id)}
            style={{
              padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
              whiteSpace: 'nowrap', flexShrink: 0,
              background: statusFilter === f.id ? 'var(--orange)' : 'var(--card)',
              color: statusFilter === f.id ? '#fff' : 'var(--text-secondary)',
              border: statusFilter === f.id ? 'none' : '1px solid var(--border)',
            }}
          >
            {f.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setSortByInstaller(v => !v)}
          style={{
            padding: '7px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            whiteSpace: 'nowrap', flexShrink: 0,
            background: sortByInstaller ? 'var(--orange)' : 'var(--card)',
            color: sortByInstaller ? '#fff' : 'var(--text-secondary)',
            border: sortByInstaller ? 'none' : '1px solid var(--border)',
          }}
        >
          {sortByInstaller ? '✓ By installer' : 'By installer'}
        </button>
      </div>

      {/* Pseudo-filter banner so it's obvious the list is narrowed */}
      {(statusFilter === 'overdue' || statusFilter === 'needs_photos') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 700, color: statusFilter === 'overdue' ? 'var(--error)' : 'var(--warning)' }}>
          {statusFilter === 'overdue' ? `Showing ${filteredJobs.length} overdue job${filteredJobs.length !== 1 ? 's' : ''}` : `Showing ${filteredJobs.length} job${filteredJobs.length !== 1 ? 's' : ''} with photos awaiting review`}
          <button onClick={() => setStatusFilter('active')} style={{ padding: '2px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>✕ Clear</button>
        </div>
      )}

      {/* Job List */}
      {displayJobs.length === 0 ? (
        <div style={{
          padding: '40px 20px', textAlign: 'center',
          background: 'var(--card)', borderRadius: '14px',
          border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>No jobs found</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {displayJobs.map((job, i) => {
            // Group headers when sorted by installer
            const prev = displayJobs[i - 1];
            const groupLabel = (j: CniJobSummary) => j.installer_name || 'Unassigned';
            const showGroup = sortByInstaller && (!prev || groupLabel(prev) !== groupLabel(job));
            return (
              <div key={job.id}>
                {showGroup && (
                  <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', margin: '10px 0 4px 2px' }}>
                    {groupLabel(job)}
                  </div>
                )}
                <button
                  onClick={() => router.push(`/admin/cni/jobs/${job.id}`)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '10px 14px', borderRadius: '10px',
                    background: 'var(--card)',
                    border: `1px solid ${isOverdue(job) ? 'color-mix(in srgb, var(--error) 35%, var(--border))' : 'var(--border)'}`,
                    boxShadow: 'var(--shadow-sm)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.title}
                    </div>
                    <span style={{
                      fontSize: '10px', fontWeight: 700, padding: '3px 8px',
                      borderRadius: '6px', whiteSpace: 'nowrap', flexShrink: 0,
                      color: STATUS_COLORS[job.status] || 'var(--text-muted)',
                      background: `color-mix(in srgb, ${STATUS_COLORS[job.status] || 'var(--text-muted)'} 12%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${STATUS_COLORS[job.status] || 'var(--text-muted)'} 25%, transparent)`,
                    }}>
                      {STATUS_LABELS[job.status] || job.status}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '10px', marginTop: '3px', fontSize: '11px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                    <span>{job.job_number}</span>
                    {job.customer_name && <span>{job.customer_name}</span>}
                    {job.installer_name && !sortByInstaller && <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{job.installer_name}</span>}
                    {job.deadline && (
                      <span style={{ color: isOverdue(job) ? 'var(--error)' : 'var(--text-muted)', fontWeight: isOverdue(job) ? 700 : 400 }}>
                        due {new Date(job.deadline).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </span>
                    )}
                    {photoJobIds.has(job.id) && <span style={{ color: 'var(--warning)', fontWeight: 700 }}>📷 photos to review</span>}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
