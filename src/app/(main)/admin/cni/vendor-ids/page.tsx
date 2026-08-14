'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import NetsuiteVendorSearch from '@/components/NetsuiteVendorSearch';

interface Installer {
  user_id: string;
  full_name: string;
  email: string;
  company_id: string | null;
  company_name: string | null;
  status: string;
  deactivated: boolean;
  netsuite_vendor_id: string | null;
}

type IdFilter = 'all' | 'missing' | 'has';
type RowState = { saving?: boolean; saved?: boolean; error?: string };

export default function CniVendorIdsPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [installers, setInstallers] = useState<Installer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [idFilter, setIdFilter] = useState<IdFilter>('all');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [showDeactivated, setShowDeactivated] = useState(false);

  // Per-row edit drafts + save state, keyed by user_id.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  // Which row has the NetSuite search open (one at a time).
  const [searchOpen, setSearchOpen] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    loadInstallers();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin]);

  const loadInstallers = async () => {
    setLoadError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/cni/installers', {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || 'Failed to load installers');
      } else {
        setInstallers(data.installers || []);
      }
    } catch {
      setLoadError('Network error loading installers');
    }
    setLoading(false);
  };

  const saveVendorId = async (userId: string) => {
    const draft = (drafts[userId] ?? '').trim();
    setRowState(s => ({ ...s, [userId]: { saving: true } }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/cni/installers', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ userId, netsuiteVendorId: draft || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRowState(s => ({ ...s, [userId]: { error: data.error || 'Save failed' } }));
        return;
      }
      setInstallers(list => list.map(i =>
        i.user_id === userId ? { ...i, netsuite_vendor_id: data.netsuite_vendor_id } : i,
      ));
      setDrafts(d => { const next = { ...d }; delete next[userId]; return next; });
      setRowState(s => ({ ...s, [userId]: { saved: true } }));
      setTimeout(() => setRowState(s => ({ ...s, [userId]: {} })), 2200);
    } catch {
      setRowState(s => ({ ...s, [userId]: { error: 'Network error' } }));
    }
  };

  // Distinct companies present, for the filter dropdown.
  const companies = useMemo(() => {
    const seen = new Map<string, string>();
    installers.forEach(i => { if (i.company_id) seen.set(i.company_id, i.company_name || 'Company'); });
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [installers]);

  const activeMissing = installers.filter(i => !i.deactivated && !i.netsuite_vendor_id).length;

  const filtered = installers.filter(i => {
    if (!showDeactivated && i.deactivated) return false;
    if (companyFilter === 'independent' && i.company_id) return false;
    if (companyFilter !== 'all' && companyFilter !== 'independent' && i.company_id !== companyFilter) return false;
    if (idFilter === 'missing' && i.netsuite_vendor_id) return false;
    if (idFilter === 'has' && !i.netsuite_vendor_id) return false;
    if (search) {
      const s = search.toLowerCase();
      const match = i.full_name?.toLowerCase().includes(s) ||
        i.company_name?.toLowerCase().includes(s) ||
        i.email?.toLowerCase().includes(s) ||
        i.netsuite_vendor_id?.toLowerCase().includes(s);
      if (!match) return false;
    }
    return true;
  });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            NetSuite Vendor IDs
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {installers.length} installer{installers.length !== 1 ? 's' : ''}
            {activeMissing > 0 && <span style={{ color: 'var(--warning)', fontWeight: 700 }}> • {activeMissing} missing</span>}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Use the vendor&apos;s numeric <strong>Internal ID</strong> (e.g. 1234) — <strong>not</strong> the &ldquo;Entity ID&rdquo;/name. Find it under Lists → Vendors (Internal ID column), or the <code>&amp;id=</code> in the vendor record URL. Bills won&apos;t post otherwise.
          </div>
        </div>
      </div>

      {loadError && (
        <div style={{
          padding: '10px 14px', borderRadius: '10px', marginBottom: '12px', fontSize: '13px', fontWeight: 600,
          background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)',
        }}>
          {loadError}
        </div>
      )}

      <input
        style={{ ...inputStyle, marginBottom: '10px' }}
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search by name, company, email, vendor ID..."
      />

      {/* Filters */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '2px', flexWrap: 'wrap' }}>
        {([
          { id: 'all', label: 'All' },
          { id: 'missing', label: 'Missing ID' },
          { id: 'has', label: 'Has ID' },
        ] as const).map(f => (
          <button
            key={f.id}
            onClick={() => setIdFilter(f.id)}
            style={{
              padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              border: '1px solid var(--border)', whiteSpace: 'nowrap',
              background: idFilter === f.id ? 'var(--orange)' : 'var(--input-bg)',
              color: idFilter === f.id ? '#fff' : 'var(--text-body)',
            }}
          >
            {f.label}
          </button>
        ))}
        {companies.length > 0 && (
          <select
            value={companyFilter}
            onChange={e => setCompanyFilter(e.target.value)}
            style={{
              padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
              border: '1px solid var(--border)',
              background: companyFilter !== 'all' ? 'var(--orange)' : 'var(--input-bg)',
              color: companyFilter !== 'all' ? '#fff' : 'var(--text-body)',
            }}
          >
            <option value="all">All companies</option>
            <option value="independent">Independent</option>
            {companies.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        )}
        <button
          onClick={() => setShowDeactivated(v => !v)}
          style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            border: '1px solid var(--border)', whiteSpace: 'nowrap',
            background: showDeactivated ? 'var(--orange)' : 'var(--input-bg)',
            color: showDeactivated ? '#fff' : 'var(--text-muted)',
          }}
        >
          {showDeactivated ? 'Showing deactivated' : 'Hide deactivated'}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--card)', borderRadius: '14px', border: '1px solid var(--border)' }}>
          {installers.length === 0 ? 'No CNI installers found.' : 'No results match your filters.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map(inst => {
            const draft = drafts[inst.user_id];
            const current = inst.netsuite_vendor_id || '';
            const value = draft ?? current;
            const dirty = draft !== undefined && draft !== current;
            const rs = rowState[inst.user_id] || {};
            return (
              <div
                key={inst.user_id}
                style={{
                  padding: '12px 14px', borderRadius: '12px',
                  background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
                  opacity: inst.deactivated ? 0.6 : 1,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{inst.full_name}</span>
                      {inst.deactivated && (
                        <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--error-bg)', color: 'var(--error)' }}>DEACTIVATED</span>
                      )}
                      {!current && !inst.deactivated && (
                        <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--warning-bg)', color: 'var(--warning)' }}>NO VENDOR ID</span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {inst.company_name || 'No company yet'}{inst.email ? ` • ${inst.email}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => router.push(`/admin/cni/installers/${inst.user_id}`)}
                    style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', padding: '2px 0' }}
                  >
                    Open →
                  </button>
                </div>

                {/* Vendor id editor */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', whiteSpace: 'nowrap' }}>Vendor ID</span>
                  <input
                    value={value}
                    onChange={e => setDrafts(d => ({ ...d, [inst.user_id]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter' && dirty) saveVendorId(inst.user_id); }}
                    placeholder="—"
                    style={{
                      flex: 1, minWidth: 0, padding: '8px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
                      border: `1px solid ${dirty ? 'var(--orange)' : 'var(--border)'}`,
                      background: 'var(--input-bg)', color: 'var(--text-body)',
                    }}
                  />
                  <button
                    onClick={() => setSearchOpen(o => o === inst.user_id ? null : inst.user_id)}
                    title="Search existing NetSuite vendors and pick one"
                    style={{
                      padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                      background: searchOpen === inst.user_id ? 'var(--subtle-bg)' : 'var(--input-bg)',
                      color: searchOpen === inst.user_id ? 'var(--text-muted)' : 'var(--text-body)',
                      border: '1px solid var(--border)', cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                  >
                    Search
                  </button>
                  {dirty && (
                    <button
                      onClick={() => saveVendorId(inst.user_id)}
                      disabled={rs.saving}
                      style={{
                        padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                        background: rs.saving ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
                        cursor: rs.saving ? 'default' : 'pointer', whiteSpace: 'nowrap',
                      }}
                    >
                      {rs.saving ? 'Saving…' : 'Save'}
                    </button>
                  )}
                  {!dirty && rs.saved && (
                    <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--success)', whiteSpace: 'nowrap' }}>✓ Saved</span>
                  )}
                </div>
                {searchOpen === inst.user_id && (
                  <div style={{ marginTop: '8px' }}>
                    <NetsuiteVendorSearch
                      onSelect={v => {
                        setDrafts(d => ({ ...d, [inst.user_id]: v.id }));
                        setSearchOpen(null);
                      }}
                      autoFocus
                    />
                  </div>
                )}
                {rs.error && (
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--error)', marginTop: '6px' }}>{rs.error}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
