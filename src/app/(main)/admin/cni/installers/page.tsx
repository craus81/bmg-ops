'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import PhoneInput from '@/components/PhoneInput';
import { theme } from '@/lib/theme';

interface CniInstaller {
  user_id: string;
  full_name: string;
  email: string;
  company_name: string | null;
  availability_status: string;
  service_types: string[];
  risk_tags: string[];
  jobs_completed: number;
  profile_complete: boolean;
  communication_rating: string;
  completion_reliability: string;
  photo_quality: string;
  coverage_radius_miles: number | null;
  business_address: any;
  deactivated?: boolean;
}

export default function CniInstallersPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const supabase = createClient();
  const [installers, setInstallers] = useState<CniInstaller[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [availFilter, setAvailFilter] = useState('all');
  const [capFilter, setCapFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');

  // Quick Add / Invite modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [invName, setInvName] = useState('');
  const [invEmail, setInvEmail] = useState('');
  const [invPhone, setInvPhone] = useState('');
  const [invCompany, setInvCompany] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    loadInstallers();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin]);

  const loadInstallers = async () => {
    // Primary source: any user tagged as installer in profiles.
    const { data: users } = await supabase
      .from('profiles')
      .select('id, full_name, email, deactivated, company_id, role, roles')
      .or('role.eq.installer,roles.cs.{installer}');

    if (!users || users.length === 0) { setLoading(false); return; }

    const userIds = users.map((u: any) => u.id);
    const companyIds = [...new Set(users.map((u: any) => u.company_id).filter(Boolean))];

    // Pull cni_profiles extra data (availability, service_types, ratings, etc.).
    const { data: cniRows } = await supabase
      .from('cni_profiles')
      .select('user_id, company_name, availability_status, service_types, risk_tags, jobs_completed, profile_complete, communication_rating, completion_reliability, photo_quality, coverage_radius_miles, business_address')
      .in('user_id', userIds);
    const cniMap: Record<string, any> = {};
    if (cniRows) cniRows.forEach((r: any) => { cniMap[r.user_id] = r; });

    // Resolve company names for profiles-sourced users.
    const companyMap: Record<string, string> = {};
    if (companyIds.length > 0) {
      const { data: companies } = await supabase
        .from('companies').select('id, name').in('id', companyIds);
      if (companies) companies.forEach((c: any) => { companyMap[c.id] = c.name; });
    }

    setInstallers(users.map((u: any) => {
      const cni = cniMap[u.id] || {};
      return {
        user_id: u.id,
        full_name: u.full_name || 'Unknown',
        email: u.email || '',
        deactivated: u.deactivated || false,
        company_name: (u.company_id ? companyMap[u.company_id] : null) || cni.company_name || null,
        availability_status: cni.availability_status || 'unknown',
        service_types: cni.service_types || [],
        risk_tags: cni.risk_tags || [],
        jobs_completed: cni.jobs_completed || 0,
        profile_complete: cni.profile_complete || false,
        communication_rating: cni.communication_rating || '',
        completion_reliability: cni.completion_reliability || '',
        photo_quality: cni.photo_quality || '',
        coverage_radius_miles: cni.coverage_radius_miles || null,
        business_address: cni.business_address || null,
      };
    }));
    setLoading(false);
  };

  const handleInvite = async () => {
    if (!invName.trim() || !invEmail.trim()) return;
    setInviting(true);
    setInviteResult(null);

    try {
      const res = await fetch('/api/cni/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: invName.trim(),
          email: invEmail.trim(),
          phone: invPhone.trim() || undefined,
          companyName: invCompany.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setInviteResult({ success: true, message: data.message });
        setInvName(''); setInvEmail(''); setInvPhone(''); setInvCompany('');
        // Reload list after short delay
        setTimeout(() => { loadInstallers(); }, 1000);
      } else {
        setInviteResult({ success: false, message: data.error || 'Failed to send invite' });
      }
    } catch {
      setInviteResult({ success: false, message: 'Network error' });
    }
    setInviting(false);
  };

  const filtered = installers.filter(i => {
    if (search) {
      const s = search.toLowerCase();
      const match = (i.full_name?.toLowerCase().includes(s) ||
            i.company_name?.toLowerCase().includes(s) ||
            i.email?.toLowerCase().includes(s) ||
            i.business_address?.city?.toLowerCase().includes(s) ||
            i.business_address?.state?.toLowerCase().includes(s));
      if (!match) return false;
    }
    if (availFilter !== 'all' && i.availability_status !== availFilter) return false;
    if (capFilter !== 'all' && !i.service_types.includes(capFilter)) return false;
    if (tagFilter === 'preferred' && !i.risk_tags.includes('preferred')) return false;
    if (tagFilter === 'dna' && !i.risk_tags.includes('do_not_assign')) return false;
    if (tagFilter === 'at_risk' && !i.risk_tags.includes('at_risk')) return false;
    if (tagFilter === 'no_tags' && i.risk_tags.length > 0) return false;
    return true;
  });

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div>
      {/* Header with Add button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
          <div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
              CNI Installers
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{installers.length} registered</div>
          </div>
        </div>
        <button
          onClick={() => { setShowAddModal(true); setInviteResult(null); }}
          style={{
            padding: '8px 16px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
            background: 'var(--orange)', color: '#fff', border: 'none', cursor: 'pointer',
          }}
        >
          + Add Installer
        </button>
      </div>

      {/* Quick Add / Invite Modal */}
      {showAddModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: '20px',
          background: 'var(--overlay)',
        }}>
          <div style={{
            width: '100%', maxWidth: '420px',
            background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: '16px', padding: '24px', boxShadow: 'var(--shadow-md)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Invite CNI Installer
              </div>
              <button onClick={() => setShowAddModal(false)} style={{ fontSize: '20px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
              This will create an account and send a branded email with login credentials and a link to complete their CNI profile.
            </div>

            {inviteResult && (
              <div style={{
                padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', fontWeight: 600,
                background: inviteResult.success ? 'var(--success-bg)' : 'var(--error-bg)',
                border: `1px solid ${inviteResult.success ? 'var(--success-border)' : 'var(--error-border)'}`,
                color: inviteResult.success ? 'var(--success)' : 'var(--error)',
              }}>
                {inviteResult.message}
              </div>
            )}

            <div style={{ marginBottom: '10px' }}>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '4px', display: 'block' }}>Full Name *</label>
              <input
                value={invName} onChange={e => setInvName(e.target.value)}
                placeholder="John Smith"
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
                  border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
                }}
              />
            </div>
            <div style={{ marginBottom: '10px' }}>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '4px', display: 'block' }}>Email *</label>
              <input
                type="email" value={invEmail} onChange={e => setInvEmail(e.target.value)}
                placeholder="john@example.com"
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
                  border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
                }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '4px', display: 'block' }}>Phone</label>
                <PhoneInput
                  value={invPhone} onChange={v => setInvPhone(v)}
                  placeholder="(555) 123-4567"
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
                    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '4px', display: 'block' }}>Company</label>
                <input
                  value={invCompany} onChange={e => setInvCompany(e.target.value)}
                  placeholder="Company name"
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
                    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setShowAddModal(false)}
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                  background: 'var(--subtle-bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >Cancel</button>
              <button
                onClick={handleInvite}
                disabled={inviting || !invName.trim() || !invEmail.trim()}
                style={{
                  flex: 2, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                  background: inviting ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
                  cursor: inviting ? 'default' : 'pointer',
                }}
              >
                {inviting ? 'Sending Invite...' : 'Send Invite'}
              </button>
            </div>
          </div>
        </div>
      )}

      <input
        style={{
          width: '100%', padding: '12px 14px', borderRadius: '10px', marginBottom: '10px',
          border: '1px solid var(--border)', background: 'var(--input-bg)',
          color: 'var(--text-body)', fontSize: '14px',
        }}
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search by name, company, city, state..."
      />

      {/* Filters */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '2px' }}>
        <select value={availFilter} onChange={e => setAvailFilter(e.target.value)} style={{
          padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
          border: '1px solid var(--border)', background: availFilter !== 'all' ? 'var(--orange)' : 'var(--input-bg)',
          color: availFilter !== 'all' ? '#fff' : 'var(--text-body)',
        }}>
          <option value="all">Availability</option>
          <option value="available">Available</option>
          <option value="limited">Limited</option>
          <option value="unavailable">Unavailable</option>
        </select>
        <select value={capFilter} onChange={e => setCapFilter(e.target.value)} style={{
          padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
          border: '1px solid var(--border)', background: capFilter !== 'all' ? 'var(--orange)' : 'var(--input-bg)',
          color: capFilter !== 'all' ? '#fff' : 'var(--text-body)',
        }}>
          <option value="all">Capability</option>
          <option value="graphics_install">Graphics Install</option>
          <option value="tech_install">Tech Install</option>
          <option value="upfitting">Upfitting</option>
          <option value="removal_rebrand">Removal/Rebrand</option>
        </select>
        <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} style={{
          padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
          border: '1px solid var(--border)', background: tagFilter !== 'all' ? 'var(--orange)' : 'var(--input-bg)',
          color: tagFilter !== 'all' ? '#fff' : 'var(--text-body)',
        }}>
          <option value="all">Tags</option>
          <option value="preferred">Preferred</option>
          <option value="at_risk">At Risk</option>
          <option value="dna">Do Not Assign</option>
          <option value="no_tags">No Tags</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--card)', borderRadius: '14px', border: '1px solid var(--border)' }}>
          {installers.length === 0 ? 'No CNI installers registered yet — use the button above to invite one.' : 'No results found'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map(inst => (
            <button
              key={inst.user_id}
              onClick={() => router.push(`/admin/cni/installers/${inst.user_id}`)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '14px 16px', borderRadius: '12px',
                background: 'var(--card)', border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-sm)',
                opacity: inst.deactivated ? 0.5 : 1,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {inst.full_name}
                    </span>
                    {inst.deactivated && (
                      <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--error-bg)', color: 'var(--error)' }}>DEACTIVATED</span>
                    )}
                    {!inst.profile_complete && !inst.deactivated && (
                      <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--warning-bg)', color: 'var(--warning)' }}>PENDING</span>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {inst.company_name || 'Independent'}
                    {inst.business_address?.city ? ` • ${inst.business_address.city}, ${inst.business_address.state || ''}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  {inst.availability_status !== 'unknown' && (
                    <span style={{
                      fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                      background: inst.availability_status === 'available' ? 'var(--success-bg)' :
                                 inst.availability_status === 'limited' ? 'var(--warning-bg)' : 'var(--error-bg)',
                      color: inst.availability_status === 'available' ? 'var(--success)' :
                             inst.availability_status === 'limited' ? 'var(--warning)' : 'var(--error)',
                      border: `1px solid ${inst.availability_status === 'available' ? 'var(--success-border)' :
                              inst.availability_status === 'limited' ? 'var(--warning-border)' : 'var(--error-border)'}`,
                      textTransform: 'capitalize',
                    }}>
                      {inst.availability_status}
                    </span>
                  )}
                  {inst.risk_tags.includes('do_not_assign') && (
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: 'var(--error-bg)', color: 'var(--error)', border: '1px solid var(--error-border)' }}>DNA</span>
                  )}
                  {inst.risk_tags.includes('preferred') && (
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success-border)' }}>★</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '10px', marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
                <span>{inst.jobs_completed} jobs</span>
                {inst.service_types.length > 0 && (
                  <span>{inst.service_types.map(s => s.replace('_', ' ')).join(', ')}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
