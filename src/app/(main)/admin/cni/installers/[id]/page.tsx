'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

const RISK_TAG_OPTIONS = [
  { id: 'preferred', label: 'Preferred', color: 'var(--success)' },
  { id: 'at_risk', label: 'At Risk', color: 'var(--warning)' },
  { id: 'needs_review', label: 'Needs Review', color: '#60a5fa' },
  { id: 'do_not_assign', label: 'Do Not Assign', color: 'var(--error)' },
];

export default function CniInstallerDetailPage() {
  const router = useRouter();
  const params = useParams();
  const userId = params.id as string;
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [profile, setProfile] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [internalNotes, setInternalNotes] = useState<any[]>([]);
  const [newNote, setNewNote] = useState('');
  const [newNoteType, setNewNoteType] = useState('general');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Editable internal fields
  const [completionReliability, setCompletionReliability] = useState('good');
  const [photoQuality, setPhotoQuality] = useState('good');
  const [communicationRating, setCommunicationRating] = useState('responsive');
  const [riskTags, setRiskTags] = useState<string[]>([]);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  }, [isAdmin, userId]);

  const loadData = async () => {
    const { data: cniData } = await supabase
      .from('cni_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();
    setProfile(cniData);

    if (cniData) {
      setCompletionReliability(cniData.completion_reliability || 'good');
      setPhotoQuality(cniData.photo_quality || 'good');
      setCommunicationRating(cniData.communication_rating || 'responsive');
      setRiskTags(cniData.risk_tags || []);
    }

    const { data: userData } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', userId)
      .single();
    setUserProfile(userData);

    const { data: jobsData } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, customer_name, completed_at, invoice_status, deadline, confirmed_schedule_end')
      .eq('assigned_installer_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    setJobs(jobsData || []);

    // Load internal notes
    const { data: notesData } = await supabase
      .from('cni_internal_notes')
      .select('*')
      .eq('installer_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    setInternalNotes(notesData || []);

    setLoading(false);
  };

  const toggleTag = (tag: string) => {
    setRiskTags(riskTags.includes(tag) ? riskTags.filter(t => t !== tag) : [...riskTags, tag]);
  };

  const saveInternalFields = async () => {
    if (!profile) return;
    setSaving(true);
    await supabase.from('cni_profiles').update({
      completion_reliability: completionReliability,
      photo_quality: photoQuality,
      communication_rating: communicationRating,
      risk_tags: riskTags,
      updated_at: new Date().toISOString(),
    }).eq('user_id', userId);
    setSaving(false);
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  if (!profile || !userProfile) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <div style={{ color: 'var(--text-muted)', marginBottom: '12px' }}>CNI profile not found</div>
        <button onClick={() => router.push('/admin/cni/installers')} style={{ color: 'var(--orange)', fontWeight: 600 }}>← Back</button>
      </div>
    );
  }

  const addr = profile.business_address || {};
  const sectionStyle: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni/installers')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>{userProfile.full_name}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {profile.company_name || 'Independent'} • {userProfile.email}
          </div>
        </div>
      </div>

      {/* Tags */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <span style={{
          fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '6px',
          textTransform: 'capitalize',
          background: profile.availability_status === 'available' ? 'var(--success-bg)' :
                     profile.availability_status === 'limited' ? 'var(--warning-bg)' : 'var(--error-bg)',
          color: profile.availability_status === 'available' ? 'var(--success)' :
                 profile.availability_status === 'limited' ? 'var(--warning)' : 'var(--error)',
        }}>
          {profile.availability_status}
        </span>
        {riskTags.map(tag => {
          const opt = RISK_TAG_OPTIONS.find(o => o.id === tag);
          return (
            <span key={tag} style={{
              fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '6px',
              background: `color-mix(in srgb, ${opt?.color || 'var(--text-muted)'} 12%, transparent)`,
              color: opt?.color || 'var(--text-muted)',
            }}>
              {opt?.label || tag}
            </span>
          );
        })}
      </div>

      {/* Basic Info */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>PROFILE</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Phone</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{profile.phone || '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Coverage</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{profile.coverage_radius_miles ? `${profile.coverage_radius_miles} mi` : '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Location</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
              {addr.city ? `${addr.city}, ${addr.state || ''}` : '—'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Jobs Completed</div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{profile.jobs_completed || 0}</div>
          </div>
        </div>
        {profile.service_types?.length > 0 && (
          <div style={{ marginTop: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Services</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {profile.service_types.map((s: string) => s.replace(/_/g, ' ')).join(', ')}
            </div>
          </div>
        )}
        {profile.equipment_capabilities?.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Equipment</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {profile.equipment_capabilities.map((s: string) => s.replace(/_/g, ' ')).join(', ')}
            </div>
          </div>
        )}
      </div>

      {/* Compliance */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>COMPLIANCE</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>W9</div>
            <div style={{ fontSize: '13px', color: profile.w9_file_path ? 'var(--success)' : 'var(--error)' }}>
              {profile.w9_file_path ? '✓ Uploaded' : '✕ Missing'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Insurance</div>
            <div style={{ fontSize: '13px', color: profile.insurance_cert_path ? 'var(--success)' : 'var(--error)' }}>
              {profile.insurance_cert_path ? '✓ Uploaded' : '✕ Missing'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Terms Accepted</div>
            <div style={{ fontSize: '13px', color: profile.terms_accepted_at ? 'var(--success)' : 'var(--text-muted)' }}>
              {profile.terms_accepted_at ? '✓ Yes' : 'No'}
            </div>
          </div>
          {profile.insurance_expiry && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Insurance Expiry</div>
              <div style={{
                fontSize: '13px', fontWeight: 600,
                color: new Date(profile.insurance_expiry) < new Date() ? 'var(--error)' : 'var(--text-primary)',
              }}>
                {new Date(profile.insurance_expiry).toLocaleDateString()}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* INTERNAL ONLY — Performance & Risk */}
      <div style={{
        padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'color-mix(in srgb, var(--error) 5%, var(--card))',
        border: '1px solid var(--error-border)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--error)', marginBottom: '12px' }}>
          INTERNAL ONLY — Not visible to installer
        </div>

        {/* Performance */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>Performance</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
            {[
              { label: 'Reliability', value: completionReliability, set: setCompletionReliability, opts: ['good', 'late_flags', 'at_risk'] },
              { label: 'Photos', value: photoQuality, set: setPhotoQuality, opts: ['pass', 'conditional', 'fail_trends'] },
              { label: 'Comms', value: communicationRating, set: setCommunicationRating, opts: ['responsive', 'slow', 'difficult'] },
            ].map(field => (
              <div key={field.label}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>{field.label}</div>
                <select
                  value={field.value}
                  onChange={e => field.set(e.target.value)}
                  style={{
                    width: '100%', padding: '8px', borderRadius: '8px', fontSize: '11px',
                    background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-body)',
                  }}
                >
                  {field.opts.map(o => (
                    <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Risk Tags */}
        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>Risk Tags</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {RISK_TAG_OPTIONS.map(opt => (
              <button
                key={opt.id}
                onClick={() => toggleTag(opt.id)}
                style={{
                  padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                  background: riskTags.includes(opt.id) ? `color-mix(in srgb, ${opt.color} 15%, transparent)` : 'var(--input-bg)',
                  color: riskTags.includes(opt.id) ? opt.color : 'var(--text-muted)',
                  border: riskTags.includes(opt.id) ? `1px solid ${opt.color}` : '1px solid var(--border)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={saveInternalFields}
          disabled={saving}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
            background: saving ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
          }}
        >
          {saving ? 'Saving...' : 'Save Internal Fields'}
        </button>
      </div>

      {/* Performance Summary */}
      {jobs.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>PERFORMANCE SUMMARY</div>
          {(() => {
            const completed = jobs.filter(j => j.status === 'approved_closed');
            const onTime = completed.filter(j => {
              if (!j.deadline || !j.completed_at) return true;
              return new Date(j.completed_at) <= new Date(j.deadline);
            });
            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                <div style={{ textAlign: 'center', padding: '10px', borderRadius: '8px', background: 'var(--input-bg)' }}>
                  <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>{jobs.length}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Total Jobs</div>
                </div>
                <div style={{ textAlign: 'center', padding: '10px', borderRadius: '8px', background: 'var(--success-bg)' }}>
                  <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--success)' }}>{completed.length}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Completed</div>
                </div>
                <div style={{ textAlign: 'center', padding: '10px', borderRadius: '8px', background: completed.length > 0 ? 'var(--success-bg)' : 'var(--subtle-bg)' }}>
                  <div style={{ fontSize: '18px', fontWeight: 800, color: completed.length > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {completed.length > 0 ? Math.round((onTime.length / completed.length) * 100) : 0}%
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>On-Time</div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Job History */}
      {jobs.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
            JOB HISTORY ({jobs.length})
          </div>
          {jobs.map(j => (
            <button
              key={j.id}
              onClick={() => router.push(`/admin/cni/jobs/${j.id}`)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '10px 12px', borderRadius: '8px', marginBottom: '6px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{j.title}</div>
                <span style={{
                  fontSize: '10px', fontWeight: 700,
                  color: j.status === 'approved_closed' ? 'var(--success)' : 'var(--text-muted)',
                }}>
                  {j.status === 'approved_closed' ? '✓' : '•'} {j.status.replace(/_/g, ' ')}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {j.job_number} {j.customer_name ? `• ${j.customer_name}` : ''}
                {j.invoice_status && j.invoice_status !== 'none' && (
                  <span style={{
                    marginLeft: '6px',
                    color: j.invoice_status === 'billed_in_netsuite' ? 'var(--success)' :
                           j.invoice_status === 'approved' ? 'var(--success)' : 'var(--warning)',
                  }}>
                    • Invoice: {j.invoice_status.replace(/_/g, ' ')}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Internal Notes */}
      <div style={{
        ...sectionStyle,
        background: 'color-mix(in srgb, var(--error) 3%, var(--card))',
        border: '2px solid var(--error)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--error)' }}>
            INTERNAL NOTES — NOT VISIBLE TO INSTALLER
          </div>
        </div>

        {/* Add note */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
            <select
              value={newNoteType}
              onChange={e => setNewNoteType(e.target.value)}
              style={{
                padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
                border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
              }}
            >
              <option value="general">General</option>
              <option value="issue">Issue</option>
              <option value="qc">QC</option>
            </select>
            <input
              type="text"
              placeholder="Add internal note..."
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: '8px', fontSize: '12px',
                border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
              }}
            />
            <button
              onClick={async () => {
                if (!newNote.trim()) return;
                await supabase.from('cni_internal_notes').insert({
                  installer_id: userId,
                  note_type: newNoteType,
                  content: newNote.trim(),
                  created_by: user?.id,
                });
                setNewNote('');
                await loadData();
              }}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--orange)', color: '#fff', border: 'none',
              }}
            >
              Add
            </button>
          </div>
        </div>

        {/* Notes list */}
        {internalNotes.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No internal notes yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {internalNotes.map(n => (
              <div key={n.id} style={{
                padding: '8px 10px', borderRadius: '8px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                    background: n.note_type === 'issue' ? 'var(--error-bg)' : n.note_type === 'qc' ? 'var(--warning-bg)' : 'var(--subtle-bg)',
                    color: n.note_type === 'issue' ? 'var(--error)' : n.note_type === 'qc' ? 'var(--warning)' : 'var(--text-muted)',
                    textTransform: 'uppercase',
                  }}>
                    {n.note_type}
                  </span>
                  {n.auto_generated && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontStyle: 'italic' }}>auto</span>
                  )}
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    {new Date(n.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{n.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: '80px' }} />
    </div>
  );
}
