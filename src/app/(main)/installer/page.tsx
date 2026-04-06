'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

const STATUS_LABELS: Record<string, string> = {
  awaiting_assignment: 'Awaiting Assignment',
  bidding_open: 'Open for Bids',
  assigned_awaiting_scheduling: 'Awaiting Scheduling',
  scheduling_proposed: 'Schedule Proposed',
  scheduled_pending_confirmation: 'Confirm Schedule',
  scheduled_confirmed: 'Scheduled',
  in_progress: 'In Progress',
  completed_pending_review: 'Under Review',
  approved_closed: 'Closed',
};

export default function InstallerPortalPage() {
  const router = useRouter();
  const { user, isInstaller, isAdmin } = useAuth();
  const supabase = createClient();
  const [jobs, setJobs] = useState<any[]>([]);
  const [hasProfile, setHasProfile] = useState(false);
  const [inviteCount, setInviteCount] = useState(0);
  const [openJobCount, setOpenJobCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    if (!isInstaller && !isAdmin) { router.push('/home'); return; }
    loadData();
  }, [user, isInstaller, isAdmin]);

  const loadData = async () => {
    if (!user) return;

    // Check if CNI profile exists
    const { data: profile } = await supabase
      .from('cni_profiles')
      .select('id, profile_complete')
      .eq('user_id', user.id)
      .single();
    setHasProfile(!!profile);

    // Load assigned jobs
    const { data: jobsData } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, customer_name, deadline, confirmed_schedule_start')
      .eq('assigned_installer_id', user.id)
      .order('created_at', { ascending: false });
    setJobs(jobsData || []);

    // Count pending invites (unseen)
    const { count: invCount } = await supabase
      .from('cni_job_invites')
      .select('*', { count: 'exact', head: true })
      .eq('installer_id', user.id)
      .is('seen_at', null);
    setInviteCount(invCount || 0);

    // Count open board jobs
    const { count: openCount } = await supabase
      .from('cni_jobs')
      .select('*', { count: 'exact', head: true })
      .in('status', ['awaiting_assignment', 'bidding_open'])
      .eq('distribution_type', 'published')
      .is('assigned_installer_id', null);
    setOpenJobCount(openCount || 0);

    setLoading(false);
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const activeJobs = jobs.filter(j => j.status !== 'approved_closed');
  const completedJobs = jobs.filter(j => j.status === 'approved_closed');

  return (
    <div>
      <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px', marginBottom: '4px' }}>
        Installer Portal
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '20px' }}>
        Certified Network Installer
      </div>

      {/* Profile prompt */}
      {!hasProfile && (
        <button
          onClick={() => router.push('/installer/profile')}
          style={{
            width: '100%', padding: '16px', borderRadius: '14px', textAlign: 'left',
            background: 'var(--warning-bg)', border: '1px solid var(--warning-border)',
            marginBottom: '16px',
          }}
        >
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--warning)' }}>
            Complete Your CNI Profile
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Set up your company info, capabilities, and availability to receive jobs
          </div>
        </button>
      )}

      {/* New Invites Banner */}
      {inviteCount > 0 && (
        <button
          onClick={() => router.push('/installer/available')}
          style={{
            width: '100%', padding: '14px 16px', borderRadius: '14px', textAlign: 'left',
            background: 'color-mix(in srgb, var(--orange) 10%, var(--card))',
            border: '1px solid var(--orange)', marginBottom: '16px',
            display: 'flex', alignItems: 'center', gap: '12px',
          }}
        >
          <div style={{
            width: '36px', height: '36px', borderRadius: '50%',
            background: 'var(--orange)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', fontWeight: 800, flexShrink: 0,
          }}>
            {inviteCount}
          </div>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--orange)' }}>
              New Job Invite{inviteCount !== 1 ? 's' : ''}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Tap to view and respond
            </div>
          </div>
        </button>
      )}

      {/* Quick Links */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
        <button
          onClick={() => router.push('/installer/profile')}
          style={{
            padding: '14px 12px', borderRadius: '12px', textAlign: 'left',
            background: 'var(--card)', border: '1px solid var(--border)',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>Profile</div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>My Profile</div>
        </button>
        <button
          onClick={() => router.push('/installer/available')}
          style={{
            padding: '14px 12px', borderRadius: '12px', textAlign: 'left',
            background: (inviteCount + openJobCount) > 0
              ? 'color-mix(in srgb, var(--orange) 5%, var(--card))'
              : 'var(--card)',
            border: (inviteCount + openJobCount) > 0
              ? '1px solid var(--orange)'
              : '1px solid var(--border)',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>Invites</div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>Available</div>
          <div style={{ fontSize: '11px', color: (inviteCount + openJobCount) > 0 ? 'var(--orange)' : 'var(--text-muted)' }}>
            {inviteCount + openJobCount} job{(inviteCount + openJobCount) !== 1 ? 's' : ''}
          </div>
        </button>
        <button
          onClick={() => router.push('/installer/jobs')}
          style={{
            padding: '14px 12px', borderRadius: '12px', textAlign: 'left',
            background: 'var(--card)', border: '1px solid var(--border)',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>Jobs</div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>My Jobs</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{jobs.length} total</div>
        </button>
      </div>

      {/* Active Jobs */}
      <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
        Active Jobs ({activeJobs.length})
      </div>
      {activeJobs.length === 0 ? (
        <div style={{
          padding: '30px', textAlign: 'center', borderRadius: '14px',
          background: 'var(--card)', border: '1px solid var(--border)', marginBottom: '20px',
        }}>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No active jobs right now</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
          {activeJobs.map(job => (
            <button
              key={job.id}
              onClick={() => router.push(`/installer/jobs/${job.id}`)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '14px 16px', borderRadius: '12px',
                background: 'var(--card)', border: '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{job.title}</div>
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                  background: job.status === 'in_progress' ? 'var(--orange-soft)' : 'var(--subtle-bg)',
                  color: job.status === 'in_progress' ? 'var(--orange)' : 'var(--text-muted)',
                }}>
                  {STATUS_LABELS[job.status] || job.status}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {job.job_number} {job.customer_name ? `• ${job.customer_name}` : ''}
                {job.confirmed_schedule_start ? ` • ${new Date(job.confirmed_schedule_start).toLocaleDateString()}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Completed Jobs */}
      {completedJobs.length > 0 && (
        <>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
            Completed ({completedJobs.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '80px' }}>
            {completedJobs.slice(0, 5).map(job => (
              <button
                key={job.id}
                onClick={() => router.push(`/installer/jobs/${job.id}`)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '12px 16px', borderRadius: '12px',
                  background: 'var(--card)', border: '1px solid var(--border)', opacity: 0.7,
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{job.title}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {job.job_number} • ✓ Closed
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
