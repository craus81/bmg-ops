'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface UpfitNote {
  id: string;
  note_type: string;
  content: string;
  created_by: string | null;
  created_at: string;
  profiles?: { full_name: string } | null;
}

interface UpfitProject {
  id: string;
  project_name: string;
  status: string;
  prospect_id: string | null;
  customer_name: string | null;
  customer_netsuite_id: string | null;
  estimate_id: string | null;
  estimate_number: string | null;
  netsuite_so_id: string | null;
  netsuite_so_number: string | null;
  netsuite_vendor_po_id: string | null;
  netsuite_vendor_po_number: string | null;
  scheduled_date: string | null;
  scheduled_end_date: string | null;
  fleet_checkin_id: string | null;
  estimated_total: number | null;
  so_total: number | null;
  assigned_to: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  upfit_project_notes?: UpfitNote[];
}

const STATUSES = [
  { key: 'opportunity', label: 'Opportunity', color: '#a78bfa' },
  { key: 'estimate', label: 'Estimate', color: '#fbbf24' },
  { key: 'sold', label: 'Sold', color: '#34d399' },
  { key: 'parts_ordered', label: 'Parts Ordered', color: '#60a5fa' },
  { key: 'scheduled', label: 'Scheduled', color: '#38bdf8' },
  { key: 'in_progress', label: 'In Progress', color: '#f97316' },
  { key: 'completed', label: 'Completed', color: '#22c55e' },
  { key: 'cancelled', label: 'Cancelled', color: '#6b7280' },
];

const NOTE_ICONS: Record<string, string> = {
  note: '📝',
  status_change: '🔄',
  estimate: '📋',
  sales_order: '🧾',
  parts_order: '📦',
  schedule: '📅',
  checkin: '🚗',
  completion: '✅',
};

export default function UpfitProjectsPage() {
  const { user } = useAuth();
  const supabase = createClient();

  const [projects, setProjects] = useState<UpfitProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});

  // Detail view
  const [selected, setSelected] = useState<UpfitProject | null>(null);
  const [notes, setNotes] = useState<UpfitNote[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  // New project form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCustomer, setNewCustomer] = useState('');
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    const res = await fetch('/api/upfit-projects');
    if (res.ok) {
      const data = await res.json();
      setProjects(data.projects || []);
    }

    // Load profiles for display names
    const { data: profs } = await supabase.from('profiles').select('id, full_name');
    if (profs) {
      const map: Record<string, string> = {};
      for (const p of profs) map[p.id] = p.full_name || 'Unknown';
      setProfiles(map);
    }

    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const loadNotes = async (projectId: string) => {
    setLoadingNotes(true);
    const res = await fetch(`/api/upfit-projects/notes?projectId=${projectId}`);
    if (res.ok) {
      const data = await res.json();
      setNotes(data.notes || []);
    }
    setLoadingNotes(false);
  };

  const openProject = (p: UpfitProject) => {
    setSelected(p);
    loadNotes(p.id);
  };

  const addNote = async () => {
    if (!selected || !newNote.trim()) return;
    setAddingNote(true);
    const res = await fetch('/api/upfit-projects/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: selected.id, content: newNote.trim() }),
    });
    if (res.ok) {
      setNewNote('');
      loadNotes(selected.id);
    }
    setAddingNote(false);
  };

  const updateStatus = async (projectId: string, newStatus: string) => {
    const res = await fetch('/api/upfit-projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, status: newStatus }),
    });
    if (res.ok) {
      load();
      if (selected?.id === projectId) {
        setSelected({ ...selected, status: newStatus });
        loadNotes(projectId);
      }
    }
  };

  const createProject = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const res = await fetch('/api/upfit-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_name: newName.trim(),
        customer_name: newCustomer.trim() || null,
      }),
    });
    if (res.ok) {
      setNewName('');
      setNewCustomer('');
      setShowCreate(false);
      load();
    }
    setCreating(false);
  };

  // Filter logic
  const activeStatuses = ['opportunity', 'estimate', 'sold', 'parts_ordered', 'scheduled', 'in_progress'];
  const filtered = projects.filter(p => {
    if (filter === 'active' && !activeStatuses.includes(p.status)) return false;
    if (filter === 'completed' && p.status !== 'completed') return false;
    if (filter === 'cancelled' && p.status !== 'cancelled') return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.project_name.toLowerCase().includes(q) && !(p.customer_name || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const getStatus = (key: string) => STATUSES.find(s => s.key === key) || STATUSES[0];
  const fmt = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtTime = (d: string) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Detail view
  if (selected) {
    const st = getStatus(selected.status);
    return (
      <div style={{ padding: '16px', maxWidth: '800px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '18px', cursor: 'pointer', padding: '4px' }}>&larr;</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: theme.textPrimary }}>{selected.project_name}</div>
            {selected.customer_name && <div style={{ fontSize: '12px', color: theme.textSecondary }}>{selected.customer_name}</div>}
          </div>
          <span style={{ fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: `${st.color}20`, color: st.color, border: `1px solid ${st.color}40` }}>{st.label}</span>
        </div>

        {/* Status pipeline */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '4px' }}>
          {STATUSES.filter(s => s.key !== 'cancelled').map(s => {
            const isCurrent = s.key === selected.status;
            const idx = STATUSES.findIndex(x => x.key === s.key);
            const currentIdx = STATUSES.findIndex(x => x.key === selected.status);
            const isPast = idx < currentIdx && selected.status !== 'cancelled';
            return (
              <button
                key={s.key}
                onClick={() => updateStatus(selected.id, s.key)}
                style={{
                  flex: 1,
                  minWidth: '70px',
                  padding: '6px 4px',
                  borderRadius: '6px',
                  fontSize: '9px',
                  fontWeight: 700,
                  border: isCurrent ? `2px solid ${s.color}` : '1px solid var(--border)',
                  background: isCurrent ? `${s.color}20` : isPast ? `${s.color}10` : 'var(--card)',
                  color: isCurrent ? s.color : isPast ? s.color : theme.textMuted,
                  cursor: 'pointer',
                  opacity: isPast ? 0.7 : 1,
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Linked records */}
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Linked Records</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
            <div>
              <span style={{ color: theme.textMuted }}>Estimate: </span>
              <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{selected.estimate_number || '—'}</span>
            </div>
            <div>
              <span style={{ color: theme.textMuted }}>Sales Order: </span>
              <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{selected.netsuite_so_number || '—'}</span>
            </div>
            <div>
              <span style={{ color: theme.textMuted }}>Vendor PO: </span>
              <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{selected.netsuite_vendor_po_number || '—'}</span>
            </div>
            <div>
              <span style={{ color: theme.textMuted }}>Schedule: </span>
              <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{selected.scheduled_date ? fmt(selected.scheduled_date) : '—'}</span>
            </div>
            {selected.estimated_total && (
              <div>
                <span style={{ color: theme.textMuted }}>Est. Total: </span>
                <span style={{ color: theme.textPrimary, fontWeight: 600 }}>${selected.estimated_total.toLocaleString()}</span>
              </div>
            )}
            {selected.so_total && (
              <div>
                <span style={{ color: theme.textMuted }}>SO Total: </span>
                <span style={{ color: theme.textPrimary, fontWeight: 600 }}>${selected.so_total.toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>

        {/* Add note */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <input
            value={newNote}
            onChange={e => setNewNote(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && addNote()}
            placeholder="Add a note..."
            style={{ flex: 1, padding: '8px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '13px', outline: 'none' }}
          />
          <button
            onClick={addNote}
            disabled={addingNote || !newNote.trim()}
            style={{ padding: '8px 14px', borderRadius: '8px', background: theme.orange, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: addingNote || !newNote.trim() ? 0.5 : 1 }}
          >
            Add
          </button>
        </div>

        {/* Notes timeline */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Activity Timeline</div>
        {loadingNotes ? (
          <div style={{ color: theme.textMuted, fontSize: '12px', textAlign: 'center', padding: '20px' }}>Loading...</div>
        ) : notes.length === 0 ? (
          <div style={{ color: theme.textMuted, fontSize: '12px', textAlign: 'center', padding: '20px' }}>No notes yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {notes.map(n => (
              <div key={n.id} style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>{NOTE_ICONS[n.note_type] || '📝'}</span>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: theme.textSecondary }}>{n.profiles?.full_name || profiles[n.created_by || ''] || 'System'}</span>
                  </div>
                  <span style={{ fontSize: '10px', color: theme.textMuted }}>{fmtTime(n.created_at)}</span>
                </div>
                <div style={{ fontSize: '12px', color: theme.textPrimary, lineHeight: '1.4' }}>{n.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // List view
  return (
    <div style={{ padding: '16px', maxWidth: '800px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>Upfit Projects</div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{ padding: '6px 14px', borderRadius: '8px', background: theme.orange, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
        >
          + New Project
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>New Upfit Project</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Project name (e.g. Acme Corp — Shelf Package)"
              style={{ padding: '8px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '13px', outline: 'none' }}
            />
            <input
              value={newCustomer}
              onChange={e => setNewCustomer(e.target.value)}
              placeholder="Customer name"
              style={{ padding: '8px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '13px', outline: 'none' }}
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowCreate(false)} style={{ padding: '6px 12px', borderRadius: '6px', background: 'none', border: `1px solid ${theme.border}`, color: theme.textMuted, fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={createProject} disabled={creating || !newName.trim()} style={{ padding: '6px 14px', borderRadius: '6px', background: theme.orange, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: creating || !newName.trim() ? 0.5 : 1 }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {[
          { key: 'active', label: 'Active' },
          { key: 'completed', label: 'Completed' },
          { key: 'cancelled', label: 'Cancelled' },
          { key: 'all', label: 'All' },
        ].map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={{
              padding: '5px 12px',
              borderRadius: '6px',
              fontSize: '11px',
              fontWeight: 700,
              border: filter === f.key ? `1px solid ${theme.tabActiveBorder}` : `1px solid ${theme.border}`,
              background: filter === f.key ? theme.tabActiveBg : 'transparent',
              color: filter === f.key ? theme.tabActiveColor : theme.textMuted,
              cursor: 'pointer',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search projects..."
        style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '13px', outline: 'none', marginBottom: '12px', boxSizing: 'border-box' }}
      />

      {/* Project list */}
      {loading ? (
        <div style={{ textAlign: 'center', color: theme.textMuted, padding: '40px', fontSize: '13px' }}>Loading projects...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: theme.textMuted, padding: '40px', fontSize: '13px' }}>No projects found</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map(p => {
            const st = getStatus(p.status);
            const noteCount = p.upfit_project_notes?.length || 0;
            return (
              <div
                key={p.id}
                onClick={() => openProject(p)}
                style={{
                  background: theme.card,
                  border: `1px solid ${theme.border}`,
                  borderRadius: '10px',
                  padding: '12px 14px',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onMouseOver={e => (e.currentTarget.style.borderColor = st.color)}
                onMouseOut={e => (e.currentTarget.style.borderColor = theme.border)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{p.project_name}</div>
                    {p.customer_name && <div style={{ fontSize: '11px', color: theme.textSecondary, marginTop: '2px' }}>{p.customer_name}</div>}
                  </div>
                  <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: `${st.color}20`, color: st.color, border: `1px solid ${st.color}40`, whiteSpace: 'nowrap', flexShrink: 0 }}>{st.label}</span>
                </div>
                <div style={{ display: 'flex', gap: '12px', fontSize: '10px', color: theme.textMuted }}>
                  {p.estimate_number && <span>Est: {p.estimate_number}</span>}
                  {p.netsuite_so_number && <span>SO: {p.netsuite_so_number}</span>}
                  {p.scheduled_date && <span>Sched: {fmt(p.scheduled_date)}</span>}
                  {noteCount > 0 && <span>{noteCount} note{noteCount !== 1 ? 's' : ''}</span>}
                  <span style={{ marginLeft: 'auto' }}>{fmt(p.updated_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
