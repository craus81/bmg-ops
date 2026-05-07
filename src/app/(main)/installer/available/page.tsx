'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface AvailableJob {
  id: string;
  job_number: string;
  title: string;
  scope: string | null;
  customer_name: string | null;
  address: any;
  budget: number | null;
  deadline: string | null;
  estimated_hours: number | null;
  vin_count: number;
  distribution_type: string;
  published_at: string | null;
  created_at: string;
  // from invite
  invite_id?: string;
  invite_type?: string;
  seen_at?: string | null;
  // from bid
  my_bid?: { response: string; responded_at: string } | null;
}

export default function AvailableJobsPage() {
  const router = useRouter();
  const { user, isInstaller, isAdmin } = useAuth();
  const supabase = createClient();

  const [jobs, setJobs] = useState<AvailableJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'invites' | 'open'>('invites');

  useEffect(() => {
    if (!user) return;
    if (!isInstaller && !isAdmin) { router.push('/home'); return; }
    loadJobs();
  }, [user, isInstaller, isAdmin]);

  const loadJobs = async () => {
    if (!user) return;

    // Load my invites (direct invites to me)
    const { data: invites } = await supabase
      .from('cni_job_invites')
      .select('id, job_id, invite_type, seen_at')
      .eq('installer_id', user.id);

    const inviteJobIds = (invites || []).map((i: any) => i.job_id);

    // Load published jobs (open board) that I haven't been assigned to
    const { data: publishedJobs } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, scope, customer_name, address, budget, deadline, estimated_hours, vin_count, distribution_type, published_at, created_at')
      .in('status', ['awaiting_assignment', 'bidding_open'])
      .eq('distribution_type', 'published')
      .is('assigned_installer_id', null);

    // Load invite jobs
    let inviteJobs: any[] = [];
    if (inviteJobIds.length > 0) {
      const { data } = await supabase
        .from('cni_jobs')
        .select('id, job_number, title, scope, customer_name, address, budget, deadline, estimated_hours, vin_count, distribution_type, published_at, created_at')
        .in('id', inviteJobIds)
        .in('status', ['awaiting_assignment', 'bidding_open'])
        .is('assigned_installer_id', null);
      inviteJobs = data || [];
    }

    // Load my existing bids
    const { data: myBids } = await supabase
      .from('cni_job_bids')
      .select('job_id, response, responded_at')
      .eq('installer_id', user.id);
    const bidMap: Record<string, { response: string; responded_at: string }> = {};
    (myBids || []).forEach((b: any) => { bidMap[b.job_id] = { response: b.response, responded_at: b.responded_at }; });

    // Build invite invite map
    const inviteMap: Record<string, any> = {};
    (invites || []).forEach((i: any) => { inviteMap[i.job_id] = i; });

    // Merge: invite jobs get invite metadata
    const mergedInvites: AvailableJob[] = inviteJobs.map(j => ({
      ...j,
      invite_id: inviteMap[j.id]?.id,
      invite_type: inviteMap[j.id]?.invite_type,
      seen_at: inviteMap[j.id]?.seen_at,
      my_bid: bidMap[j.id] || null,
    }));

    // Open board: exclude jobs I already have an invite for (to avoid duplicates)
    const openJobs: AvailableJob[] = (publishedJobs || [])
      .filter((j: any) => !inviteJobIds.includes(j.id))
      .map((j: any) => ({
        ...j,
        my_bid: bidMap[j.id] || null,
      }));

    setJobs([...mergedInvites, ...openJobs]);

    // Mark unseen invites as seen
    const unseenInvites = (invites || []).filter((i: any) => !i.seen_at);
    if (unseenInvites.length > 0) {
      await supabase
        .from('cni_job_invites')
        .update({ seen_at: new Date().toISOString() })
        .in('id', unseenInvites.map((i: any) => i.id));
    }

    setLoading(false);
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const inviteJobs = jobs.filter(j => j.invite_id);
  const openBoardJobs = jobs.filter(j => !j.invite_id);
  const displayJobs = tab === 'invites' ? inviteJobs : openBoardJobs;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/installer')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            Available Jobs
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {inviteJobs.length} invite{inviteJobs.length !== 1 ? 's' : ''} • {openBoardJobs.length} open
          </div>
        </div>
      </div>

      {/* Tab Switcher */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px', marginBottom: '16px',
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px',
      }}>
        {([
          { id: 'invites' as const, label: `Invites (${inviteJobs.length})` },
          { id: 'open' as const, label: `Open Board (${openBoardJobs.length})` },
        ]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: '10px 6px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
              border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
              color: tab === t.id ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Job List */}
      {displayJobs.length === 0 ? (
        <div style={{
          padding: '40px 20px', textAlign: 'center', borderRadius: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>--</div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-muted)' }}>
            {tab === 'invites' ? 'No job invites right now' : 'No open jobs on the board'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {tab === 'invites'
              ? 'You\'ll get notified when a coordinator sends you a job invite'
              : 'Check back soon for new opportunities'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {displayJobs.map(job => (
            <JobCard key={job.id} job={job} onTap={() => router.push(`/installer/available/${job.id}`)} />
          ))}
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}

function JobCard({ job, onTap }: { job: AvailableJob; onTap: () => void }) {
  const addr = job.address || {};
  const hasBid = !!job.my_bid;

  return (
    <button
      onClick={onTap}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '16px', borderRadius: '14px',
        background: hasBid ? 'color-mix(in srgb, var(--success) 5%, var(--card))' : 'var(--card)',
        border: hasBid ? '1px solid var(--success-border)' : job.invite_id ? '1px solid var(--orange)' : '1px solid var(--border)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {/* Top row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{job.title}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {job.job_number} {job.customer_name ? `• ${job.customer_name}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
          {job.invite_id && (
            <span style={{
              fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
              background: 'color-mix(in srgb, var(--orange) 12%, transparent)',
              color: 'var(--orange)',
            }}>
              Invited
            </span>
          )}
          {hasBid && (
            <span style={{
              fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
              background: job.my_bid?.response === 'interested' ? 'var(--success-bg)' : 'var(--error-bg)',
              color: job.my_bid?.response === 'interested' ? 'var(--success)' : 'var(--error)',
            }}>
              {job.my_bid?.response === 'interested' ? '✓ Interested' : '✕ Declined'}
            </span>
          )}
        </div>
      </div>

      {/* Details */}
      {job.scope && (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px', lineHeight: '1.4' }}>
          {job.scope.length > 120 ? job.scope.substring(0, 120) + '...' : job.scope}
        </div>
      )}

      {/* Meta row */}
      <div style={{ display: 'flex', gap: '12px', marginTop: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
        {addr.city && <span>{addr.city}, {addr.state || ''}</span>}
        {job.budget && <span>${Number(job.budget).toLocaleString()}</span>}
        {job.vin_count > 0 && <span>{job.vin_count} vehicle{job.vin_count !== 1 ? 's' : ''}</span>}
        {job.deadline && <span>{new Date(job.deadline).toLocaleDateString()}</span>}
      </div>
    </button>
  );
}
