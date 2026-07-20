'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { installerCountsByCompany } from '@/lib/cni-companies';

interface CniCompany {
  id: string;
  name: string;
  netsuite_vendor_id: string | null;
  w9_file_path: string | null;
  insurance_cert_path: string | null;
  insurance_expiry: string | null;
  direct_deposit_file_path: string | null;
  primary_contact_profile_id: string | null;

  member_count: number;
}

export default function CniCompaniesPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();
  const [companies, setCompanies] = useState<CniCompany[]>([]);
  const [loading, setLoading] = useState(true);

  // New company inline form
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadCompanies();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin]);

  const loadCompanies = async () => {
    const { data: companiesData } = await supabase
      .from('companies')
      .select('id, name, netsuite_vendor_id, primary_contact_profile_id, w9_file_path, insurance_cert_path, insurance_expiry, direct_deposit_file_path')
      .order('name');

    // Installer counts come from profiles assigned to each company.
    const counts = await installerCountsByCompany(supabase);

    setCompanies((companiesData || []).map((c: any) => ({
      ...c,
      member_count: counts.get(c.id) || 0,
    })));
    setLoading(false);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    const { data, error } = await supabase
      .from('companies')
      .insert({ name })
      .select('id')
      .single();
    setCreating(false);
    if (error) {
      setCreateError(error.message.includes('duplicate') ? 'A company with that name already exists' : error.message);
      return;
    }
    setNewName('');
    setShowNew(false);
    if (data?.id) {
      router.push(`/admin/cni/companies/${data.id}`);
    } else {
      loadCompanies();
    }
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
          <div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
              CNI Companies
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{companies.length} compan{companies.length === 1 ? 'y' : 'ies'}</div>
          </div>
        </div>
        <button
          onClick={() => { setShowNew(s => !s); setCreateError(null); }}
          style={{
            padding: '8px 16px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
            background: showNew ? 'var(--subtle-bg)' : 'var(--orange)',
            color: showNew ? 'var(--text-muted)' : '#fff',
            border: showNew ? '1px solid var(--border)' : 'none', cursor: 'pointer',
          }}
        >
          {showNew ? 'Cancel' : '+ New Company'}
        </button>
      </div>

      {/* New company inline form */}
      {showNew && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
        }}>
          <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '4px', display: 'block' }}>
            Company Name
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="e.g. Designs That Stick"
              autoFocus
              style={{
                flex: 1, padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
                border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
              }}
            />
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              style={{
                padding: '10px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                background: creating || !newName.trim() ? 'var(--text-muted)' : 'var(--orange)',
                color: '#fff', border: 'none', cursor: creating ? 'default' : 'pointer',
              }}
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
          {createError && (
            <div style={{ fontSize: '12px', color: 'var(--error)', fontWeight: 600, marginTop: '8px' }}>
              {createError}
            </div>
          )}
        </div>
      )}

      {/* Company list */}
      {companies.length === 0 ? (
        <div style={{
          padding: '40px 20px', textAlign: 'center',
          background: 'var(--card)', borderRadius: '14px', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
            No companies yet — use the button above to create one.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {companies.map(c => (
            <button
              key={c.id}
              onClick={() => router.push(`/admin/cni/companies/${c.id}`)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '14px 16px', borderRadius: '12px',
                background: 'var(--card)', border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {c.name}
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', whiteSpace: 'nowrap',
                  color: 'var(--text-secondary)', background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                }}>
                  {c.member_count} member{c.member_count !== 1 ? 's' : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '6px', fontSize: '11px', color: 'var(--text-muted)', alignItems: 'center', flexWrap: 'wrap' }}>
                <span>NetSuite vendor: {c.netsuite_vendor_id || '—'}</span>
                {([
                  ['W9', !!c.w9_file_path],
                  // Insurance only counts when the cert is on file and not expired.
                  ['INS', !!c.insurance_cert_path && !(c.insurance_expiry && c.insurance_expiry < new Date().toISOString().slice(0, 10))],
                  ['DD', !!c.direct_deposit_file_path],
                ] as [string, boolean][]).map(([label, ok]) => (
                  <span key={label} style={{
                    fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                    background: ok ? 'var(--success-bg)' : 'var(--error-bg)',
                    color: ok ? 'var(--success)' : 'var(--error)',
                  }}>
                    {label} {ok ? '✓' : '✕'}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
