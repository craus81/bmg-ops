'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import type { Profile, AppRole } from '@/lib/types';
import { FEATURES, ROLE_DEFAULT_FEATURES, resolveFeatures, type FeatureKey } from '@/lib/features';

interface Company {
  id: string;
  name: string;
}

const ROLES: { value: AppRole; label: string; color: string }[] = [
  { value: 'super_admin', label: 'Super Admin', color: '#f472b6' },
  { value: 'admin', label: 'Admin', color: 'var(--orange)' },
  { value: 'executive', label: 'Executive', color: '#eab308' },
  { value: 'finance', label: 'Finance / AP', color: '#2dd4bf' },
  { value: 'sales', label: 'Sales', color: '#60a5fa' },
  { value: 'graphics_production', label: 'Graphics / Production', color: '#c084fc' },
  { value: 'shop_tech', label: 'Shop Tech (O\'Fallon)', color: '#38bdf8' },
  { value: 'field_tech', label: 'Field Tech (Off-site)', color: '#fbbf24' },
  { value: 'installer', label: 'CNI Installer', color: 'var(--text-muted)' },
  { value: 'customer', label: 'Customer', color: '#34d399' },
];

function getRoleInfo(role: string) {
  const mapped = role === 'production' ? 'graphics_production' : role;
  return ROLES.find(r => r.value === mapped) || ROLES[1];
}

function getUserRoles(user: Profile): AppRole[] {
  const raw = (user.roles && user.roles.length > 0) ? user.roles : (user.role ? [user.role] : []);
  // Map legacy 'production' to 'graphics_production'
  return raw.map(r => (r === 'production' as any ? 'graphics_production' : r)) as AppRole[];
}

export default function UsersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();
  const [users, setUsers] = useState<(Profile & { company_id?: string; company_name?: string })[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'denied' | 'deactivated'>('all');
  const [pendingCompanies, setPendingCompanies] = useState<Record<string, string>>({});
  const [newCompanyName, setNewCompanyName] = useState('');
  const [showNewCompany, setShowNewCompany] = useState<string | null>(null);

  // Create user form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({
    fullName: '', email: '', password: '', roles: ['installer'] as AppRole[], companyId: '', sendInvite: true,
  });
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [resending, setResending] = useState<string | null>(null);

  // Edit user modal
  const [editUser, setEditUser] = useState<(Profile & { company_id?: string; company_name?: string }) | null>(null);
  const [editForm, setEditForm] = useState({ fullName: '', email: '', roles: [] as AppRole[], companyId: '' });
  const [featureOverrides, setFeatureOverrides] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin || !hasFeature('user_management')) { router.push('/home'); return; }
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin]);

  // ?user=<profile id> deep link (access-request notifications): open that
  // user's edit modal once the list has loaded. One-shot PER ID — clicking a
  // second request's notification while already on this page (same-route
  // router.push, no remount) must still open that user's modal.
  const deepLinkedUser = useRef<string | null>(null);
  useEffect(() => {
    const target = searchParams?.get('user');
    if (!target || loading || deepLinkedUser.current === target) return;
    const match = users.find(u => u.id === target);
    if (!match) return;
    deepLinkedUser.current = target;
    openEditModal(match);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- openEditModal is recreated per render
  }, [searchParams, loading, users]);

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
      await dialog.alert('Failed to create company: ' + error.message);
      return null;
    }

    setCompanies((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    return data.id;
  };

  const toggleCreateRole = (role: AppRole) => {
    setCreateForm(prev => {
      const has = prev.roles.includes(role);
      const next = has ? prev.roles.filter(r => r !== role) : [...prev.roles, role];
      return { ...prev, roles: next.length > 0 ? next : prev.roles }; // must have at least 1
    });
  };

  const toggleEditRole = (role: AppRole) => {
    setEditForm(prev => {
      const has = prev.roles.includes(role);
      const next = has ? prev.roles.filter(r => r !== role) : [...prev.roles, role];
      return { ...prev, roles: next.length > 0 ? next : prev.roles };
    });
  };

  const handleCreateUser = async () => {
    if (!createForm.fullName.trim() || !createForm.email.trim() || !createForm.password.trim()) {
      setCreateMessage('Please fill in all required fields.');
      return;
    }

    setCreating(true);
    setCreateMessage('');

    try {
      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: createForm.email.trim(),
          password: createForm.password.trim(),
          fullName: createForm.fullName.trim(),
          role: createForm.roles[0], // primary role for backward compat
          roles: createForm.roles,
          companyId: createForm.companyId || null,
          sendInvite: createForm.sendInvite,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setCreateMessage(data.error || 'Failed to create user');
      } else {
        setCreateMessage(data.message || 'User created successfully');
        if (data.inviteLink) {
          setInviteLink(data.inviteLink);
        }
        setShowCreateForm(false);
        setCreateForm({ fullName: '', email: '', password: '', roles: ['installer'], companyId: '', sendInvite: true });
        loadData();
      }
    } catch (err: any) {
      setCreateMessage('Error: ' + err.message);
    } finally {
      setCreating(false);
      setTimeout(() => setCreateMessage(''), 5000);
    }
  };

  const copyInviteLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      const input = document.createElement('input');
      input.value = link;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  const handleResendInvite = async (userId: string, email: string, fullName: string) => {
    setResending(userId);
    try {
      const res = await fetch('/api/admin/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, email, fullName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateMessage(data.error || 'Failed to resend invite');
      } else {
        if (data.inviteLink) {
          setInviteLink(data.inviteLink);
        }
        setCreateMessage(data.emailSent ? `Invite re-sent to ${email}` : `Link generated for ${email} (email not configured)`);
      }
    } catch (err: any) {
      setCreateMessage('Error: ' + err.message);
    } finally {
      setResending(null);
      setTimeout(() => setCreateMessage(''), 5000);
    }
  };

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let pass = '';
    for (let i = 0; i < 10; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
    setCreateForm({ ...createForm, password: pass });
  };

  const handleApprove = async (userId: string, role: string) => {
    // Check pendingCompanies state first, then fall back to user's existing company_id
    const existingUser = users.find(u => u.id === userId);
    let companyId = pendingCompanies[userId] || existingUser?.company_id;

    if (!companyId) {
      await dialog.alert('Please select a company before approving.');
      return;
    }

    if (companyId === '__new__') {
      await dialog.alert('Please create the new company first.');
      return;
    }

    const { error } = await supabase
      .from('profiles')
      .update({ status: 'approved', role, roles: [role], company_id: companyId })
      .eq('id', userId);

    if (!error) {
      const company = companies.find((c) => c.id === companyId);
      setUsers((prev) => prev.map((u) =>
        u.id === userId
          ? { ...u, status: 'approved' as const, role: role as any, roles: [role as AppRole], company_id: companyId, company_name: company?.name || '' }
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

  const handleUpdateRoles = async (userId: string, roles: AppRole[]) => {
    // super_admin always rides alongside admin in the roles array — the
    // scalar role stays 'admin' so every RLS policy keyed on it still passes.
    // Enforced here too: a roles array with super_admin but no admin fails
    // every roles-array gate (requireAdmin, PO-note tagging, View As).
    if (roles.includes('super_admin') && !roles.includes('admin')) roles = [...roles, 'admin'];
    const primaryRole = roles.includes('admin') || roles.includes('super_admin') ? 'admin' : roles[0];
    const { error } = await supabase
      .from('profiles')
      .update({ role: primaryRole, roles })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role: primaryRole as any, roles } : u));
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

  const handleDeactivate = async (userId: string, userName: string) => {
    if (!(await dialog.confirm(`Deactivate ${userName}? They will no longer be able to log in.`, { confirmLabel: 'Deactivate' }))) return;

    const { error } = await supabase
      .from('profiles')
      .update({ deactivated: true, deactivated_at: new Date().toISOString() })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, deactivated: true } : u));
      setCreateMessage(`${userName} has been deactivated.`);
      setTimeout(() => setCreateMessage(''), 3000);
    }
  };

  const handleReactivate = async (userId: string) => {
    const { error } = await supabase
      .from('profiles')
      .update({ deactivated: false, deactivated_at: null, deactivated_by: null })
      .eq('id', userId);

    if (!error) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, deactivated: false } : u));
      setCreateMessage('User reactivated.');
      setTimeout(() => setCreateMessage(''), 3000);
    }
  };

  const handleDeleteUser = async (userId: string, userName: string) => {
    if (!(await dialog.confirm(`Permanently delete ${userName}? This cannot be undone.`, { destructive: true, confirmLabel: 'Delete' }))) return;
    if (!(await dialog.confirm(`Are you absolutely sure? This will remove ${userName} from the system entirely.`, { destructive: true, confirmLabel: 'Delete' }))) return;

    try {
      const res = await fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateMessage(data.error || 'Failed to delete user');
      } else {
        setUsers((prev) => prev.filter((u) => u.id !== userId));
        setCreateMessage(`${userName} has been permanently deleted.`);
      }
    } catch (err: any) {
      setCreateMessage('Error: ' + err.message);
    }
    setTimeout(() => setCreateMessage(''), 5000);
  };

  const openEditModal = async (user: Profile & { company_id?: string; company_name?: string }) => {
    setEditUser(user);
    setEditForm({
      fullName: user.full_name || '',
      email: user.email || '',
      roles: getUserRoles(user),
      companyId: user.company_id || '',
    });
    // Load feature overrides for this user
    const { data: overrides } = await supabase
      .from('user_feature_overrides')
      .select('feature, granted')
      .eq('user_id', user.id);
    const map: Record<string, boolean> = {};
    (overrides || []).forEach((o: any) => { map[o.feature] = o.granted; });
    setFeatureOverrides(map);
  };

  const handleSaveEdit = async () => {
    if (!editUser) return;
    setSaving(true);

    // Same invariant as handleUpdateRoles: super_admin implies admin in the
    // roles array, or the account fails every roles-array admin gate.
    const roles = editForm.roles.includes('super_admin') && !editForm.roles.includes('admin')
      ? [...editForm.roles, 'admin' as AppRole]
      : editForm.roles;
    const primaryRole = roles.includes('admin') || roles.includes('super_admin') ? 'admin' : roles[0];

    const { error } = await supabase
      .from('profiles')
      .update({
        full_name: editForm.fullName.trim(),
        email: editForm.email.trim(),
        role: primaryRole,
        roles,
        company_id: editForm.companyId || null,
      })
      .eq('id', editUser.id);

    if (!error) {
      // Save feature overrides
      // Delete existing overrides then insert new ones
      await supabase.from('user_feature_overrides').delete().eq('user_id', editUser.id);
      const overrideRows = Object.entries(featureOverrides).map(([feature, granted]) => ({
        user_id: editUser.id,
        feature,
        granted,
      }));
      if (overrideRows.length > 0) {
        await supabase.from('user_feature_overrides').insert(overrideRows);
      }

      const company = companies.find(c => c.id === editForm.companyId);
      setUsers((prev) => prev.map((u) =>
        u.id === editUser.id
          ? { ...u, full_name: editForm.fullName.trim(), email: editForm.email.trim(), role: primaryRole as any, roles, company_id: editForm.companyId || undefined, company_name: company?.name || '' }
          : u
      ));
      setEditUser(null);
      setCreateMessage('User updated.');
      setTimeout(() => setCreateMessage(''), 3000);
    } else {
      await dialog.alert('Failed to update: ' + error.message);
    }
    setSaving(false);
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
  const deactivatedCount = users.filter((u) => u.deactivated).length;
  const activeUsers = users.filter(u => !u.deactivated);
  const deactivatedUsers = users.filter(u => u.deactivated);

  const filtered = filter === 'deactivated'
    ? deactivatedUsers
    : filter === 'all'
      ? activeUsers
      : activeUsers.filter((u) => u.status === filter);

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: '10px',
    border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--text-primary)', fontSize: '13px',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '10px', fontWeight: 700,
    color: 'var(--text-muted)', textTransform: 'uppercase',
    letterSpacing: '0.5px', marginBottom: '4px',
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          User Management ({activeUsers.length})
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {pendingCount > 0 && (
            <div style={{
              padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
              background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)',
            }}>
              {pendingCount} pending
            </div>
          )}
          <button
            onClick={() => setShowCreateForm(true)}
            style={{
              padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 800,
              background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            + Create User
          </button>
        </div>
      </div>

      {/* Status message */}
      {createMessage && (
        <div style={{
          padding: '8px 12px', borderRadius: '8px', marginBottom: '10px',
          background: createMessage.includes('Error') || createMessage.includes('Failed') || createMessage.includes('Please')
            ? 'var(--error-bg)' : 'rgba(16,185,129,0.1)',
          border: `1px solid ${createMessage.includes('Error') || createMessage.includes('Failed') || createMessage.includes('Please')
            ? 'var(--error-border)' : 'rgba(16,185,129,0.2)'}`,
          color: createMessage.includes('Error') || createMessage.includes('Failed') || createMessage.includes('Please')
            ? 'var(--error)' : '#34d399',
          fontSize: '12px', fontWeight: 600,
        }}>
          {createMessage}
        </div>
      )}

      {/* Invite link banner */}
      {inviteLink && (
        <div style={{
          padding: '12px', borderRadius: '10px', marginBottom: '10px',
          background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', marginBottom: '6px', textTransform: 'uppercase' }}>
            Invite Link
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              readOnly
              value={inviteLink}
              style={{
                flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '11px',
                border: '1px solid rgba(59,130,246,0.2)', background: 'var(--bg)',
                color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
              onClick={e => (e.target as HTMLInputElement).select()}
            />
            <button
              onClick={() => copyInviteLink(inviteLink)}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: linkCopied ? 'rgba(16,185,129,0.15)' : 'var(--accent)',
                border: linkCopied ? '1px solid rgba(16,185,129,0.3)' : 'none',
                color: linkCopied ? '#34d399' : '#fff',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {linkCopied ? '✓ Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setInviteLink('')}
              style={{
                padding: '8px', borderRadius: '8px', fontSize: '14px',
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--text-muted)', cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>
            Share this link with the user so they can log in instantly. It expires in 24 hours.
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {([
          { id: 'all' as const, label: 'All' },
          { id: 'pending' as const, label: `Pending${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
          { id: 'approved' as const, label: 'Approved' },
          { id: 'denied' as const, label: 'Denied' },
          { id: 'deactivated' as const, label: `Deactivated${deactivatedCount > 0 ? ` (${deactivatedCount})` : ''}` },
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
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No {filter !== 'all' ? filter : ''} users</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {filtered.map((user) => {
          const isPending = user.status === 'pending';
          const isDenied = user.status === 'denied';
          const isApproved = user.status === 'approved';
          const isDeactivated = !!user.deactivated;
          const statusColor = isPending ? 'var(--warning)' : isDenied ? 'var(--error)' : isDeactivated ? 'var(--text-muted)' : 'var(--success)';
          const statusBg = isPending ? 'var(--warning-bg)' : isDenied ? 'var(--error-bg)' : isDeactivated ? 'var(--subtle-bg)' : 'var(--success-bg)';
          const statusBorder = isPending ? 'var(--warning-border)' : isDenied ? 'var(--error-border)' : isDeactivated ? 'var(--border)' : 'var(--success-border)';
          const selectedCompany = pendingCompanies[user.id] || '';
          const userRoles = getUserRoles(user);

          return (
            <div key={user.id} style={{
              background: 'var(--card)', border: `1px solid ${isPending ? 'var(--warning-border)' : 'var(--border)'}`,
              borderRadius: '14px', padding: '14px', boxShadow: 'var(--shadow-sm)',
              opacity: isDeactivated ? 0.6 : 1,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text-primary)' }}>
                    {user.full_name || 'No name'}
                    {isDeactivated && <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginLeft: '6px' }}>(Deactivated)</span>}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{user.email}</div>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{
                      padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                      background: statusBg, border: `1px solid ${statusBorder}`, color: statusColor,
                    }}>
                      {isDeactivated ? 'Deactivated' : isPending ? 'Pending' : isDenied ? 'Denied' : 'Approved'}
                    </span>
                    {userRoles.map(r => {
                      const info = getRoleInfo(r);
                      return (
                        <span key={r} style={{
                          padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: r === 'admin' ? 'var(--orange-soft)' : 'var(--subtle-bg)',
                          border: `1px solid ${r === 'admin' ? 'rgba(238,49,32,0.2)' : 'var(--border)'}`,
                          color: info.color,
                        }}>
                          {info.label}
                        </span>
                      );
                    })}
                    {user.company_name && (
                      <span style={{
                        padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                        background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
                      }}>
                        {user.company_name}
                      </span>
                    )}
                    {isPending && user.requested_role && (
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        requested: {user.requested_role}
                      </span>
                    )}
                  </div>
                </div>
                {/* Edit button - always visible for non-deactivated */}
                {!isDeactivated && (
                  <button
                    onClick={() => openEditModal(user)}
                    style={{
                      padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                      color: 'var(--text-secondary)', cursor: 'pointer', marginLeft: '8px', flexShrink: 0,
                    }}
                  >
                    Edit
                  </button>
                )}
              </div>

              {/* Pending actions */}
              {isPending && !isDeactivated && (
                <div style={{ marginTop: '12px' }}>
                  <div style={{ marginBottom: '8px' }}>
                    <label style={labelStyle}>Assign Company</label>
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
                      style={inputStyle}
                    >
                      <option value="">Select company...</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      <option value="__new__">+ Add New Company</option>
                    </select>
                  </div>

                  {showNewCompany === user.id && (
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                      <input
                        type="text"
                        value={newCompanyName}
                        onChange={(e) => setNewCompanyName(e.target.value)}
                        placeholder="Company name..."
                        style={{ ...inputStyle, flex: 1 }}
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
                      ✓ Approve as {user.requested_role === 'admin' ? 'Admin' : user.requested_role || 'Installer'}
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
              {isApproved && !isDeactivated && (
                <div style={{ marginTop: '10px' }}>
                  {/* Role checkboxes */}
                  <div style={{ marginBottom: '8px' }}>
                    <label style={labelStyle}>Roles</label>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      {ROLES.map(r => {
                        const active = userRoles.includes(r.value);
                        return (
                          <button
                            key={r.value}
                            onClick={() => {
                              const next = active
                                ? userRoles.filter(x => x !== r.value)
                                : [...userRoles, r.value];
                              if (next.length > 0) handleUpdateRoles(user.id, next);
                            }}
                            style={{
                              padding: '4px 10px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                              background: active ? (r.value === 'admin' ? 'var(--orange-soft)' : 'rgba(99,102,241,0.1)') : 'var(--bg)',
                              border: `1px solid ${active ? (r.value === 'admin' ? 'rgba(238,49,32,0.3)' : 'rgba(99,102,241,0.25)') : 'var(--border)'}`,
                              color: active ? r.color : 'var(--text-muted)',
                              cursor: 'pointer', transition: 'all 0.15s',
                            }}
                          >
                            {active ? '✓ ' : ''}{r.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

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

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => handleResendInvite(user.id, user.email, user.full_name || '')}
                      disabled={resending === user.id}
                      style={{
                        padding: '6px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                        background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                        color: '#60a5fa', cursor: resending === user.id ? 'not-allowed' : 'pointer',
                        opacity: resending === user.id ? 0.5 : 1,
                      }}
                    >
                      {resending === user.id ? 'Sending...' : 'Resend Invite'}
                    </button>
                    <button
                      onClick={() => handleDeactivate(user.id, user.full_name || 'this user')}
                      style={{
                        padding: '6px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                        background: 'transparent', border: '1px solid var(--error-border)',
                        color: 'var(--error)', cursor: 'pointer',
                      }}
                    >
                      Deactivate
                    </button>
                  </div>
                </div>
              )}

              {/* Deactivated user actions */}
              {isDeactivated && (
                <div style={{ marginTop: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => handleReactivate(user.id)}
                    style={{
                      padding: '6px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                      background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)',
                      color: '#34d399', cursor: 'pointer',
                    }}
                  >
                    Reactivate
                  </button>
                  <button
                    onClick={() => handleResendInvite(user.id, user.email, user.full_name || '')}
                    disabled={resending === user.id}
                    style={{
                      padding: '6px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                      background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                      color: '#60a5fa', cursor: resending === user.id ? 'not-allowed' : 'pointer',
                      opacity: resending === user.id ? 0.5 : 1,
                    }}
                  >
                    {resending === user.id ? 'Sending...' : 'Resend Invite'}
                  </button>
                  <button
                    onClick={() => handleDeleteUser(user.id, user.full_name || 'this user')}
                    style={{
                      padding: '6px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                      background: 'transparent', border: '1px solid var(--error-border)',
                      color: 'var(--error)', cursor: 'pointer',
                    }}
                  >
                    Delete Permanently
                  </button>
                </div>
              )}

              {/* Denied user actions */}
              {isDenied && !isDeactivated && (
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

      {/* Create User Modal */}
      {showCreateForm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', maxWidth: '480px', width: '100%', maxHeight: 'calc(80vh / var(--ts))', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Create New User</div>
              <button onClick={() => setShowCreateForm(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={labelStyle}>Full Name *</label>
                <input
                  style={inputStyle}
                  value={createForm.fullName}
                  onChange={e => setCreateForm({ ...createForm, fullName: e.target.value })}
                  placeholder="John Smith"
                />
              </div>

              <div>
                <label style={labelStyle}>Email *</label>
                <input
                  type="email"
                  style={inputStyle}
                  value={createForm.email}
                  onChange={e => setCreateForm({ ...createForm, email: e.target.value })}
                  placeholder="john@example.com"
                />
              </div>

              <div>
                <label style={labelStyle}>Password *</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    style={{ ...inputStyle, flex: 1 }}
                    value={createForm.password}
                    onChange={e => setCreateForm({ ...createForm, password: e.target.value })}
                    placeholder="Min 6 characters"
                  />
                  <button
                    onClick={generatePassword}
                    style={{
                      padding: '10px 14px', borderRadius: '10px', whiteSpace: 'nowrap',
                      background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                      color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    Generate
                  </button>
                </div>
              </div>

              <div>
                <label style={labelStyle}>Roles *</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {ROLES.map(r => {
                    const active = createForm.roles.includes(r.value);
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => toggleCreateRole(r.value)}
                        style={{
                          padding: '8px 14px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                          background: active ? (r.value === 'admin' ? 'rgba(238,49,32,0.08)' : 'rgba(99,102,241,0.08)') : 'var(--bg)',
                          border: `1px solid ${active ? (r.value === 'admin' ? 'rgba(238,49,32,0.25)' : 'rgba(99,102,241,0.2)') : 'var(--border)'}`,
                          color: active ? r.color : 'var(--text-muted)',
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                      >
                        {active ? '✓ ' : ''}{r.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label style={labelStyle}>Company</label>
                <select
                  style={inputStyle}
                  value={createForm.companyId}
                  onChange={e => setCreateForm({ ...createForm, companyId: e.target.value })}
                >
                  <option value="">No company</option>
                  {companies.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '4px 0' }}>
                <input
                  type="checkbox"
                  checked={createForm.sendInvite}
                  onChange={e => setCreateForm({ ...createForm, sendInvite: e.target.checked })}
                  style={{ width: '18px', height: '18px', accentColor: 'var(--accent)' }}
                />
                <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>
                  Send invite email with credentials
                </span>
              </label>

              {createForm.roles.includes('customer') && (
                <div style={{
                  padding: '10px', borderRadius: '8px',
                  background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.15)',
                  fontSize: '11px', color: '#34d399', lineHeight: 1.5,
                }}>
                  Customer users get a dedicated dashboard showing only their assigned jobs. You can assign jobs after creating the user.
                </div>
              )}

              <button
                onClick={handleCreateUser}
                disabled={creating || !createForm.fullName.trim() || !createForm.email.trim() || !createForm.password.trim()}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px',
                  background: 'var(--accent)', color: '#fff', fontWeight: 800, fontSize: '13px',
                  border: 'none', cursor: 'pointer',
                  opacity: creating || !createForm.fullName.trim() || !createForm.email.trim() || !createForm.password.trim() ? 0.5 : 1,
                }}
              >
                {creating ? 'Creating...' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editUser && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', maxWidth: '480px', width: '100%', maxHeight: 'calc(80vh / var(--ts))', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Edit User</div>
              <button onClick={() => setEditUser(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={labelStyle}>Full Name</label>
                <input
                  style={inputStyle}
                  value={editForm.fullName}
                  onChange={e => setEditForm({ ...editForm, fullName: e.target.value })}
                />
              </div>

              <div>
                <label style={labelStyle}>Email</label>
                <input
                  type="email"
                  style={inputStyle}
                  value={editForm.email}
                  onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                />
              </div>

              <div>
                <label style={labelStyle}>Roles</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {ROLES.map(r => {
                    const active = editForm.roles.includes(r.value);
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => toggleEditRole(r.value)}
                        style={{
                          padding: '8px 14px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                          background: active ? (r.value === 'admin' ? 'rgba(238,49,32,0.08)' : 'rgba(99,102,241,0.08)') : 'var(--bg)',
                          border: `1px solid ${active ? (r.value === 'admin' ? 'rgba(238,49,32,0.25)' : 'rgba(99,102,241,0.2)') : 'var(--border)'}`,
                          color: active ? r.color : 'var(--text-muted)',
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                      >
                        {active ? '✓ ' : ''}{r.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label style={labelStyle}>Company</label>
                <select
                  style={inputStyle}
                  value={editForm.companyId}
                  onChange={e => setEditForm({ ...editForm, companyId: e.target.value })}
                >
                  <option value="">No company</option>
                  {companies.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {/* Feature Access Overrides */}
              {!editForm.roles.includes('admin') && (
                <div>
                  <label style={labelStyle}>Feature Access</label>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    Toggle features on/off for this user. Colored = included by role. Click to override.
                  </div>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {(Object.entries(FEATURES) as [FeatureKey, string][]).map(([key, label]) => {
                      const roleDefault = editForm.roles.some(r => (ROLE_DEFAULT_FEATURES[r] || []).includes(key));
                      const override = featureOverrides[key];
                      const isGranted = override !== undefined ? override : roleDefault;
                      const isOverridden = override !== undefined;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            const newOverrides = { ...featureOverrides };
                            if (!isOverridden) {
                              // First click: override to opposite of role default
                              newOverrides[key] = !roleDefault;
                            } else if (override !== roleDefault) {
                              // Second click: remove override (back to role default)
                              delete newOverrides[key];
                            } else {
                              // Toggle override
                              newOverrides[key] = !override;
                            }
                            setFeatureOverrides(newOverrides);
                          }}
                          style={{
                            padding: '4px 8px', borderRadius: '6px', fontSize: '9px', fontWeight: 700,
                            background: isGranted ? 'rgba(59,130,246,0.1)' : 'var(--bg)',
                            border: `1px solid ${isOverridden ? '#f97316' : (isGranted ? 'rgba(59,130,246,0.3)' : 'var(--border)')}`,
                            color: isGranted ? '#60a5fa' : 'var(--text-muted)',
                            cursor: 'pointer',
                          }}
                        >
                          {isGranted ? '✓ ' : ''}{label}
                          {isOverridden && <span style={{ color: '#f97316', marginLeft: '2px' }}>*</span>}
                        </button>
                      );
                    })}
                  </div>
                  {Object.keys(featureOverrides).length > 0 && (
                    <div style={{ fontSize: '9px', color: '#f97316', marginTop: '4px' }}>
                      * = overridden from role default
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button
                  onClick={handleSaveEdit}
                  disabled={saving || !editForm.fullName.trim() || !editForm.email.trim()}
                  style={{
                    flex: 1, padding: '12px', borderRadius: '10px',
                    background: '#22c55e', color: '#fff', fontWeight: 800, fontSize: '13px',
                    border: 'none', cursor: 'pointer',
                    opacity: saving || !editForm.fullName.trim() || !editForm.email.trim() ? 0.5 : 1,
                  }}
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  onClick={() => setEditUser(null)}
                  style={{
                    padding: '12px 20px', borderRadius: '10px',
                    background: 'transparent', border: '1px solid var(--border)',
                    color: 'var(--text-muted)', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
