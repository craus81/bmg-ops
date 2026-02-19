'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import type { Profile } from '@/lib/types';

export default function UsersPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'denied'>('all');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .order('status', { ascending: true })
        .order('full_name');
      setUsers((data as Profile[]) || []);
      setLoading(false);
    };
    load();
  }, [isAdmin]);

  const handleApprove = async (userId: string, role: string) => {
    const { error } = await supabase
      .from('profiles')
      .update({ status: 'approved', role })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'approved' as const, role: role as 'admin' | 'installer' } : u));
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
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role: newRole as 'admin' | 'installer' } : u));
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
          const statusColor = isPending ? 'var(--warning)' : isDenied ? 'var(--error)' : 'var(--success)';
          const statusBg = isPending ? 'var(--warning-bg)' : isDenied ? 'var(--error-bg)' : 'var(--success-bg)';
          const statusBorder = isPending ? 'var(--warning-border)' : isDenied ? 'var(--error-border)' : 'var(--success-border)';

          return (
            <div key={user.id} style={{
              background: 'var(--card)', border: `1px solid ${isPending ? 'var(--warning-border)' : 'var(--border)'}`,
              borderRadius: '14px', padding: '14px', boxShadow: 'var(--shadow-sm)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text-primary)' }}>{user.full_name || 'No name'}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{user.email}</div>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' }}>
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
                <div style={{ display: 'flex', gap: '6px', marginTop: '12px' }}>
                  <button
                    onClick={() => handleApprove(user.id, user.requested_role || 'installer')}
                    style={{
                      flex: 1, padding: '10px', borderRadius: '10px',
                      background: 'var(--success)', color: '#fff',
                      fontSize: '12px', fontWeight: 700, border: 'none',
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
              )}

              {/* Approved user actions */}
              {!isPending && !isDenied && (
                <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                  <button
                    onClick={() => handleChangeRole(user.id, user.role === 'admin' ? 'installer' : 'admin')}
                    style={{
                      padding: '6px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Switch to {user.role === 'admin' ? 'Installer' : 'Admin'}
                  </button>
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
