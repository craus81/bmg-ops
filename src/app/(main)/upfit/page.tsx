'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { storage, storageDownloadUrl } from '@/lib/storage';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { DropZone } from '@/components/DropZone';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { theme } from '@/lib/theme';
import HistoryButton from '@/components/HistoryButton';
import { deepLinks } from '@/lib/deep-links';
import { flashNote } from '@/lib/focus-note';
import { fetchAllRows } from '@/lib/fetch-all';
import RecordChanges from '@/components/RecordChanges';
import CreatedBy from '@/components/CreatedBy';
import { apiFetch } from '@/lib/api-client';
import { DeliveryPicker, DeliverySummary } from '@/components/DeliveryPicker';
import { jobStanding, type JobStanding } from '@/lib/job-standing';
import { deliveryFromRow, deliveryProblem, deliveryToRow, type Delivery } from '@/lib/delivery';

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

interface UpfitProjectView {
  id: string;
  project_id: string;
  user_id: string;
  first_viewed_at: string;
  last_viewed_at: string;
  view_count: number;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return '';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
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
  parts_ordered_date: string | null;
  parts_eta: string | null;
  customer_dropoff_date: string | null;
  need_back_date: string | null;
  /** Delivery method columns (migration 414, src/lib/delivery.ts). */
  delivery_method?: string | null;
  delivery_ship_speed?: string | null;
  delivery_address?: string | null;
  delivery_contact_name?: string | null;
  delivery_contact_phone?: string | null;
  delivery_notes?: string | null;
  delivery_installer?: string | null;
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

interface ProjectPoLink {
  id: string;
  po_id: string;
  po_number: string | null;
  source: string;
  po: {
    id: string; netsuite_id: string | null; tranid: string | null; vendor_name: string | null;
    status_label: string | null; eta_date: string | null; tracking_number: string | null;
  } | null;
}

const STANDING_COLORS: Record<JobStanding['tone'], string> = {
  bad: '#ef4444', warn: '#f59e0b', good: '#22c55e', info: '#60a5fa', muted: '#94a3b8',
};

export default function UpfitProjectsPage() {
  const { user, isAdmin, hasFeature } = useAuth();
  useRequireFeature('upfit_projects');
  const supabase = createClient();
  const dialog = useDialog();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [projects, setProjects] = useState<UpfitProject[]>([]);
  // Per-project parts verdicts for the card chips (R3-12), keyed by id.
  const [boardReadiness, setBoardReadiness] = useState<Record<string, {
    verdict: 'reserved' | 'ready' | 'waiting' | 'short';
    covered: number; onOrder: number; short: number; lastEta: string | null;
  }>>({});
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<Record<string, string>>({});

  // Project views — who has opened each project (read receipts). Loaded
  // eagerly for all projects so the list can show the unread-activity dot
  // and the 👁 seen-by badge; the detail view shows the full Seen By list.
  const [projectViews, setProjectViews] = useState<Record<string, UpfitProjectView[]>>({});

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
  // Delivery method card (migration 414): null = not editing.
  const [deliveryEdit, setDeliveryEdit] = useState<Delivery | null>(null);
  const [deliveryTried, setDeliveryTried] = useState(false);
  const [deliverySaving, setDeliverySaving] = useState(false);
  const [deliveryNote, setDeliveryNote] = useState<string | null>(null);

  // Parts readiness — needed vs on hand vs on order for the project's SO
  const [readiness, setReadiness] = useState<any | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);

  // ALL vendor POs linked to the selected project (upfit_project_pos,
  // migration 267) — the scalar column on the project is only the first.
  const [projectPos, setProjectPos] = useState<ProjectPoLink[]>([]);
  const [poLinkInput, setPoLinkInput] = useState('');
  const [poLinkBusy, setPoLinkBusy] = useState(false);


  const load = async () => {
    setLoading(true);
    const res = await fetch('/api/upfit-projects');
    if (res.ok) {
      const data = await res.json();
      setProjects(data.projects || []);

      // Parts-readiness chips for the cards (R3-12) — one batch call over
      // synced data, non-blocking; the detail panel keeps the live compute.
      const readyIds = (data.projects || [])
        .filter((p: any) => p.netsuite_so_id && !['completed', 'cancelled'].includes(p.status))
        .slice(0, 100)
        .map((p: any) => p.id);
      if (readyIds.length > 0) {
        fetch('/api/upfit-projects/readiness-board', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: readyIds }),
        }).then(r => (r.ok ? r.json() : null)).then(d => {
          if (d?.readiness) setBoardReadiness(d.readiness);
        }).catch(() => { /* chips are a nicety; the panel has the live view */ });
      }
    }

    // Load profiles for display names
    const { data: profs } = await supabase.from('profiles').select('id, full_name, role, roles').eq('status', 'approved').order('full_name');
    if (profs) {
      const map: Record<string, string> = {};
      for (const p of profs) map[p.id] = p.full_name || 'Unknown';
      setProfiles(map);
      // The assignee dropdowns exclude external CNI installers (the
      // 'installer' role); the name map above keeps covering everyone so
      // tasks already assigned to one still show a name.
      setProfileList(profs.filter((p: any) => p.role !== 'installer' && !(p.roles || []).includes('installer')) as { id: string; full_name: string }[]);
    }

    setLoading(false);
    loadViews();
  };

  // Views are best-effort — the page must still render if the
  // upfit_project_views migration hasn't been applied yet. One row per
  // (user, opened project) grows unboundedly, so paginate past PostgREST's
  // 1000-row cap; id gives the deterministic unique order.
  const loadViews = async () => {
    try {
      const { data } = await fetchAllRows<UpfitProjectView>((from, to) =>
        supabase
          .from('upfit_project_views')
          .select('*')
          .order('id')
          .range(from, to)
      );
      const byProject: Record<string, UpfitProjectView[]> = {};
      for (const v of data) (byProject[v.project_id] ||= []).push(v);
      for (const k of Object.keys(byProject)) {
        byProject[k].sort((a, b) => b.last_viewed_at.localeCompare(a.last_viewed_at));
      }
      setProjectViews(byProject);
    } catch (e) {
      console.warn('upfit_project_views unavailable:', e);
    }
  };

  // Stamp my view so the unread dot clears for me and I appear in Seen By
  // (best-effort — opening the project must work even if the RPC hasn't
  // been migrated).
  const recordProjectView = async (projectId: string) => {
    if (!user) return;
    try {
      await supabase.rpc('record_upfit_project_view', { p_project_id: projectId });
    } catch (e) {
      console.warn('record_upfit_project_view unavailable:', e);
    }
    loadViews();
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  // Deep-link: ?id=<projectId> auto-opens that project so /upfit?id= works
  // from the graphics page parent-link, the tracking page, etc.
  const flashedSubRecordKey = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const projectId = searchParams.get('id');
    if (!projectId) return;
    // A mention deep link (&note=<id>) scroll-flashes that note once the
    // project's Activity timeline loads; a task-assignment deep link
    // (&task=<id>) does the same for the task row. Keyed one-shot so data
    // refreshes don't re-yank the scroll, but a NEW note/task link to the
    // already-open project (same-route push, no remount) still flashes.
    const noteId = searchParams.get('note');
    const taskId = searchParams.get('task');
    // Scheduling alerts (migration 450) land on the parts or dates card.
    const focus = searchParams.get('focus');
    const subKey = `${projectId}:${noteId || ''}:${taskId || ''}:${focus || ''}`;
    const focusSubRecords = () => {
      if (flashedSubRecordKey.current === subKey) return;
      flashedSubRecordKey.current = subKey;
      if (noteId) flashNote(`upnote-${noteId}`);
      if (taskId) flashNote(`uptask-${taskId}`);
      if (focus === 'parts') flashNote('upfit-parts-readiness');
      if (focus === 'dates') flashNote('upfit-key-dates');
    };
    if (selected?.id === projectId) {
      // Project already open — just focus the linked note/task.
      focusSubRecords();
      return;
    }
    const inList = projects.find(p => p.id === projectId);
    if (inList) {
      openProject(inList);
      focusSubRecords();
      return;
    }
    // Project may be archived/cancelled and filtered out of the active
    // list — fall back to fetching it directly.
    (async () => {
      const { data } = await supabase.from('upfit_projects').select('*').eq('id', projectId).maybeSingle();
      if (data) {
        openProject(data as UpfitProject);
        focusSubRecords();
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams, projects]);

  // 3D design behind this project (audit Stage 10: "the shop builds without
  // ever seeing the approved layout" — the design was reachable only from
  // the estimate side). Resolved through the estimate the design quoted:
  // upfit_designs.estimate_id ↔ upfit_projects.estimate_id, no new schema.
  const [designLink, setDesignLink] = useState<{ id: string; name: string; snapshotUrl: string | null } | null>(null);
  useEffect(() => {
    setDesignLink(null);
    const estId = selected?.estimate_id;
    if (!estId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('upfit_designs')
        .select('id, name, snapshot_path')
        .eq('estimate_id', estId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || !data) return;
      const snapshotUrl = data.snapshot_path
        ? storage.from('photos').getPublicUrl(data.snapshot_path).data?.publicUrl || null
        : null;
      setDesignLink({ id: data.id, name: data.name || '3D design', snapshotUrl });
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [selected?.estimate_id]);

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
    if (!(await dialog.confirm(`Delete "${file.file_name}"?`, { destructive: true, confirmLabel: 'Delete' }))) return;
    await storage.from('upfit-files').remove([file.storage_path]);
    await supabase.from('upfit_project_files').delete().eq('id', file.id);
    setFiles(prev => prev.filter(f => f.id !== file.id));
  };

  // Download route keeps the recorded file name on save.
  const getFileUrl = (path: string, name?: string | null) => storageDownloadUrl('upfit-files', path, name || '');

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
        if (project?.netsuite_so_id) loadReadiness(project.id, true);
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

  const loadReadiness = async (projectId: string, hasSo: boolean) => {
    if (!hasSo) { setReadiness(null); return; }
    setReadinessLoading(true);
    setReadiness(null);
    try {
      const res = await fetch(`/api/upfit-projects/parts-readiness?id=${projectId}`);
      if (res.ok) setReadiness(await res.json());
    } catch { /* card just stays hidden */ }
    setReadinessLoading(false);
  };

  // Reserve/release stock for this project. The API returns recomputed
  // readiness, so the card refreshes in the same round trip.
  const allocate = async (body: Record<string, unknown>) => {
    if (!selected) return;
    setReadinessLoading(true);
    try {
      const res = await fetch('/api/upfit-projects/allocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selected.id, ...body }),
      });
      const data = await res.json();
      if (!res.ok) await dialog.alert(data.error || 'Allocation failed');
      else setReadiness(data);
    } catch { /* leave the card as-is */ }
    setReadinessLoading(false);
  };

  // Audit item 17A: a short readiness row finally has an action. POSTs a
  // purchase request (server enriches item id/vendor and notifies
  // purchasing) and repaints the card from the returned readiness — the
  // allocations-route one-round-trip pattern.
  const [requesting, setRequesting] = useState(false);
  const requestParts = async (projectId: string, items: { itemNumber: string; quantity: number; description?: string | null; netsuiteItemId?: string | null }[]) => {
    if (items.length === 0 || requesting) return;
    setRequesting(true);
    try {
      const res = await fetch('/api/purchase-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, projectId, returnReadiness: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      if (body.readiness) setReadiness(body.readiness);
    } catch (e: any) {
      await dialog.alert(`Could not request the part${items.length !== 1 ? 's' : ''}: ${e?.message || 'unknown error'}`);
    }
    setRequesting(false);
  };

  const editAllocation = async (p: any) => {
    const answer = await dialog.prompt(
      `Reserve how many ${p.item_number} for this job? (0 releases; ${p.allocated + p.free} max)`,
      String(p.allocated > 0 ? p.allocated : Math.min(p.needed, p.allocated + p.free)),
    );
    if (answer === null) return;
    const qty = parseFloat(answer);
    if (isNaN(qty) || qty < 0) return;
    allocate({ action: 'set', itemNumber: p.item_number, quantity: qty });
  };

  // The project's linked vendor POs — a handful per project, read straight
  // off the join table with the mirror row embedded for status/ETA display.
  const loadProjectPos = async (projectId: string) => {
    try {
      const { data } = await supabase
        .from('upfit_project_pos')
        .select('id, po_id, po_number, source, po:netsuite_vendor_pos(id, netsuite_id, tranid, vendor_name, status_label, eta_date, tracking_number)')
        .eq('project_id', projectId)
        .order('created_at');
      setProjectPos((data as unknown as ProjectPoLink[]) || []);
    } catch {
      setProjectPos([]);
    }
  };

  const linkPo = async () => {
    if (!selected || !poLinkInput.trim() || poLinkBusy) return;
    setPoLinkBusy(true);
    try {
      const res = await fetch('/api/upfit-projects/link-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selected.id, poNumber: poLinkInput.trim() }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        await dialog.alert(json?.error || 'Could not link the PO.');
      } else {
        setPoLinkInput('');
        loadProjectPos(selected.id);
        loadNotes(selected.id);
        if (json?.alreadyLinked) await dialog.alert(`PO ${json.po?.tranid || ''} is already linked to this project.`.trim());
      }
    } catch (e: any) {
      await dialog.alert(`Could not link the PO: ${e?.message || 'unknown error'}`);
    }
    setPoLinkBusy(false);
  };

  const unlinkPo = async (link: ProjectPoLink) => {
    if (!selected || poLinkBusy) return;
    const label = link.po?.tranid || link.po_number || 'this PO';
    if (!(await dialog.confirm(`Unlink ${label} from this project? Vendor ETA emails for it will stop updating the project.`))) return;
    setPoLinkBusy(true);
    try {
      const res = await fetch(`/api/upfit-projects/link-po?id=${link.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        await dialog.alert(j?.error || 'Could not unlink the PO.');
      } else {
        loadProjectPos(selected.id);
        loadNotes(selected.id);
      }
    } catch (e: any) {
      await dialog.alert(`Could not unlink the PO: ${e?.message || 'unknown error'}`);
    }
    setPoLinkBusy(false);
  };

  const openProject = (p: UpfitProject) => {
    setSelected(p);
    setDeliveryEdit(null);
    setDeliveryTried(false);
    setDeliveryNote(null);
    setProjectPos([]);
    setPoLinkInput('');
    loadNotes(p.id);
    loadTasks(p.id);
    loadFiles(p.id);
    loadLinkedCheckin(p.fleet_checkin_id);
    loadLinkedGraphics(p.id);
    loadReadiness(p.id, !!p.netsuite_so_id);
    // The header chip's verdict: the list load only covers the newest 100
    // open jobs, so fetch this one's when it wasn't among them.
    if (p.netsuite_so_id && !boardReadiness[p.id]) {
      fetch('/api/upfit-projects/readiness-board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [p.id] }),
      }).then(r => (r.ok ? r.json() : null)).then(d => {
        if (d?.readiness) setBoardReadiness(prev => ({ ...prev, ...d.readiness }));
      }).catch(() => { /* chip falls back to Sold */ });
    }
    loadProjectPos(p.id);
    recordProjectView(p.id);
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
      // Carry the new note's id so a mention deep link scrolls straight to it.
      const { note } = await res.json().catch(() => ({ note: null }));
      reportMentions({
        text: newNote.trim(),
        sourceType: 'upfit_note',
        sourceId: selected.id,
        contextLabel: `${selected.project_name}${selected.customer_name ? ` — ${selected.customer_name}` : ''}`,
        contextUrl: deepLinks.upfitProject(selected.id, { noteId: note?.id }),
      });
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

  // The four dates that make a project trackable, saved as they're set.
  // Drop-off / need-back also feed the shop arrival schedule (shop_inbound,
  // synced server-side by the PUT route).
  const saveDate = async (field: string, value: string) => {
    if (!selected) return;
    const v = value || null;
    setSelected({ ...selected, [field]: v });
    setProjects(prev => prev.map(p => p.id === selected.id ? { ...p, [field]: v } : p));
    await fetch('/api/upfit-projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selected.id, [field]: v }),
    });
  };

  // Saves on the project, its estimate and its open Production jobs.
  const saveDelivery = async () => {
    if (!selected || !deliveryEdit) return;
    const problem = deliveryProblem(deliveryEdit, false);
    if (problem) { setDeliveryTried(true); await dialog.alert(problem); return; }
    setDeliverySaving(true);
    try {
      const res = await apiFetch('/api/delivery', {
        method: 'POST',
        body: JSON.stringify({ source: 'upfit_project', id: selected.id, delivery: deliveryEdit }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const row = deliveryToRow(deliveryEdit, 'upfit_projects');
      setSelected({ ...selected, ...row });
      setProjects(prev => prev.map(p => p.id === selected.id ? { ...p, ...row } : p));
      const u = body.updated || {};
      const others = [...(u.estimates || []).map((n: string) => `estimate ${n}`), ...(u.jobs || [])];
      setDeliveryNote(others.length ? `Also updated: ${others.join(', ')}.` : null);
      setDeliveryEdit(null);
      setDeliveryTried(false);
    } catch (e: any) {
      await dialog.alert(`Delivery didn't save: ${e?.message || 'network error'}`);
    }
    setDeliverySaving(false);
  };

  const fmt = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtTime = (d: string) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Detail view
  if (selected) {
    // What the job is waiting on, worked out from parts and the vehicle
    // (src/lib/job-standing.ts) — replaces the hand-moved status bar.
    const standing = jobStanding(selected, boardReadiness[selected.id]);
    const stColor = STANDING_COLORS[standing.tone];
    const closed = selected.status === 'completed' || selected.status === 'cancelled';
    return (
      <div style={{ padding: '16px', maxWidth: '800px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <button onClick={() => (window.history.length > 1 ? router.back() : router.push('/home'))} title="Back" style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '18px', cursor: 'pointer', padding: '4px' }}>&larr;</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: theme.textPrimary }}>{selected.project_name}</div>
            {selected.customer_name && <div style={{ fontSize: '12px', color: theme.textSecondary }}>{selected.customer_name}</div>}
            <CreatedBy userId={selected.created_by} at={selected.created_at} style={{ display: 'block', fontSize: '11px' }} />
          </div>
          <span title={standing.detail || undefined} style={{ fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: `${stColor}20`, color: stColor, border: `1px solid ${stColor}40` }}>{standing.label}</span>
          {/* R6-13: who changed what on this project. */}
          <HistoryButton table="upfit_projects" recordId={selected.id} compact />
        </div>

        {/* Done / Cancel / Reopen (2026-10-20): the 12-step status bar is
            gone; where the job stands is worked out (header chip). A job
            closes on its own when its vehicle ships (migration 085); a job
            with no vehicle (graphics-only, parts-only) is marked done here.
            Cancelling releases reserved parts (migration 228). */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', marginBottom: '16px' }}>
          {standing.detail && <span style={{ fontSize: '12px', color: theme.textSecondary, marginRight: 'auto' }}>{standing.detail}</span>}
          {!closed ? (
            <>
              <button
                onClick={async () => {
                  if (!(await dialog.confirm(`Mark "${selected.project_name}" done?`, { confirmLabel: 'Mark done' }))) return;
                  updateStatus(selected.id, 'completed');
                }}
                style={{ padding: '5px 12px', borderRadius: '7px', border: '1px solid rgba(34,197,94,0.5)', background: 'rgba(34,197,94,0.12)', color: '#22c55e', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}
              >✓ Mark done</button>
              <button
                onClick={async () => {
                  if (!(await dialog.confirm(
                    `Cancel "${selected.project_name}"? Its reserved parts release back to free stock; the job stays in history and can be reopened.`,
                    { destructive: true, confirmLabel: 'Cancel job' },
                  ))) return;
                  updateStatus(selected.id, 'cancelled');
                }}
                style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '11px', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: '2px 4px' }}
              >✕ Cancel job</button>
            </>
          ) : (
            <button
              onClick={() => updateStatus(selected.id, 'sold')}
              title="Reopen this job"
              style={{ padding: '5px 12px', borderRadius: '7px', border: `1px solid ${theme.border}`, background: 'var(--card)', color: theme.textPrimary, fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}
            >↺ Reopen job</button>
          )}
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
            {/* All linked vendor POs (upfit_project_pos) — the scalar
                netsuite_vendor_po_number holds only the first, shown as a
                fallback while the join rows load or if none exist. */}
            <div style={{ gridColumn: '1 / -1' }}>
              <span style={{ color: theme.textMuted }}>Vendor PO{projectPos.length > 1 ? 's' : ''}: </span>
              {projectPos.length === 0 && (
                <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{selected.netsuite_vendor_po_number || '—'}</span>
              )}
              {projectPos.map(l => (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '3px' }}>
                  <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{l.po?.tranid || l.po_number || '—'}</span>
                  {l.po?.vendor_name && <span style={{ color: theme.textMuted }}>{l.po.vendor_name}</span>}
                  {l.po?.status_label && (
                    <span style={{ fontSize: '10px', fontWeight: 700, color: theme.textSecondary, border: `1px solid ${theme.border}`, borderRadius: '999px', padding: '1px 7px' }}>
                      {l.po.status_label}
                    </span>
                  )}
                  {l.po?.eta_date && <span style={{ color: theme.textSecondary }}>ETA {fmt(l.po.eta_date)}</span>}
                  {l.po?.netsuite_id && (
                    <a href={deepLinks.pdfViewer(deepLinks.netsuitePdf('purchaseOrder', l.po.netsuite_id, deepLinks.poPdfFileName(l.po.tranid, l.po.netsuite_id)), { name: deepLinks.poPdfFileName(l.po.tranid, l.po.netsuite_id), back: deepLinks.upfitProject(selected.id), backLabel: selected.project_name || 'Upfit project' })}
                      target="_blank" rel="noreferrer" title="NetSuite's printed PO"
                      style={{ padding: '1px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, border: `1px solid ${theme.border}`, color: '#60a5fa', textDecoration: 'none', whiteSpace: 'nowrap' }}>📄 PDF</a>
                  )}
                  <button
                    onClick={() => unlinkPo(l)}
                    disabled={poLinkBusy}
                    title="Unlink this PO from the project"
                    style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '13px', fontWeight: 700, cursor: 'pointer', padding: '0 2px' }}
                  >×</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' }}>
                <input
                  value={poLinkInput}
                  onChange={e => setPoLinkInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') linkPo(); }}
                  placeholder="Link a PO # (e.g. 376)"
                  style={{ flex: '0 1 160px', padding: '4px 8px', fontSize: '12px', background: theme.inputBg, border: `1px solid ${theme.border}`, borderRadius: '6px', color: theme.textPrimary }}
                />
                <button
                  onClick={linkPo}
                  disabled={poLinkBusy || !poLinkInput.trim()}
                  style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 700, background: 'none', border: `1px solid ${theme.border}`, borderRadius: '6px', color: theme.textSecondary, cursor: poLinkBusy || !poLinkInput.trim() ? 'default' : 'pointer', opacity: poLinkBusy || !poLinkInput.trim() ? 0.5 : 1 }}
                >Link</button>
              </div>
            </div>
            <div>
              <span style={{ color: theme.textMuted }}>Schedule: </span>
              <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{selected.scheduled_date ? fmt(selected.scheduled_date) : '—'}</span>
            </div>
            {designLink && (
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={{ color: theme.textMuted }}>3D Design: </span>
                <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{designLink.name}</span>
                {(isAdmin || hasFeature('upfit_configurator')) && (
                  <a
                    href={deepLinks.upfitDesign(designLink.id)}
                    style={{ marginLeft: '8px', color: 'var(--accent, #2563eb)', fontWeight: 700, fontSize: '11px' }}
                  >Open in designer →</a>
                )}
                {designLink.snapshotUrl && (
                  // The approved layout itself — visible to every role that
                  // can see the project, including techs who can't open the
                  // designer. This is the shop's build reference.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={designLink.snapshotUrl}
                    alt={`3D layout — ${designLink.name}`}
                    style={{ display: 'block', marginTop: '6px', maxWidth: '100%', maxHeight: '180px', borderRadius: '8px', border: `1px solid ${theme.border}` }}
                  />
                )}
              </div>
            )}
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
                style={{ padding: '7px 14px', borderRadius: '6px', background: theme.accent, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: nsLookingUp || !nsLookupNumber.trim() ? 0.5 : 1, whiteSpace: 'nowrap' }}
              >
                {nsLookingUp ? 'Looking up...' : 'Link'}
              </button>
            </div>
            {nsLookupError && (
              <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{nsLookupError}</div>
            )}
          </div>
        </div>

        {/* Key dates — parts + customer schedule. Anyone who talks to the
            customer fills in drop-off / need-back; those two drive the shop
            arrival schedule. */}
        <div id="upfit-key-dates" style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Key Dates</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
            {([
              ['parts_ordered_date', 'Parts Ordered'],
              ['parts_eta', 'Parts ETA'],
              ['customer_dropoff_date', 'Customer Drop-off'],
              ['need_back_date', 'Needs It Back'],
            ] as const).map(([field, label]) => (
              <div key={field}>
                <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                <input
                  id={`upfit-date-${field}`}
                  type="date"
                  value={(selected[field] || '').slice(0, 10)}
                  onChange={e => saveDate(field, e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '6px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '12px', outline: 'none' }}
                />
              </div>
            ))}
          </div>
          {selected.customer_dropoff_date && (
            <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '8px' }}>
              On the shop arrival schedule for {fmt(selected.customer_dropoff_date)}.
            </div>
          )}
        </div>

        {/* Delivery method — entered on the estimate, shared with this
            project's graphics jobs (migration 414). */}
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '12px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Delivery</div>
            {!deliveryEdit && (
              <button
                onClick={() => { setDeliveryEdit(deliveryFromRow(selected, 'upfit_projects')); setDeliveryNote(null); }}
                style={{ fontSize: '10px', fontWeight: 700, color: theme.accent, background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {selected.delivery_method ? 'Edit' : '+ Set delivery'}
              </button>
            )}
          </div>
          {deliveryEdit ? (
            <>
              <DeliveryPicker
                value={deliveryEdit}
                onChange={setDeliveryEdit}
                showProblems={deliveryTried}
                customerNetsuiteId={selected.customer_netsuite_id}
                customerName={selected.customer_name}
              />
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={saveDelivery}
                  disabled={deliverySaving}
                  style={{ padding: '6px 14px', borderRadius: '6px', background: theme.accent, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: deliverySaving ? 0.6 : 1 }}
                >
                  {deliverySaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => { setDeliveryEdit(null); setDeliveryTried(false); }}
                  style={{ padding: '6px 12px', borderRadius: '6px', background: 'none', color: theme.textMuted, border: `1px solid ${theme.border}`, fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <span style={{ fontSize: '10px', color: theme.textMuted }}>Also updates the estimate and this project&apos;s open graphics jobs.</span>
              </div>
            </>
          ) : (
            <DeliverySummary value={deliveryFromRow(selected, 'upfit_projects')} emptyText="Not set yet. Usually entered on the estimate." />
          )}
          {!deliveryEdit && linkedGraphics.length > 0 && selected.delivery_method && (
            <div style={{ fontSize: '10px', color: '#34d399', marginTop: '8px' }}>
              Shared with {linkedGraphics.length} graphics job{linkedGraphics.length === 1 ? '' : 's'}: {linkedGraphics.map(g => g.job_number).filter(Boolean).join(', ')}.
            </div>
          )}
          {deliveryNote && <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '4px' }}>{deliveryNote}</div>}
        </div>

        {/* Parts readiness — per part on the SO: needed vs on hand (live
            NetSuite) vs on order (synced vendor POs, matched by part
            number since vendor POs aren't linked to the SO). */}
        {selected.netsuite_so_id && (
          <div id="upfit-parts-readiness" style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '12px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Parts Readiness{readiness?.soNumber ? ` · ${readiness.soNumber}` : ''}
              </div>
              <span style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <a
                  href={deepLinks.salesOrder(selected.netsuite_so_id)}
                  style={{ fontSize: '10px', fontWeight: 700, color: 'var(--accent)', textDecoration: 'none' }}
                >
                  Open sales order
                </a>
                {readiness?.available && (readiness.parts || []).some((p: any) => p.allocatable > 0) && (
                  <button
                    onClick={() => allocate({ action: 'allocate_all' })}
                    disabled={readinessLoading}
                    style={{ fontSize: '10px', fontWeight: 700, color: '#22c55e', background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    Reserve available
                  </button>
                )}
                {readiness?.available && (readiness.parts || []).some((p: any) => p.allocated > 0) && (
                  <button
                    onClick={async () => { if (await dialog.confirm('Release every part reserved for this job back to the pool?')) allocate({ action: 'release_all' }); }}
                    disabled={readinessLoading}
                    style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    Release all
                  </button>
                )}
                <button
                  onClick={() => loadReadiness(selected.id, true)}
                  disabled={readinessLoading}
                  style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  {readinessLoading ? 'Checking…' : 'Refresh'}
                </button>
              </span>
            </div>
            {readinessLoading && !readiness && (
              <div style={{ fontSize: '11px', color: theme.textMuted }}>Checking NetSuite…</div>
            )}
            {readiness && !readiness.available && (
              <div style={{ fontSize: '11px', color: theme.textMuted }}>
                {readiness.reason === 'no_sales_order' ? 'Link a sales order to check parts.' : `NetSuite lookup failed${readiness.error ? `: ${readiness.error}` : ''}`}
              </div>
            )}
            {readiness?.available && readiness.parts.length === 0 && (
              <div style={{ fontSize: '11px', color: theme.textMuted }}>No item lines on the sales order.</div>
            )}
            {readiness?.available && readiness.parts.length > 0 && (
              <>
                {readiness.summary.verdict && (() => {
                  const v = readiness.summary.verdict;
                  const color = v === 'reserved' || v === 'ready' ? '#22c55e' : v === 'waiting' ? '#60a5fa' : '#ef4444';
                  return (
                    <div style={{
                      fontSize: '11px', fontWeight: 800, padding: '7px 10px', borderRadius: '8px', marginBottom: '8px',
                      background: `${color}1f`, color, border: `1px solid ${color}59`,
                    }}>
                      {v === 'reserved' && (selected.customer_dropoff_date
                        ? `✓ All parts reserved — drop-off set for ${fmt(selected.customer_dropoff_date)}`
                        : '✓ All parts reserved for this job — ready to schedule')}
                      {v === 'reserved' && !selected.customer_dropoff_date && (
                        <>
                          <div style={{ marginTop: '3px', fontWeight: 600, color: theme.textMuted }}>Call the customer and set the drop-off date.</div>
                          <button
                            onClick={() => {
                              flashNote('upfit-key-dates');
                              setTimeout(() => (document.getElementById('upfit-date-customer_dropoff_date') as HTMLInputElement | null)?.focus(), 400);
                            }}
                            style={{ display: 'block', marginTop: '6px', padding: '6px 10px', borderRadius: '7px', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}
                          >
                            📅 Set drop-off date
                          </button>
                        </>
                      )}
                      {v === 'ready' && '✓ All parts available — reserve them so another job can\'t claim them'}
                      {v === 'ready' && (
                        <>
                          <div style={{ marginTop: '3px', fontWeight: 600, color: theme.textMuted }}>Check the shelf first. Once they&apos;re reserved, whoever schedules installs is told to book it.</div>
                          <button
                            onClick={() => allocate({ action: 'allocate_all' })}
                            disabled={readinessLoading}
                            style={{ display: 'block', marginTop: '6px', padding: '6px 10px', borderRadius: '7px', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', fontSize: '11px', fontWeight: 800, cursor: readinessLoading ? 'default' : 'pointer', opacity: readinessLoading ? 0.6 : 1 }}
                          >
                            📦 Reserve all parts
                          </button>
                        </>
                      )}
                      {v === 'waiting' && `⏳ Waiting on parts already on order${readiness.summary.lastEta ? ` — last ETA ${fmt(readiness.summary.lastEta)}` : ''}`}
                      {v === 'short' && `✗ ${readiness.summary.short} part${readiness.summary.short !== 1 ? 's' : ''} not in stock or on order — don't schedule yet`}
                      {v === 'short' && (() => {
                        const unrequested = readiness.parts.filter((p: any) => p.short > 0 && (p.requested || 0) < p.short);
                        if (unrequested.length === 0) {
                          return <div style={{ marginTop: '5px', fontWeight: 700, color: '#f59e0b' }}>🛒 All short parts are requested — waiting on purchasing.</div>;
                        }
                        return (
                          <button
                            disabled={requesting}
                            onClick={() => requestParts(selected.id, unrequested.map((p: any) => ({
                              itemNumber: p.item_number,
                              // The TARGET outstanding ask, not a delta: the server raises
                              // a pending row to max(existing, quantity), so a delta could
                              // go stale and no-op forever (Round 3 finding).
                              quantity: p.short,
                              description: p.description,
                              netsuiteItemId: p.netsuite_item_id,
                            })))}
                            style={{ display: 'block', marginTop: '6px', padding: '6px 10px', borderRadius: '7px', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.4)', color: '#f59e0b', fontSize: '11px', fontWeight: 800, cursor: requesting ? 'default' : 'pointer', opacity: requesting ? 0.6 : 1 }}
                          >
                            {requesting ? 'Requesting…' : `🛒 Request ${unrequested.length} short part${unrequested.length !== 1 ? 's' : ''} from purchasing`}
                          </button>
                        );
                      })()}
                    </div>
                  );
                })()}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                  {readiness.summary.short > 0 && (
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: '#ef444420', color: '#ef4444' }}>{readiness.summary.short} short</span>
                  )}
                  {readiness.summary.onOrder > 0 && (
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: '#60a5fa20', color: '#60a5fa' }}>{readiness.summary.onOrder} on order</span>
                  )}
                  {readiness.summary.covered > 0 && (
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: '#22c55e20', color: '#22c55e' }}>{readiness.summary.covered} covered</span>
                  )}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                    <thead>
                      <tr style={{ color: theme.textMuted, textAlign: 'left' }}>
                        <th style={{ padding: '4px 6px', fontWeight: 700 }}>Part</th>
                        <th style={{ padding: '4px 6px', fontWeight: 700, textAlign: 'right' }}>Need</th>
                        <th style={{ padding: '4px 6px', fontWeight: 700, textAlign: 'right' }} title="Reserved for this job — click a value to change it">Res.</th>
                        <th style={{ padding: '4px 6px', fontWeight: 700, textAlign: 'right' }} title="Free stock after every job's reservations">Free</th>
                        <th style={{ padding: '4px 6px', fontWeight: 700, textAlign: 'right' }}>On Order</th>
                        <th style={{ padding: '4px 6px', fontWeight: 700 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {readiness.parts.map((p: any) => {
                        const state = p.state === 'reserved'
                          ? { label: 'Reserved', color: '#22c55e' }
                          : p.state === 'available'
                            ? { label: 'Available', color: '#4ade80' }
                            : p.state === 'waiting' || (p.state == null && p.short === 0 && p.needed > p.on_hand)
                              ? { label: 'On order', color: '#60a5fa' }
                              : p.short > 0
                                ? { label: `Short ${p.short}`, color: '#ef4444' }
                                : { label: 'Covered', color: '#22c55e' };
                        return (
                          <tr key={p.item_number} style={{ borderTop: `1px solid ${theme.border}` }}>
                            <td style={{ padding: '5px 6px' }}>
                              <div style={{ fontWeight: 700, color: theme.textPrimary }}>{p.item_number}</div>
                              {p.description && <div style={{ color: theme.textMuted, fontSize: '10px' }}>{p.description}</div>}
                              {p.pos.length > 0 && (
                                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '3px' }}>
                                  {p.pos.map((po: any, i: number) => (
                                    <span key={i} style={{ fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px', background: '#60a5fa15', color: '#60a5fa', border: '1px solid #60a5fa30' }}>
                                      {po.tranid || 'PO'}{po.vendor_name ? ` · ${po.vendor_name}` : ''}{po.trandate ? ` · ${fmt(po.trandate)}` : ''} · {po.remaining} coming{po.eta_date ? ` · ETA ${fmt(po.eta_date)}` : ''}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '5px 6px', textAlign: 'right', color: theme.textPrimary, fontWeight: 700 }}>{p.needed}</td>
                            <td style={{ padding: '5px 6px', textAlign: 'right' }}>
                              <button
                                onClick={() => editAllocation(p)}
                                title="Change how many are reserved for this job"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 800, color: (p.allocated || 0) > 0 ? '#22c55e' : theme.textMuted, textDecoration: 'underline dotted', padding: 0 }}
                              >
                                {p.allocated ?? 0}
                              </button>
                            </td>
                            <td style={{ padding: '5px 6px', textAlign: 'right', color: theme.textSecondary }}>{p.free ?? p.on_hand}</td>
                            <td style={{ padding: '5px 6px', textAlign: 'right', color: theme.textSecondary }}>{p.on_order}</td>
                            <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>
                              <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: `${state.color}20`, color: state.color, whiteSpace: 'nowrap' }}>{state.label}</span>
                              {p.short > 0 && ((p.requested || 0) >= p.short ? (
                                <span title="A purchase request is pending for this part" style={{ marginLeft: '4px', fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: 'rgba(251,191,36,0.15)', color: '#f59e0b', whiteSpace: 'nowrap' }}>🛒 Requested</span>
                              ) : (
                                <button
                                  disabled={requesting}
                                  onClick={() => requestParts(selected.id, [{ itemNumber: p.item_number, quantity: p.short, description: p.description, netsuiteItemId: p.netsuite_item_id }])}
                                  title="Ask purchasing to order the short quantity"
                                  style={{ marginLeft: '4px', fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '6px', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.4)', color: '#f59e0b', cursor: requesting ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
                                >
                                  Order
                                </button>
                              ))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

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
            style={{ padding: '7px 14px', borderRadius: '6px', background: theme.accent, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: addingTask || !newTaskTitle.trim() ? 0.5 : 1, whiteSpace: 'nowrap' }}
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
                <div key={t.id} id={`uptask-${t.id}`} style={{ background: theme.card, border: `1px solid ${overdue ? '#ef4444' : theme.border}`, borderRadius: '8px', padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px', opacity: isDone ? 0.5 : 1 }}>
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
                    onClick={async () => { if (await dialog.confirm(`Delete task "${t.title}"?`, { destructive: true, confirmLabel: 'Delete' })) deleteTask(t.id); }}
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
        <DropZone
          onFiles={files => { if (selected) uploadFiles(selected.id, files); }}
          multiple
          disabled={uploadingFiles}
        >
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
              style={{ padding: '4px 10px', borderRadius: '6px', background: theme.accent, color: '#fff', border: 'none', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: uploadingFiles ? 0.5 : 1 }}
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
                  href={getFileUrl(f.storage_path, f.file_name)}
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
        </DropZone>

        {/* Add note */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <MentionTextArea
            value={newNote}
            onChange={setNewNote}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } }}
            placeholder="Add a note... @name to tag a teammate"
            style={{ flex: 1, padding: '8px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '13px', outline: 'none' }}
          />
          <button
            onClick={addNote}
            disabled={addingNote || !newNote.trim()}
            style={{ padding: '8px 14px', borderRadius: '8px', background: theme.accent, color: '#fff', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: addingNote || !newNote.trim() ? 0.5 : 1 }}
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
              <div key={n.id} id={`upnote-${n.id}`} style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: theme.textSecondary }}>{n.profiles?.full_name || profiles[n.created_by || ''] || 'System'}</span>
                  </div>
                  <span style={{ fontSize: '10px', color: theme.textMuted }}>{fmtTime(n.created_at)}</span>
                </div>
                <div style={{ fontSize: '12px', color: theme.textPrimary, lineHeight: '1.4' }}>{n.content}</div>
              </div>
            ))}
          </div>
        )}

        {/* Seen By — read receipts of who has opened this project */}
        <div style={{ marginTop: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Seen By</div>
          {(() => {
            const others = (projectViews[selected.id] || []).filter(v => v.user_id !== user?.id);
            if (others.length === 0) {
              return <div style={{ fontSize: '11px', color: theme.textMuted }}>No one else has opened this project yet.</div>;
            }
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                {others.map(v => (
                  <div key={v.id} style={{ fontSize: '11px', color: theme.textPrimary, display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                    <span>
                      {profiles[v.user_id] || 'Unknown'}
                      {v.view_count > 1 && (
                        <span style={{ marginLeft: '6px', color: theme.textMuted, fontSize: '10px' }}>({v.view_count}×)</span>
                      )}
                    </span>
                    <span style={{ color: theme.textMuted, fontSize: '10px' }} title={new Date(v.last_viewed_at).toLocaleString()}>
                      {relativeTime(v.last_viewed_at)}
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        {/* Field-level audit history (A2 phase 4) — admin-only per audit_log RLS */}
        {isAdmin && <RecordChanges table="upfit_projects" recordId={selected.id} />}
      </div>
    );
  }

  // No job open: the list was retired with the Upfit tab (2026-10-20,
  // Craig chose Option C). Jobs open from the customer page, the estimate,
  // Purchasing → Jobs waiting on parts and the vehicle on In-Shop.
  return (
    <div style={{ padding: '16px', maxWidth: '560px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>Jobs</div>
      {loading || searchParams.get('id') ? (
        <div style={{ fontSize: '13px', color: theme.textMuted }}>Loading…</div>
      ) : (
        <>
          <div style={{ fontSize: '13px', color: theme.textSecondary, lineHeight: 1.5 }}>
            The Upfit list has moved. Open a job from the customer&rsquo;s page (Jobs card), from its estimate (Open job), from Purchasing &rarr; Jobs waiting on parts, or from the vehicle on In-Shop.
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {hasFeature('parts_ordering') && (
              <a href="/admin/purchasing?tab=jobs" style={{ padding: '8px 14px', borderRadius: '8px', background: theme.accent, color: '#fff', fontSize: '12px', fontWeight: 700, textDecoration: 'none' }}>Jobs waiting on parts</a>
            )}
            <a href="/tracking" style={{ padding: '8px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`, color: theme.textPrimary, fontSize: '12px', fontWeight: 700, textDecoration: 'none' }}>In-Shop</a>
          </div>
        </>
      )}
    </div>
  );
}
