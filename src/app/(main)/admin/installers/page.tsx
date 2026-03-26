'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import type { OutsideInstaller } from '@/lib/types';

// ─── Form ─────────────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  company_name: string;
  phone: string;
  email: string;
  notes: string;
}

const emptyForm = (): FormState => ({ name: '', company_name: '', phone: '', email: '', notes: '' });

function InstallerForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: FormState;
  onSave: (f: FormState) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState(initial);
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Field label="Name *" value={form.name} onChange={set('name')} placeholder="John Smith" />
      <Field label="Company" value={form.company_name} onChange={set('company_name')} placeholder="Smith Wraps LLC" />
      <Field label="Phone" value={form.phone} onChange={set('phone')} placeholder="(555) 000-0000" type="tel" />
      <Field label="Email" value={form.email} onChange={set('email')} placeholder="john@example.com" type="email" />
      <div>
        <label style={labelStyle}>Notes</label>
        <textarea
          value={form.notes}
          onChange={set('notes')}
          placeholder="Specialties, availability, etc."
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
        <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
        <button
          onClick={() => onSave(form)}
          disabled={!form.name.trim() || saving}
          style={{ ...primaryBtn, opacity: !form.name.trim() || saving ? 0.5 : 1 }}
        >{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, type = 'text',
}: {
  label: string; value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input type={type} value={value} onChange={onChange} placeholder={placeholder} style={inputStyle} />
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '10px', fontWeight: 700,
  color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.5px', marginBottom: '5px',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: '10px',
  border: `1px solid var(--border)`, background: 'var(--input-bg)',
  color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600,
  boxSizing: 'border-box',
};

const primaryBtn: React.CSSProperties = {
  flex: 1, padding: '12px', borderRadius: '10px', background: 'var(--navy)',
  border: 'none', color: '#fff', fontWeight: 800, fontSize: '14px', cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  flex: 1, padding: '12px', borderRadius: '10px', background: 'var(--border)',
  border: 'none', color: 'var(--text-primary)', fontWeight: 700, fontSize: '14px', cursor: 'pointer',
};

// ─── Installer card ───────────────────────────────────────────────────────────

function InstallerCard({
  installer,
  onEdit,
  onToggleActive,
}: {
  installer: OutsideInstaller;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div style={{
      background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
      padding: '14px', opacity: installer.active ? 1 : 0.55,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: '15px' }}>{installer.name}</div>
          {installer.company_name && (
            <div style={{ fontSize: '12px', color: theme.textSecondary, marginTop: '1px' }}>{installer.company_name}</div>
          )}
          <div style={{ display: 'flex', gap: '12px', marginTop: '6px', flexWrap: 'wrap' }}>
            {installer.phone && (
              <a href={`tel:${installer.phone}`} style={{ fontSize: '12px', color: theme.success, fontWeight: 600, textDecoration: 'none' }}>
                {installer.phone}
              </a>
            )}
            {installer.email && (
              <a href={`mailto:${installer.email}`} style={{ fontSize: '12px', color: '#60a5fa', fontWeight: 600, textDecoration: 'none' }}>
                {installer.email}
              </a>
            )}
          </div>
          {installer.notes && (
            <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '6px', fontStyle: 'italic' }}>{installer.notes}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '6px', marginLeft: '10px', flexShrink: 0 }}>
          <button onClick={onEdit} style={{
            padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textSecondary, cursor: 'pointer',
          }}>Edit</button>
          <button onClick={onToggleActive} style={{
            padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: installer.active ? theme.errorBg : theme.successBg,
            border: `1px solid ${installer.active ? theme.errorBorder : theme.successBorder}`,
            color: installer.active ? theme.error : theme.success, cursor: 'pointer',
          }}>{installer.active ? 'Deactivate' : 'Activate'}</button>
        </div>
      </div>

      {!installer.active && (
        <div style={{
          marginTop: '8px', fontSize: '11px', fontWeight: 700, color: theme.textMuted,
          padding: '3px 8px', background: theme.border, borderRadius: '6px', display: 'inline-block',
        }}>INACTIVE</div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InstallerAdminPage() {
  const { profile } = useAuth();
  const router = useRouter();

  const isAdmin = profile?.role === 'admin' || (profile?.roles || []).includes('admin' as any);

  const [installers, setInstallers] = useState<OutsideInstaller[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Redirect non-admins
  useEffect(() => {
    if (profile && !isAdmin) router.push('/home');
  }, [profile, isAdmin, router]);

  const load = async () => {
    setLoading(true);
    const res = await fetch('/api/installers?active=false');
    if (res.ok) setInstallers(await res.json());
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (form: FormState) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/installers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create');
      setInstallers(prev => [data, ...prev]);
      setCreating(false);
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  };

  const handleEdit = async (id: string, form: FormState) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/installers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');
      setInstallers(prev => prev.map(i => i.id === id ? data : i));
      setEditingId(null);
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  };

  const handleToggleActive = async (installer: OutsideInstaller) => {
    try {
      const res = await fetch(`/api/installers/${installer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !installer.active }),
      });
      const data = await res.json();
      if (res.ok) setInstallers(prev => prev.map(i => i.id === installer.id ? data : i));
    } catch {}
  };

  const visible = installers.filter(i => showInactive || i.active);

  if (!isAdmin) return null;

  return (
    <div style={{ padding: '16px 16px 100px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Admin</div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, margin: '0' }}>Outside Installers</h1>
        </div>
        {!creating && (
          <button
            onClick={() => { setCreating(true); setEditingId(null); setError(''); }}
            style={{
              padding: '9px 14px', borderRadius: '10px', background: theme.navy,
              border: 'none', color: '#fff', fontWeight: 800, fontSize: '13px', cursor: 'pointer',
            }}
          >+ Add</button>
        )}
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`,
          borderRadius: '10px', color: theme.error, fontSize: '13px', marginBottom: '12px',
        }}>{error}</div>
      )}

      {/* Create form */}
      {creating && (
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          padding: '16px', marginBottom: '16px',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '12px', color: theme.textSecondary }}>New Installer</div>
          <InstallerForm
            initial={emptyForm()}
            onSave={handleCreate}
            onCancel={() => { setCreating(false); setError(''); }}
            saving={saving}
          />
        </div>
      )}

      {/* Show inactive toggle */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
        <button
          onClick={() => setShowInactive(v => !v)}
          style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: showInactive ? theme.warningBg : 'transparent',
            border: `1px solid ${showInactive ? theme.warningBorder : theme.border}`,
            color: showInactive ? theme.warning : theme.textMuted, cursor: 'pointer',
          }}
        >{showInactive ? 'Hide Inactive' : 'Show Inactive'}</button>
      </div>

      {/* List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: theme.textMuted }}>Loading...</div>
      ) : visible.length === 0 ? (
        <div style={{
          padding: '32px', textAlign: 'center', background: theme.card,
          border: `1px solid ${theme.border}`, borderRadius: '14px',
          color: theme.textMuted, fontSize: '14px',
        }}>
          {installers.length === 0 ? 'No outside installers yet. Add one to get started.' : 'No active installers.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {visible.map(installer => (
            editingId === installer.id ? (
              <div key={installer.id} style={{
                background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', padding: '16px',
              }}>
                <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '12px', color: theme.textSecondary }}>
                  Editing: {installer.name}
                </div>
                <InstallerForm
                  initial={{ name: installer.name, company_name: installer.company_name || '', phone: installer.phone || '', email: installer.email || '', notes: installer.notes || '' }}
                  onSave={(form) => handleEdit(installer.id, form)}
                  onCancel={() => { setEditingId(null); setError(''); }}
                  saving={saving}
                />
              </div>
            ) : (
              <InstallerCard
                key={installer.id}
                installer={installer}
                onEdit={() => { setEditingId(installer.id); setCreating(false); setError(''); }}
                onToggleActive={() => handleToggleActive(installer)}
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}
