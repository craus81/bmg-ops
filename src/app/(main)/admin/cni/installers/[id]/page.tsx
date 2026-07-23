'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import { loadCompaniesWithCounts, type CompanyOption } from '@/lib/cni-companies';
import { storage } from '@/lib/storage';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { flashNote } from '@/lib/focus-note';

const RISK_TAG_OPTIONS = [
  { id: 'preferred', label: 'Preferred', color: 'var(--success)' },
  { id: 'at_risk', label: 'At Risk', color: 'var(--warning)' },
  { id: 'needs_review', label: 'Needs Review', color: '#60a5fa' },
  { id: 'do_not_assign', label: 'Do Not Assign', color: 'var(--error)' },
];

const SERVICE_TYPE_OPTIONS = [
  { id: 'graphics_install', label: 'Graphics Installation' },
  { id: 'tech_install', label: 'Technology Installation' },
  { id: 'upfitting', label: 'Upfitting' },
  { id: 'removal_rebrand', label: 'Removal / Rebrand' },
];

const EQUIPMENT_OPTIONS = [
  { id: 'indoor', label: 'Indoor' },
  { id: 'outdoor', label: 'Outdoor Only' },
  { id: 'lift_bucket', label: 'Lift / Bucket' },
  { id: 'shop', label: 'Shop' },
  { id: 'mobile', label: 'Mobile' },
];

export default function CniInstallerDetailPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const userId = params.id as string;
  const { isAdmin, user, loading: authLoading } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();

  const [profile, setProfile] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [internalNotes, setInternalNotes] = useState<any[]>([]);
  const [newNote, setNewNote] = useState('');
  const [newNoteType, setNewNoteType] = useState('general');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');

  // Editable internal fields
  const [completionReliability, setCompletionReliability] = useState('good');
  const [photoQuality, setPhotoQuality] = useState('pass');
  const [communicationRating, setCommunicationRating] = useState('responsive');
  const [riskTags, setRiskTags] = useState<string[]>([]);

  // Company is the single source of truth via profiles.company_id — the picker
  // sets that, not a free-text string (which used to silently NOT change the
  // installer's actual company). New-company name, when filled, takes priority.
  const [companies, setCompanies] = useState<CompanyOption[]>([]);

  // Edit mode
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    fullName: '', email: '', companyId: '', newCompanyName: '', phone: '',
    street: '', city: '', state: '', zip: '',
    coverageRadius: '', serviceTypes: [] as string[], equipmentCapabilities: [] as string[],
    availabilityStatus: 'available',
  });

  // Action states
  const [resending, setResending] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
    // A mention deep link (?note=<id>) scroll-flashes that note once the
    // notes list renders.
    const noteId = searchParams.get('note');
    if (noteId) flashNote(`cni-note-${noteId}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin, userId]);

  const showMessage = (msg: string, type: 'success' | 'error' = 'success') => {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(''), 4000);
  };

  const loadData = async () => {
    setCompanies(await loadCompaniesWithCounts(supabase));

    const { data: userData } = await supabase
      .from('profiles')
      .select('full_name, email, deactivated, deactivated_at, role, roles, company_id')
      .eq('id', userId)
      .single();
    setUserProfile(userData);

    let { data: cniData } = await supabase
      .from('cni_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    // Self-heal: a user tagged installer in user management may not have a
    // cni_profiles onboarding record yet. Create a blank one so this page —
    // and its edits/saves — work without a separate provisioning step.
    const isInstaller = userData?.role === 'installer' || (userData?.roles || []).includes('installer');
    if (!cniData && userData && isInstaller) {
      let companyName: string | null = null;
      if (userData.company_id) {
        const { data: comp } = await supabase
          .from('companies').select('name').eq('id', userData.company_id).maybeSingle();
        companyName = comp?.name || null;
      }
      // photo_quality is set explicitly: its table default ('good') is invalid
      // under the column's own CHECK, so an insert that omits it fails.
      const { data: created } = await supabase
        .from('cni_profiles')
        .upsert({ user_id: userId, company_name: companyName, photo_quality: 'pass' }, { onConflict: 'user_id' })
        .select('*')
        .single();
      cniData = created || null;
    }
    setProfile(cniData || {});

    if (cniData) {
      setCompletionReliability(cniData.completion_reliability || 'good');
      setPhotoQuality(cniData.photo_quality || 'pass');
      setCommunicationRating(cniData.communication_rating || 'responsive');
      setRiskTags(cniData.risk_tags || []);
    }

    const { data: jobsData } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, customer_name, completed_at, invoice_status, deadline, confirmed_schedule_end')
      .eq('assigned_installer_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    setJobs(jobsData || []);

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

  const addInternalNote = async () => {
    const content = newNote.trim();
    if (!content) return;
    const { data: inserted, error } = await supabase.from('cni_internal_notes').insert({
      installer_id: userId,
      note_type: newNoteType,
      content,
      created_by: user?.id,
    }).select('id').single();
    if (!error) {
      // Carry the note id so a mention deep link scrolls straight to it.
      reportMentions({
        text: content,
        sourceType: 'cni_internal_note',
        sourceId: userId,
        contextLabel: `Installer — ${userProfile?.full_name || 'CNI installer'}`,
        contextUrl: `/admin/cni/installers/${userId}${inserted?.id ? `?note=${inserted.id}` : ''}`,
      });
    }
    setNewNote('');
    await loadData();
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
    showMessage('Internal fields saved');
  };

  // ── Edit Profile ──
  const startEditing = () => {
    const addr = profile?.business_address || {};
    setEditForm({
      fullName: userProfile?.full_name || '',
      email: userProfile?.email || '',
      companyId: userProfile?.company_id || '',
      newCompanyName: '',
      phone: profile?.phone || '',
      street: addr.street || '',
      city: addr.city || '',
      state: addr.state || '',
      zip: addr.zip || '',
      coverageRadius: profile?.coverage_radius_miles?.toString() || '',
      serviceTypes: profile?.service_types || [],
      equipmentCapabilities: profile?.equipment_capabilities || [],
      availabilityStatus: profile?.availability_status || 'available',
    });
    setIsEditing(true);
  };

  const saveEdit = async () => {
    if (!editForm.fullName.trim() || !editForm.email.trim()) {
      showMessage('Name and email are required', 'error');
      return;
    }
    setSaving(true);

    // Resolve the company: a typed new name wins (create-or-reuse it), else the
    // picked existing company. This sets profiles.company_id — the authoritative
    // membership link — instead of a free-text label that changed nothing.
    let companyId: string | null = editForm.companyId || null;
    let companyName: string | null = companies.find(c => c.id === companyId)?.name || null;
    const newName = editForm.newCompanyName.trim();
    if (newName) {
      const existing = companies.find(c => c.name.toLowerCase() === newName.toLowerCase());
      if (existing) {
        companyId = existing.id;
        companyName = existing.name;
      } else {
        const { data: created, error: compErr } = await supabase
          .from('companies').insert({ name: newName }).select('id, name').single();
        if (compErr || !created) {
          showMessage('Failed to create company: ' + (compErr?.message || 'unknown'), 'error');
          setSaving(false);
          return;
        }
        companyId = created.id;
        companyName = created.name;
      }
    }

    // Update profiles table (name, email, company membership)
    const { error: profileErr } = await supabase.from('profiles').update({
      full_name: editForm.fullName.trim(),
      email: editForm.email.trim().toLowerCase(),
      company_id: companyId,
    }).eq('id', userId);

    if (profileErr) {
      showMessage('Failed to update profile: ' + profileErr.message, 'error');
      setSaving(false);
      return;
    }

    // Update cni_profiles table. company_name is kept in sync with the chosen
    // company as a transitional display fallback (a later migration drops it).
    const { error: cniErr } = await supabase.from('cni_profiles').update({
      company_name: companyName,
      phone: editForm.phone.trim() || null,
      business_address: {
        street: editForm.street.trim(),
        city: editForm.city.trim(),
        state: editForm.state.trim(),
        zip: editForm.zip.trim(),
      },
      coverage_radius_miles: editForm.coverageRadius ? parseInt(editForm.coverageRadius) : null,
      service_types: editForm.serviceTypes,
      equipment_capabilities: editForm.equipmentCapabilities,
      availability_status: editForm.availabilityStatus,
      updated_at: new Date().toISOString(),
    }).eq('user_id', userId);

    if (cniErr) {
      showMessage('Failed to update CNI profile: ' + cniErr.message, 'error');
      setSaving(false);
      return;
    }

    setSaving(false);
    setIsEditing(false);
    showMessage('Profile updated successfully');
    await loadData();
  };

  const toggleEditItem = (list: string[], item: string) => {
    return list.includes(item) ? list.filter(i => i !== item) : [...list, item];
  };

  // ── Deactivate / Reactivate ──
  const handleDeactivate = async () => {
    const name = userProfile?.full_name || 'this installer';
    if (!(await dialog.confirm(`Deactivate ${name}? They will no longer be able to log in.`, { confirmLabel: 'Deactivate' }))) return;

    const { error } = await supabase.from('profiles')
      .update({ deactivated: true, deactivated_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) {
      showMessage('Failed to deactivate: ' + error.message, 'error');
    } else {
      showMessage(`${name} has been deactivated`);
      await loadData();
    }
  };

  const handleReactivate = async () => {
    const { error } = await supabase.from('profiles')
      .update({ deactivated: false, deactivated_at: null, deactivated_by: null })
      .eq('id', userId);

    if (error) {
      showMessage('Failed to reactivate: ' + error.message, 'error');
    } else {
      showMessage('Installer reactivated');
      await loadData();
    }
  };

  // ── Delete ──
  const handleDelete = async () => {
    const name = userProfile?.full_name || 'this installer';
    if (!(await dialog.confirm(`Permanently delete ${name}? This cannot be undone.`, { destructive: true, confirmLabel: 'Delete' }))) return;
    if (!(await dialog.confirm(`Are you absolutely sure? This will remove ${name} and all their CNI data from the system entirely.`, { destructive: true, confirmLabel: 'Delete' }))) return;

    setDeleting(true);
    try {
      const res = await fetch('/api/cni/delete-installer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (!res.ok) {
        showMessage(data.error || 'Failed to delete installer', 'error');
        setDeleting(false);
      } else {
        router.push('/admin/cni/installers');
      }
    } catch (err: any) {
      showMessage('Error: ' + err.message, 'error');
      setDeleting(false);
    }
  };

  // ── Resend Invite ──
  const handleResendInvite = async () => {
    setResending(true);
    try {
      const res = await fetch('/api/cni/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          email: userProfile?.email,
          fullName: userProfile?.full_name,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showMessage(data.error || 'Failed to resend invite', 'error');
      } else {
        showMessage(data.emailSent ? 'Invite email sent!' : 'Link generated (email may not have sent)');
      }
    } catch (err: any) {
      showMessage('Error: ' + err.message, 'error');
    }
    setResending(false);
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  if (!userProfile) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <div style={{ color: 'var(--text-muted)', marginBottom: '12px' }}>Installer not found</div>
        <button onClick={() => router.push('/admin/cni/installers')} style={{ color: 'var(--orange)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>← Back</button>
      </div>
    );
  }

  const addr = profile.business_address || {};
  const isDeactivated = !!userProfile.deactivated;
  const isProfileIncomplete = !profile.profile_complete;

  const sectionStyle: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '13px',
    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px', display: 'block',
  };

  return (
    <div>
      {/* Message Banner */}
      {message && (
        <div style={{
          padding: '10px 14px', borderRadius: '10px', marginBottom: '12px', fontSize: '13px', fontWeight: 600,
          background: messageType === 'success' ? 'var(--success-bg)' : 'var(--error-bg)',
          border: `1px solid ${messageType === 'success' ? 'var(--success-border)' : 'var(--error-border)'}`,
          color: messageType === 'success' ? 'var(--success)' : 'var(--error)',
        }}>
          {message}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
        <button onClick={() => router.push('/admin/cni/installers')} style={{
          fontSize: '20px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer',
        }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)',
            opacity: isDeactivated ? 0.5 : 1,
          }}>
            {userProfile.full_name}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {companies.find(c => c.id === userProfile.company_id)?.name || profile.company_name || 'Independent'} • {userProfile.email}
          </div>
        </div>
        {!isEditing && (
          <button onClick={startEditing} style={{
            padding: '6px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: 'var(--subtle-bg)', border: '1px solid var(--border)',
            color: theme.textPrimary, cursor: 'pointer',
          }}>
            Edit
          </button>
        )}
      </div>

      {/* Status Badges */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {isDeactivated && (
          <span style={{
            fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '6px',
            background: 'var(--error-bg)', color: 'var(--error)',
          }}>
            DEACTIVATED
          </span>
        )}
        {isProfileIncomplete && (
          <span style={{
            fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '6px',
            background: 'var(--warning-bg)', color: 'var(--warning)',
          }}>
            PENDING SETUP
          </span>
        )}
        {!isDeactivated && (
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
        )}
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

      {/* ── EDIT MODE ── */}
      {isEditing ? (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary, marginBottom: '14px' }}>
            Edit Installer Profile
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>Full Name *</label>
              <input style={inputStyle} value={editForm.fullName} onChange={e => setEditForm({ ...editForm, fullName: e.target.value })} />
            </div>
            <div>
              <label style={labelStyle}>Email *</label>
              <input style={inputStyle} value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
            </div>
            <div>
              <label style={labelStyle}>Company</label>
              <select
                style={inputStyle}
                value={editForm.companyId}
                onChange={e => setEditForm({ ...editForm, companyId: e.target.value, newCompanyName: '' })}
              >
                <option value="">— Select a company —</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <input
                style={{ ...inputStyle, marginTop: '6px' }}
                placeholder="…or type a new company to create"
                value={editForm.newCompanyName}
                onChange={e => setEditForm({ ...editForm, newCompanyName: e.target.value })}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Sets the installer&apos;s actual company (membership), not just a label.
              </div>
            </div>
            <div>
              <label style={labelStyle}>Phone</label>
              <input style={inputStyle} value={editForm.phone} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} />
            </div>
          </div>

          {/* Address */}
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Street Address</label>
            <input style={inputStyle} value={editForm.street} onChange={e => setEditForm({ ...editForm, street: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>City</label>
              <input style={inputStyle} value={editForm.city} onChange={e => setEditForm({ ...editForm, city: e.target.value })} />
            </div>
            <div>
              <label style={labelStyle}>State</label>
              <input style={inputStyle} value={editForm.state} onChange={e => setEditForm({ ...editForm, state: e.target.value })} maxLength={2} />
            </div>
            <div>
              <label style={labelStyle}>Zip</label>
              <input style={inputStyle} value={editForm.zip} onChange={e => setEditForm({ ...editForm, zip: e.target.value })} />
            </div>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Coverage Radius (miles)</label>
            <input style={inputStyle} type="number" value={editForm.coverageRadius} onChange={e => setEditForm({ ...editForm, coverageRadius: e.target.value })} />
          </div>

          {/* Availability */}
          <div style={{ marginBottom: '14px' }}>
            <label style={labelStyle}>Availability Status</label>
            <select
              value={editForm.availabilityStatus}
              onChange={e => setEditForm({ ...editForm, availabilityStatus: e.target.value })}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="available">Available</option>
              <option value="limited">Limited</option>
              <option value="unavailable">Unavailable</option>
            </select>
          </div>

          {/* Service Types */}
          <div style={{ marginBottom: '14px' }}>
            <label style={labelStyle}>Service Types</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
              {SERVICE_TYPE_OPTIONS.map(opt => {
                const active = editForm.serviceTypes.includes(opt.id);
                return (
                  <button key={opt.id} onClick={() => setEditForm({ ...editForm, serviceTypes: toggleEditItem(editForm.serviceTypes, opt.id) })} style={{
                    padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                    background: active ? 'color-mix(in srgb, var(--orange) 12%, transparent)' : 'var(--input-bg)',
                    border: `1px solid ${active ? 'var(--orange)' : 'var(--border)'}`,
                    color: active ? 'var(--orange)' : 'var(--text-muted)',
                  }}>
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Equipment */}
          <div style={{ marginBottom: '16px' }}>
            <label style={labelStyle}>Equipment &amp; Capabilities</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
              {EQUIPMENT_OPTIONS.map(opt => {
                const active = editForm.equipmentCapabilities.includes(opt.id);
                return (
                  <button key={opt.id} onClick={() => setEditForm({ ...editForm, equipmentCapabilities: toggleEditItem(editForm.equipmentCapabilities, opt.id) })} style={{
                    padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                    background: active ? 'color-mix(in srgb, #2a6178 15%, transparent)' : 'var(--input-bg)',
                    border: `1px solid ${active ? '#2a6178' : 'var(--border)'}`,
                    color: active ? '#5cb8d4' : 'var(--text-muted)',
                  }}>
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Save / Cancel */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={saveEdit} disabled={saving} style={{
              flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: saving ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none', cursor: saving ? 'default' : 'pointer',
            }}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button onClick={() => setIsEditing(false)} style={{
              padding: '12px 20px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer',
            }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ── VIEW MODE: Basic Info ── */}
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
        </>
      )}

      {/* Compliance */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>COMPLIANCE</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          {([
            ['W9', profile.w9_file_path],
            ['Insurance', profile.insurance_cert_path],
            ['Direct Deposit', profile.direct_deposit_file_path],
          ] as [string, string | null][]).map(([label, path]) => (
            <div key={label}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: '13px', color: path ? 'var(--success)' : 'var(--error)' }}>
                {path ? '✓ Uploaded' : '✕ Missing'}
                {path && (
                  <a
                    href={storage.from('cni-docs').getPublicUrl(path).data.publicUrl}
                    target="_blank" rel="noreferrer"
                    style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none' }}
                  >
                    📄 View
                  </a>
                )}
              </div>
            </div>
          ))}
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
                  padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
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
            background: saving ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none', cursor: saving ? 'default' : 'pointer',
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
                background: 'var(--input-bg)', border: '1px solid var(--border)', cursor: 'pointer',
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
            <MentionTextArea
              placeholder="Add internal note... (@ tags a teammate)"
              value={newNote}
              onChange={setNewNote}
              rows={1}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: '8px', fontSize: '12px', resize: 'none',
                border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  addInternalNote();
                }
              }}
            />
            <button
              onClick={addInternalNote}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--orange)', color: '#fff', border: 'none', cursor: 'pointer',
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
              <div key={n.id} id={`cni-note-${n.id}`} style={{
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

      {/* ── Account Actions ── */}
      <div style={{
        ...sectionStyle,
        background: 'var(--subtle-bg)',
        border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '12px' }}>
          ACCOUNT ACTIONS
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Resend Invite */}
          <button
            onClick={handleResendInvite}
            disabled={resending}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'var(--card)', border: '1px solid var(--border)',
              color: theme.textPrimary, cursor: resending ? 'default' : 'pointer',
              opacity: resending ? 0.6 : 1,
            }}
          >
            {resending ? 'Sending...' : isProfileIncomplete ? 'Resend CNI Invite Email' : 'Send Login Link'}
          </button>

          {/* Deactivate / Reactivate */}
          {isDeactivated ? (
            <button
              onClick={handleReactivate}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                background: 'var(--success-bg)', border: '1px solid var(--success-border)',
                color: 'var(--success)', cursor: 'pointer',
              }}
            >
              Reactivate Installer
            </button>
          ) : (
            <button
              onClick={handleDeactivate}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                background: 'var(--warning-bg)', border: '1px solid var(--warning-border)',
                color: 'var(--warning)', cursor: 'pointer',
              }}
            >
              Deactivate Installer
            </button>
          )}

          {/* Delete */}
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'var(--error-bg)', border: '1px solid var(--error-border)',
              color: 'var(--error)', cursor: deleting ? 'default' : 'pointer',
              opacity: deleting ? 0.6 : 1,
            }}
          >
            {deleting ? 'Deleting...' : 'Delete Permanently'}
          </button>
        </div>
      </div>

      <div style={{ height: '80px' }} />
    </div>
  );
}
