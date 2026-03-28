'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface CniJob {
  id: string;
  job_number: string;
  title: string;
  description: string | null;
  scope: string | null;
  customer_name: string | null;
  address: any;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  site_contact_email: string | null;
  is_multi_unit: boolean;
  vin_count: number;
  budget: number | null;
  deadline: string | null;
  estimated_hours: number | null;
  requires_shipment: boolean;
  shipping_address: any;
  tracking_number: string | null;
  carrier: string | null;
  material_delivered: boolean;
  assigned_installer_id: string | null;
  assigned_at: string | null;
  status: string;
  proposed_schedule_start: string | null;
  proposed_schedule_end: string | null;
  confirmed_schedule_start: string | null;
  confirmed_schedule_end: string | null;
  schedule_confirmed_at: string | null;
  completed_at: string | null;
  invoice_status: string;
  invoice_file_path: string | null;
  netsuite_bill_id: string | null;
  distribution_type: string;
  published_at: string | null;
  bid_count: number;
  created_by: string;
  created_at: string;
}

interface CniVin {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  status: string;
  completed_at: string | null;
  photos_submitted: boolean;
  photos_approved: boolean;
}

interface StatusHistoryEntry {
  id: string;
  from_status: string | null;
  to_status: string;
  changed_by: string | null;
  note: string | null;
  created_at: string;
  changer_name?: string;
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

// Define valid next statuses for coordinator
const NEXT_STATUSES: Record<string, string[]> = {
  awaiting_assignment: ['bidding_open', 'assigned_awaiting_scheduling'],
  bidding_open: ['assigned_awaiting_scheduling'],
  assigned_awaiting_scheduling: [],
  scheduling_proposed: ['scheduled_pending_confirmation'],
  scheduled_pending_confirmation: [],
  scheduled_confirmed: ['in_progress'],
  in_progress: [],
  completed_pending_review: ['approved_closed'],
  approved_closed: [],
};

export default function CniJobDetailPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [job, setJob] = useState<CniJob | null>(null);
  const [vins, setVins] = useState<CniVin[]>([]);
  const [history, setHistory] = useState<StatusHistoryEntry[]>([]);
  const [installerName, setInstallerName] = useState('');
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Assignment modal
  const [showAssign, setShowAssign] = useState(false);
  const [installers, setInstallers] = useState<any[]>([]);

  // Distribution
  const [showInvite, setShowInvite] = useState(false);
  const [inviteInstallers, setInviteInstallers] = useState<any[]>([]);
  const [invitedIds, setInvitedIds] = useState<string[]>([]);
  const [bidCount, setBidCount] = useState(0);

  // Phase 3: photos + messages
  const [photoStats, setPhotoStats] = useState({ total: 0, pending: 0, approved: 0, denied: 0 });
  const [unreadMsgCount, setUnreadMsgCount] = useState(0);

  // Phase 4: invoice + closure
  const [nsBillId, setNsBillId] = useState('');
  const [budgetExceeded, setBudgetExceeded] = useState(false);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadJob();
  }, [isAdmin, jobId]);

  const loadJob = async () => {
    const { data: jobData } = await supabase
      .from('cni_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (!jobData) { router.push('/admin/cni'); return; }
    setJob(jobData);

    // Load VINs
    const { data: vinData } = await supabase
      .from('cni_job_vins')
      .select('*')
      .eq('job_id', jobId)
      .order('sort_order');
    setVins(vinData || []);

    // Load installer name
    if (jobData.assigned_installer_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', jobData.assigned_installer_id)
        .single();
      if (profile) setInstallerName(profile.full_name);
    }

    // Load bid count + invited IDs
    const { count: bCount } = await supabase
      .from('cni_job_bids')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', jobId);
    setBidCount(bCount || 0);

    const { data: inviteData } = await supabase
      .from('cni_job_invites')
      .select('installer_id')
      .eq('job_id', jobId);
    setInvitedIds((inviteData || []).map(i => i.installer_id));

    // Load photo stats
    const { data: photoData } = await supabase
      .from('cni_job_photos')
      .select('review_status')
      .eq('job_id', jobId);
    if (photoData) {
      setPhotoStats({
        total: photoData.length,
        pending: photoData.filter(p => p.review_status === 'pending').length,
        approved: photoData.filter(p => p.review_status === 'approved').length,
        denied: photoData.filter(p => p.review_status === 'denied').length,
      });
    }

    // Load unread message count
    if (user) {
      const { count: mCount } = await supabase
        .from('cni_job_messages')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .neq('sender_id', user.id)
        .is('read_at', null);
      setUnreadMsgCount(mCount || 0);
    }

    // Load status history
    const { data: historyData } = await supabase
      .from('cni_job_status_history')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });
    if (historyData) {
      const changerIds = [...new Set(historyData.filter(h => h.changed_by).map(h => h.changed_by))];
      let nameMap: Record<string, string> = {};
      if (changerIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', changerIds);
        if (profiles) profiles.forEach((p: any) => { nameMap[p.id] = p.full_name; });
      }
      setHistory(historyData.map(h => ({ ...h, changer_name: h.changed_by ? nameMap[h.changed_by] : undefined })));
    }

    setLoading(false);
  };

  const updateStatus = async (newStatus: string) => {
    if (!job || updating) return;
    setUpdating(true);
    const { error } = await supabase
      .from('cni_jobs')
      .update({ status: newStatus })
      .eq('id', job.id);
    if (!error) {
      await loadJob();
    }
    setUpdating(false);
  };

  const assignInstaller = async (installerId: string) => {
    if (!job || updating) return;
    setUpdating(true);
    const { error } = await supabase
      .from('cni_jobs')
      .update({
        assigned_installer_id: installerId,
        assigned_at: new Date().toISOString(),
        status: 'assigned_awaiting_scheduling',
      })
      .eq('id', job.id);
    if (!error) {
      setShowAssign(false);
      await loadJob();
    }
    setUpdating(false);
  };

  const loadInstallerList = async () => {
    const { data } = await supabase
      .from('cni_profiles')
      .select('user_id, company_name, availability_status')
      .not('risk_tags', 'cs', '{do_not_assign}');
    if (data) {
      const userIds = data.map((p: any) => p.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);
      const nameMap: Record<string, string> = {};
      if (profiles) profiles.forEach((p: any) => { nameMap[p.id] = p.full_name; });
      setInstallers(data.map((p: any) => ({
        id: p.user_id,
        full_name: nameMap[p.user_id] || 'Unknown',
        company_name: p.company_name,
        availability_status: p.availability_status,
      })));
    }
    setShowAssign(true);
  };

  const loadInviteList = async () => {
    const { data } = await supabase
      .from('cni_profiles')
      .select('user_id, company_name, availability_status, business_address, coverage_radius_miles, jobs_completed, risk_tags')
      .not('risk_tags', 'cs', '{do_not_assign}');
    if (data) {
      const userIds = data.map((p: any) => p.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);
      const nameMap: Record<string, string> = {};
      if (profiles) profiles.forEach((p: any) => { nameMap[p.id] = p.full_name; });
      setInviteInstallers(data.map((p: any) => ({
        ...p,
        full_name: nameMap[p.user_id] || 'Unknown',
      })));
    }
    setShowInvite(true);
  };

  const sendInvite = async (installerId: string) => {
    if (!job || !user) return;
    setUpdating(true);
    await supabase.from('cni_job_invites').upsert({
      job_id: job.id,
      installer_id: installerId,
      invite_type: 'direct',
      invited_by: user.id,
    }, { onConflict: 'job_id,installer_id' });
    setInvitedIds(prev => [...prev, installerId]);
    setUpdating(false);
  };

  const publishToBoard = async () => {
    if (!job) return;
    setUpdating(true);
    await supabase.from('cni_jobs').update({
      distribution_type: 'published',
      published_at: new Date().toISOString(),
      status: job.status === 'awaiting_assignment' ? 'bidding_open' : job.status,
    }).eq('id', job.id);
    await loadJob();
    setUpdating(false);
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const statusColor = STATUS_COLORS[job.status] || 'var(--text-muted)';
  const nextStatuses = NEXT_STATUSES[job.status] || [];
  const addr = job.address || {};

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>
            {job.title}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {job.job_number} {job.customer_name ? `• ${job.customer_name}` : ''}
          </div>
        </div>
      </div>

      {/* Status Badge */}
      <div style={{
        padding: '12px 16px', borderRadius: '12px', marginBottom: '14px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: `color-mix(in srgb, ${statusColor} 10%, var(--card))`,
        border: `1px solid color-mix(in srgb, ${statusColor} 25%, transparent)`,
      }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>STATUS</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: statusColor, marginTop: '2px' }}>
            {STATUS_LABELS[job.status]}
          </div>
        </div>
        {nextStatuses.length > 0 && (
          <div style={{ display: 'flex', gap: '6px' }}>
            {nextStatuses.map(ns => (
              <button
                key={ns}
                onClick={() => updateStatus(ns)}
                disabled={updating}
                style={{
                  padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                  background: 'var(--orange)', color: '#fff', border: 'none',
                }}
              >
                → {STATUS_LABELS[ns]?.split(' ')[0] || ns}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Assignment */}
      <div style={{
        padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>INSTALLER</div>
        {job.assigned_installer_id ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>👷 {installerName}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Assigned {job.assigned_at ? new Date(job.assigned_at).toLocaleDateString() : ''}
              </div>
            </div>
            <button
              onClick={() => router.push(`/admin/cni/installers/${job.assigned_installer_id}`)}
              style={{
                padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
                background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
              }}
            >
              View Profile
            </button>
          </div>
        ) : (
          <button
            onClick={loadInstallerList}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'var(--orange)', color: '#fff', border: 'none',
            }}
          >
            Assign Installer
          </button>
        )}
      </div>

      {/* Distribution & Bids — show when not yet assigned or bidding */}
      {(!job.assigned_installer_id || job.status === 'bidding_open') && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>DISTRIBUTION</div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <button
              onClick={loadInviteList}
              style={{
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--subtle-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              }}
            >
              📨 Invite Installers {invitedIds.length > 0 ? `(${invitedIds.length})` : ''}
            </button>
            {job.distribution_type !== 'published' ? (
              <button
                onClick={publishToBoard}
                disabled={updating}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  background: 'var(--orange)', color: '#fff', border: 'none',
                }}
              >
                📋 Publish to Board
              </button>
            ) : (
              <div style={{
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--success-bg)', color: 'var(--success)', textAlign: 'center',
                border: '1px solid var(--success-border)',
              }}>
                ✓ Published
              </div>
            )}
          </div>

          {bidCount > 0 && (
            <button
              onClick={() => router.push(`/admin/cni/jobs/${job.id}/bids`)}
              style={{
                width: '100%', padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'color-mix(in srgb, var(--orange) 10%, var(--card))',
                color: 'var(--orange)', border: '1px solid var(--orange)',
              }}
            >
              📊 Review Bids ({bidCount} response{bidCount !== 1 ? 's' : ''})
            </button>
          )}
        </div>
      )}

      {/* Schedule */}
      {job.confirmed_schedule_start && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>SCHEDULE</div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
            📅 {new Date(job.confirmed_schedule_start).toLocaleDateString()}
            {job.confirmed_schedule_end && job.confirmed_schedule_end !== job.confirmed_schedule_start
              ? ` — ${new Date(job.confirmed_schedule_end).toLocaleDateString()}`
              : ''}
          </div>
          {job.schedule_confirmed_at && (
            <div style={{ fontSize: '11px', color: 'var(--success)', marginTop: '2px' }}>
              ✓ Confirmed {new Date(job.schedule_confirmed_at).toLocaleDateString()}
            </div>
          )}
        </div>
      )}
      {job.proposed_schedule_start && !job.confirmed_schedule_start && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>PROPOSED SCHEDULE</div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#60a5fa' }}>
            📅 {new Date(job.proposed_schedule_start).toLocaleDateString()}
            {job.proposed_schedule_end && job.proposed_schedule_end !== job.proposed_schedule_start
              ? ` — ${new Date(job.proposed_schedule_end).toLocaleDateString()}`
              : ''}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            <button
              onClick={() => updateStatus('scheduled_pending_confirmation')}
              disabled={updating}
              style={{
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--success)', color: '#fff', border: 'none',
              }}
            >
              Approve Schedule
            </button>
          </div>
        </div>
      )}

      {/* Job Info */}
      <div style={{
        padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>JOB DETAILS</div>
        {job.scope && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Scope</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>{job.scope}</div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          {job.budget && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Budget</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)' }}>${job.budget.toLocaleString()}</div>
            </div>
          )}
          {job.deadline && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Deadline</div>
              <div style={{
                fontSize: '14px', fontWeight: 700,
                color: new Date(job.deadline) < new Date() && job.status !== 'approved_closed' ? 'var(--error)' : 'var(--text-primary)',
              }}>
                {new Date(job.deadline).toLocaleDateString()}
              </div>
            </div>
          )}
          {job.estimated_hours && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Est. Hours</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{job.estimated_hours}h</div>
            </div>
          )}
        </div>
        {(addr.street || addr.city) && (
          <div style={{ marginTop: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Location</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {[addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')}
            </div>
          </div>
        )}
        {job.site_contact_name && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Site Contact</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {job.site_contact_name} {job.site_contact_phone ? `• ${job.site_contact_phone}` : ''}
            </div>
          </div>
        )}
      </div>

      {/* VINs */}
      {vins.length > 0 && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
            VINS ({vins.length})
          </div>
          {vins.map(v => (
            <div key={v.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 12px', borderRadius: '8px', marginBottom: '6px',
              background: 'var(--input-bg)', border: '1px solid var(--border)',
            }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                  {v.vin}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {[v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}
                </div>
              </div>
              <span style={{
                fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                color: v.status === 'completed' ? 'var(--success)' : v.status === 'in_progress' ? 'var(--orange)' : 'var(--text-muted)',
                background: v.status === 'completed' ? 'var(--success-bg)' : v.status === 'in_progress' ? 'var(--orange-soft)' : 'var(--subtle-bg)',
              }}>
                {v.status === 'completed' ? '✓ Complete' : v.status === 'in_progress' ? 'In Progress' : 'Pending'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Photos + Messages quick actions */}
      {job.assigned_installer_id && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <button
            onClick={() => router.push(`/admin/cni/jobs/${job.id}/photos`)}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', textAlign: 'center',
              background: photoStats.pending > 0
                ? 'color-mix(in srgb, var(--warning) 8%, var(--card))'
                : 'var(--card)',
              border: photoStats.pending > 0 ? '1px solid var(--warning)' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '20px', marginBottom: '4px' }}>📷</div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Photos {photoStats.total > 0 ? `(${photoStats.total})` : ''}
            </div>
            {photoStats.pending > 0 && (
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>
                {photoStats.pending} pending review
              </div>
            )}
          </button>
          <button
            onClick={() => router.push(`/admin/cni/jobs/${job.id}/messages`)}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', textAlign: 'center',
              background: unreadMsgCount > 0
                ? 'color-mix(in srgb, var(--orange) 8%, var(--card))'
                : 'var(--card)',
              border: unreadMsgCount > 0 ? '1px solid var(--orange)' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '20px', marginBottom: '4px' }}>💬</div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>Messages</div>
            {unreadMsgCount > 0 && (
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--orange)' }}>
                {unreadMsgCount} unread
              </div>
            )}
          </button>
        </div>
      )}

      {/* Invoice & Closure */}
      {job.invoice_status !== 'none' && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: job.invoice_status === 'submitted'
            ? 'color-mix(in srgb, var(--warning) 8%, var(--card))'
            : 'var(--card)',
          border: job.invoice_status === 'submitted'
            ? '1px solid var(--warning-border)'
            : '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>INVOICE</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            {job.invoice_status === 'submitted' ? '📄 Submitted — Awaiting Your Review' :
             job.invoice_status === 'approved' ? '✅ Approved — Create Bill in NetSuite' :
             job.invoice_status === 'billed_in_netsuite' ? '💰 Billed in NetSuite' : job.invoice_status}
          </div>

          {/* Budget comparison warning */}
          {job.invoice_status === 'submitted' && job.budget && (
            <div style={{
              padding: '8px 12px', borderRadius: '8px', marginBottom: '10px',
              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
              fontSize: '12px', color: 'var(--text-muted)',
            }}>
              Job Budget: <strong style={{ color: 'var(--success)' }}>${Number(job.budget).toLocaleString()}</strong>
              <span style={{ marginLeft: '8px', fontSize: '11px' }}>
                (Review invoice against this amount)
              </span>
            </div>
          )}

          {/* Invoice file link */}
          {job.invoice_file_path && (
            <div style={{
              padding: '8px 12px', borderRadius: '8px', marginBottom: '10px',
              background: 'var(--input-bg)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <span style={{ fontSize: '20px' }}>📄</span>
              <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-primary)' }}>
                {job.invoice_file_path.split('/').pop()}
              </div>
            </div>
          )}

          {/* Approve / reject actions for submitted invoices */}
          {job.invoice_status === 'submitted' && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={async () => {
                  setUpdating(true);
                  await supabase.from('cni_jobs').update({
                    invoice_status: 'approved',
                    invoice_approved_at: new Date().toISOString(),
                    invoice_approved_by: user?.id,
                  }).eq('id', job.id);
                  await loadJob();
                  setUpdating(false);
                }}
                disabled={updating}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  background: 'var(--success)', color: '#fff', border: 'none',
                }}
              >
                ✓ Approve Invoice
              </button>
            </div>
          )}

          {/* NetSuite bill ID entry for approved invoices */}
          {job.invoice_status === 'approved' && !job.netsuite_bill_id && (
            <div style={{ marginTop: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                Enter NetSuite Bill ID after creating the bill manually:
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  placeholder="NS Bill ID (e.g. BILL-12345)"
                  value={nsBillId}
                  onChange={e => setNsBillId(e.target.value)}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: '8px',
                    border: '1px solid var(--border)', background: 'var(--input-bg)',
                    color: 'var(--text-body)', fontSize: '13px',
                  }}
                />
                <button
                  onClick={async () => {
                    if (!nsBillId.trim()) return;
                    setUpdating(true);
                    await supabase.from('cni_jobs').update({
                      netsuite_bill_id: nsBillId.trim(),
                      invoice_status: 'billed_in_netsuite',
                    }).eq('id', job.id);
                    setNsBillId('');
                    await loadJob();
                    setUpdating(false);
                  }}
                  disabled={!nsBillId.trim() || updating}
                  style={{
                    padding: '10px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                    background: nsBillId.trim() ? 'var(--orange)' : 'var(--text-muted)',
                    color: '#fff', border: 'none',
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {job.netsuite_bill_id && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
              NetSuite Bill: <strong>{job.netsuite_bill_id}</strong>
            </div>
          )}
        </div>
      )}

      {/* Job Closure Check */}
      {job.status === 'completed_pending_review' && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'color-mix(in srgb, var(--success) 5%, var(--card))',
          border: '1px solid var(--success-border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>CLOSURE CHECKLIST</div>
          {(() => {
            const allVinsComplete = vins.length > 0 && vins.every(v => v.status === 'completed');
            const allPhotosApproved = photoStats.total > 0 && photoStats.denied === 0 && photoStats.pending === 0;
            const invoiceApproved = ['approved', 'billed_in_netsuite'].includes(job.invoice_status);
            const canClose = allVinsComplete && allPhotosApproved && invoiceApproved;

            return (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                  <div style={{ fontSize: '13px', color: allVinsComplete ? 'var(--success)' : 'var(--error)' }}>
                    {allVinsComplete ? '✓' : '✕'} All VINs completed ({vins.filter(v => v.status === 'completed').length}/{vins.length})
                  </div>
                  <div style={{ fontSize: '13px', color: allPhotosApproved ? 'var(--success)' : 'var(--error)' }}>
                    {allPhotosApproved ? '✓' : '✕'} All photos approved ({photoStats.approved}/{photoStats.total})
                  </div>
                  <div style={{ fontSize: '13px', color: invoiceApproved ? 'var(--success)' : 'var(--error)' }}>
                    {invoiceApproved ? '✓' : '✕'} Invoice {invoiceApproved ? 'approved' : 'pending'}
                  </div>
                </div>
                {canClose ? (
                  <button
                    onClick={() => updateStatus('approved_closed')}
                    disabled={updating}
                    style={{
                      width: '100%', padding: '12px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
                      background: 'var(--success)', color: '#fff', border: 'none',
                    }}
                  >
                    Close Job — All Requirements Met
                  </button>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    Complete all checklist items above before closing this job
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Status History */}
      <button
        onClick={() => setShowHistory(!showHistory)}
        style={{
          width: '100%', padding: '12px 16px', borderRadius: '12px', textAlign: 'left',
          background: 'var(--card)', border: '1px solid var(--border)', marginBottom: '14px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>
          STATUS HISTORY ({history.length})
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{showHistory ? '▲' : '▼'}</span>
      </button>
      {showHistory && history.length > 0 && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px', marginTop: '-8px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          {history.map(h => (
            <div key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600 }}>
                {STATUS_LABELS[h.to_status] || h.to_status}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {h.changer_name || 'System'} • {new Date(h.created_at).toLocaleString()}
              </div>
              {h.note && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{h.note}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Invite Installer Modal */}
      {showInvite && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }}>
          <div style={{
            background: 'var(--card)', borderRadius: '16px', padding: '20px',
            maxWidth: '400px', width: '100%', maxHeight: '80vh', overflowY: 'auto',
            border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Invite Installers</div>
              <button onClick={() => setShowInvite(false)} style={{ fontSize: '18px', color: 'var(--text-muted)' }}>✕</button>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              Send direct invites — installers will see the job and can respond
            </div>
            {inviteInstallers.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                No CNI installers available
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {inviteInstallers.map((inst: any) => {
                  const alreadyInvited = invitedIds.includes(inst.user_id);
                  return (
                    <div
                      key={inst.user_id}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 14px', borderRadius: '10px',
                        background: alreadyInvited ? 'color-mix(in srgb, var(--success) 5%, var(--input-bg))' : 'var(--input-bg)',
                        border: alreadyInvited ? '1px solid var(--success-border)' : '1px solid var(--border)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{inst.full_name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {inst.company_name || 'Independent'}
                          {inst.business_address?.city ? ` • ${inst.business_address.city}` : ''}
                          {' • '}<span style={{
                            color: inst.availability_status === 'available' ? 'var(--success)' :
                                   inst.availability_status === 'limited' ? 'var(--warning)' : 'var(--error)',
                          }}>{inst.availability_status}</span>
                        </div>
                      </div>
                      {alreadyInvited ? (
                        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--success)' }}>✓ Invited</span>
                      ) : (
                        <button
                          onClick={() => sendInvite(inst.user_id)}
                          disabled={updating}
                          style={{
                            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                            background: 'var(--orange)', color: '#fff', border: 'none',
                          }}
                        >
                          Invite
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Assign Installer Modal */}
      {showAssign && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }}>
          <div style={{
            background: 'var(--card)', borderRadius: '16px', padding: '20px',
            maxWidth: '400px', width: '100%', maxHeight: '80vh', overflowY: 'auto',
            border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Assign Installer</div>
              <button onClick={() => setShowAssign(false)} style={{ fontSize: '18px', color: 'var(--text-muted)' }}>✕</button>
            </div>
            {installers.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                No CNI installers available
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {installers.map((inst: any) => (
                  <button
                    key={inst.id}
                    onClick={() => assignInstaller(inst.id)}
                    disabled={updating}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', borderRadius: '10px', textAlign: 'left', width: '100%',
                      background: 'var(--input-bg)', border: '1px solid var(--border)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{inst.full_name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {inst.company_name || 'Independent'} •{' '}
                        <span style={{
                          color: inst.availability_status === 'available' ? 'var(--success)' :
                                 inst.availability_status === 'limited' ? 'var(--warning)' : 'var(--error)',
                        }}>
                          {inst.availability_status}
                        </span>
                      </div>
                    </div>
                    <span style={{ color: 'var(--orange)', fontWeight: 700, fontSize: '12px' }}>Assign →</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
