'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

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
}

export default function CniInstallersPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();
  const [installers, setInstallers] = useState<CniInstaller[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [availFilter, setAvailFilter] = useState('all');
  const [capFilter, setCapFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadInstallers();
  }, [isAdmin]);

  const loadInstallers = async () => {
    const { data: profiles } = await supabase
      .from('cni_profiles')
      .select('user_id, company_name, availability_status, service_types, risk_tags, jobs_completed, profile_complete, communication_rating, completion_reliability, photo_quality, coverage_radius_miles, business_address')
      .order('created_at', { ascending: false });

    if (profiles) {
      const userIds = profiles.map((p: any) => p.user_id);
      const { data: users } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', userIds);
      const userMap: Record<string, any> = {};
      if (users) users.forEach((u: any) => { userMap[u.id] = u; });

      setInstallers(profiles.map((p: any) => ({
        ...p,
        full_name: userMap[p.user_id]?.full_name || 'Unknown',
        email: userMap[p.user_id]?.email || '',
      })));
    }
    setLoading(false);
  };

  const filtered = installers.filter(i => {
    // Text search
    if (search) {
      const s = search.toLowerCase();
      const match = (i.full_name?.toLowerCase().includes(s) ||
            i.company_name?.toLowerCase().includes(s) ||
            i.email?.toLowerCase().includes(s) ||
            i.business_address?.city?.toLowerCase().includes(s) ||
            i.business_address?.state?.toLowerCase().includes(s));
      if (!match) return false;
    }
    // Availability filter
    if (availFilter !== 'all' && i.availability_status !== availFilter) return false;
    // Capability filter
    if (capFilter !== 'all' && !i.service_types.includes(capFilter)) return false;
    // Tag filter
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            CNI Installers
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{installers.length} registered</div>
        </div>
      </div>

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
        <select
          value={availFilter}
          onChange={e => setAvailFilter(e.target.value)}
          style={{
            padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
            border: '1px solid var(--border)', background: availFilter !== 'all' ? 'var(--orange)' : 'var(--input-bg)',
            color: availFilter !== 'all' ? '#fff' : 'var(--text-body)',
          }}
        >
          <option value="all">Availability</option>
          <option value="available">Available</option>
          <option value="limited">Limited</option>
          <option value="unavailable">Unavailable</option>
        </select>
        <select
          value={capFilter}
          onChange={e => setCapFilter(e.target.value)}
          style={{
            padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
            border: '1px solid var(--border)', background: capFilter !== 'all' ? 'var(--orange)' : 'var(--input-bg)',
            color: capFilter !== 'all' ? '#fff' : 'var(--text-body)',
          }}
        >
          <option value="all">Capability</option>
          <option value="graphics_install">Graphics Install</option>
          <option value="tech_install">Tech Install</option>
          <option value="upfitting">Upfitting</option>
          <option value="removal_rebrand">Removal/Rebrand</option>
        </select>
        <select
          value={tagFilter}
          onChange={e => setTagFilter(e.target.value)}
          style={{
            padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
            border: '1px solid var(--border)', background: tagFilter !== 'all' ? 'var(--orange)' : 'var(--input-bg)',
            color: tagFilter !== 'all' ? '#fff' : 'var(--text-body)',
          }}
        >
          <option value="all">Tags</option>
          <option value="preferred">Preferred</option>
          <option value="at_risk">At Risk</option>
          <option value="dna">Do Not Assign</option>
          <option value="no_tags">No Tags</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--card)', borderRadius: '14px', border: '1px solid var(--border)' }}>
          {installers.length === 0 ? 'No CNI installers registered yet' : 'No results found'}
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
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {inst.full_name}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {inst.company_name || 'Independent'}
                    {inst.business_address?.city ? ` • ${inst.business_address.city}, ${inst.business_address.state || ''}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
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
                  {inst.risk_tags.includes('do_not_assign') && (
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: 'var(--error-bg)', color: 'var(--error)', border: '1px solid var(--error-border)' }}>
                      DNA
                    </span>
                  )}
                  {inst.risk_tags.includes('preferred') && (
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success-border)' }}>
                      ★
                    </span>
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
