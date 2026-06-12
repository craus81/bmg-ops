'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface CniCompany {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  netsuite_vendor_id: string | null;
  primary_contact_profile_id: string | null;
  created_at: string;
}

interface Member {
  cni_profile_id: string;
  user_id: string;
  full_name: string;
  status: string;
  netsuite_vendor_id: string | null;
}

interface UnassignedProfile {
  cni_profile_id: string;
  user_id: string;
  full_name: string;
}

export default function CniCompanyDetailPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.id as string;
  const { isAdmin } = useAuth();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [company, setCompany] = useState<CniCompany | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [unassigned, setUnassigned] = useState<UnassignedProfile[]>([]);
  const [metrics, setMetrics] = useState({ total: 0, active: 0, completed: 0, onTime: 0 });

  // Editable fields
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [primaryContact, setPrimaryContact] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ success: boolean; message: string } | null>(null);

  // Members
  const [addSelect, setAddSelect] = useState('');
  const [memberBusy, setMemberBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin, companyId]);

  const loadData = async () => {
    const { data: companyData } = await supabase
      .from('cni_companies')
      .select('id, name, phone, email, netsuite_vendor_id, primary_contact_profile_id, created_at')
      .eq('id', companyId)
      .single();

    if (companyData) {
      setCompany(companyData);
      setName(companyData.name || '');
      setPhone(companyData.phone || '');
      setEmail(companyData.email || '');
      setVendorId(companyData.netsuite_vendor_id || '');
      setPrimaryContact(companyData.primary_contact_profile_id || '');
    }

    // Members of this company
    const { data: memberProfiles } = await supabase
      .from('cni_profiles')
      .select('id, user_id, netsuite_vendor_id')
      .eq('company_id', companyId);

    let memberList: Member[] = [];
    if (memberProfiles && memberProfiles.length > 0) {
      const userIds = memberProfiles.map((p: any) => p.user_id);
      const { data: users } = await supabase
        .from('profiles')
        .select('id, full_name, status')
        .in('id', userIds);
      const userMap: Record<string, any> = {};
      (users || []).forEach((u: any) => { userMap[u.id] = u; });
      memberList = memberProfiles.map((p: any) => ({
        cni_profile_id: p.id,
        user_id: p.user_id,
        full_name: userMap[p.user_id]?.full_name || 'Unknown',
        status: userMap[p.user_id]?.status || 'unknown',
        netsuite_vendor_id: p.netsuite_vendor_id,
      }));
      memberList.sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    setMembers(memberList);

    // Installers with no company yet (candidates to add)
    const { data: freeProfiles } = await supabase
      .from('cni_profiles')
      .select('id, user_id')
      .is('company_id', null);

    let freeList: UnassignedProfile[] = [];
    if (freeProfiles && freeProfiles.length > 0) {
      const freeIds = freeProfiles.map((p: any) => p.user_id);
      const { data: freeUsers } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', freeIds);
      const freeMap: Record<string, string> = {};
      (freeUsers || []).forEach((u: any) => { freeMap[u.id] = u.full_name; });
      freeList = freeProfiles.map((p: any) => ({
        cni_profile_id: p.id,
        user_id: p.user_id,
        full_name: freeMap[p.user_id] || 'Unknown',
      }));
      freeList.sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    setUnassigned(freeList);

    // Job metric rollups for this company
    const { data: companyJobs } = await supabase
      .from('cni_jobs')
      .select('status, completed_at, deadline')
      .eq('assigned_company_id', companyId);
    const jobs = companyJobs || [];
    setMetrics({
      total: jobs.length,
      active: jobs.filter((j: any) => j.status !== 'awaiting_assignment' && j.status !== 'approved_closed').length,
      completed: jobs.filter((j: any) => j.status === 'approved_closed').length,
      onTime: jobs.filter((j: any) =>
        j.status === 'approved_closed' && j.completed_at && j.deadline &&
        new Date(j.completed_at) <= new Date(j.deadline)
      ).length,
    });

    setLoading(false);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setSaveMsg({ success: false, message: 'Company name is required' });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    const { error } = await supabase
      .from('cni_companies')
      .update({
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        netsuite_vendor_id: vendorId.trim() || null,
        primary_contact_profile_id: primaryContact || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', companyId);
    setSaving(false);
    if (error) {
      setSaveMsg({ success: false, message: 'Failed to save: ' + error.message });
    } else {
      setSaveMsg({ success: true, message: 'Company details saved' });
      loadData();
    }
  };

  const handleAddMember = async (cniProfileId: string) => {
    if (!cniProfileId) return;
    setMemberBusy(true);
    const { error } = await supabase
      .from('cni_profiles')
      .update({ company_id: companyId })
      .eq('id', cniProfileId);
    setMemberBusy(false);
    setAddSelect('');
    if (!error) loadData();
  };

  const handleRemoveMember = async (cniProfileId: string) => {
    setMemberBusy(true);
    const { error } = await supabase
      .from('cni_profiles')
      .update({ company_id: null })
      .eq('id', cniProfileId);
    setMemberBusy(false);
    setConfirmRemove(null);
    if (!error) {
      // Clear primary contact if it pointed at the removed member
      const removed = members.find(m => m.cni_profile_id === cniProfileId);
      if (removed && company?.primary_contact_profile_id === removed.user_id) {
        await supabase
          .from('cni_companies')
          .update({ primary_contact_profile_id: null })
          .eq('id', companyId);
        setPrimaryContact('');
      }
      loadData();
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '4px', display: 'block',
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  if (!company) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
        Company not found.{' '}
        <button onClick={() => router.push('/admin/cni/companies')} style={{ color: 'var(--orange)', fontWeight: 700 }}>
          Back to companies
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni/companies')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            {company.name}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {members.length} member{members.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* Metrics card */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Metrics
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px' }}>
          {([
            { label: 'Jobs', value: metrics.total, color: 'var(--text-primary)' },
            { label: 'Active', value: metrics.active, color: 'var(--orange)' },
            { label: 'Completed', value: metrics.completed, color: 'var(--success)' },
            { label: 'On-Time', value: metrics.onTime, color: 'var(--success)' },
          ]).map(stat => (
            <div key={stat.label} style={{
              padding: '10px 8px', borderRadius: '10px', textAlign: 'center',
              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: stat.color }}>{stat.value}</div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{stat.label}</div>
            </div>
          ))}
        </div>
        {metrics.completed > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
            {metrics.onTime} of {metrics.completed} completed job{metrics.completed !== 1 ? 's' : ''} finished on or before the deadline.
          </div>
        )}
      </div>

      {/* Company details card */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Company Details
        </div>

        {saveMsg && (
          <div style={{
            padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', fontWeight: 600,
            background: saveMsg.success ? 'var(--success-bg)' : 'var(--error-bg)',
            border: `1px solid ${saveMsg.success ? 'var(--success-border)' : 'var(--error-border)'}`,
            color: saveMsg.success ? 'var(--success)' : 'var(--error)',
          }}>
            {saveMsg.message}
          </div>
        )}

        <div style={{ marginBottom: '10px' }}>
          <label style={labelStyle}>Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
          <div>
            <label style={labelStyle}>Phone</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 123-4567" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="office@company.com" style={inputStyle} />
          </div>
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label style={labelStyle}>NetSuite Vendor ID</label>
          <input
            value={vendorId} onChange={e => setVendorId(e.target.value)}
            placeholder="Company-level vendor (lump-sum payouts)"
            style={inputStyle}
          />
        </div>
        <div style={{ marginBottom: '14px' }}>
          <label style={labelStyle}>Primary Contact</label>
          <select value={primaryContact} onChange={e => setPrimaryContact(e.target.value)} style={inputStyle}>
            <option value="">— None —</option>
            {members.map(m => (
              <option key={m.user_id} value={m.user_id}>{m.full_name}</option>
            ))}
          </select>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Notify-only — the primary contact has no special workflow powers.
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
            background: saving ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
            cursor: saving ? 'default' : 'pointer',
          }}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Members card */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Members
        </div>

        {members.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            No members yet — add installers below.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
            {members.map(m => (
              <div
                key={m.cni_profile_id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 12px', borderRadius: '10px',
                  background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {m.full_name}
                    </span>
                    <span style={{
                      fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', textTransform: 'capitalize',
                      background: m.status === 'approved' ? 'var(--success-bg)' : 'var(--warning-bg)',
                      color: m.status === 'approved' ? 'var(--success)' : 'var(--warning)',
                    }}>
                      {m.status}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    NetSuite vendor: {m.netsuite_vendor_id || '—'}
                  </div>
                </div>
                {confirmRemove === m.cni_profile_id ? (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Remove?</span>
                    <button
                      onClick={() => handleRemoveMember(m.cni_profile_id)}
                      disabled={memberBusy}
                      style={{
                        padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        background: 'var(--error)', color: '#fff', border: 'none', cursor: 'pointer',
                      }}
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmRemove(null)}
                      style={{
                        padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        background: 'var(--card)', color: 'var(--text-muted)', border: '1px solid var(--border)', cursor: 'pointer',
                      }}
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmRemove(m.cni_profile_id)}
                    style={{
                      padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                      background: 'var(--card)', color: 'var(--error)', border: '1px solid var(--error-border)', cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add member */}
        <label style={labelStyle}>Add Member</label>
        {unassigned.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            No unassigned installers available.
          </div>
        ) : (
          <select
            value={addSelect}
            disabled={memberBusy}
            onChange={e => { setAddSelect(e.target.value); handleAddMember(e.target.value); }}
            style={inputStyle}
          >
            <option value="">Select an installer to add…</option>
            {unassigned.map(p => (
              <option key={p.cni_profile_id} value={p.cni_profile_id}>{p.full_name}</option>
            ))}
          </select>
        )}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          Only installers without a company are listed. Per-person NetSuite vendor IDs are read-only here (editable in phase 3).
        </div>
      </div>

      <div style={{ height: '80px' }} />
    </div>
  );
}
