'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface Bid {
  id: string;
  job_id: string;
  installer_id: string;
  response: string;
  decline_reason: string | null;
  proposed_start: string | null;
  proposed_end: string | null;
  notes: string | null;
  responded_at: string;
  // joined
  installer_name: string;
  company_name: string | null;
  availability_status: string;
  coverage_radius_miles: number | null;
  jobs_completed: number;
  risk_tags: string[];
  completion_reliability: string;
  communication_rating: string;
  photo_quality: string;
  business_address: any;
}

export default function BidReviewPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { isAdmin } = useAuth();
  const supabase = createClient();

  const [job, setJob] = useState<any>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [tab, setTab] = useState<'interested' | 'declined'>('interested');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  }, [isAdmin, jobId]);

  const loadData = async () => {
    // Load job
    const { data: jobData } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, assigned_installer_id, budget, deadline, address')
      .eq('id', jobId)
      .single();
    if (!jobData) { router.push('/admin/cni'); return; }
    setJob(jobData);

    // Load bids
    const { data: bidsData } = await supabase
      .from('cni_job_bids')
      .select('*')
      .eq('job_id', jobId)
      .order('responded_at', { ascending: false });

    if (bidsData && bidsData.length > 0) {
      // Get installer profiles + names
      const installerIds = bidsData.map((b: any) => b.installer_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', installerIds);
      const nameMap: Record<string, string> = {};
      (profiles || []).forEach((p: any) => { nameMap[p.id] = p.full_name; });

      const { data: cniProfiles } = await supabase
        .from('cni_profiles')
        .select('user_id, company_name, availability_status, coverage_radius_miles, jobs_completed, risk_tags, completion_reliability, communication_rating, photo_quality, business_address')
        .in('user_id', installerIds);
      const cniMap: Record<string, any> = {};
      (cniProfiles || []).forEach((p: any) => { cniMap[p.user_id] = p; });

      setBids(bidsData.map((b: any) => ({
        ...b,
        installer_name: nameMap[b.installer_id] || 'Unknown',
        company_name: cniMap[b.installer_id]?.company_name || null,
        availability_status: cniMap[b.installer_id]?.availability_status || 'unknown',
        coverage_radius_miles: cniMap[b.installer_id]?.coverage_radius_miles || null,
        jobs_completed: cniMap[b.installer_id]?.jobs_completed || 0,
        risk_tags: cniMap[b.installer_id]?.risk_tags || [],
        completion_reliability: cniMap[b.installer_id]?.completion_reliability || 'good',
        communication_rating: cniMap[b.installer_id]?.communication_rating || 'responsive',
        photo_quality: cniMap[b.installer_id]?.photo_quality || 'good',
        business_address: cniMap[b.installer_id]?.business_address || {},
      })));
    }

    setLoading(false);
  };

  const assignFromBid = async (bid: Bid) => {
    if (!job || assigning) return;
    setAssigning(true);

    await supabase.from('cni_jobs').update({
      assigned_installer_id: bid.installer_id,
      assigned_at: new Date().toISOString(),
      status: 'assigned_awaiting_scheduling',
      // If the bid included proposed dates, seed them
      ...(bid.proposed_start ? {
        proposed_schedule_start: bid.proposed_start,
        proposed_schedule_end: bid.proposed_end || bid.proposed_start,
      } : {}),
    }).eq('id', job.id);

    router.push(`/admin/cni/jobs/${job.id}`);
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const interestedBids = bids.filter(b => b.response === 'interested');
  const declinedBids = bids.filter(b => b.response === 'declined');
  const displayBids = tab === 'interested' ? interestedBids : declinedBids;

  const perfColor = (val: string) => {
    if (val === 'good' || val === 'responsive' || val === 'pass') return 'var(--success)';
    if (val === 'late_flags' || val === 'slow' || val === 'conditional') return 'var(--warning)';
    return 'var(--error)';
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push(`/admin/cni/jobs/${jobId}`)} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Bid Review
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {job.job_number} • {job.title}
          </div>
        </div>
      </div>

      {/* Already assigned notice */}
      {job.assigned_installer_id && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--success-bg)', border: '1px solid var(--success-border)',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--success)' }}>
            ✓ Installer already assigned to this job
          </div>
        </div>
      )}

      {/* Summary */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '16px',
      }}>
        <div style={{
          padding: '12px', borderRadius: '10px', textAlign: 'center',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>{bids.length}</div>
          <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>Total</div>
        </div>
        <div style={{
          padding: '12px', borderRadius: '10px', textAlign: 'center',
          background: 'color-mix(in srgb, var(--success) 8%, var(--card))', border: '1px solid var(--success-border)',
        }}>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--success)' }}>{interestedBids.length}</div>
          <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>Interested</div>
        </div>
        <div style={{
          padding: '12px', borderRadius: '10px', textAlign: 'center',
          background: 'color-mix(in srgb, var(--error) 8%, var(--card))', border: '1px solid var(--error-border)',
        }}>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--error)' }}>{declinedBids.length}</div>
          <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)' }}>Declined</div>
        </div>
      </div>

      {/* Tab Switcher */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px',
      }}>
        {([
          { id: 'interested' as const, label: `Interested (${interestedBids.length})` },
          { id: 'declined' as const, label: `Declined (${declinedBids.length})` },
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

      {/* Bid List */}
      {displayBids.length === 0 ? (
        <div style={{
          padding: '30px', textAlign: 'center', borderRadius: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {tab === 'interested' ? 'No interested responses yet' : 'No declined responses'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {displayBids.map(bid => (
            <div key={bid.id} style={{
              padding: '16px', borderRadius: '14px',
              background: 'var(--card)', border: '1px solid var(--border)',
            }}>
              {/* Installer header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {bid.installer_name}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {bid.company_name || 'Independent'}
                    {bid.business_address?.city ? ` • ${bid.business_address.city}, ${bid.business_address.state || ''}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {bid.risk_tags.includes('preferred') && (
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: 'var(--success-bg)', color: 'var(--success)' }}>★ Preferred</span>
                  )}
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                    background: bid.availability_status === 'available' ? 'var(--success-bg)' : bid.availability_status === 'limited' ? 'var(--warning-bg)' : 'var(--error-bg)',
                    color: bid.availability_status === 'available' ? 'var(--success)' : bid.availability_status === 'limited' ? 'var(--warning)' : 'var(--error)',
                    textTransform: 'capitalize',
                  }}>
                    {bid.availability_status}
                  </span>
                </div>
              </div>

              {/* Performance mini-scores */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '10px', fontSize: '11px' }}>
                <span>{bid.jobs_completed} jobs</span>
                <span style={{ color: perfColor(bid.completion_reliability) }}>
                  Reliability: {bid.completion_reliability.replace(/_/g, ' ')}
                </span>
                <span style={{ color: perfColor(bid.communication_rating) }}>
                  Comms: {bid.communication_rating}
                </span>
                <span style={{ color: perfColor(bid.photo_quality) }}>
                  Photos: {bid.photo_quality.replace(/_/g, ' ')}
                </span>
              </div>

              {/* Bid details */}
              {bid.response === 'interested' && (
                <>
                  {bid.proposed_start && (
                    <div style={{
                      padding: '8px 12px', borderRadius: '8px', marginBottom: '8px',
                      background: 'var(--input-bg)', border: '1px solid var(--border)',
                    }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Proposed Schedule</div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '2px' }}>
                        {new Date(bid.proposed_start).toLocaleDateString()}
                        {bid.proposed_end && bid.proposed_end !== bid.proposed_start
                          ? ` — ${new Date(bid.proposed_end).toLocaleDateString()}`
                          : ''}
                      </div>
                    </div>
                  )}
                  {bid.notes && (
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px', fontStyle: 'italic' }}>
                      "{bid.notes}"
                    </div>
                  )}
                </>
              )}

              {bid.response === 'declined' && bid.decline_reason && (
                <div style={{ fontSize: '12px', color: 'var(--error)', marginBottom: '10px' }}>
                  Reason: {bid.decline_reason.replace(/_/g, ' ')}
                </div>
              )}

              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                Responded {new Date(bid.responded_at).toLocaleString()}
              </div>

              {/* Actions */}
              {bid.response === 'interested' && !job.assigned_installer_id && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => assignFromBid(bid)}
                    disabled={assigning}
                    style={{
                      flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                      background: assigning ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
                    }}
                  >
                    {assigning ? 'Assigning...' : 'Assign This Installer'}
                  </button>
                  <button
                    onClick={() => router.push(`/admin/cni/installers/${bid.installer_id}`)}
                    style={{
                      padding: '10px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
                      background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                    }}
                  >
                    Profile
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
