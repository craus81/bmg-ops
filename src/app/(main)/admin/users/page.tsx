'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import type { Profile } from '@/lib/types';

interface Company {
  id: string;
  name: string;
}

export default function UsersPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();
  const [users, setUsers] = useState<(Profile & { company_id?: string; company_name?: string })[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'denied'>('all');
  const [pendingCompanies, setPendingCompanies] = useState<Record<string, string>>({});
  const [newCompanyName, setNewCompanyName] = useState('');
  const [showNewCompany, setShowNewCompany] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  }, [isAdmin]);

  const loadData = async () => {
    const { data: companyData } = await supabase
      .from('companies')
      .select('*')
      .order('name');
    setCompanies(companyData || []);

    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('status', { ascending: true })
      .order('full_name');

    const enriched = (data || []).map((u: any) => {
      const company = (companyData || []).find((c: Company) => c.id === u.company_id);
      return { ...u, company_name: company?.name || null };
    });

    setUsers(enriched);
    setLoading(false);
  };

  const createCompany = async (name: string): Promise<string | null> => {
    const { data, error } = await supabase
      .from('companies')
      .insert({ name: name.trim() })
      .select()
      .single();

    if (error) {
      alert('Failed to create company: ' + error.message);
      return null;
    }

    setCompanies((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    return data.id;
  };

  const handleApprove = async (userId: string, role: string) => {
    let companyId = pendingCompanies[userId];

    if (!companyId) {
      alert('Please select a company before approving.');
      return;
    }

    // Handle "new company" flow
    if (companyId === '__new__') {
      alert('Please create the new company first.');
      return;
    }

    const { error } = await supabase
      .from('profiles')
      .update({ status: 'approved', role, company_id: companyId })
      .eq('id', userId);

    if (!error) {
      const company = companies.find((c) => c.id === companyId);
      setUsers((prev) => prev.map((u) =>
        u.id === userId
          ? { ...u, status: 'approved' as const, role: role as 'admin' | 'installer' | 'production' | 'sales', company_id: companyId, company_name: company?.name || '' }
          : u
      ));
      setPendingCompanies((prev) => { const next = { ...prev }; delete next[userId]; return next; });
    }
  };

  const handleDeny = async (userId: string) => {
    const { error } = await supabase
      .from('profiles')
      .update({ status: 'denied' })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'denied' as const } : u));
    }
  };

  const handleChangeRole = async (userId: string, newRole: string) => {
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role: newRole as 'admin' | 'installer' | 'production' | 'sales' } : u));
    }
  };

  const handleChangeCompany = async (userId: string, companyId: string) => {
    const { error } = await supabase
      .from('profiles')
      .update({ company_id: companyId })
      .eq('id', userId);

    if (!error) {
      const company = companies.find((c) => c.id === companyId);
      setUsers((prev) => prev.map((u) =>
        u.id === userId ? { ...u, company_id: companyId, company_name: company?.name || '' } : u
      ));
    }
  };

  const handleResetStatus = async (userId: string, newStatus: string) => {
    const { error } = await supabase
      .from('profiles')
      .update({ status: newStatus })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: newStatus as any } : u));
    }
  };

  const handleCreateAndSelect = async (userId: string) => {
    if (!newCompanyName.trim()) return;
    const id = await createCompany(newCompanyName);
    if (id) {
      setPendingCompanies((prev) => ({ ...prev, [userId]: id }));
      setNewCompanyName('');
      setShowNewCompany(null);
    }
  };

  const pendingCount = users.filter((u) => u.status === 'pending').length;
  const filtered = filter === 'all' ? users : users.filter((u) => u.status === filter);

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          User Management ({users.length})
        </div>
        {pendingCount > 0 && (
          <div style={{
            padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)',
          }}>
            {pendingCount} pending
          </div>
        )}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        {([
          { id: 'all' as const, label: 'All' },
          { id: 'pending' as const, label: `Pending${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
          { id: 'approved' as const, label: 'Approved' },
          { id: 'denied' as const, label: 'Denied' },
        ]).map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
              background: filter === f.id ? 'var(--tab-active-bg)' : 'transparent',
              border: filter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              color: filter === f.id ? 'var(--tab-active-color)' : 'var(--text-muted)',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>👥</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No {filter !== 'all' ? filter : ''} users</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {filtered.map((user) => {
          const isPending = user.status === 'pending';
          const isDenied = user.status === 'denied';
          const isApproved = user.status === 'approved';
          const statusColor = isPending ? 'var(--warning)' : isDenied ? 'var(--error)' : 'var(--success)';
          const statusBg = isPending ? 'var(--warning-bg)' : isDenied ? 'var(--error-bg)' : 'var(--success-bg)';
          const statusBorder = isPending ? 'var(--warning-border)' : isDenied ? 'var(--error-border)' : 'var(--success-border)';
          const selectedCompany = pendingCompanies[user.id] || '';

          return (
            <div key={user.id} style={{
              background: 'var(--card)', border: `1px solid ${isPending ? 'var(--warning-border)' : 'var(--border)'}`,
              borderRadius: '14px', padding: '14px', boxShadow: 'var(--shadow-sm)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text-primary)' }}>{user.full_name || 'No name'}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{user.email}</div>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{
                      padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                      background: statusBg, border: `1px solid ${statusBorder}`, color: statusColor,
                    }}>
                      {isPending ? '⏳ Pending' : isDenied ? '🚫 Denied' : '✓ Approved'}
                    </span>
                    <span style={{
                      padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                      background: user.role === 'admin' ? 'var(--orange-soft)' : 'var(--subtle-bg)',
                      border: `1px solid ${user.role === 'admin' ? 'rgba(238,49,32,0.2)' : 'var(--border)'}`,
                      color: user.role === 'admin' ? 'var(--orange)' : 'var(--text-muted)',
                    }}>
                      {user.role === 'admin' ? '👔 Admin' : '🔧 Installer'}
                    </span>
                    {user.company_name && (
                      <span style={{
                        padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                        background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
                      }}>
                        🏢 {user.company_name}
                      </span>
                    )}
                    {isPending && user.requested_role && (
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        requested: {user.requested_role}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Pending actions */}
              {isPending && (
                <div style={{ marginTop: '12px' }}>
                  {/* Company selector */}
                  <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                      Assign Company
                    </label>
                    <select
                      value={selectedCompany}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '__new__') {
                          setShowNewCompany(user.id);
                          setPendingCompanies((prev) => ({ ...prev, [user.id]: '__new__' }));
                        } else {
                          setShowNewCompany(null);
                          setPendingCompanies((prev) => ({ ...prev, [user.id]: val }));
                        }
                      }}
                      style={{
                        width: '100%', padding: '10px 12px', borderRadius: '10px',
                        border: '1px solid var(--border)', background: 'var(--bg)',
                        color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600,
                      }}
                    >
                      <option value="">Select company...</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      <option value="__new__">+ Add New Company</option>
                    </select>
                  </div>

                  {/* New company input */}
                  {showNewCompany === user.id && (
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={newCompanyName}
                        onChange={(e) => setNewCompanyName(e.target.value)}
                        placeholder="Company name..."
                        style={{
                          flex: 1, padding: '10px 12px', borderRadius: '10px',
                          border: '1px solid var(--border)', background: 'var(--bg)',
                          color: 'var(--text-primary)', fontSize: '13px',
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleCreateAndSelect(user.id); }}
                      />
                      <button
                        onClick={() => handleCreateAndSelect(user.id)}
                        disabled={!newCompanyName.trim()}
                        style={{
                          padding: '10px 16px', borderRadius: '10px',
                          background: 'var(--navy)', color: '#fff',
                          fontSize: '12px', fontWeight: 700, border: 'none',
                          opacity: !newCompanyName.trim() ? 0.4 : 1,
                        }}
                      >
                        Create
                      </button>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => handleApprove(user.id, user.requested_role || 'installer')}
                      disabled={!selectedCompany || selectedCompany === '__new__'}
                      style={{
                        flex: 1, padding: '10px', borderRadius: '10px',
                        background: 'var(--success)', color: '#fff',
                        fontSize: '12px', fontWeight: 700, border: 'none',
                        opacity: !selectedCompany || selectedCompany === '__new__' ? 0.4 : 1,
                      }}
                    >
                      ✓ Approve as {user.requested_role === 'admin' ? 'Admin' : 'Installer'}
                    </button>
                    <button
                      onClick={() => handleDeny(user.id)}
                      style={{
                        padding: '10px 16px', borderRadius: '10px',
                        background: 'var(--error-bg)', border: '1px solid var(--error-border)',
                        color: 'var(--error)', fontSize: '12px', fontWeight: 700,
                      }}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )}

              {/* Approved user actions */}
              {isApproved && (
                <div style={{ marginTop: '10px' }}>
                  {/* Company changer */}
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
                    <select
                      value={user.company_id || ''}
                      onChange={(e) => {
                        if (e.target.value === '__new__') {
                          setShowNewCompany(user.id);
                        } else if (e.target.value) {
                          handleChangeCompany(user.id, e.target.value);
                        }
                      }}
                      style={{
                        flex: 1, padding: '6px 10px', borderRadius: '8px', fontSize: '11px',
                        border: '1px solid var(--border)', background: 'var(--bg)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <option value="">No company</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      <option value="__new__">+ Add New Company</option>
                    </select>
                  </div>

                  {/* New company input for approved users */}
                  {showNewCompany === user.id && (
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={newCompanyName}
                        onChange={(e) => setNewCompanyName(e.target.value)}
                        placeholder="Company name..."
                        style={{
                          flex: 1, padding: '8px 10px', borderRadius: '8px',
                          border: '1px solid var(--border)', background: 'var(--bg)',
                          color: 'var(--text-primary)', fontSize: '12px',
                        }}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter' && newCompanyName.trim()) {
                            const id = await createCompany(newCompanyName);
                            if (id) {
                              await handleChangeCompany(user.id, id);
                              setNewCompanyName('');
                              setShowNewCompany(null);
                            }
                          }
                        }}
                      />
                      <button
                        onClick={async () => {
                          if (!newCompanyName.trim()) return;
                          const id = await createCompany(newCompanyName);
                          if (id) {
                            await handleChangeCompany(user.id, id);
                            setNewCompanyName('');
                            setShowNewCompany(null);
                          }
                        }}
                        disabled={!newCompanyName.trim()}
                        style={{
                          padding: '8px 14px', borderRadius: '8px',
                          background: 'var(--navy)', color: '#fff',
                          fontSize: '11px', fontWeight: 700, border: 'none',
                          opacity: !newCompanyName.trim() ? 0.4 : 1,
                        }}
                      >
                        Create
                      </button>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <select
                      value={user.role}
                      onChange={(e) => handleChangeRole(user.id, e.target.value)}
                      style={{
                        padding: '6px 10px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                        background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <option value="admin">Admin</option>
                      <option value="installer">Installer</option>
                      <option value="production">Production</option>
                      <option value="sales">Sales</option>
                    </select>
                    <button
                      onClick={() => { if (window.confirm(`Revoke access for ${user.full_name}?`)) handleResetStatus(user.id, 'denied'); }}
                      style={{
                        padding: '6px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                        background: 'transparent', border: '1px solid var(--error-border)',
                        color: 'var(--error)',
                      }}
                    >
                      Revoke Access
                    </button>
                  </div>
                </div>
              )}

              {/* Denied user actions */}
              {isDenied && (
                <div style={{ marginTop: '10px' }}>
                  <button
                    onClick={() => handleApprove(user.id, user.requested_role || 'installer')}
                    style={{
                      padding: '6px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Re-approve
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button onClick={() => router.push('/more')} style={{
        width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px',
        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
        fontSize: '13px', fontWeight: 700,
      }}>
        ← Back
      </button>
    </div>
  );
}
