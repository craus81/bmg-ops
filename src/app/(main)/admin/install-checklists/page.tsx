'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';

type Category = 'upfit' | 'graphics' | 'mixed';
interface ChecklistItem {
  label: string;
  required: boolean;
}
interface Template {
  id: string;
  name: string;
  install_category: Category;
  items: ChecklistItem[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const CATEGORY_LABELS: Record<Category, string> = {
  upfit: 'Upfit only',
  graphics: 'Graphics only',
  mixed: 'Mixed (upfit + graphics)',
};

export default function InstallChecklistsAdminPage() {
  const router = useRouter();
  const { user, isAdmin, loading: authLoading } = useAuth();
  const dialog = useDialog();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; install_category: Category; items: ChecklistItem[]; is_active: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/install-checklists');
    const data = await res.json();
    setTemplates(data.templates || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!user) return;
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    load();
  }, [authLoading, user, isAdmin, router, load]);

  const startNew = () => {
    setEditingId('new');
    setDraft({
      name: '',
      install_category: 'mixed',
      items: [{ label: '', required: false }],
      is_active: true,
    });
  };

  const startEdit = (t: Template) => {
    setEditingId(t.id);
    setDraft({
      name: t.name,
      install_category: t.install_category,
      items: t.items.length > 0 ? t.items : [{ label: '', required: false }],
      is_active: t.is_active,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const cleaned = draft.items.filter(i => i.label.trim());
    if (!draft.name.trim() || cleaned.length === 0) {
      await dialog.alert('Template needs a name and at least one item.');
      return;
    }
    setSaving(true);
    const payload = {
      name: draft.name.trim(),
      install_category: draft.install_category,
      items: cleaned,
      is_active: draft.is_active,
    };
    const isNew = editingId === 'new';
    const res = await fetch(
      isNew ? '/api/install-checklists' : `/api/install-checklists/${editingId}`,
      {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      await dialog.alert('Save failed: ' + (data.error || 'Unknown error'));
      return;
    }
    cancelEdit();
    load();
  };

  const deleteTemplate = async (id: string) => {
    if (!(await dialog.confirm('Archive this template? Existing checklists already instantiated on vehicles are unaffected.', { destructive: true, confirmLabel: 'Archive' }))) return;
    const res = await fetch(`/api/install-checklists/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      await dialog.alert('Delete failed: ' + (data.error || 'Unknown error'));
      return;
    }
    load();
  };

  const updateItem = (idx: number, patch: Partial<ChecklistItem>) => {
    if (!draft) return;
    const items = [...draft.items];
    items[idx] = { ...items[idx], ...patch };
    setDraft({ ...draft, items });
  };

  const addItem = () => {
    if (!draft) return;
    setDraft({ ...draft, items: [...draft.items, { label: '', required: false }] });
  };

  const removeItem = (idx: number) => {
    if (!draft) return;
    const items = draft.items.filter((_, i) => i !== idx);
    setDraft({ ...draft, items: items.length > 0 ? items : [{ label: '', required: false }] });
  };

  const moveItem = (idx: number, direction: -1 | 1) => {
    if (!draft) return;
    const target = idx + direction;
    if (target < 0 || target >= draft.items.length) return;
    const items = [...draft.items];
    [items[idx], items[target]] = [items[target], items[idx]];
    setDraft({ ...draft, items });
  };

  if (loading) return <div style={{ padding: '20px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Install Checklists</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Templates used when a vehicle enters in_progress. Required items gate completion.
          </div>
        </div>
        {!editingId && (
          <button
            onClick={startNew}
            style={{
              padding: '10px 16px', borderRadius: '10px', border: 'none',
              background: 'var(--accent, #2563eb)', color: '#fff',
              fontSize: '13px', fontWeight: 700, cursor: 'pointer',
            }}
          >+ New Template</button>
        )}
      </div>

      {editingId && draft && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', padding: '16px', marginBottom: '20px',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
            {editingId === 'new' ? 'New Template' : 'Edit Template'}
          </div>

          <div style={{ display: 'grid', gap: '10px', marginBottom: '14px' }}>
            <label>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Name</div>
              <input
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Masterack upfit"
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)' }}
              />
            </label>
            <label>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Category</div>
              <select
                value={draft.install_category}
                onChange={e => setDraft({ ...draft, install_category: e.target.value as Category })}
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)' }}
              >
                <option value="mixed">{CATEGORY_LABELS.mixed}</option>
                <option value="upfit">{CATEGORY_LABELS.upfit}</option>
                <option value="graphics">{CATEGORY_LABELS.graphics}</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={draft.is_active}
                onChange={e => setDraft({ ...draft, is_active: e.target.checked })}
              />
              <span style={{ fontSize: '12px' }}>Active</span>
            </label>
          </div>

          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
            Items
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
            {draft.items.map((item, idx) => (
              <div key={idx} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  value={item.label}
                  onChange={e => updateItem(idx, { label: e.target.value })}
                  placeholder="Task label"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)' }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={item.required}
                    onChange={e => updateItem(idx, { required: e.target.checked })}
                  />
                  Req.
                </label>
                <button onClick={() => moveItem(idx, -1)} disabled={idx === 0} style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', cursor: idx === 0 ? 'not-allowed' : 'pointer', opacity: idx === 0 ? 0.4 : 1 }}>↑</button>
                <button onClick={() => moveItem(idx, 1)} disabled={idx === draft.items.length - 1} style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', cursor: idx === draft.items.length - 1 ? 'not-allowed' : 'pointer', opacity: idx === draft.items.length - 1 ? 0.4 : 1 }}>↓</button>
                <button onClick={() => removeItem(idx)} style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', color: 'var(--danger, #ef4444)' }}>×</button>
              </div>
            ))}
          </div>
          <button
            onClick={addItem}
            style={{ padding: '6px 12px', borderRadius: '8px', border: '1px dashed var(--border)', background: 'transparent', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
          >+ Add Item</button>

          <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
            <button
              onClick={saveDraft}
              disabled={saving}
              style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: 'var(--accent, #2563eb)', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >{saving ? 'Saving...' : 'Save'}</button>
            <button
              onClick={cancelEdit}
              style={{ padding: '10px 16px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {templates.map(t => (
          <div
            key={t.id}
            style={{
              background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: '14px', padding: '14px',
              opacity: t.is_active ? 1 : 0.5,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '14px', fontWeight: 700 }}>{t.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {CATEGORY_LABELS[t.install_category]} · {t.items.length} item{t.items.length === 1 ? '' : 's'}
                  {!t.is_active && ' · archived'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={() => startEdit(t)}
                  style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                >Edit</button>
                {t.is_active && (
                  <button
                    onClick={() => deleteTemplate(t.id)}
                    style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', fontWeight: 700, color: 'var(--danger, #ef4444)', cursor: 'pointer' }}
                  >Archive</button>
                )}
              </div>
            </div>

            <div style={{ marginTop: '10px', display: 'grid', gap: '4px' }}>
              {t.items.map((item, idx) => (
                <div key={idx} style={{ fontSize: '12px', color: 'var(--text-secondary, #475569)' }}>
                  {item.required && <span style={{ color: 'var(--danger, #ef4444)', marginRight: '4px' }}>*</span>}
                  {item.label}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
