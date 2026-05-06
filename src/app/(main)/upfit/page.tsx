'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
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

interface UpfitTask {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  assigned_to: string | null;
  due_date: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_by: string | null;
  created_at: string;
  assignee?: { id: string; full_name: string } | null;
  creator?: { full_name: string } | null;
}

interface LinkedGraphicsJob {
  id: string;
  job_number: string | null;
  title: string;
  status: string;
  assigned_to: string | null;
  due_date: string | null;
  scheduled_install_date: string | null;
  approval_proof_file_id: string | null;
  proof_url: string | null;
  proof_file_name: string | null;
}

const GRAPHICS_STATUS_COLORS: Record<string, string> = {
  flagged: '#ef4444',
  received: '#94a3b8',
  designing: '#a78bfa',
  revision: '#f59e0b',
  printing: '#60a5fa',
  outgassing: '#60a5fa',
  cutting: '#60a5fa',
  packing: '#60a5fa',
  ready: '#22c55e',
  ready_to_pickup: '#22c55e',
  shipped: '#22c55e',
  picked_up: '#22c55e',
  installed: '#22c55e',
  cancelled: '#64748b',
};

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
  upfit_project_tasks?: { id: string; completed_at: string | null }[];
}

const STATUSES = [
  { key: 'opportunity', label: 'Opportunity', color: '#a78bfa' },
  { key: 'estimate', label: 'Estimate', color: '#fbbf24' },
  { key: 'sold', label: 'Sold', color: '#34d399' },
  { key: 'parts_ordered', label: 'Parts Ordered', color: '#60a5fa' },
  { key: 'parts_arrived', label: 'Parts Arrived', color: '#3b82f6' },
  { key: 'parts_in_stock', label: 'Parts In Stock', color: '#2563eb' },
  { key: 'scheduled_dropoff', label: 'Scheduled Drop-off', color: '#38bdf8' },
  { key: 'scheduled_build', label: 'Scheduled Build', color: '#0ea5e9' },
  { key: 'in_progress', label: 'In Progress', color: '#f97316' },
  { key: 'scheduled_pickup', label: 'Scheduled Pickup', color: '#eab308' },
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
  const searchParams = useSearchParams();

  const [projects, setProjects] = useState<UpfitProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<Record<string, string>>({});

  const [profileList, setProfileList] = useState<{ id: string; full_name: string }[]>([]);

  // Detail view
  const [selected, setSelected] = useState<UpfitProject | null>(null);
  const [notes, setNotes] = useState<UpfitNote[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  // Tasks
  const [tasks, setTasks] = useState<UpfitTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskAssignee, setNewTaskAssignee] = useState('');
  const [newTaskDue, setNewTaskDue] = useState('');
  const [addingTask, setAddingTask] = useState(false);

  // Files
  interface UpfitFile { id: string; project_id: string; file_name: string; file_type: string | null; file_size: number | null; storage_path: string; uploaded_by: string | null; uploaded_at: string; }
  const [files, setFiles] = useState<UpfitFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // NetSuite lookup
  const [nsLookupNumber, setNsLookupNumber] = useState('');
  const [nsLookingUp, setNsLookingUp] = useState(false);
  const [nsLookupError, setNsLookupError] = useState('');

  // Linked fleet check-in (for handoff display)
  const [linkedCheckin, setLinkedCheckin] = useState<{ id: string; vin: string; status: string; vehicle_year: string | null; vehicle_make: string | null; vehicle_model: string | null } | null>(null);

  // Linked graphics jobs (one upfit project can have multiple graphics jobs)
  const [linkedGraphics, setLinkedGraphics] = useState<LinkedGraphicsJob[]>([]);

  // New project form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCustomer, setNewCustomer] = useState('');
  const [creating, setCreating] = useState(false);
  const [createFiles, setCreateFiles] = useState<File[]>([]);
  const createFileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    const res = await fetch('/api/upfit-projects');
    if (res.ok) {
      const data = await res.json();
      setProjects(data.projects || []);
    }

    // Load profiles for display names
    const { data: profs } = await supabase.from('profiles').select('id, full_name').eq('status', 'approved').order('full_name');
    if (profs) {
      const map: Record<string, string> = {};
      for (const p of profs) map[p.id] = p.full_name || 'Unknown';
      setProfiles(map);
      setProfileList(profs as { id: string; full_name: string }[]);
    }

    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Deep-link: ?id=<projectId> auto-opens that project so /upfit?id= works
  // from the graphics page parent-link, the tracking page, etc.
  useEffect(() => {
    if (loading) return;
    const projectId = searchParams.get('id');
    if (!projectId || selected?.id === projectId) return;
    const inList = projects.find(p => p.id === projectId);
    if (inList) {
      openProject(inList);
      return;
    }
    // Project may be archived/cancelled and filtered out of the active
    // list — fall back to fetching it directly.
    (async () => {
      const { data } = await supabase.from('upfit_projects').select('*').eq('id', projectId).maybeSingle();
      if (data) openProject(data as UpfitProject);
    })();
  }, [loading, searchParams, projects]);

  const loadNotes = async (projectId: string) => {
    setLoadingNotes(true);
    const res = await fetch(`/api/upfit-projects/notes?projectId=${projectId}`);
    if (res.ok) {
      const data = await res.json();
      setNotes(data.notes || []);
    }
    setLoadingNotes(false);
  };

  const loadTasks = async (projectId: string) => {
    setLoadingTasks(true);
    const res = await fetch(`/api/upfit-projects/tasks?projectId=${projectId}`);
    if (res.ok) {
      const data = await res.json();
      setTasks(data.tasks || []);
    }
    setLoadingTasks(false);
  };

  const addTask = async () => {
    if (!selected || !newTaskTitle.trim()) return;
    setAddingTask(true);
    const res = await fetch('/api/upfit-projects/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: selected.id,
        title: newTaskTitle.trim(),
        assigned_to: newTaskAssignee || null,
        due_date: newTaskDue || null,
      }),
    });
    if (res.ok) {
      setNewTaskTitle('');
      setNewTaskAssignee('');
      setNewTaskDue('');
      loadTasks(selected.id);
    }
    setAddingTask(false);
  };

  const updateTask = async (taskId: string, fields: Record<string, any>) => {
    const res = await fetch('/api/upfit-projects/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, ...fields }),
    });
    if (res.ok && selected) loadTasks(selected.id);
  };

  const deleteTask = async (taskId: string) => {
    const res = await fetch('/api/upfit-projects/tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId }),
    });
    if (res.ok && selected) loadTasks(selected.id);
  };

  const loadFiles = async (projectId: string) => {
    const { data } = await supabase
      .from('upfit_project_files')
      .select('*')
      .eq('project_id', projectId)
      .order('uploaded_at', { ascending: false });
    setFiles((data as UpfitFile[]) || []);
  };

  const uploadFiles = async (projectId: string, filesToUpload: File[]) => {
    if (filesToUpload.length === 0) return;
    setUploadingFiles(true);
    for (const file of filesToUpload) {
      const ext = file.name.split('.').pop() || 'bin';
      const path = `upfit-files/${projectId}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const { error: upErr } = await storage.from('upfit-files').upload(path, file, { contentType: file.type });
      if (upErr) {
        console.error('File upload error:', upErr);
        continue;
      }
      const { error: dbErr } = await supabase.from('upfit_project_files').insert({
        project_id: projectId,
        file_name: file.name,
        file_type: file.type || null,
        file_size: file.size,
        storage_path: path,
        uploaded_by: user?.id,
      });
      if (dbErr) console.error('File record insert error:', dbErr);
    }
    setUploadingFiles(false);
    await loadFiles(projectId);
  };

  const deleteFile = async (file: UpfitFile) => {
    if (!window.confirm(`Delete "${file.file_name}"?`)) return;
    await storage.from('upfit-files').remove([file.storage_path]);
    await supabase.from('upfit_project_files').delete().eq('id', file.id);
    setFiles(prev => prev.filter(f => f.id !== file.id));
  };

  const getFileUrl = (path: string) => storage.from('upfit-files').getPublicUrl(path).data.publicUrl;

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const pullFromNetSuite = async () => {
    if (!selected || !nsLookupNumber.trim()) return;
    setNsLookingUp(true);
    setNsLookupError('');
    try {
      const res = await fetch(`/api/netsuite/lookup-transaction?tranid=${encodeURIComponent(nsLookupNumber.trim())}`);
      const data = await res.json();
      if (!res.ok || !data.found) {
        setNsLookupError(data.error || 'Not found');
        setNsLookingUp(false);
        return;
      }
      const m = data.match;
      const updates: any = {
        customer_name: m.customer_name || selected.customer_name,
        customer_netsuite_id: m.customer_id || selected.customer_netsuite_id,
      };
      if (m.type === 'estimate') {
        updates.estimate_number = m.tranid;
        updates.estimated_total = m.total;
      } else {
        updates.netsuite_so_id = String(m.id);
        updates.netsuite_so_number = m.tranid;
        updates.so_total = m.total;
      }
      const updateRes = await fetch('/api/upfit-projects', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected.id, ...updates }),
      });
      if (updateRes.ok) {
        const { project } = await updateRes.json();
        setSelected(project);
        setNsLookupNumber('');
        load();
      } else {
        setNsLookupError('Failed to save link');
      }
    } catch (e: any) {
      setNsLookupError(e.message || 'Lookup failed');
    }
    setNsLookingUp(false);
  };

  const loadLinkedCheckin = async (checkinId: string | null) => {
    if (!checkinId) { setLinkedCheckin(null); return; }
    const { data } = await supabase
      .from('fleet_checkins')
      .select('id, vin, status, vehicle_year, vehicle_make, vehicle_model')
      .eq('id', checkinId)
      .maybeSingle();
    setLinkedCheckin((data as any) || null);
  };

  const loadLinkedGraphics = async (projectId: string) => {
    const { data: jobs } = await supabase
      .from('graphics_jobs')
      .select('id, job_number, title, status, assigned_to, due_date, scheduled_install_date, approval_proof_file_id')
      .eq('upfit_project_id', projectId)
      .order('created_at', { ascending: true });

    if (!jobs || jobs.length === 0) {
      setLinkedGraphics([]);
      return;
    }

    // Resolve proof preview URLs. Prefer the per-send approval_proof_file_id
    // (the file Brian actually sent for approval); fall back to the most
    // recent uploaded file on the job so the panel still has a thumbnail
    // during early design stages.
    const proofIds = jobs.map((j: any) => j.approval_proof_file_id).filter(Boolean);
    const jobIds = jobs.map((j: any) => j.id);

    const [{ data: explicitProofs }, { data: latestFiles }] = await Promise.all([
      proofIds.length > 0
        ? supabase.from('graphics_job_files').select('id, job_id, file_name, storage_path').in('id', proofIds)
        : Promise.resolve({ data: [] as any[] }),
      supabase
        .from('graphics_job_files')
        .select('id, job_id, file_name, storage_path, uploaded_at')
        .in('job_id', jobIds)
        .order('uploaded_at', { ascending: false }),
    ]);

    const explicitByJob: Record<string, { file_name: string; storage_path: string }> = {};
    for (const f of explicitProofs || []) {
      explicitByJob[f.job_id] = { file_name: f.file_name, storage_path: f.storage_path };
    }
    const latestByJob: Record<string, { file_name: string; storage_path: string }> = {};
    for (const f of latestFiles || []) {
      if (!latestByJob[f.job_id]) {
        latestByJob[f.job_id] = { file_name: f.file_name, storage_path: f.storage_path };
      }
    }

    const enriched: LinkedGraphicsJob[] = jobs.map((j: any) => {
      const chosen = explicitByJob[j.id] || latestByJob[j.id];
      return {
        id: j.id,
        job_number: j.job_number,
        title: j.title,
        status: j.status,
        assigned_to: j.assigned_to,
        due_date: j.due_date,
        scheduled_install_date: j.scheduled_install_date,
        approval_proof_file_id: j.approval_proof_file_id,
        proof_url: chosen ? storage.from('graphics-proofs').getPublicUrl(chosen.storage_path).data.publicUrl : null,
        proof_file_name: chosen ? chosen.file_name : null,
      };
    });
    setLinkedGraphics(enriched);
  };

  const openProject = (p: UpfitProject) => {
    setSelected(p);
    loadNotes(p.id);
    loadTasks(p.id);
    loadFiles(p.id);
    loadLinkedCheckin(p.fleet_checkin_id);
    loadLinkedGraphics(p.id);
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
      const json = await res.json();
      const newProjectId = json?.project?.id;
      if (newProjectId && createFiles.length > 0) {
        await uploadFiles(newProjectId, createFiles);
      }
      setNewName('');
      setNewCustomer('');
      setCreateFiles([]);
      setShowCreate(false);
      load();
    }
    setCreating(false);
  };

  // Filter logic
  const activeStatuses = ['opportunity', 'estimate', 'sold', 'parts_ordered', 'parts_arrived', 'parts_in_stock', 'scheduled_dropoff', 'scheduled_build', 'in_progress', 'scheduled_pickup'];
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

          {/* Linked vehicle (handoff from fleet check-in) */}
          {linkedCheckin && (
            <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${theme.border}` }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Linked Vehicle</div>
              <button
                onClick={() => window.location.assign(`/tracking?vehicle=${linkedCheckin.id}`)}
                style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: '6px', background: theme.inputBg, border: `1px solid ${theme.border}`, color: theme.textPrimary, fontSize: '12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}
              >
                <span style={{ fontWeight: 600 }}>
                  {[linkedCheckin.vehicle_year, linkedCheckin.vehicle_make, linkedCheckin.vehicle_model].filter(Boolean).join(' ') || 'Vehicle'} · VIN {linkedCheckin.vin}
                </span>
                <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '5px', background: `${theme.orange}20`, color: theme.orange }}>
                  {linkedCheckin.status.replace(/_/g, ' ')}
                </span>
              </button>
            </div>
          )}

          {/* Pull from NetSuite */}
          <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pull from NetSuite</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                value={nsLookupNumber}
                onChange={e => { setNsLookupNumber(e.target.value); setNsLookupError(''); }}
                onKeyDown={e => e.key === 'Enter' && pullFromNetSuite()}
                placeholder="SO or estimate number (e.g. SO12345)"
                style={{ flex: 1, padding: '7px 10px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '12px', outline: 'none' }}
              />
              <button
                onClick={pullFromNetSuite}
                disabled={nsLookingUp || !nsLookupNumber.trim()}
                style={{ padding: '7px 14px', borderRadius: '6px', background: theme.orange, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: nsLookingUp || !nsLookupNumber.trim() ? 0.5 : 1, whiteSpace: 'nowrap' }}
              >
                {nsLookingUp ? 'Looking up...' : 'Link'}
              </button>
            </div>
            {nsLookupError && (
              <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{nsLookupError}</div>
            )}
          </div>
        </div>

        {/* Graphics — linked graphics jobs (from migrations/084-graphics-upfit-project-link.sql).
            Read-only summary of each linked job's production status, designer,
            due/install dates, and proof preview. Click through to /graphics?id=
            to act on the job itself. */}
        {linkedGraphics.length > 0 && (
          <>
            <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Graphics ({linkedGraphics.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
              {linkedGraphics.map(g => {
                const designerName = g.assigned_to ? (profiles[g.assigned_to] || 'Unknown') : null;
                const statusColor = GRAPHICS_STATUS_COLORS[g.status] || '#94a3b8';
                const installDate = g.scheduled_install_date || g.due_date;
                return (
                  <button
                    key={g.id}
                    onClick={() => window.location.assign(`/graphics?id=${g.id}`)}
                    style={{
                      textAlign: 'left',
                      background: theme.card,
                      border: `1px solid ${theme.border}`,
                      borderRadius: '10px',
                      padding: '10px',
                      display: 'grid',
                      gridTemplateColumns: g.proof_url ? '64px 1fr' : '1fr',
                      gap: '10px',
                      alignItems: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    {g.proof_url && (
                      <div style={{ width: '64px', height: '64px', borderRadius: '6px', overflow: 'hidden', background: theme.inputBg, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <img
                          src={g.proof_url}
                          alt={g.proof_file_name || 'Proof'}
                          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                      </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: theme.textPrimary }}>
                          {g.job_number || g.id.slice(0, 8)}
                        </span>
                        <span style={{
                          fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                          background: `${statusColor}20`, color: statusColor, border: `1px solid ${statusColor}40`,
                          textTransform: 'uppercase',
                        }}>
                          {g.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '2px' }}>
                        {g.title}
                      </div>
                      <div style={{ fontSize: '10px', color: theme.textMuted, display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                        <span>Designer: <span style={{ color: theme.textSecondary, fontWeight: 600 }}>{designerName || 'Unassigned'}</span></span>
                        {installDate && (
                          <span>{g.scheduled_install_date ? 'Install' : 'Due'}: <span style={{ color: theme.textSecondary, fontWeight: 600 }}>{fmt(installDate)}</span></span>
                        )}
                        {!g.proof_url && <span style={{ fontStyle: 'italic' }}>No proof yet</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Tasks */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Tasks ({tasks.filter(t => !t.completed_at).length} open · {tasks.filter(t => t.completed_at).length} done)</span>
        </div>

        {/* Add task form */}
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '10px', marginBottom: '10px', display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '6px' }}>
          <input
            value={newTaskTitle}
            onChange={e => setNewTaskTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && addTask()}
            placeholder="Task title (e.g. Order parts)"
            style={{ padding: '7px 10px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '12px', outline: 'none' }}
          />
          <select
            value={newTaskAssignee}
            onChange={e => setNewTaskAssignee(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '12px', outline: 'none' }}
          >
            <option value="">Unassigned</option>
            {profileList.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
          <input
            type="date"
            value={newTaskDue}
            onChange={e => setNewTaskDue(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '12px', outline: 'none' }}
          />
          <button
            onClick={addTask}
            disabled={addingTask || !newTaskTitle.trim()}
            style={{ padding: '7px 14px', borderRadius: '6px', background: theme.orange, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: addingTask || !newTaskTitle.trim() ? 0.5 : 1, whiteSpace: 'nowrap' }}
          >
            + Task
          </button>
        </div>

        {/* Task list */}
        {loadingTasks ? (
          <div style={{ color: theme.textMuted, fontSize: '12px', textAlign: 'center', padding: '14px', marginBottom: '16px' }}>Loading tasks...</div>
        ) : tasks.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px' }}>
            {tasks.map(t => {
              const isDone = !!t.completed_at;
              const overdue = t.due_date && !isDone && new Date(t.due_date) < new Date(new Date().toDateString());
              return (
                <div key={t.id} style={{ background: theme.card, border: `1px solid ${overdue ? '#ef4444' : theme.border}`, borderRadius: '8px', padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px', opacity: isDone ? 0.5 : 1 }}>
                  <input
                    type="checkbox"
                    checked={isDone}
                    onChange={() => updateTask(t.id, { completed: !isDone })}
                    style={{ cursor: 'pointer', accentColor: '#22c55e' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: theme.textPrimary, textDecoration: isDone ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.title}
                    </div>
                    <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px', display: 'flex', gap: '8px' }}>
                      {t.due_date && <span style={{ color: overdue ? '#ef4444' : theme.textMuted }}>Due {fmt(t.due_date)}</span>}
                      {t.assignee?.full_name && <span>→ {t.assignee.full_name}</span>}
                      {!t.assignee && <span style={{ fontStyle: 'italic' }}>Unassigned</span>}
                    </div>
                  </div>
                  <select
                    value={t.assigned_to || ''}
                    onChange={e => updateTask(t.id, { assigned_to: e.target.value || null })}
                    style={{ padding: '4px 6px', borderRadius: '5px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '11px', outline: 'none', maxWidth: '130px' }}
                    title="Reassign task"
                  >
                    <option value="">Unassigned</option>
                    {profileList.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                  </select>
                  <button
                    onClick={() => { if (confirm(`Delete task "${t.title}"?`)) deleteTask(t.id); }}
                    style={{ padding: '4px 6px', borderRadius: '5px', background: 'none', border: 'none', color: theme.textMuted, fontSize: '12px', cursor: 'pointer' }}
                    title="Delete task"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Files */}
        <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Files ({files.length})</span>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={e => {
                const fs = e.target.files;
                if (fs && fs.length > 0 && selected) uploadFiles(selected.id, Array.from(fs));
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              style={{ display: 'none' }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingFiles}
              style={{ padding: '4px 10px', borderRadius: '6px', background: theme.orange, color: '#fff', border: 'none', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: uploadingFiles ? 0.5 : 1 }}
            >
              {uploadingFiles ? 'Uploading...' : '+ Upload'}
            </button>
          </div>
        </div>
        {files.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px' }}>
            {files.map(f => (
              <div key={f.id} style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <a
                  href={getFileUrl(f.storage_path)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ flex: 1, minWidth: 0, color: theme.textPrimary, fontSize: '12px', fontWeight: 600, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {f.file_name}
                </a>
                <span style={{ fontSize: '10px', color: theme.textMuted, flexShrink: 0 }}>{formatFileSize(f.file_size)}</span>
                <span style={{ fontSize: '10px', color: theme.textMuted, flexShrink: 0 }}>{fmtTime(f.uploaded_at)}</span>
                <button
                  onClick={() => deleteFile(f)}
                  style={{ padding: '4px 6px', borderRadius: '5px', background: 'none', border: 'none', color: theme.textMuted, fontSize: '12px', cursor: 'pointer' }}
                  title="Delete file"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

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
            <div>
              {createFiles.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
                  {createFiles.map((f, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 600, background: theme.inputBg, border: `1px solid ${theme.border}`, color: theme.textPrimary }}>
                      {f.name}
                      <span onClick={() => setCreateFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ cursor: 'pointer', fontSize: '10px', opacity: 0.7 }}>✕</span>
                    </span>
                  ))}
                </div>
              )}
              <input
                ref={createFileInputRef}
                type="file"
                multiple
                onChange={e => {
                  const fs = Array.from(e.target.files || []);
                  if (fs.length > 0) setCreateFiles(prev => [...prev, ...fs]);
                  if (createFileInputRef.current) createFileInputRef.current.value = '';
                }}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={() => createFileInputRef.current?.click()}
                style={{ width: '100%', padding: '8px', borderRadius: '8px', background: 'transparent', border: `1px dashed ${theme.border}`, color: theme.textMuted, fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
              >
                + Add Files (PO PDFs, photos, specs)
              </button>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowCreate(false); setCreateFiles([]); }} style={{ padding: '6px 12px', borderRadius: '6px', background: 'none', border: `1px solid ${theme.border}`, color: theme.textMuted, fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={createProject} disabled={creating || !newName.trim()} style={{ padding: '6px 14px', borderRadius: '6px', background: theme.orange, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: creating || !newName.trim() ? 0.5 : 1 }}>{creating ? 'Creating...' : 'Create'}</button>
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
            const openTasks = (p.upfit_project_tasks || []).filter(t => !t.completed_at).length;
            const totalTasks = (p.upfit_project_tasks || []).length;
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
                <div style={{ display: 'flex', gap: '12px', fontSize: '10px', color: theme.textMuted, flexWrap: 'wrap' }}>
                  {p.estimate_number && <span>Est: {p.estimate_number}</span>}
                  {p.netsuite_so_number && <span>SO: {p.netsuite_so_number}</span>}
                  {p.scheduled_date && <span>Sched: {fmt(p.scheduled_date)}</span>}
                  {totalTasks > 0 && (
                    <span style={{ color: openTasks > 0 ? '#fbbf24' : '#22c55e' }}>
                      {openTasks > 0 ? `${openTasks}/${totalTasks} tasks open` : `${totalTasks} task${totalTasks !== 1 ? 's' : ''} done`}
                    </span>
                  )}
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
