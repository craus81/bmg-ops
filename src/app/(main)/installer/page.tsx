'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import InstallerPreviewBanner from '@/components/InstallerPreviewBanner';
import { getInstallerPreview, setInstallerPreview, type InstallerPreview } from '@/lib/installer-preview';

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
  const [readyForInstallCount, setReadyForInstallCount] = useState(0);
  const [readyForInstallStale, setReadyForInstallStale] = useState(0);
  const [loading, setLoading] = useState(true);

  // Admin preview: scope the portal to a chosen installer (admins only).
  const [preview, setPreview] = useState<InstallerPreview | null>(null);
  const [previewOptions, setPreviewOptions] = useState<{ profileId: string; name: string; companyId: string | null; companyName: string | null }[]>([]);
  const [previewSelect, setPreviewSelect] = useState('');

  useEffect(() => {
    if (!user) return;
    if (!isInstaller && !isAdmin) { router.push('/home'); return; }
    const p = isAdmin ? getInstallerPreview() : null;
    setPreview(p);
    loadData(p);
    if (isAdmin) loadPreviewOptions();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, isInstaller, isAdmin]);

  const loadPreviewOptions = async () => {
    const { data: cniProfiles } = await supabase
      .from('cni_profiles')
      .select('user_id, company_id, company_name');
    if (!cniProfiles || cniProfiles.length === 0) return;
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', cniProfiles.map((p: any) => p.user_id));
    const names = new Map((profiles || []).map((p: any) => [p.id, p.full_name]));
    setPreviewOptions(cniProfiles.map((p: any) => ({
      profileId: p.user_id,
      name: names.get(p.user_id) || 'Unknown',
      companyId: p.company_id || null,
      companyName: p.company_name || null,
    })).sort((a: any, b: any) => a.name.localeCompare(b.name)));
  };

  const startPreview = () => {
    const opt = previewOptions.find(o => o.profileId === previewSelect);
    if (!opt) return;
    const p = { profileId: opt.profileId, name: opt.name, companyId: opt.companyId };
    setInstallerPreview(p);
    setPreview(p);
    setLoading(true);
    loadData(p);
  };

  const loadData = async (p: InstallerPreview | null) => {
    if (!user) return;
    // The installer whose portal we're showing: the previewed one (admin
    // preview) or the signed-in user.
    const effectiveId = p?.profileId || user.id;

    // Check if CNI profile exists
    const { data: profile } = await supabase
      .from('cni_profiles')
      .select('id, profile_complete, company_id')
      .eq('user_id', effectiveId)
      .single();
    setHasProfile(!!profile || !!p);

    // Load my jobs: assigned to my company (any installer at the company
    // works company jobs) or directly to me (legacy / pre-company jobs).
    const companyId = profile?.company_id || p?.companyId || null;
    const orFilter = companyId
      ? `assigned_installer_id.eq.${effectiveId},assigned_company_id.eq.${companyId}`
      : `assigned_installer_id.eq.${effectiveId}`;
    const { data: jobsData } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, customer_name, deadline, confirmed_schedule_start')
      .or(orFilter)
      .order('created_at', { ascending: false });
    setJobs(jobsData || []);

    // Count pending invites (unseen)
    const { count: invCount } = await supabase
      .from('cni_job_invites')
      .select('*', { count: 'exact', head: true })
      .eq('installer_id', effectiveId)
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

    // Ready-for-install vehicles assigned to me
    try {
      const res = await fetch('/api/installer/ready-for-install?mine=1');
      if (res.ok) {
        const data = await res.json();
        setReadyForInstallCount(data.count || 0);
        setReadyForInstallStale(
          (data.vehicles || []).filter((v: any) => v.stale).length
        );
      }
    } catch {}

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

      <InstallerPreviewBanner preview={preview} />

      {/* Admin with no preview: pick an installer to view the portal as */}
      {isAdmin && !preview && (
        <div style={{
          padding: '14px 16px', borderRadius: '14px', marginBottom: '16px',
          background: 'color-mix(in srgb, #a78bfa 8%, var(--card))', border: '1px solid #a78bfa',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: '#a78bfa', marginBottom: '4px' }}>ADMIN PREVIEW</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            You&apos;re signed in as an admin, so this portal is empty. Pick a CNI installer to see
            the portal exactly as they do — their company&apos;s jobs, shifts, and earnings.
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <select
              value={previewSelect}
              onChange={e => setPreviewSelect(e.target.value)}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
                border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
              }}
            >
              <option value="">Choose an installer…</option>
              {previewOptions.map(o => (
                <option key={o.profileId} value={o.profileId}>
                  {o.name}{o.companyName ? ` — ${o.companyName}` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={startPreview}
              disabled={!previewSelect}
              style={{
                padding: '10px 16px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                background: previewSelect ? '#a78bfa' : 'var(--text-muted)', color: '#fff', border: 'none',
                cursor: previewSelect ? 'pointer' : 'default',
              }}
            >
              Preview
            </button>
          </div>
        </div>
      )}

      {/* Profile prompt */}
      {!hasProfile && !isAdmin && (
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

      {/* Ready for Install Banner */}
      {readyForInstallCount > 0 && (
        <button
          onClick={() => router.push('/installer/ready-for-install')}
          style={{
            width: '100%', padding: '14px 16px', borderRadius: '14px', textAlign: 'left',
            background: readyForInstallStale > 0
              ? 'color-mix(in srgb, var(--danger, #ef4444) 10%, var(--card))'
              : 'color-mix(in srgb, #4ade80 10%, var(--card))',
            border: `1px solid ${readyForInstallStale > 0 ? 'var(--danger, #ef4444)' : '#4ade80'}`,
            marginBottom: '16px',
            display: 'flex', alignItems: 'center', gap: '12px',
          }}
        >
          <div style={{
            width: '36px', height: '36px', borderRadius: '50%',
            background: readyForInstallStale > 0 ? 'var(--danger, #ef4444)' : '#22c55e',
            color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', fontWeight: 800, flexShrink: 0,
          }}>
            {readyForInstallCount}
          </div>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Ready to install
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {readyForInstallStale > 0
                ? `${readyForInstallStale} waiting more than 7 days`
                : 'Graphics done, waiting on you'}
            </div>
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
        <button
          onClick={() => router.push('/earnings')}
          style={{
            padding: '14px 12px', borderRadius: '12px', textAlign: 'left',
            background: 'var(--card)', border: '1px solid var(--border)',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>Pay</div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>My Earnings</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>per-vehicle pay</div>
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
