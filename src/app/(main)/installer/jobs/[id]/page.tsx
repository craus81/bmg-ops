'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

const STATUS_LABELS: Record<string, string> = {
  assigned_awaiting_scheduling: 'Awaiting Your Schedule Proposal',
  bidding_open: 'Open for Bids',
  scheduling_proposed: 'Schedule Proposed — Awaiting Approval',
  scheduled_pending_confirmation: 'Confirm Your Schedule',
  scheduled_confirmed: 'Scheduled',
  in_progress: 'In Progress',
  completed_pending_review: 'Under Review',
  approved_closed: 'Completed & Closed',
};

export default function InstallerJobDetailPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { user, isInstaller, isAdmin } = useAuth();
  const supabase = createClient();

  const [job, setJob] = useState<any>(null);
  const [vins, setVins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const [photoCount, setPhotoCount] = useState(0);
  const [unreadMsgCount, setUnreadMsgCount] = useState(0);

  // Schedule proposal
  const [propStart, setPropStart] = useState('');
  const [propEnd, setPropEnd] = useState('');

  useEffect(() => {
    if (!user) return;
    loadJob();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, jobId]);

  const loadJob = async () => {
    const { data } = await supabase
      .from('cni_jobs')
      .select('*')
      .eq('id', jobId)
      .single();
    if (!data) { router.push('/installer'); return; }
    setJob(data);

    const { data: vinData } = await supabase
      .from('cni_job_vins')
      .select('*')
      .eq('job_id', jobId)
      .order('sort_order');
    setVins(vinData || []);

    // Photo count
    const { count: pCount } = await supabase
      .from('cni_job_photos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', jobId);
    setPhotoCount(pCount || 0);

    // Unread message count
    if (user) {
      const { count: mCount } = await supabase
        .from('cni_job_messages')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .neq('sender_id', user.id)
        .is('read_at', null);
      setUnreadMsgCount(mCount || 0);
    }

    setLoading(false);
  };

  const proposeSchedule = async () => {
    if (!propStart || !job) return;
    setUpdating(true);
    await supabase.from('cni_jobs').update({
      proposed_schedule_start: propStart,
      proposed_schedule_end: propEnd || propStart,
      status: 'scheduling_proposed',
    }).eq('id', job.id);
    await loadJob();
    setUpdating(false);
  };

  const confirmSchedule = async () => {
    if (!job) return;
    setUpdating(true);
    await supabase.from('cni_jobs').update({
      confirmed_schedule_start: job.proposed_schedule_start,
      confirmed_schedule_end: job.proposed_schedule_end,
      schedule_confirmed_at: new Date().toISOString(),
      status: 'scheduled_confirmed',
    }).eq('id', job.id);
    await loadJob();
    setUpdating(false);
  };

  const markVinComplete = async (vinId: string) => {
    setUpdating(true);
    await supabase.from('cni_job_vins').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', vinId);

    // Check if all VINs are complete
    const updated = vins.map(v => v.id === vinId ? { ...v, status: 'completed' } : v);
    const allComplete = updated.every(v => v.status === 'completed');
    if (allComplete && job) {
      await supabase.from('cni_jobs').update({
        status: 'completed_pending_review',
        completed_at: new Date().toISOString(),
      }).eq('id', job.id);
    }

    await loadJob();
    setUpdating(false);
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const addr = job.address || {};
  const shipAddr = job.shipping_address || {};

  const sectionStyle: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 14px', borderRadius: '10px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', fontSize: '14px',
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/installer')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>{job.title}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {job.job_number} {job.customer_name ? `• ${job.customer_name}` : ''}
          </div>
        </div>
      </div>

      {/* Status */}
      <div style={{
        ...sectionStyle,
        background: job.status === 'in_progress' ? 'var(--orange-soft)' : 'var(--card)',
        borderColor: job.status === 'in_progress' ? 'var(--orange)' : 'var(--border)',
      }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>STATUS</div>
        <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
          {STATUS_LABELS[job.status] || job.status}
        </div>
      </div>

      {/* Action: Propose Schedule */}
      {job.status === 'assigned_awaiting_scheduling' && (
        <div style={{ ...sectionStyle, background: 'var(--warning-bg)', borderColor: 'var(--warning-border)' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--warning)', marginBottom: '12px' }}>
            Propose Your Schedule
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>Start Date</label>
              <input style={inputStyle} type="date" value={propStart} onChange={e => setPropStart(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>End Date</label>
              <input style={inputStyle} type="date" value={propEnd} onChange={e => setPropEnd(e.target.value)} />
            </div>
          </div>
          <button
            onClick={proposeSchedule}
            disabled={!propStart || updating}
            style={{
              width: '100%', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
              background: propStart ? 'var(--orange)' : 'var(--text-muted)', color: '#fff', border: 'none',
            }}
          >
            {updating ? 'Submitting...' : 'Submit Schedule Proposal'}
          </button>
        </div>
      )}

      {/* Action: Confirm Schedule */}
      {job.status === 'scheduled_pending_confirmation' && (
        <div style={{ ...sectionStyle, background: 'var(--success-bg)', borderColor: 'var(--success-border)' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)', marginBottom: '8px' }}>
            Your Schedule Has Been Approved
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '12px' }}>
            {job.proposed_schedule_start ? new Date(job.proposed_schedule_start).toLocaleDateString() : ''}
            {job.proposed_schedule_end && job.proposed_schedule_end !== job.proposed_schedule_start
              ? ` — ${new Date(job.proposed_schedule_end).toLocaleDateString()}`
              : ''}
          </div>
          <button
            onClick={confirmSchedule}
            disabled={updating}
            style={{
              width: '100%', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
              background: 'var(--success)', color: '#fff', border: 'none',
            }}
          >
            {updating ? 'Confirming...' : 'Confirm Schedule'}
          </button>
        </div>
      )}

      {/* Confirmed Schedule */}
      {job.confirmed_schedule_start && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>CONFIRMED SCHEDULE</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)' }}>
            {new Date(job.confirmed_schedule_start).toLocaleDateString()}
            {job.confirmed_schedule_end && job.confirmed_schedule_end !== job.confirmed_schedule_start
              ? ` — ${new Date(job.confirmed_schedule_end).toLocaleDateString()}`
              : ''}
          </div>
        </div>
      )}

      {/* Project Overview */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>PROJECT OVERVIEW</div>
        {job.scope && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Scope</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>{job.scope}</div>
          </div>
        )}
        {(addr.street || addr.city) && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Install Location</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {[addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')}
            </div>
          </div>
        )}
        {job.site_contact_name && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Site Contact</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {job.site_contact_name} {job.site_contact_phone ? `• ${job.site_contact_phone}` : ''}
            </div>
          </div>
        )}
        {job.budget && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Budget</div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)', marginTop: '2px' }}>
              ${Number(job.budget).toLocaleString()}
            </div>
          </div>
        )}
        {job.deadline && (
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Deadline</div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '2px' }}>
              {new Date(job.deadline).toLocaleDateString()}
            </div>
          </div>
        )}
      </div>

      {/* Material Shipment */}
      {job.requires_shipment && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>MATERIALS</div>
          <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
            {job.material_delivered
              ? 'Materials delivered'
              : job.tracking_number
                ? `In transit — ${job.carrier || ''} ${job.tracking_number}`
                : 'Awaiting shipment'}
          </div>
          {(shipAddr.street || shipAddr.city) && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Ship to: {[shipAddr.street, shipAddr.city, shipAddr.state, shipAddr.zip].filter(Boolean).join(', ')}
            </div>
          )}
          {!job.material_delivered && job.tracking_number && (
            <button
              onClick={async () => {
                setUpdating(true);
                await supabase.from('cni_jobs').update({
                  material_delivered: true,
                  material_delivered_at: new Date().toISOString(),
                }).eq('id', job.id);
                await loadJob();
                setUpdating(false);
              }}
              disabled={updating}
              style={{
                marginTop: '10px', width: '100%', padding: '10px', borderRadius: '8px',
                fontSize: '12px', fontWeight: 700,
                background: 'var(--success)', color: '#fff', border: 'none',
              }}
            >
              ✓ Confirm Materials Received
            </button>
          )}
        </div>
      )}

      {/* Quick Actions: Photos + Messages */}
      {['in_progress', 'scheduled_confirmed', 'completed_pending_review'].includes(job.status) && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <button
            onClick={() => router.push(`/installer/jobs/${job.id}/photos`)}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', textAlign: 'center',
              background: 'var(--card)', border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>Photos</div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>Photos</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{photoCount} uploaded</div>
          </button>
          <button
            onClick={() => router.push(`/installer/jobs/${job.id}/messages`)}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', textAlign: 'center',
              background: unreadMsgCount > 0
                ? 'color-mix(in srgb, var(--orange) 8%, var(--card))'
                : 'var(--card)',
              border: unreadMsgCount > 0 ? '1px solid var(--orange)' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>Msgs</div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>Messages</div>
            {unreadMsgCount > 0 && (
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--orange)' }}>{unreadMsgCount} new</div>
            )}
          </button>
        </div>
      )}

      {/* VINs with completion */}
      {vins.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
            VEHICLES ({vins.filter(v => v.status === 'completed').length}/{vins.length} complete)
          </div>
          {vins.map(v => (
            <div key={v.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 12px', borderRadius: '8px', marginBottom: '6px',
              background: v.status === 'completed' ? 'var(--success-bg)' : 'var(--input-bg)',
              border: v.status === 'completed' ? '1px solid var(--success-border)' : '1px solid var(--border)',
            }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                  {v.vin}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {[v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}
                </div>
              </div>
              {v.status === 'completed' ? (
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--success)' }}>✓ Done</span>
              ) : job.status === 'in_progress' ? (
                <button
                  onClick={() => markVinComplete(v.id)}
                  disabled={updating}
                  style={{
                    padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                    background: 'var(--success)', color: '#fff', border: 'none',
                  }}
                >
                  Mark Complete
                </button>
              ) : (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Pending</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Invoice */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>INVOICE</div>
        {job.invoice_status === 'none' || !job.invoice_status ? (
          <>
            {['in_progress', 'completed_pending_review'].includes(job.status) ? (
              <button
                onClick={() => router.push(`/installer/jobs/${job.id}/invoice`)}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                  background: 'var(--orange)', color: '#fff', border: 'none',
                }}
              >
                Upload Invoice
              </button>
            ) : (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Invoice upload available once job is in progress
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
              {job.invoice_status === 'submitted' ? 'Submitted — Under Review' :
               job.invoice_status === 'approved' ? 'Approved — Bill Pending' :
               job.invoice_status === 'billed_in_netsuite' ? 'Billed in NetSuite' :
               job.invoice_status}
            </div>
            {job.netsuite_bill_id && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                NetSuite Bill: {job.netsuite_bill_id}
              </div>
            )}
            {job.invoice_status === 'submitted' && (
              <button
                onClick={() => router.push(`/installer/jobs/${job.id}/invoice`)}
                style={{
                  marginTop: '8px', padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
                  background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                }}
              >
                View / Replace Invoice
              </button>
            )}
          </>
        )}
      </div>

      <div style={{ height: '80px' }} />
    </div>
  );
}
