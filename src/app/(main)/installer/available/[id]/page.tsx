'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import InstallerPreviewBanner from '@/components/InstallerPreviewBanner';
import { getInstallerPreview } from '@/lib/installer-preview';

export default function AvailableJobDetailPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { user, isInstaller, isAdmin } = useAuth();
  const supabase = createClient();

  const [job, setJob] = useState<any>(null);
  const [vins, setVins] = useState<any[]>([]);
  // Admin preview: bids placed while previewing are recorded for the
  // previewed installer so the company-response flows can be exercised.
  const [preview] = useState(() => getInstallerPreview());
  const [myBid, setMyBid] = useState<any>(null);
  const [myCompanyId, setMyCompanyId] = useState<string | null>(null);
  const [companyBid, setCompanyBid] = useState<any>(null); // a coworker's bid for my company
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Response form
  const [showResponseForm, setShowResponseForm] = useState(false);
  const [responseType, setResponseType] = useState<'interested' | 'declined'>('interested');
  const [propStart, setPropStart] = useState('');
  const [propEnd, setPropEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [declineReason, setDeclineReason] = useState('');

  useEffect(() => {
    if (!user) return;
    loadJob();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, jobId]);

  const loadJob = async () => {
    if (!user) return;

    const { data: jobData } = await supabase
      .from('cni_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (!jobData) { router.push('/installer/available'); return; }
    setJob(jobData);

    // Load VINs
    const { data: vinData } = await supabase
      .from('cni_job_vins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model')
      .eq('job_id', jobId)
      .order('sort_order');
    setVins(vinData || []);

    // My company comes from the profile (shared companies list).
    const { data: myProfile } = await supabase
      .from('profiles')
      .select('company_id')
      .eq('id', (isAdmin && preview?.profileId) || user.id)
      .maybeSingle();
    const companyId: string | null = myProfile?.company_id || null;
    setMyCompanyId(companyId);

    // Check for existing bid
    const { data: bidData } = await supabase
      .from('cni_job_bids')
      .select('*')
      .eq('job_id', jobId)
      .eq('installer_id', (isAdmin && preview?.profileId) || user.id)
      .maybeSingle();
    if (bidData) setMyBid(bidData);

    // Company response: any member's bid counts as the company's (readable via RLS)
    if (companyId) {
      const { data: companyBids } = await supabase
        .from('cni_job_bids')
        .select('response, responded_at, installer_id')
        .eq('job_id', jobId)
        .eq('company_id', companyId);
      const coworkerBid = (companyBids || []).find((b: any) => b.installer_id !== ((isAdmin && preview?.profileId) || user.id));
      setCompanyBid(coworkerBid || null);
    } else {
      setCompanyBid(null);
    }

    setLoading(false);
  };

  const submitResponse = async () => {
    if (!user || !job || submitting) return;
    setSubmitting(true);

    // Upsert bid
    const bidData: any = {
      job_id: job.id,
      installer_id: (isAdmin && preview?.profileId) || user.id,
      company_id: myCompanyId,
      response: responseType,
      responded_at: new Date().toISOString(),
    };

    if (responseType === 'interested') {
      bidData.proposed_start = propStart || null;
      bidData.proposed_end = propEnd || null;
      bidData.notes = notes || null;
    } else {
      bidData.decline_reason = declineReason || null;
    }

    const { error } = await supabase.from('cni_job_bids').upsert(bidData, {
      onConflict: 'job_id,installer_id',
    });

    if (!error) {
      // Update bid_count on the job
      const { count } = await supabase
        .from('cni_job_bids')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', job.id);
      await supabase.from('cni_jobs').update({ bid_count: count || 0 }).eq('id', job.id);

      await loadJob();
      setShowResponseForm(false);
    }
    setSubmitting(false);
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
      <InstallerPreviewBanner preview={isAdmin ? preview : null} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/installer/available')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>{job.title}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {job.job_number} {job.customer_name ? `• ${job.customer_name}` : ''}
          </div>
        </div>
      </div>

      {/* My Response Status */}
      {myBid && (
        <div style={{
          ...sectionStyle,
          background: myBid.response === 'interested'
            ? 'color-mix(in srgb, var(--success) 8%, var(--card))'
            : 'color-mix(in srgb, var(--error) 8%, var(--card))',
          borderColor: myBid.response === 'interested' ? 'var(--success-border)' : 'var(--error-border)',
        }}>
          <div style={{
            fontSize: '14px', fontWeight: 700, marginBottom: '4px',
            color: myBid.response === 'interested' ? 'var(--success)' : 'var(--error)',
          }}>
            {myBid.response === 'interested' ? '✓ You expressed interest' : '✕ You declined this job'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Responded {new Date(myBid.responded_at).toLocaleDateString()}
            {myBid.proposed_start && ` • Proposed: ${new Date(myBid.proposed_start).toLocaleDateString()}`}
          </div>
          {myBid.notes && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              {myBid.notes}
            </div>
          )}
          {myBid.decline_reason && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Reason: {myBid.decline_reason}
            </div>
          )}
          <button
            onClick={() => { setShowResponseForm(true); setResponseType(myBid.response === 'interested' ? 'interested' : 'declined'); }}
            style={{
              marginTop: '10px', padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
              background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
            }}
          >
            Update Response
          </button>
        </div>
      )}

      {/* Project Overview */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>PROJECT OVERVIEW</div>
        {job.scope && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Scope</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px', lineHeight: '1.5' }}>{job.scope}</div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          {job.budget && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Budget</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)' }}>${Number(job.budget).toLocaleString()}</div>
            </div>
          )}
          {job.deadline && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Deadline</div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {new Date(job.deadline).toLocaleDateString()}
              </div>
            </div>
          )}
          {job.estimated_hours && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Est. Hours</div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{job.estimated_hours}h</div>
            </div>
          )}
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Vehicles</div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{job.vin_count}</div>
          </div>
        </div>
      </div>

      {/* Location */}
      {(addr.street || addr.city) && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>INSTALL LOCATION</div>
          <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
            {[addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')}
          </div>
          {job.site_contact_name && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
              Contact: {job.site_contact_name} {job.site_contact_phone ? `• ${job.site_contact_phone}` : ''}
            </div>
          )}
        </div>
      )}

      {/* Materials */}
      {job.requires_shipment && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>MATERIALS</div>
          <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
            Materials will be shipped to the install location
          </div>
          {(shipAddr.street || shipAddr.city) && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Ship to: {[shipAddr.street, shipAddr.city, shipAddr.state, shipAddr.zip].filter(Boolean).join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Vehicles */}
      {vins.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
            VEHICLES ({vins.length})
          </div>
          {vins.map(v => (
            <div key={v.id} style={{
              padding: '8px 12px', borderRadius: '8px', marginBottom: '4px',
              background: 'var(--input-bg)', border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                {v.vin}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {[v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Company already responded (a coworker did it) */}
      {!myBid && companyBid && (
        <div style={{
          ...sectionStyle,
          background: companyBid.response === 'interested'
            ? 'color-mix(in srgb, var(--success) 8%, var(--card))'
            : 'color-mix(in srgb, var(--error) 8%, var(--card))',
          borderColor: companyBid.response === 'interested' ? 'var(--success-border)' : 'var(--error-border)',
        }}>
          <div style={{
            fontSize: '14px', fontWeight: 700, marginBottom: '4px',
            color: companyBid.response === 'interested' ? 'var(--success)' : 'var(--error)',
          }}>
            {companyBid.response === 'interested' ? '✓ Your company responded' : '✕ Your company declined this job'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Responded {new Date(companyBid.responded_at).toLocaleDateString()}
          </div>
        </div>
      )}

      {/* Response Buttons */}
      {!myBid && !companyBid && !showResponseForm && (
        <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
          <button
            onClick={() => { setResponseType('interested'); setShowResponseForm(true); }}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', fontSize: '14px', fontWeight: 700,
              background: 'var(--orange)', color: '#fff', border: 'none',
            }}
          >
            I'm Interested
          </button>
          <button
            onClick={() => { setResponseType('declined'); setShowResponseForm(true); }}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', fontSize: '14px', fontWeight: 700,
              background: 'var(--subtle-bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
            }}
          >
            Decline
          </button>
        </div>
      )}

      {/* Response Form */}
      {showResponseForm && (
        <div style={{
          padding: '16px', borderRadius: '14px', marginBottom: '14px',
          background: responseType === 'interested'
            ? 'color-mix(in srgb, var(--success) 5%, var(--card))'
            : 'color-mix(in srgb, var(--error) 5%, var(--card))',
          border: responseType === 'interested'
            ? '1px solid var(--success-border)'
            : '1px solid var(--error-border)',
        }}>
          {/* Toggle */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
            <button
              onClick={() => setResponseType('interested')}
              style={{
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: responseType === 'interested' ? 'var(--success)' : 'var(--input-bg)',
                color: responseType === 'interested' ? '#fff' : 'var(--text-muted)',
                border: 'none',
              }}
            >
              Interested
            </button>
            <button
              onClick={() => setResponseType('declined')}
              style={{
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: responseType === 'declined' ? 'var(--error)' : 'var(--input-bg)',
                color: responseType === 'declined' ? '#fff' : 'var(--text-muted)',
                border: 'none',
              }}
            >
              Decline
            </button>
          </div>

          {responseType === 'interested' ? (
            <>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '10px' }}>
                Propose your availability
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>
                    Earliest Start
                  </label>
                  <input style={inputStyle} type="date" value={propStart} onChange={e => setPropStart(e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>
                    End Date
                  </label>
                  <input style={inputStyle} type="date" value={propEnd} onChange={e => setPropEnd(e.target.value)} />
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>
                  Notes (optional)
                </label>
                <textarea
                  style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Any relevant info about your availability, equipment, etc."
                />
              </div>
            </>
          ) : (
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>
                Reason for declining (optional)
              </label>
              <select
                style={inputStyle}
                value={declineReason}
                onChange={e => setDeclineReason(e.target.value)}
              >
                <option value="">Select a reason...</option>
                <option value="schedule_conflict">Schedule conflict</option>
                <option value="too_far">Too far from my area</option>
                <option value="not_my_specialty">Not my specialty</option>
                <option value="budget_too_low">Budget too low</option>
                <option value="other">Other</option>
              </select>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setShowResponseForm(false)}
              style={{
                flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
                background: 'var(--subtle-bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
              }}
            >
              Cancel
            </button>
            <button
              onClick={submitResponse}
              disabled={submitting}
              style={{
                flex: 2, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                background: submitting ? 'var(--text-muted)' : responseType === 'interested' ? 'var(--orange)' : 'var(--error)',
                color: '#fff', border: 'none',
              }}
            >
              {submitting ? 'Submitting...' : responseType === 'interested' ? 'Submit Interest' : 'Confirm Decline'}
            </button>
          </div>
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
