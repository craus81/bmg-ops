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

export default function CniDashboardPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();
  const [jobs, setJobs] = useState<CniJobSummary[]>([]);
  const [installerCount, setInstallerCount] = useState(0);
  const [pendingPhotos, setPendingPhotos] = useState(0);
  const [pendingInvoices, setPendingInvoices] = useState(0);
  const [biddingJobs, setBiddingJobs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('active');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin]);

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

    // Count CNI installers
    const { count } = await supabase
      .from('cni_profiles')
      .select('*', { count: 'exact', head: true });
    setInstallerCount(count || 0);

    // Pending photo reviews
    const { count: photoCount } = await supabase
      .from('cni_job_photos')
      .select('*', { count: 'exact', head: true })
      .eq('review_status', 'pending');
    setPendingPhotos(photoCount || 0);

    // Pending invoices
    if (jobsData) {
      setPendingInvoices(jobsData.filter((j: any) => j.status === 'completed_pending_review').length);
      setBiddingJobs(jobsData.filter((j: any) => j.status === 'bidding_open').length);
    }

    setLoading(false);
  };

  const filteredJobs = jobs.filter(j => {
    if (statusFilter === 'active') return j.status !== 'approved_closed';
    if (statusFilter === 'all') return true;
    return j.status === statusFilter;
  });

  const statusCounts = jobs.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const activeCount = jobs.filter(j => j.status !== 'approved_closed').length;
  const needsReview = jobs.filter(j => j.status === 'completed_pending_review').length;
  const unassigned = jobs.filter(j => j.status === 'awaiting_assignment').length;
  const overdue = jobs.filter(j => j.deadline && new Date(j.deadline) < new Date() && j.status !== 'approved_closed').length;

  if (loading) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading CNI Dashboard...
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            CNI Dashboard
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Certified Network Installer Management
          </div>
        </div>
        <button
          onClick={() => router.push('/admin/cni/jobs/new')}
          style={{
            padding: '10px 18px', borderRadius: '10px',
            background: 'var(--orange)', color: '#fff',
            fontSize: '13px', fontWeight: 700, border: 'none',
          }}
        >
          + New Job
        </button>
      </div>

      {/* Stats Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Active Jobs" value={activeCount} color="var(--orange)" />
        <StatCard label="Needs Review" value={needsReview} color="var(--warning)" />
        <StatCard label="Unassigned" value={unassigned} color="var(--text-muted)" />
        <StatCard label="Overdue" value={overdue} color="var(--error)" />
      </div>

      {/* Pending Actions */}
      {(pendingPhotos > 0 || pendingInvoices > 0 || biddingJobs > 0) && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'color-mix(in srgb, var(--warning) 6%, var(--card))',
          border: '1px solid var(--warning-border)',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)', marginBottom: '8px' }}>NEEDS YOUR ATTENTION</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {pendingPhotos > 0 && (
              <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                <strong>{pendingPhotos}</strong> photo{pendingPhotos !== 1 ? 's' : ''} awaiting review
              </div>
            )}
            {pendingInvoices > 0 && (
              <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                <strong>{pendingInvoices}</strong> job{pendingInvoices !== 1 ? 's' : ''} pending completion review
              </div>
            )}
            {biddingJobs > 0 && (
              <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                <strong>{biddingJobs}</strong> job{biddingJobs !== 1 ? 's' : ''} with open bidding
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quick Links */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', marginBottom: '20px' }}>
        <QuickLink icon="" label="All Jobs" sub={`${jobs.length} total`} onClick={() => setStatusFilter('all')} />
        <QuickLink icon="" label="Installers" sub={`${installerCount} registered`} onClick={() => router.push('/admin/cni/installers')} />
        <QuickLink icon="" label="Companies" sub="Installer companies" onClick={() => router.push('/admin/cni/companies')} />
        <QuickLink icon="" label="Vendor IDs" sub="NetSuite payout IDs" onClick={() => router.push('/admin/cni/vendor-ids')} />
        <QuickLink icon="" label="Pay Rates" sub="Per-vehicle pay" onClick={() => router.push('/admin/pay-rates')} />
        <QuickLink icon="" label="Payroll" sub="Field install pay" onClick={() => router.push('/admin/payroll')} />
        <QuickLink icon="" label="Preview Portal" sub="See the installer view" onClick={() => router.push('/installer')} />
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '4px' }}>
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
              padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
              whiteSpace: 'nowrap',
              background: statusFilter === f.id ? 'var(--orange)' : 'var(--card)',
              color: statusFilter === f.id ? '#fff' : 'var(--text-secondary)',
              border: statusFilter === f.id ? 'none' : '1px solid var(--border)',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Job List */}
      {filteredJobs.length === 0 ? (
        <div style={{
          padding: '40px 20px', textAlign: 'center',
          background: 'var(--card)', borderRadius: '14px',
          border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>No jobs found</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filteredJobs.map(job => (
            <button
              key={job.id}
              onClick={() => router.push(`/admin/cni/jobs/${job.id}`)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '14px 16px', borderRadius: '12px',
                background: 'var(--card)', border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {job.title}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {job.job_number} {job.customer_name ? `• ${job.customer_name}` : ''}
                  </div>
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '3px 8px',
                  borderRadius: '6px', whiteSpace: 'nowrap',
                  color: STATUS_COLORS[job.status] || 'var(--text-muted)',
                  background: `color-mix(in srgb, ${STATUS_COLORS[job.status] || 'var(--text-muted)'} 12%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${STATUS_COLORS[job.status] || 'var(--text-muted)'} 25%, transparent)`,
                }}>
                  {STATUS_LABELS[job.status] || job.status}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
                {job.installer_name && <span>{job.installer_name}</span>}
                {job.deadline && (
                  <span style={{ color: new Date(job.deadline) < new Date() && job.status !== 'approved_closed' ? 'var(--error)' : 'var(--text-muted)' }}>
                    {new Date(job.deadline).toLocaleDateString()}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: '12px',
      background: 'var(--card)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: '22px', fontWeight: 800, color, letterSpacing: '-1px' }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginTop: '2px' }}>{label}</div>
    </div>
  );
}

function QuickLink({ icon, label, sub, onClick }: { icon: string; label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: '14px 16px', borderRadius: '12px', textAlign: 'left',
      background: 'var(--card)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)', width: '100%',
    }}>
      {icon && <div style={{ fontSize: '20px' }}>{icon}</div>}
      <div>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{label}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{sub}</div>
      </div>
    </button>
  );
}
