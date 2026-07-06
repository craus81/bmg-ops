'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import AssignmentPicker from '@/components/AssignmentPicker';
import GraphicsInvoiceReviewModal from '@/components/GraphicsInvoiceReviewModal';
import { PartLabel } from '@/components/PartLabel';
import DropboxProofSearch from '@/components/DropboxProofSearch';
import { exportPackingListPDF, packingListFromJob, type PackingListLine } from '@/lib/packing-list-pdf';
import type {
  GraphicsJob, GraphicsJobStatus, GraphicsJobCategory, GraphicsStatusHistory, GraphicsJobView, Profile,
} from '@/lib/types';
import {
  GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS, GRAPHICS_STATUS_ORDER,
  GRAPHICS_CATEGORY_LABELS, GRAPHICS_CATEGORY_COLORS,
} from '@/lib/types';

type ViewMode = 'pipeline' | 'list';
type FilterStatus = GraphicsJobStatus | 'all' | 'active';
type FilterCategory = GraphicsJobCategory | 'all';

// Parse a date string as local date (avoids UTC timezone shift)
function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  // Handle ISO strings like "2025-03-26T00:00:00.000Z" or plain "2025-03-26"
  const parts = dateStr.substring(0, 10).split('-');
  if (parts.length !== 3) return new Date(dateStr);
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

// Format a date string for display without timezone shift
function displayDate(dateStr: string | null | undefined): string {
  const d = parseLocalDate(dateStr);
  if (!d) return '';
  return d.toLocaleDateString();
}

// Extract YYYY-MM-DD for date input value
function toDateInputValue(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
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

// Active statuses (not terminal)
const ACTIVE_STATUSES: GraphicsJobStatus[] = ['flagged', 'received', 'designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing', 'ready', 'ready_to_pickup'];

export default function GraphicsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isAdmin, isProduction, isSales, profile } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [jobs, setJobs] = useState<GraphicsJob[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // Parent upfit projects, keyed by upfit_project_id, populated on mount
  // for any job that has a non-null upfit_project_id (migration 084).
  const [upfitProjects, setUpfitProjects] = useState<Record<string, { id: string; project_name: string; status: string; customer_name: string | null }>>({});
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('pipeline');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('active');
  const [filterCategory, setFilterCategory] = useState<FilterCategory>('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'due_date' | 'created_at' | 'status'>('due_date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<GraphicsJob | null>(null);
  const [invoiceJob, setInvoiceJob] = useState<GraphicsJob | null>(null);
  const invoicePromptHandled = useRef<Set<string>>(new Set());
  const [statusHistory, setStatusHistory] = useState<GraphicsStatusHistory[]>([]);

  // Status change with comment
  const [pendingStatus, setPendingStatus] = useState<{ job: GraphicsJob; status: GraphicsJobStatus } | null>(null);
  const [statusComment, setStatusComment] = useState('');

  // Internal notes (comment thread)
  const [newNote, setNewNote] = useState('');

  // Create job state
  const [showCreate, setShowCreate] = useState(false);
  const [createStep, setCreateStep] = useState<'category' | 'details'>('category');
  // Set when /tracking or the post-check-in prompt deep-links into the
  // create modal; we re-link the resulting graphics_job to the source
  // check-in so the "Needs Graphics" chip clears automatically.
  const [prefillCheckinId, setPrefillCheckinId] = useState<string | null>(null);
  const [awaitingGraphics, setAwaitingGraphics] = useState<any[]>([]);
  const [createForm, setCreateForm] = useState({
    job_category: '' as GraphicsJobCategory | '',
    title: '', part_number: '', part_numbers: [] as string[], partInput: '', customer: '', quantity: 1,
    content: '', notes: '',
    vinyl_type: '', vinyl_color: '', laminate: '', print_method: '', cut_method: '', premask: '',
    priority: 'normal' as 'low' | 'normal' | 'high' | 'rush',
    due_date: '',
    scheduled_install_date: '',
    ship_to: '',
    supplier: '',
    po_number: '',
  });
  const [createAssignees, setCreateAssignees] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // Customer autocomplete
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<{ company_name: string }[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const customerTimeout = useRef<any>(null);

  const searchCustomers = (query: string) => {
    setCustomerSearch(query);
    setCreateForm(f => ({ ...f, customer: query }));
    if (customerTimeout.current) clearTimeout(customerTimeout.current);
    if (query.length < 2) { setCustomerResults([]); return; }
    customerTimeout.current = setTimeout(async () => {
      setCustomerLoading(true);
      const { data } = await supabase
        .from('customers')
        .select('company_name')
        .ilike('company_name', `%${query}%`)
        .eq('active', true)
        .order('company_name')
        .limit(8);
      setCustomerResults(data || []);
      setCustomerLoading(false);
    }, 250);
  };

  const selectCustomer = (name: string) => {
    setCreateForm(f => ({ ...f, customer: name }));
    setCustomerSearch(name);
    setCustomerResults([]);
  };

  // Job files
  interface JobFile { id: string; job_id: string; file_name: string; file_type: string | null; file_size: number | null; storage_path: string; uploaded_by: string | null; uploaded_at: string; }
  interface PoFile { id: string; po_id: string; file_name: string; file_type: string | null; file_size: number | null; storage_path: string; source: string | null; uploaded_at: string; }
  const [jobFiles, setJobFiles] = useState<Record<string, JobFile[]>>({});
  // PO PDFs surfaced read-only on jobs that link to a PO
  const [jobPoFiles, setJobPoFiles] = useState<Record<string, PoFile[]>>({});
  const [createFiles, setCreateFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createFileInputRef = useRef<HTMLInputElement>(null);

  // Job assignments
  const [jobAssignments, setJobAssignments] = useState<Record<string, string[]>>({});
  // Per-job generation counter for assignment loads. Bumped by saves so that
  // an in-flight load can detect it's stale and skip overwriting state.
  const assignmentsLoadGen = useRef<Record<string, number>>({});

  // Job views — record of who has opened each job (read receipts).
  // Loaded eagerly for all jobs so the collapsed cards can show "seen by".
  const [jobViews, setJobViews] = useState<Record<string, GraphicsJobView[]>>({});

  // Saving state
  const [saving, setSaving] = useState(false);

  // Estimate & Invoice state
  const [creatingEstimate, setCreatingEstimate] = useState(false);
  const [fetchingPdfJobId, setFetchingPdfJobId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    if (!isProduction && !isAdmin && !isSales) { router.push('/home'); return; }
    loadJobs();
    loadProfiles();
    loadUpfitProjects();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, isAdmin, isProduction]);

  // Auto-open a job for editing when navigated from PO page via ?editJob=<id>
  useEffect(() => {
    if (loading) return;
    const editJobId = searchParams.get('editJob');
    if (!editJobId) return;
    const job = jobs.find(j => j.id === editJobId);
    if (job) {
      setExpandedJobId(job.id);
      setEditingJob({ ...job });
      setFilterStatus('all');
      loadHistory(job.id);
      loadJobAssignments(job.id);
      loadJobFiles(job.id);
      recordJobView(job.id);
    }
    router.replace('/graphics', { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams]);

  // Admin "create invoice in FleetSuite?" prompt — opens when navigated
  // from the bell notification with ?invoiceJob=<id>. Confirms once; on
  // yes, opens the invoice review modal. Either way, clears the param.
  useEffect(() => {
    if (loading) return;
    const invoiceJobId = searchParams.get('invoiceJob');
    if (!invoiceJobId) return;
    if (invoicePromptHandled.current.has(invoiceJobId)) return;
    const job = jobs.find(j => j.id === invoiceJobId);
    invoicePromptHandled.current.add(invoiceJobId);
    router.replace('/graphics', { scroll: false });
    if (!job) return;
    (async () => {
      if ((job as any).netsuite_invoice_id) {
        await dialog.alert(`Already invoiced as #${(job as any).netsuite_invoice_number || (job as any).netsuite_invoice_id}.`);
        return;
      }
      const label = job.title || `Job #${job.job_number || job.id.slice(0, 8)}`;
      if (await dialog.confirm(`Create invoice in FleetSuite for ${label}?`)) {
        setInvoiceJob(job);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams, jobs]);

  // Auto-expand job from ?id= URL param (deep link from notifications/search)
  useEffect(() => {
    if (loading) return;
    const jobId = searchParams.get('id');
    if (jobId && jobs.some(j => j.id === jobId)) {
      setExpandedJobId(jobId);
      loadHistory(jobId);
      loadJobAssignments(jobId);
      loadJobFiles(jobId);
      recordJobView(jobId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams]);

  // Open the create-job modal when other pages deep-link with ?new=1.
  // Customer / SO / VIN / checkin id flow through URL params from
  // /tracking and the post-check-in graphics-needed prompt so the new
  // job can pre-fill those fields and back-link to the source check-in.
  useEffect(() => {
    if (loading) return;
    if (searchParams.get('new') === '1') {
      setShowCreate(true);
      const customer = searchParams.get('customer') || '';
      const so = searchParams.get('so') || '';
      const checkinId = searchParams.get('checkinId');
      if (customer) {
        setCreateForm(f => ({ ...f, customer, po_number: so || f.po_number }));
        setCustomerSearch(customer);
      }
      if (checkinId) setPrefillCheckinId(checkinId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams]);

  // Awaiting-graphics queue: vehicles whose linked SO/estimate scored
  // positive in the keyword scan but haven't yet been linked to a
  // graphics_job. Reload alongside jobs so creating one drops it off
  // the queue immediately.
  const loadAwaitingGraphics = async () => {
    const { data } = await supabase
      .from('fleet_checkins')
      .select('id, vin, customer_name, sales_order_number, graphics_signal, created_at, vehicle_year, vehicle_make, vehicle_model')
      .eq('needs_graphics', true)
      .is('matched_graphics_job_id', null)
      .neq('status', 'delivered')
      .order('created_at', { ascending: false })
      .limit(50);
    setAwaitingGraphics(data || []);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  useEffect(() => { loadAwaitingGraphics(); }, []);

  // Dismiss a queue entry when no graphics job is actually needed. Clearing
  // needs_graphics (rather than tracking a separate "dismissed" state) also
  // removes the vehicle's needs-graphics badge on the tracking page, and
  // nothing re-runs the keyword scan later, so it won't reappear.
  const dismissAwaiting = async (ci: any) => {
    const label = ci.customer_name || [ci.vehicle_year, ci.vehicle_make, ci.vehicle_model].filter(Boolean).join(' ') || 'this vehicle';
    if (!(await dialog.confirm(`Dismiss ${label} from the graphics queue? Use this when no graphics job is needed.`, { confirmLabel: 'Dismiss' }))) return;
    const { error } = await supabase
      .from('fleet_checkins')
      .update({ needs_graphics: false })
      .eq('id', ci.id);
    if (error) { await dialog.alert('Failed to dismiss: ' + error.message); return; }
    setAwaitingGraphics(prev => prev.filter(x => x.id !== ci.id));
  };

  const loadJobs = async () => {
    // Exclude installed/cancelled by default — they're archived
    const { data: jobsData } = await supabase
      .from('graphics_jobs')
      .select('*')
      .not('status', 'in', '("installed","cancelled")')
      .order('created_at', { ascending: false });
    setJobs((jobsData as GraphicsJob[]) || []);
    setLoading(false);

    // Views are best-effort — if the graphics_job_views table or RPC
    // hasn't been migrated yet, the page should still render the jobs.
    try {
      const { data: viewsData } = await supabase
        .from('graphics_job_views')
        .select('*');
      setJobViews(groupViewsByJob((viewsData as GraphicsJobView[]) || []));
    } catch (e) {
      console.warn('graphics_job_views unavailable:', e);
    }
  };

  const groupViewsByJob = (rows: GraphicsJobView[]): Record<string, GraphicsJobView[]> => {
    const out: Record<string, GraphicsJobView[]> = {};
    for (const v of rows) {
      (out[v.job_id] ||= []).push(v);
    }
    // Newest first within each job
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => b.last_viewed_at.localeCompare(a.last_viewed_at));
    }
    return out;
  };

  const recordJobView = async (jobId: string) => {
    if (!user) return;
    try {
      const { error } = await supabase.rpc('record_graphics_job_view', { p_job_id: jobId });
      if (error) {
        console.warn('Failed to record job view:', error.message);
        return;
      }
      const { data } = await supabase
        .from('graphics_job_views')
        .select('*')
        .eq('job_id', jobId);
      if (data) {
        setJobViews(prev => ({ ...prev, [jobId]: (data as GraphicsJobView[])
          .sort((a, b) => b.last_viewed_at.localeCompare(a.last_viewed_at)) }));
      }
    } catch (e) {
      console.warn('record_graphics_job_view unavailable:', e);
    }
  };

  const loadProfiles = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status')
      .eq('status', 'approved');
    setProfiles((data as Profile[]) || []);
  };

  const loadUpfitProjects = async () => {
    // Cheap unconditional load — there are typically far fewer upfit
    // projects than graphics jobs and the rows are small.
    const { data } = await supabase
      .from('upfit_projects')
      .select('id, project_name, status, customer_name');
    if (!data) return;
    const map: Record<string, { id: string; project_name: string; status: string; customer_name: string | null }> = {};
    for (const p of data as any[]) map[p.id] = p;
    setUpfitProjects(map);
  };

  const loadHistory = async (jobId: string) => {
    const { data } = await supabase
      .from('graphics_status_history')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });
    setStatusHistory((data as GraphicsStatusHistory[]) || []);
  };

  const loadJobAssignments = async (jobId: string) => {
    // Bump generation so a concurrent save can invalidate this load. Without
    // this guard, a load fired on expand/edit can resolve AFTER the user
    // clicks a name and clobber the optimistic state with stale DB data.
    const gen = (assignmentsLoadGen.current[jobId] || 0) + 1;
    assignmentsLoadGen.current[jobId] = gen;
    const { data } = await supabase
      .from('job_assignments')
      .select('user_id')
      .eq('job_type', 'graphics_job')
      .eq('job_id', jobId);
    if (assignmentsLoadGen.current[jobId] !== gen) return;
    if (data) {
      setJobAssignments(prev => ({
        ...prev,
        [jobId]: data.map((a: any) => a.user_id),
      }));
    }
  };

  const loadJobFiles = async (jobId: string) => {
    const { data } = await supabase
      .from('graphics_job_files')
      .select('*')
      .eq('job_id', jobId)
      .order('uploaded_at', { ascending: false });
    if (data) {
      setJobFiles(prev => ({ ...prev, [jobId]: data as JobFile[] }));
    }
    // If the job is linked to a PO, also surface that PO's PDFs read-only.
    const job = jobs.find(j => j.id === jobId);
    if (job?.po_id) {
      const { data: poData } = await supabase
        .from('po_files')
        .select('*')
        .eq('po_id', job.po_id)
        .order('uploaded_at', { ascending: false });
      setJobPoFiles(prev => ({ ...prev, [jobId]: (poData as PoFile[]) || [] }));
    }
  };

  const uploadFilesToJob = async (jobId: string, files: File[]) => {
    if (files.length === 0) return;
    setUploadingFiles(true);
    const errors: string[] = [];
    let uploaded = 0;
    for (const file of files) {
      const ext = file.name.split('.').pop() || 'bin';
      const path = `graphics-files/${jobId}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, { contentType: file.type });
      if (upErr) {
        console.error('File upload error:', upErr);
        errors.push(`${file.name}: ${upErr.message || 'storage upload failed'}`);
        continue;
      }
      const { error: dbErr } = await supabase.from('graphics_job_files').insert({
        job_id: jobId,
        file_name: file.name,
        file_type: file.type || null,
        file_size: file.size,
        storage_path: path,
        uploaded_by: user?.id,
      });
      if (dbErr) {
        console.error('File record insert error:', dbErr);
        errors.push(`${file.name}: ${dbErr.message || 'database insert failed'}`);
        // Roll back the storage object so the bucket doesn't accumulate
        // orphaned files when the DB insert is the one rejecting us.
        await storage.from('graphics-proofs').remove([path]).catch(() => {});
        continue;
      }
      uploaded++;
    }
    setUploadingFiles(false);
    await loadJobFiles(jobId);
    if (errors.length > 0) {
      await dialog.alert(`Uploaded ${uploaded} of ${files.length} file${files.length === 1 ? '' : 's'}.\n\n${errors.join('\n')}`);
    }
  };

  const deleteJobFile = async (file: JobFile) => {
    if (!(await dialog.confirm(`Delete "${file.file_name}"?`, { destructive: true, confirmLabel: 'Delete' }))) return;
    await storage.from('graphics-proofs').remove([file.storage_path]);
    await supabase.from('graphics_job_files').delete().eq('id', file.id);
    setJobFiles(prev => ({
      ...prev,
      [file.job_id]: (prev[file.job_id] || []).filter(f => f.id !== file.id),
    }));
  };

  const getFileUrl = (path: string) => {
    const { data } = storage.from('graphics-proofs').getPublicUrl(path);
    return data.publicUrl;
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const saveJobAssignments = async (jobId: string, userIds: string[], jobTitle?: string) => {
    // Invalidate any in-flight load so it can't overwrite this save.
    assignmentsLoadGen.current[jobId] = (assignmentsLoadGen.current[jobId] || 0) + 1;
    const prev = jobAssignments[jobId] || [];
    setJobAssignments(p => ({ ...p, [jobId]: userIds }));
    try {
      const res = await fetch('/api/jobs/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobType: 'graphics_job',
          jobId,
          userIds,
          assignedBy: user?.id,
          notifyUsers: true,
          notifyTeam: false,
          jobTitle,
        }),
      });
      if (!res.ok) {
        console.error('Assignment save failed:', res.status, await res.text());
        setJobAssignments(p => ({ ...p, [jobId]: prev }));
      }
    } catch (err) {
      console.error('Assignment save error:', err);
      setJobAssignments(p => ({ ...p, [jobId]: prev }));
    }
  };

  // Prompt for status comment before changing
  const promptStatusChange = (job: GraphicsJob, newStatus: GraphicsJobStatus) => {
    if (job.status === newStatus) return;
    setPendingStatus({ job, status: newStatus });
    setStatusComment('');
  };

  const confirmStatusChange = async () => {
    if (!pendingStatus) return;
    await changeStatus(pendingStatus.job, pendingStatus.status, statusComment.trim() || undefined);
    setPendingStatus(null);
    setStatusComment('');
  };

  // Change job status
  const changeStatus = async (job: GraphicsJob, newStatus: GraphicsJobStatus, note?: string) => {
    const oldStatus = job.status;
    if (oldStatus === newStatus) return;

    const { error } = await supabase
      .from('graphics_jobs')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', job.id);

    if (!error) {
      // Log status change
      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: oldStatus,
        to_status: newStatus,
        changed_by: user?.id,
        note: note || null,
      });

      // Notifications split by target audience:
      //   - newStatus === 'ready': install-readiness event. Fire to a narrow
      //     install-target set (assigned installers + admins + opt-ins) via
      //     /api/graphics/notify-ready. Graphics-team users who want generic
      //     status-change pings still get them via the second path below.
      //   - All transitions also fire a generic status-change notification to
      //     anyone whose preferences include that type — preserves the
      //     existing awareness for the production team.
      if (newStatus === 'ready') {
        fetch('/api/graphics/notify-ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id }),
        }).catch(() => {});
      } else if (newStatus === 'ready_to_pickup') {
        fetch('/api/graphics/notify-pickup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id }),
        }).catch(() => {});
      } else if (newStatus === 'shipped') {
        fetch('/api/graphics/notify-shipped-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id }),
        }).catch(() => {});
      }

      const { data: prefs } = await supabase
        .from('notification_preferences')
        .select('user_id, notify_status_change, notify_shipped, custom_statuses');

      if (prefs) {
        const statusPingUserIds = prefs
          .filter((p: any) => {
            if (p.user_id === user?.id) return false;
            if (newStatus === 'shipped' && p.notify_shipped) return true;
            if (p.notify_status_change) return true;
            if (p.custom_statuses?.includes(newStatus)) return true;
            return false;
          })
          .map((p: any) => p.user_id);

        if (statusPingUserIds.length > 0) {
          fetch('/api/notifications/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userIds: statusPingUserIds,
              type: 'graphics_status',
              title: `${job.title} → ${GRAPHICS_STATUS_LABELS[newStatus]}`,
              body: `Job #${job.job_number || job.id.slice(0, 8)} status changed to ${GRAPHICS_STATUS_LABELS[newStatus]}`,
              url: `/graphics?id=${job.id}`,
              excludeUserId: user?.id,
            }),
          }).catch(() => {});
        }
      }

      // Sync calendar (updates status in description, or deletes if cancelled)
      if (job.scheduled_install_date || job.calendar_event_id) {
        fetch('/api/calendar/sync-graphics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id }),
        }).catch(() => {});
      }

      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: newStatus, updated_at: new Date().toISOString() } : j));
      if (expandedJobId === job.id) loadHistory(job.id);
    }
  };

  // Add internal note (timestamped comment, no status change)
  const addNote = async (jobId: string) => {
    if (!newNote.trim()) return;
    const job = jobs.find(j => j.id === jobId);
    await supabase.from('graphics_status_history').insert({
      job_id: jobId,
      from_status: job?.status || null,
      to_status: job?.status || 'received',
      changed_by: user?.id,
      note: newNote.trim(),
    });
    setNewNote('');
    await loadHistory(jobId);
  };

  // Send proof to customer for approval (magic link)
  const [sendingApprovalId, setSendingApprovalId] = useState<string | null>(null);
  // Per-job picker state — clicking "Send proof" opens a small inline file
  // picker inside the Customer Approval block. The actual API call doesn't
  // fire until the user picks a file and confirms.
  const [approvalPickerJobId, setApprovalPickerJobId] = useState<string | null>(null);
  const [approvalPickerFileId, setApprovalPickerFileId] = useState<string | null>(null);

  const openApprovalPicker = (jobId: string) => {
    if (sendingApprovalId) return;
    // Pre-fill with the most recently uploaded file if any (it's the
    // common case: artist uploads the proof, then sends).
    const files = jobFiles[jobId] || [];
    setApprovalPickerJobId(jobId);
    setApprovalPickerFileId(files[0]?.id || null);
  };

  const closeApprovalPicker = () => {
    setApprovalPickerJobId(null);
    setApprovalPickerFileId(null);
  };

  const confirmSendForApproval = async (jobId: string) => {
    if (sendingApprovalId) return;
    if (!approvalPickerFileId) {
      await dialog.alert('Pick a proof file to send.');
      return;
    }
    setSendingApprovalId(jobId);
    const res = await fetch(`/api/graphics-jobs/${jobId}/send-for-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proofFileId: approvalPickerFileId }),
    });
    const data = await res.json();
    setSendingApprovalId(null);
    if (!res.ok) {
      await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
      return;
    }
    closeApprovalPicker();
    await loadJobs();
    const emailInfo = data.dispatch?.email
      ? (data.dispatch.email.ok ? `Email sent to ${data.dispatch.email.target}` : `Email failed: ${data.dispatch.email.error || 'unknown'}`)
      : null;
    const smsInfo = data.dispatch?.sms
      ? (data.dispatch.sms.skipped
          ? 'SMS skipped (provider disabled)'
          : data.dispatch.sms.ok
            ? `SMS sent to ${data.dispatch.sms.target}`
            : `SMS failed: ${data.dispatch.sms.error || 'unknown'}`)
      : null;
    await dialog.alert(`Proof sent for approval. Link: ${data.approvalUrl}\n\n${[emailInfo, smsInfo].filter(Boolean).join('\n')}`);
  };

  // Save job edits
  const saveJob = async () => {
    if (!editingJob) return;
    setSaving(true);
    // assigned_to is owned by the AssignmentPicker (saved immediately via the
    // /api/jobs/assign route, which also keeps the legacy column in sync). If
    // we included it here, the stale local value would clobber a fresh save.
    const { id, created_at, created_by, assigned_to: _assigned_to, ...updateFields } = editingJob;
    // Convert non-date values like "N/A" or empty strings to null for date columns
    const sanitized = {
      ...updateFields,
      due_date: updateFields.due_date && updateFields.due_date !== 'N/A' ? updateFields.due_date : null,
      scheduled_install_date: updateFields.scheduled_install_date && updateFields.scheduled_install_date !== 'N/A' ? updateFields.scheduled_install_date : null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('graphics_jobs')
      .update(sanitized)
      .eq('id', id);

    if (!error) {
      setJobs(prev => prev.map(j => j.id === id ? editingJob : j));
      setEditingJob(null);

      // Sync install date to Google Calendar (create, update, or delete event)
      fetch('/api/calendar/sync-graphics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: id }),
      }).catch(() => {});
    }
    setSaving(false);
  };

  // Create new job
  const createJob = async () => {
    setCreating(true);
    const cat = createForm.job_category || 'production';
    const prefix = cat === 'proofing' ? 'PRF' : cat === 'internal' ? 'INT' : cat === 'customer_supplied' ? 'CSG' : 'GFX';
    const jobNumber = `${prefix}-${Date.now().toString(36).toUpperCase()}`;
    const initialStatus: GraphicsJobStatus = cat === 'proofing' ? 'designing' : 'received';
    const { data, error } = await supabase
      .from('graphics_jobs')
      .insert({
        job_number: jobNumber,
        job_category: cat,
        title: createForm.title || 'Untitled Job',
        part_number: [...createForm.part_numbers, createForm.partInput.trim()].filter(Boolean).join(', ') || null,
        customer: createForm.customer || null,
        quantity: createForm.quantity || 1,
        content: createForm.content || null,
        notes: createForm.notes || null,
        vinyl_type: cat === 'production' ? (createForm.vinyl_type || null) : null,
        vinyl_color: cat === 'production' ? (createForm.vinyl_color || null) : null,
        laminate: cat === 'production' ? (createForm.laminate || null) : null,
        print_method: cat === 'production' ? (createForm.print_method || null) : null,
        cut_method: cat === 'production' ? (createForm.cut_method || null) : null,
        premask: cat === 'production' ? (createForm.premask || null) : null,
        priority: createForm.priority,
        due_date: createForm.due_date && createForm.due_date !== 'N/A' ? createForm.due_date : null,
        scheduled_install_date: cat !== 'internal' && createForm.scheduled_install_date && createForm.scheduled_install_date !== 'N/A' ? createForm.scheduled_install_date : null,
        ship_to: (cat === 'production' || cat === 'customer_supplied') ? (createForm.ship_to || null) : null,
        supplier: cat === 'customer_supplied' ? (createForm.supplier || null) : null,
        po_number: createForm.po_number || null,
        status: initialStatus,
        created_by: user?.id,
      })
      .select()
      .single();

    if (error) {
      await dialog.alert('Failed to create job: ' + error.message);
      setCreating(false);
      return;
    }

    if (data) {
      // Back-link to the source fleet check-in when this job was created
      // from the "Needs Graphics" prompt/chip. Clears the queue entry.
      if (prefillCheckinId) {
        await supabase
          .from('fleet_checkins')
          .update({ matched_graphics_job_id: data.id })
          .eq('id', prefillCheckinId);
        setPrefillCheckinId(null);
        loadAwaitingGraphics();
      }

      // Log creation
      await supabase.from('graphics_status_history').insert({
        job_id: data.id,
        from_status: null,
        to_status: initialStatus,
        changed_by: user?.id,
        note: `${GRAPHICS_CATEGORY_LABELS[cat]} job created`,
      });

      // Sync install date to Google Calendar if set
      if (createForm.scheduled_install_date) {
        fetch('/api/calendar/sync-graphics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: data.id }),
        }).catch(() => {});
      }

      // Notify users via all channels per their preferences
      const { data: prefs } = await supabase
        .from('notification_preferences')
        .select('user_id, notify_new_job');
      if (prefs) {
        const notifyUserIds = prefs
          .filter((p: any) => p.notify_new_job && p.user_id !== user?.id)
          .map((p: any) => p.user_id);
        if (notifyUserIds.length > 0) {
          fetch('/api/notifications/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userIds: notifyUserIds,
              type: 'graphics_new',
              title: `New Graphics Job: ${createForm.title || 'Untitled'}`,
              body: `${createForm.customer || 'Unknown'} · ${createForm.quantity} unit${createForm.quantity !== 1 ? 's' : ''}${createForm.part_number ? ` · ${createForm.part_number}` : ''}`,
              url: `/graphics?id=${data.id}`,
              excludeUserId: user?.id,
            }),
          }).catch(() => {});
        }
      }

      // Assign team members if any selected
      if (createAssignees.length > 0) {
        await fetch('/api/jobs/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobType: 'graphics_job',
            jobId: data.id,
            userIds: createAssignees,
            assignedBy: user?.id,
            notifyUsers: true,
            notifyTeam: true,
            jobTitle: createForm.title || 'Untitled Job',
          }),
        }).catch(() => {});
      }

      // Upload attached files
      if (createFiles.length > 0) {
        await uploadFilesToJob(data.id, createFiles);
      }

      // If a PO number was entered, link the PO's stored PDFs onto the job.
      if (createForm.po_number) {
        const { data: poRow } = await supabase
          .from('purchase_orders')
          .select('id')
          .eq('po_number', createForm.po_number.trim())
          .maybeSingle();
        if (poRow?.id) {
          const { data: poFiles } = await supabase
            .from('po_files')
            .select('file_name, file_type, file_size, storage_path')
            .eq('po_id', poRow.id);
          if (poFiles && poFiles.length > 0) {
            await supabase.from('graphics_job_files').insert(
              poFiles.map((f: any) => ({
                job_id: data.id,
                file_name: f.file_name,
                file_type: f.file_type,
                file_size: f.file_size,
                storage_path: f.storage_path,
                uploaded_by: user?.id || null,
              }))
            );
          }
        }
      }

      setJobs(prev => [data as GraphicsJob, ...prev]);
      setShowCreate(false);
      setCreateStep('category');
      setCreateForm({
        job_category: '', title: '', part_number: '', part_numbers: [], partInput: '', customer: '', quantity: 1,
        content: '', notes: '',
        vinyl_type: '', vinyl_color: '', laminate: '', print_method: '', cut_method: '', premask: '',
        priority: 'normal', due_date: '', scheduled_install_date: '', ship_to: '', supplier: '', po_number: '',
      });
      setCreateAssignees([]);
      setCreateFiles([]);
    }
    setCreating(false);
  };

  // Delete job
  const deleteJob = async (jobId: string) => {
    if (!(await dialog.confirm('Delete this graphics job? This cannot be undone.', { destructive: true, confirmLabel: 'Delete' }))) return;
    const { error } = await supabase.from('graphics_jobs').delete().eq('id', jobId);
    if (!error) {
      setJobs(prev => prev.filter(j => j.id !== jobId));
      setExpandedJobId(null);
      setEditingJob(null);
    }
  };

  // Create estimate from graphics job
  const createEstimateFromJob = async (job: GraphicsJob) => {
    if (job.estimate_id) {
      await dialog.alert('This job already has an estimate linked.');
      return;
    }
    if (!job.part_number && !job.customer) {
      await dialog.alert('Please add at least a part number or customer to this job before creating an estimate.');
      return;
    }
    if (!(await dialog.confirm('Create an estimate from this graphics job? The estimate will be pre-populated with the job\'s part numbers and customer.'))) return;

    setCreatingEstimate(true);
    try {
      const res = await fetch('/api/graphics/create-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, userId: user?.id }),
      });
      const data = await res.json();
      if (data.success) {
        await dialog.alert(`Estimate created: ${data.estimate_number}\n${data.line_item_count} line item${data.line_item_count !== 1 ? 's' : ''}\nTotal: $${data.grand_total?.toFixed(2) || '0.00'}\n\nYou can edit this estimate on the Estimates page.`);
        // Update local job state
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, estimate_id: data.estimate_id, updated_at: new Date().toISOString() } : j));
        loadHistory(job.id);
      } else {
        await dialog.alert('Failed to create estimate: ' + (data.error || 'Unknown error'));
      }
    } catch {
      await dialog.alert('Network error — please try again');
    }
    setCreatingEstimate(false);
  };

  // Print a packing list for the job. `overrides` lets us merge in fresh
  // invoice info right after creating one (before local state catches up).
  const printPackingList = async (job: GraphicsJob, overrides?: Partial<GraphicsJob>, lines?: PackingListLine[]) => {
    try {
      exportPackingListPDF(
        packingListFromJob({ ...job, ...overrides }, lines && lines.length > 0 ? { lines } : undefined),
        { print: true },
      );
    } catch (e) {
      console.error('Packing list error:', e);
      await dialog.alert('Could not generate the packing list.');
    }
  };

  // Pull the invoice PDF from NetSuite and store it on the job record.
  // `silent` is used for the best-effort auto-fetch right after invoicing.
  const storeInvoicePdf = async (jobId: string, silent = false): Promise<string | null> => {
    setFetchingPdfJobId(jobId);
    try {
      const res = await fetch('/api/graphics/invoice-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (data.success && data.url) {
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, invoice_pdf_url: data.url } : j));
        return data.url as string;
      }
      if (!silent) await dialog.alert('Could not get the invoice PDF: ' + (data.error || 'Unknown error'));
    } catch {
      if (!silent) await dialog.alert('Network error fetching the invoice PDF — please try again.');
    } finally {
      setFetchingPdfJobId(null);
    }
    return null;
  };

  // Filter jobs
  const filteredJobs = jobs.filter(j => {
    // Flagged jobs only visible to admins
    if (j.status === 'flagged' && !isAdmin) return false;
    // Category filter
    if (filterCategory !== 'all' && (j.job_category || 'production') !== filterCategory) return false;
    // Status filter
    if (filterStatus === 'active') {
      if (!ACTIVE_STATUSES.includes(j.status)) return false;
    } else if (filterStatus !== 'all') {
      if (j.status !== filterStatus) return false;
    }
    if (search) {
      const s = search.toLowerCase();
      return (
        j.title?.toLowerCase().includes(s) ||
        j.part_number?.toLowerCase().includes(s) ||
        j.customer?.toLowerCase().includes(s) ||
        j.job_number?.toLowerCase().includes(s) ||
        j.po_number?.toLowerCase().includes(s) ||
        j.content?.toLowerCase().includes(s)
      );
    }
    return true;
  }).sort((a, b) => {
    const dirMul = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'due_date') {
      // Missing due dates always sink to the bottom, regardless of direction
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date) * dirMul;
    }
    if (sortBy === 'created_at') {
      return (a.created_at || '').localeCompare(b.created_at || '') * dirMul;
    }
    // status: order by pipeline position
    const aIdx = GRAPHICS_STATUS_ORDER.indexOf(a.status);
    const bIdx = GRAPHICS_STATUS_ORDER.indexOf(b.status);
    if (aIdx !== bIdx) return (aIdx - bIdx) * dirMul;
    // Tiebreak within a status: soonest due date first
    if (!a.due_date && !b.due_date) return 0;
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date.localeCompare(b.due_date);
  });

  // Pipeline counts (hide flagged from non-admins)
  const visibleJobs = isAdmin ? jobs : jobs.filter(j => j.status !== 'flagged');
  const statusCounts: Record<string, number> = {};
  GRAPHICS_STATUS_ORDER.forEach(s => {
    statusCounts[s] = visibleJobs.filter(j => j.status === s).length;
  });

  const getProfileName = (userId: string | null) => {
    if (!userId) return null;
    const p = profiles.find(pr => pr.id === userId);
    return p?.full_name || p?.email || null;
  };

  const priorityColor = (p: string) => {
    switch (p) {
      case 'rush': return '#ef4444';
      case 'high': return '#f59e0b';
      case 'normal': return '#60a5fa';
      case 'low': return '#6b7280';
      default: return '#6b7280';
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--text-body)', fontSize: '12px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: theme.orange, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: 'var(--text-label)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading graphics jobs...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800 }}>Graphics Production</div>
        <button
          onClick={() => setShowCreate(true)}
          style={{ padding: '8px 14px', borderRadius: '10px', background: theme.orange, color: '#fff', fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer', boxShadow: '0 2px 8px rgba(238,49,32,0.3)' }}
        >
          + New Job
        </button>
      </div>

      {/* Awaiting Graphics queue — fleet_checkins flagged by the keyword
          scan at save time. Click an entry to open the create modal
          pre-filled with the customer + SO; saving back-links the new
          job to the check-in and the entry drops off the list. */}
      {awaitingGraphics.length > 0 && (
        <div style={{
          marginBottom: '12px', padding: '10px 12px', borderRadius: '12px',
          background: 'rgba(251,146,60,0.06)', border: '1px solid rgba(251,146,60,0.25)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 800, color: '#fb923c', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Awaiting Graphics Job ({awaitingGraphics.length})
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {awaitingGraphics.map(ci => {
              const vehicleTitle = [ci.vehicle_year, ci.vehicle_make, ci.vehicle_model].filter(Boolean).join(' ') || 'Vehicle';
              return (
                <div
                  key={ci.id}
                  onClick={() => {
                    setShowCreate(true);
                    setCreateForm(f => ({ ...f, customer: ci.customer_name || '', po_number: ci.sales_order_number || f.po_number }));
                    setCustomerSearch(ci.customer_name || '');
                    setPrefillCheckinId(ci.id);
                  }}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 10px', borderRadius: '8px', background: 'var(--card)',
                    border: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {ci.customer_name || 'No Customer'}
                      {ci.sales_order_number && <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}> · SO #{ci.sales_order_number}</span>}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{vehicleTitle}</div>
                    {ci.graphics_signal && (
                      <div style={{ fontSize: '10px', color: '#fb923c', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ci.graphics_signal}
                      </div>
                    )}
                  </div>
                  <div style={{
                    padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 800,
                    background: '#fb923c', color: '#fff', flexShrink: 0, marginLeft: '8px',
                  }}>+ Create</div>
                  <button
                    onClick={e => { e.stopPropagation(); dismissAwaiting(ci); }}
                    style={{
                      background: 'none', border: 'none', color: 'var(--text-label)',
                      fontSize: '14px', cursor: 'pointer', padding: '4px 6px', flexShrink: 0, marginLeft: '2px',
                    }}
                    title="Dismiss — no graphics job needed"
                  >✕</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Category Filter */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
        {([
          { id: 'all' as const, label: 'All', color: '#60a5fa' },
          { id: 'production' as const, label: 'Production', color: GRAPHICS_CATEGORY_COLORS.production },
          { id: 'customer_supplied' as const, label: 'Cust. Supplied', color: GRAPHICS_CATEGORY_COLORS.customer_supplied },
          { id: 'proofing' as const, label: 'Proofing', color: GRAPHICS_CATEGORY_COLORS.proofing },
          { id: 'internal' as const, label: 'Internal', color: GRAPHICS_CATEGORY_COLORS.internal },
        ]).map(c => {
          const count = c.id === 'all' ? jobs.length : jobs.filter(j => (j.job_category || 'production') === c.id).length;
          return (
            <button
              key={c.id}
              onClick={() => setFilterCategory(c.id)}
              style={{
                padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                background: filterCategory === c.id ? `${c.color}22` : 'var(--subtle-bg)',
                border: `1px solid ${filterCategory === c.id ? `${c.color}55` : 'var(--border)'}`,
                color: filterCategory === c.id ? c.color : 'var(--text-label)',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {c.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Status Pipeline Summary */}
      <div style={{
        display: 'flex', gap: '3px', marginBottom: '12px', overflowX: 'auto',
        padding: '2px 0', WebkitOverflowScrolling: 'touch',
      }}>
        <button
          onClick={() => setFilterStatus('active')}
          style={{
            padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: filterStatus === 'active' ? 'rgba(59,130,246,0.2)' : 'var(--subtle-bg)',
            border: `1px solid ${filterStatus === 'active' ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
            color: filterStatus === 'active' ? '#60a5fa' : 'var(--text-label)',
            whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
          }}
        >
          Active ({visibleJobs.filter(j => ACTIVE_STATUSES.includes(j.status)).length})
        </button>
        {GRAPHICS_STATUS_ORDER.filter(s => (statusCounts[s] > 0 || s === 'received') && (s !== 'flagged' || isAdmin)).map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(filterStatus === s ? 'active' : s)}
            style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
              background: filterStatus === s ? `${GRAPHICS_STATUS_COLORS[s]}22` : 'var(--subtle-bg)',
              border: `1px solid ${filterStatus === s ? `${GRAPHICS_STATUS_COLORS[s]}66` : 'var(--border)'}`,
              color: filterStatus === s ? GRAPHICS_STATUS_COLORS[s] : 'var(--text-label)',
              whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
            }}
          >
            {GRAPHICS_STATUS_LABELS[s].replace('Job ', '')} ({statusCounts[s] || 0})
          </button>
        ))}
        <button
          onClick={() => setFilterStatus('all')}
          style={{
            padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: filterStatus === 'all' ? 'rgba(59,130,246,0.2)' : 'var(--subtle-bg)',
            border: `1px solid ${filterStatus === 'all' ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
            color: filterStatus === 'all' ? '#60a5fa' : 'var(--text-label)',
            whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
          }}
        >
          All ({jobs.length})
        </button>
      </div>

      {/* Search + Sort */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', alignItems: 'stretch' }}>
        <input
          placeholder="Search jobs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            ...inputStyle, flex: 1, marginBottom: 0,
            background: 'var(--subtle-bg)', border: '1px solid var(--border)',
          }}
        />
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as 'due_date' | 'created_at' | 'status')}
          title="Sort jobs by"
          style={{
            ...inputStyle, marginBottom: 0, width: 'auto', minWidth: '120px',
            background: 'var(--subtle-bg)', border: '1px solid var(--border)',
            cursor: 'pointer',
          }}
        >
          <option value="due_date">Due date</option>
          <option value="created_at">Date created</option>
          <option value="status">Status</option>
        </select>
        <button
          onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
          title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
          style={{
            padding: '0 12px', borderRadius: '6px', fontSize: '14px', fontWeight: 700,
            background: 'var(--subtle-bg)', border: '1px solid var(--border)',
            color: 'var(--text-label)', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      {/* Job List */}
      {filteredJobs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-label)', fontSize: '13px' }}>
          {search ? 'No matching jobs found.' : 'No graphics jobs yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {filteredJobs.map(job => {
            const isExpanded = expandedJobId === job.id;
            const isEditing = editingJob?.id === job.id;
            const editJob = isEditing ? editingJob : job;
            const statusColor = GRAPHICS_STATUS_COLORS[job.status];

            return (
              <div key={job.id} style={{
                borderRadius: '12px', overflow: 'hidden',
                border: `1px solid ${isExpanded ? `${statusColor}44` : 'var(--border)'}`,
                background: 'var(--subtle-bg)',
              }}>
                {/* Job card header */}
                <div
                  onClick={() => {
                    if (isExpanded) {
                      setExpandedJobId(null);
                      setEditingJob(null);
                    } else {
                      setExpandedJobId(job.id);
                      loadHistory(job.id);
                      loadJobAssignments(job.id);
                      loadJobFiles(job.id);
                      recordJobView(job.id);
                    }
                  }}
                  style={{ padding: '12px', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                        {job.priority !== 'normal' && (
                          <span style={{ fontSize: '9px', fontWeight: 800, color: priorityColor(job.priority), textTransform: 'uppercase', padding: '1px 5px', borderRadius: '3px', background: `${priorityColor(job.priority)}15`, border: `1px solid ${priorityColor(job.priority)}33` }}>
                            {job.priority}
                          </span>
                        )}
                        <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {job.title}
                        </div>
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {(job.job_category && job.job_category !== 'production') && (
                          <span style={{
                            padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                            background: `${GRAPHICS_CATEGORY_COLORS[job.job_category]}18`,
                            border: `1px solid ${GRAPHICS_CATEGORY_COLORS[job.job_category]}44`,
                            color: GRAPHICS_CATEGORY_COLORS[job.job_category],
                            textTransform: 'uppercase', letterSpacing: '0.3px',
                          }}>
                            {GRAPHICS_CATEGORY_LABELS[job.job_category]}
                          </span>
                        )}
                        {job.customer && <span>{job.customer}</span>}
                        {job.part_number && job.part_number.split(',').map((pn, i) => {
                          const trimmed = pn.trim();
                          if (!trimmed) return null;
                          return (
                            <span key={i} style={{ background: 'rgba(59,130,246,0.08)', padding: '0 4px', borderRadius: '3px' }}>
                              <PartLabel partNumber={trimmed} />
                            </span>
                          );
                        })}
                        <span>Qty: {job.quantity}</span>
                        {job.due_date && <span style={{ color: (parseLocalDate(job.due_date) || new Date()) < new Date() ? '#ef4444' : '#fbbf24' }}>Due: {displayDate(job.due_date)}</span>}
                        {job.scheduled_install_date && <span style={{ color: job.scheduled_install_date === 'N/A' ? 'var(--text-muted)' : '#22d3ee' }}>Install: {job.scheduled_install_date === 'N/A' ? 'N/A' : displayDate(job.scheduled_install_date)}</span>}
                        {job.po_number && <span style={{ color: '#a78bfa', fontWeight: 700 }}>PO #{job.po_number}</span>}
                        {job.estimate_id && <span style={{ padding: '0 4px', borderRadius: '3px', background: 'rgba(96,165,250,0.1)', color: '#60a5fa', fontWeight: 700 }}>Estimate</span>}
                        {job.upfit_project_id && upfitProjects[job.upfit_project_id] && (
                          <span style={{ padding: '0 4px', borderRadius: '3px', background: 'rgba(249,115,22,0.12)', color: '#f97316', fontWeight: 700 }} title={upfitProjects[job.upfit_project_id].project_name}>
                            Upfit
                          </span>
                        )}
                        {job.netsuite_invoice_number && <span style={{ padding: '0 4px', borderRadius: '3px', background: 'rgba(34,197,94,0.1)', color: '#22c55e', fontWeight: 700 }}>INV {job.netsuite_invoice_number}</span>}
                        {(() => {
                          const others = (jobViews[job.id] || []).filter(v => v.user_id !== user?.id);
                          if (others.length === 0) return null;
                          const names = others.map(v => {
                            const p = profiles.find(pr => pr.id === v.user_id);
                            return p?.full_name || p?.email || 'Unknown';
                          });
                          const tooltip = others
                            .map((v, i) => `${names[i]} — ${relativeTime(v.last_viewed_at)}`)
                            .join('\n');
                          return (
                            <span
                              title={`Seen by:\n${tooltip}`}
                              style={{ padding: '0 4px', borderRadius: '3px', background: 'rgba(148,163,184,0.12)', color: 'var(--text-muted)', fontWeight: 700 }}
                            >
                              👁 {others.length}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                    <div style={{
                      padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                      background: `${statusColor}18`, border: `1px solid ${statusColor}44`,
                      color: statusColor, whiteSpace: 'nowrap', flexShrink: 0,
                    }}>
                      {GRAPHICS_STATUS_LABELS[job.status]}
                    </div>
                  </div>
                </div>

                {/* Internal notes preview (always visible) */}
                {job.notes && (
                  <div style={{ padding: '0 12px 8px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    <span style={{ fontWeight: 700, fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.3px', color: 'var(--warning)', marginRight: '4px' }}>Note:</span>
                    {job.notes.length > 120 ? job.notes.slice(0, 120) + '...' : job.notes}
                  </div>
                )}

                {/* Expanded view — rendered as a centered modal so deep
                    links don't open a card off-screen. Bounded height with
                    an inner scroll area so the edit form's sticky-bottom
                    Save bar can stick correctly. */}
                {isExpanded && (
                  <div
                    onClick={(e) => {
                      if (e.target === e.currentTarget) {
                        setExpandedJobId(null);
                        setEditingJob(null);
                      }
                    }}
                    style={{
                      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
                      zIndex: 500, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', padding: '24px 12px',
                    }}
                  >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: 'var(--card)', borderRadius: '14px',
                      border: `1px solid ${statusColor}44`,
                      boxShadow: '0 16px 60px rgba(0,0,0,0.3)',
                      width: '100%', maxWidth: '720px',
                      maxHeight: 'calc(100vh - 48px)',
                      display: 'flex', flexDirection: 'column',
                    }}
                  >
                    {/* Modal header — fixed at top via flex layout. */}
                    <div style={{
                      flexShrink: 0,
                      background: 'var(--card)',
                      borderRadius: '14px 14px 0 0',
                      borderBottom: '1px solid var(--border)',
                      padding: '12px 14px',
                      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                          {job.priority !== 'normal' && (
                            <span style={{ fontSize: '9px', fontWeight: 800, color: priorityColor(job.priority), textTransform: 'uppercase', padding: '1px 5px', borderRadius: '3px', background: `${priorityColor(job.priority)}15`, border: `1px solid ${priorityColor(job.priority)}33` }}>
                              {job.priority}
                            </span>
                          )}
                          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {job.title}
                          </div>
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                          {job.customer && <span>{job.customer}</span>}
                          <span>Qty: {job.quantity}</span>
                          {job.po_number && <span style={{ color: '#a78bfa', fontWeight: 700 }}>PO #{job.po_number}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <div style={{
                          padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: `${statusColor}18`, border: `1px solid ${statusColor}44`,
                          color: statusColor, whiteSpace: 'nowrap',
                        }}>
                          {GRAPHICS_STATUS_LABELS[job.status]}
                        </div>
                        <button
                          onClick={() => { setExpandedJobId(null); setEditingJob(null); }}
                          aria-label="Close"
                          style={{
                            background: 'transparent', border: '1px solid var(--border)',
                            color: 'var(--text-label)', cursor: 'pointer',
                            width: '28px', height: '28px', borderRadius: '6px',
                            fontSize: '14px', lineHeight: 1,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '12px 14px 16px' }}>

                    {/* Quick status change */}
                    <div style={{ marginTop: '10px', marginBottom: '12px' }}>
                      <div style={labelStyle}>Change Status</div>
                      <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginTop: '4px' }}>
                        {GRAPHICS_STATUS_ORDER.filter(s => s !== 'cancelled' && s !== 'flagged').map(s => (
                          <button
                            key={s}
                            onClick={() => promptStatusChange(job, s)}
                            disabled={job.status === s}
                            style={{
                              padding: '4px 8px', borderRadius: '5px', fontSize: '9px', fontWeight: 700,
                              background: job.status === s ? `${GRAPHICS_STATUS_COLORS[s]}33` : 'var(--bg)',
                              border: `1px solid ${job.status === s ? GRAPHICS_STATUS_COLORS[s] : 'var(--border)'}`,
                              color: job.status === s ? GRAPHICS_STATUS_COLORS[s] : 'var(--text-label)',
                              cursor: job.status === s ? 'default' : 'pointer',
                              opacity: job.status === s ? 1 : 0.7,
                            }}
                          >
                            {GRAPHICS_STATUS_LABELS[s].replace('Job ', '')}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Seen by — read receipts of who has opened this job. */}
                    {(() => {
                      const others = (jobViews[job.id] || []).filter(v => v.user_id !== user?.id);
                      if (others.length === 0) return null;
                      return (
                        <div style={{ marginBottom: '12px' }}>
                          <div style={labelStyle}>Seen By</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px' }}>
                            {others.map(v => {
                              const p = profiles.find(pr => pr.id === v.user_id);
                              const name = p?.full_name || p?.email || 'Unknown';
                              return (
                                <div key={v.id} style={{ fontSize: '11px', color: 'var(--text-body)', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                                  <span>
                                    {name}
                                    {v.view_count > 1 && (
                                      <span style={{ marginLeft: '6px', color: 'var(--text-muted)', fontSize: '10px' }}>
                                        ({v.view_count}×)
                                      </span>
                                    )}
                                  </span>
                                  <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                                    {relativeTime(v.last_viewed_at)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Parent context — surfaces customer + upfit project (when
                        linked via migration 084) so the production team has
                        the deal context without leaving the graphics page.
                        Hidden if there's no customer AND no upfit project. */}
                    {(() => {
                      const upfit = job.upfit_project_id ? upfitProjects[job.upfit_project_id] : null;
                      const cust = job.customer || upfit?.customer_name || null;
                      if (!cust && !upfit) return null;
                      return (
                        <div style={{
                          marginBottom: '12px', padding: '10px', borderRadius: '8px',
                          background: 'rgba(249,115,22,0.05)', border: '1px solid rgba(249,115,22,0.18)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              {cust && (
                                <div style={{ fontSize: '11px', marginBottom: upfit ? '4px' : 0 }}>
                                  <span style={{ color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', fontSize: '9px', letterSpacing: '0.4px', marginRight: '6px' }}>Customer</span>
                                  <span style={{ color: 'var(--text-body)', fontWeight: 600 }}>{cust}</span>
                                </div>
                              )}
                              {upfit && (
                                <div style={{ fontSize: '11px' }}>
                                  <span style={{ color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', fontSize: '9px', letterSpacing: '0.4px', marginRight: '6px' }}>Upfit Project</span>
                                  <span style={{ color: 'var(--text-body)', fontWeight: 600 }}>{upfit.project_name}</span>
                                  <span style={{
                                    marginLeft: '6px', padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                                    background: 'rgba(249,115,22,0.12)', color: '#f97316', textTransform: 'uppercase', letterSpacing: '0.3px',
                                  }}>{upfit.status.replace(/_/g, ' ')}</span>
                                </div>
                              )}
                            </div>
                            {upfit && (
                              <a
                                href={`/upfit?id=${upfit.id}`}
                                style={{
                                  flexShrink: 0, padding: '4px 10px', borderRadius: '6px',
                                  fontSize: '11px', fontWeight: 700, color: '#f97316',
                                  background: 'rgba(249,115,22,0.10)', border: '1px solid rgba(249,115,22,0.35)',
                                  textDecoration: 'none', whiteSpace: 'nowrap',
                                }}
                              >Open ↗</a>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Toggle edit mode */}
                    {!isEditing ? (
                      <div>
                        {/* Job details read-only */}
                        {job.content && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Content / Special Instructions</div>
                            <div style={{ fontSize: '12px', color: 'var(--text-body)', padding: '8px', borderRadius: '6px', background: 'var(--bg)', whiteSpace: 'pre-wrap' }}>{job.content}</div>
                          </div>
                        )}

                        {/* Vinyl specs */}
                        {(job.vinyl_type || job.vinyl_color || job.laminate || job.print_method || job.cut_method || job.premask) && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Vinyl Specifications</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', marginTop: '4px' }}>
                              {job.vinyl_type && <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'var(--bg)', fontSize: '10px' }}><span style={{ color: 'var(--text-label)' }}>Type:</span> <span style={{ color: 'var(--text-body)' }}>{job.vinyl_type}</span></div>}
                              {job.vinyl_color && <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'var(--bg)', fontSize: '10px' }}><span style={{ color: 'var(--text-label)' }}>Color:</span> <span style={{ color: 'var(--text-body)' }}>{job.vinyl_color}</span></div>}
                              {job.laminate && <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'var(--bg)', fontSize: '10px' }}><span style={{ color: 'var(--text-label)' }}>Lam:</span> <span style={{ color: 'var(--text-body)' }}>{job.laminate}</span></div>}
                              {job.print_method && <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'var(--bg)', fontSize: '10px' }}><span style={{ color: 'var(--text-label)' }}>Print:</span> <span style={{ color: 'var(--text-body)' }}>{job.print_method}</span></div>}
                              {job.cut_method && <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'var(--bg)', fontSize: '10px' }}><span style={{ color: 'var(--text-label)' }}>Cut:</span> <span style={{ color: 'var(--text-body)' }}>{job.cut_method}</span></div>}
                              {job.premask && <div style={{ padding: '4px 6px', borderRadius: '4px', background: 'var(--bg)', fontSize: '10px' }}><span style={{ color: 'var(--text-label)' }}>Premask:</span> <span style={{ color: 'var(--text-body)' }}>{job.premask}</span></div>}
                            </div>
                          </div>
                        )}

                        {/* Tracking */}
                        {(job.tracking_number || job.carrier || job.ship_to) && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Shipping</div>
                            <div style={{ fontSize: '11px' }}>
                              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                {job.carrier && <span style={{ color: 'var(--text-body)' }}>{job.carrier}</span>}
                                {job.tracking_number && <span style={{ color: '#60a5fa', fontWeight: 700 }}>{job.tracking_number}</span>}
                              </div>
                              {job.ship_to && (
                                <div style={{ color: 'var(--text-label)', whiteSpace: 'pre-wrap', marginTop: '4px', padding: '4px 6px', borderRadius: '4px', background: 'var(--bg)', lineHeight: 1.4 }}>
                                  {job.ship_to}
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {job.notes && (
                          <div style={{ marginBottom: '10px' }}>
                            <div style={labelStyle}>Notes</div>
                            <div style={{ fontSize: '11px', color: 'var(--text-body)', whiteSpace: 'pre-wrap' }}>{job.notes}</div>
                          </div>
                        )}

                        {/* Dates & Metadata */}
                        <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
                          <span>Created: {new Date(job.created_at).toLocaleDateString()}</span>
                          {job.due_date && <span style={{ color: (parseLocalDate(job.due_date) || new Date()) < new Date() ? '#ef4444' : '#fbbf24' }}>Due: {displayDate(job.due_date)}</span>}
                          {job.scheduled_install_date && <span style={{ color: job.scheduled_install_date === 'N/A' ? 'var(--text-muted)' : '#22d3ee' }}>Install: {job.scheduled_install_date === 'N/A' ? 'N/A' : displayDate(job.scheduled_install_date)}{job.calendar_event_id ? '' : ''}</span>}
                          {getProfileName(job.assigned_to) && <span>Assigned: {getProfileName(job.assigned_to)}</span>}
                          {getProfileName(job.created_by) && <span>By: {getProfileName(job.created_by)}</span>}
                          {job.job_number && <span style={{ color: 'var(--text-muted)' }}>#{job.job_number}</span>}
                        </div>

                        {/* Activity / Status history + Notes */}
                        <div style={{ marginBottom: '10px' }}>
                          <div style={labelStyle}>Activity</div>
                          {statusHistory.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                              {statusHistory.map(h => {
                                const isNote = h.from_status === h.to_status && h.note;
                                return (
                                  <div key={h.id} style={{ fontSize: '10px', color: 'var(--text-label)', padding: '4px 6px', borderRadius: '6px', background: isNote ? 'rgba(245,158,11,0.06)' : 'transparent' }}>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{new Date(h.created_at).toLocaleString()}</span>
                                      {!isNote && h.from_status && (
                                        <span><span style={{ color: GRAPHICS_STATUS_COLORS[h.from_status as GraphicsJobStatus] || 'var(--text-body)' }}>{GRAPHICS_STATUS_LABELS[h.from_status as GraphicsJobStatus] || h.from_status}</span> →</span>
                                      )}
                                      {!isNote && (
                                        <span style={{ color: GRAPHICS_STATUS_COLORS[h.to_status as GraphicsJobStatus] || 'var(--text-body)', fontWeight: 700 }}>{GRAPHICS_STATUS_LABELS[h.to_status as GraphicsJobStatus] || h.to_status}</span>
                                      )}
                                      {getProfileName(h.changed_by) && <span style={{ color: 'var(--text-muted)' }}>— {getProfileName(h.changed_by)}</span>}
                                    </div>
                                    {h.note && (
                                      <div style={{ marginTop: '2px', fontSize: '11px', color: 'var(--text-body)', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
                                        {h.note}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {/* Add note */}
                          <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                            <input
                              value={newNote}
                              onChange={e => setNewNote(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter' && newNote.trim()) addNote(job.id); }}
                              placeholder="Add a note..."
                              style={{
                                flex: 1, padding: '6px 10px', borderRadius: '6px', fontSize: '11px',
                                background: 'var(--input-bg)', border: '1px solid var(--border)',
                                color: 'var(--text-primary)', outline: 'none',
                              }}
                            />
                            <button
                              onClick={() => addNote(job.id)}
                              disabled={!newNote.trim()}
                              style={{
                                padding: '6px 12px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                background: newNote.trim() ? 'rgba(59,130,246,0.15)' : 'var(--subtle-bg)',
                                border: '1px solid ' + (newNote.trim() ? 'rgba(59,130,246,0.3)' : 'var(--border)'),
                                color: newNote.trim() ? '#60a5fa' : 'var(--text-muted)',
                                cursor: newNote.trim() ? 'pointer' : 'default',
                              }}
                            >
                              Post
                            </button>
                          </div>
                        </div>

                        {/* Customer approval */}
                        <div style={{ marginBottom: '10px', padding: '8px 10px', borderRadius: '8px', background: (job as any).customer_approved ? 'rgba(34,197,94,0.1)' : 'var(--subtle-bg)', border: '1px solid ' + ((job as any).customer_approved ? 'rgba(34,197,94,0.3)' : 'var(--border)') }}>
                          <div style={{ ...labelStyle, marginBottom: '6px' }}>Customer Approval</div>
                          {(job as any).customer_approved ? (
                            <div style={{ fontSize: '11px', color: '#22c55e', fontWeight: 700 }}>
                              ✓ Approved {(job as any).customer_approved_at ? ` · ${new Date((job as any).customer_approved_at).toLocaleString()}` : ''}
                            </div>
                          ) : (job as any).customer_rejected_at ? (
                            <div>
                              <div style={{ fontSize: '11px', color: '#ef4444', fontWeight: 700, marginBottom: '4px' }}>Changes requested</div>
                              {(job as any).customer_rejection_reason && (
                                <div style={{ fontSize: '11px', color: 'var(--text-body)', fontStyle: 'italic' }}>{(job as any).customer_rejection_reason}</div>
                              )}
                              {approvalPickerJobId !== job.id && (
                                <button
                                  onClick={() => openApprovalPicker(job.id)}
                                  disabled={sendingApprovalId === job.id}
                                  style={{
                                    marginTop: '6px', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                    background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)',
                                    color: '#60a5fa', cursor: 'pointer',
                                  }}
                                >Resend for approval</button>
                              )}
                            </div>
                          ) : (
                            <div>
                              {(job as any).sent_for_approval_at && (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                                  Sent for approval {new Date((job as any).sent_for_approval_at).toLocaleString()}
                                </div>
                              )}
                              {approvalPickerJobId !== job.id && (
                                <button
                                  onClick={() => openApprovalPicker(job.id)}
                                  disabled={sendingApprovalId === job.id}
                                  style={{
                                    padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                    background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)',
                                    color: '#60a5fa', cursor: 'pointer',
                                  }}
                                >{(job as any).sent_for_approval_at ? 'Resend approval link' : 'Send proof for customer approval'}</button>
                              )}
                            </div>
                          )}

                          {/* File picker — opens when user clicks Send / Resend. Shows the
                              job's attached files with radio buttons; only the chosen file
                              is sent to the customer. */}
                          {approvalPickerJobId === job.id && (
                            <div style={{
                              marginTop: '8px', padding: '10px', borderRadius: '8px',
                              background: 'var(--card)', border: '1px solid var(--border)',
                            }}>
                              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                                Pick the proof to send
                              </div>
                              {(jobFiles[job.id] || []).length === 0 ? (
                                <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>
                                  No files attached to this job. Upload a proof first.
                                </div>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                  {(jobFiles[job.id] || []).map(f => (
                                    <label key={f.id} style={{
                                      display: 'flex', alignItems: 'center', gap: '8px',
                                      padding: '6px 8px', borderRadius: '6px',
                                      background: approvalPickerFileId === f.id ? 'rgba(59,130,246,0.1)' : 'var(--subtle-bg)',
                                      border: '1px solid ' + (approvalPickerFileId === f.id ? 'rgba(59,130,246,0.3)' : 'var(--border)'),
                                      cursor: 'pointer',
                                    }}>
                                      <input
                                        type="radio"
                                        name={`approval-file-${job.id}`}
                                        checked={approvalPickerFileId === f.id}
                                        onChange={() => setApprovalPickerFileId(f.id)}
                                      />
                                      <span style={{ fontSize: '12px', color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {f.file_name}
                                      </span>
                                      {f.file_type && (
                                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{f.file_type.split('/')[1] || f.file_type}</span>
                                      )}
                                    </label>
                                  ))}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                                <button
                                  onClick={() => confirmSendForApproval(job.id)}
                                  disabled={!approvalPickerFileId || sendingApprovalId === job.id}
                                  style={{
                                    flex: 1, padding: '8px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
                                    background: approvalPickerFileId ? '#22c55e' : 'var(--border)',
                                    border: 'none', color: '#fff',
                                    cursor: approvalPickerFileId && sendingApprovalId !== job.id ? 'pointer' : 'not-allowed',
                                    opacity: approvalPickerFileId && sendingApprovalId !== job.id ? 1 : 0.5,
                                  }}
                                >{sendingApprovalId === job.id ? 'Sending…' : 'Send to customer'}</button>
                                <button
                                  onClick={closeApprovalPicker}
                                  disabled={sendingApprovalId === job.id}
                                  style={{
                                    padding: '8px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
                                    background: 'transparent', border: '1px solid var(--border)',
                                    color: 'var(--text-muted)', cursor: 'pointer',
                                  }}
                                >Cancel</button>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Files */}
                        <div style={{ marginBottom: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                            <div style={labelStyle}>Files &amp; Attachments</div>
                            {(jobFiles[job.id] || []).length > 1 && (
                              <a
                                href={`/api/graphics-jobs/${job.id}/download-all`}
                                style={{
                                  padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                  background: 'rgba(96,165,250,0.12)',
                                  border: '1px solid rgba(96,165,250,0.3)',
                                  color: '#60a5fa', textDecoration: 'none',
                                }}
                              >⬇ Download all ({(jobFiles[job.id] || []).length})</a>
                            )}
                          </div>
                          {(jobFiles[job.id] || []).length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
                              {(jobFiles[job.id] || []).map(f => {
                                const isImage = f.file_type?.startsWith('image/');
                                const isPdf = f.file_type === 'application/pdf';
                                return (
                                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', background: 'var(--subtle-bg)' }}>
                                    <span style={{ fontSize: '14px', flexShrink: 0 }}>{isImage ? '\ud83d\uddbc\ufe0f' : isPdf ? '\ud83d\udcc4' : '\ud83d\udcce'}</span>
                                    <a
                                      href={getFileUrl(f.storage_path)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ flex: 1, fontSize: '11px', fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    >
                                      {f.file_name}
                                    </a>
                                    {f.file_size && <span style={{ fontSize: '9px', color: 'var(--text-muted)', flexShrink: 0 }}>{formatFileSize(f.file_size)}</span>}
                                    <button
                                      onClick={() => deleteJobFile(f)}
                                      style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '10px', fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}
                                    >
                                      ✕
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {(jobPoFiles[job.id] || []).length > 0 && (
                            <div style={{ marginBottom: '6px' }}>
                              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>From linked PO</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {jobPoFiles[job.id].map(f => (
                                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', background: 'rgba(96,165,250,0.06)', border: '1px dashed rgba(96,165,250,0.3)' }}>
                                    <span style={{ fontSize: '14px', flexShrink: 0 }}>{'📄'}</span>
                                    <a
                                      href={getFileUrl(f.storage_path)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ flex: 1, fontSize: '11px', fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    >
                                      {f.file_name}
                                    </a>
                                    {f.file_size && <span style={{ fontSize: '9px', color: 'var(--text-muted)', flexShrink: 0 }}>{formatFileSize(f.file_size)}</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            onChange={async (e) => {
                              const files = Array.from(e.target.files || []) as File[];
                              if (files.length > 0) await uploadFilesToJob(job.id, files);
                              e.target.value = '';
                            }}
                            style={{ display: 'none' }}
                          />
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploadingFiles}
                            style={{
                              width: '100%', padding: '8px', borderRadius: '8px',
                              fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                              background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                              color: uploadingFiles ? 'var(--text-muted)' : 'var(--text-secondary)',
                            }}
                          >
                            {uploadingFiles ? 'Uploading...' : '+ Upload Files (proofs, logos, photos)'}
                          </button>

                          {/* Dropbox proof search — pre-fills with customer
                              so users can find existing artwork without
                              hand-walking the Dropbox folder tree. */}
                          <div style={{ marginTop: '8px' }}>
                            <DropboxProofSearch
                              defaultQuery={job.customer || job.part_number || ''}
                            />
                          </div>
                        </div>

                        {/* Team Assignment */}
                        <div style={{ marginBottom: '10px' }}>
                          <AssignmentPicker
                            jobType="graphics_job"
                            jobId={job.id}
                            selectedIds={jobAssignments[job.id] || []}
                            onChange={(ids) => saveJobAssignments(job.id, ids, job.title)}
                            roles={['graphics_production', 'production', 'admin', 'field_tech', 'shop_tech']}
                            label="Assigned Team"
                            compact
                          />
                        </div>

                        {/* Estimate & Invoice */}
                        <div style={{ marginBottom: '10px' }}>
                          <div style={labelStyle}>Estimate & Invoice</div>

                          {/* Show linked estimate */}
                          {job.estimate_id && (
                            <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.15)', marginBottom: '6px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ fontSize: '11px', color: '#60a5fa', fontWeight: 700 }}>Estimate Linked</div>
                                <button
                                  onClick={() => router.push('/estimates')}
                                  style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: '5px', padding: '3px 8px', cursor: 'pointer' }}
                                >
                                  Open Estimates
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Show invoice info if invoiced */}
                          {job.netsuite_invoice_id && (
                            <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)', marginBottom: '6px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                                <div>
                                  <a
                                    href={`https://system.netsuite.com/app/accounting/transactions/custinvc.nl?id=${job.netsuite_invoice_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ fontSize: '11px', color: '#22c55e', fontWeight: 700, textDecoration: 'none' }}
                                  >
                                    Invoice #{job.netsuite_invoice_number || job.netsuite_invoice_id} ↗
                                  </a>
                                  <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '2px' }}>
                                    {job.invoice_amount ? `$${job.invoice_amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''}
                                    {job.invoiced_at ? ` — ${new Date(job.invoiced_at).toLocaleDateString()}` : ''}
                                    {job.po_number ? ` — PO #${job.po_number}` : ''}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                                  {job.invoice_pdf_url ? (
                                    <a
                                      href={job.invoice_pdf_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', color: '#60a5fa', whiteSpace: 'nowrap', textDecoration: 'none' }}
                                    >
                                      View Invoice PDF ↗
                                    </a>
                                  ) : (
                                    <button
                                      onClick={() => storeInvoicePdf(job.id)}
                                      disabled={fetchingPdfJobId === job.id}
                                      style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: fetchingPdfJobId === job.id ? 'default' : 'pointer', background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', color: '#60a5fa', whiteSpace: 'nowrap', opacity: fetchingPdfJobId === job.id ? 0.5 : 1 }}
                                    >
                                      {fetchingPdfJobId === job.id ? 'Getting…' : 'Get Invoice PDF'}
                                    </button>
                                  )}
                                  <button
                                    onClick={() => printPackingList(job)}
                                    style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', whiteSpace: 'nowrap' }}
                                  >
                                    Print Packing List
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* PO number display */}
                          {job.po_number && !job.netsuite_invoice_id && (
                            <div style={{ fontSize: '11px', color: '#a78bfa', marginBottom: '6px', padding: '4px 8px', borderRadius: '6px', background: 'rgba(167,139,250,0.06)' }}>
                              PO #{job.po_number} — ready to invoice when job completes
                            </div>
                          )}

                          {/* Action buttons for estimate/invoice */}
                          {job.status !== 'cancelled' && (
                            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                              {!job.estimate_id && (
                                <button
                                  onClick={() => createEstimateFromJob(job)}
                                  disabled={creatingEstimate}
                                  style={{
                                    flex: 1, padding: '8px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                                    background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)', color: '#60a5fa',
                                    opacity: creatingEstimate ? 0.5 : 1,
                                  }}
                                >
                                  {creatingEstimate ? 'Creating...' : 'Create Estimate'}
                                </button>
                              )}
                              {!job.netsuite_invoice_id && (
                                <button
                                  onClick={() => setInvoiceJob(job)}
                                  style={{
                                    flex: 1, padding: '8px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                                    background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e',
                                  }}
                                >
                                  Review &amp; Invoice
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            onClick={() => { setEditingJob({ ...job }); loadJobAssignments(job.id); }}
                            style={{ flex: 1, padding: '10px', borderRadius: '8px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                          >
                            Edit Job
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() => deleteJob(job.id)}
                              style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                            >
                              Delete
                            </button>
                          )}
                          {job.status !== 'cancelled' && (
                            <button
                              onClick={() => promptStatusChange(job, 'cancelled')}
                              style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(107,114,128,0.08)', border: '1px solid rgba(107,114,128,0.2)', color: '#6b7280', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      /* Edit mode */
                      <div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                          <div style={{ gridColumn: '1 / -1' }}>
                            <div style={labelStyle}>Title</div>
                            <input style={inputStyle} value={editJob!.title} onChange={e => setEditingJob({ ...editJob!, title: e.target.value })} />
                          </div>
                          <div style={{ gridColumn: '1 / -1' }}>
                            <div style={labelStyle}>Part Number(s) — PO Line Items</div>
                            {(() => {
                              const parts = (editJob!.part_number || '').split(',').map(s => s.trim()).filter(Boolean);
                              return (
                                <>
                                  {parts.length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '4px' }}>
                                      {parts.map((pn, i) => (
                                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.2)' }}>
                                          {pn}
                                          <span onClick={() => setEditingJob({ ...editJob!, part_number: parts.filter((_, j) => j !== i).join(', ') || null })} style={{ cursor: 'pointer', fontSize: '14px', marginLeft: '2px' }}>&times;</span>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  <input style={inputStyle} placeholder="Type each part # and press Enter to add (supports multiple PO lines)"
                                    onKeyDown={e => {
                                      const val = (e.target as HTMLInputElement).value.trim();
                                      if ((e.key === 'Enter' || e.key === ',') && val) {
                                        e.preventDefault();
                                        const newParts = [...parts, val].join(', ');
                                        setEditingJob({ ...editJob!, part_number: newParts });
                                        (e.target as HTMLInputElement).value = '';
                                      }
                                    }}
                                  />
                                </>
                              );
                            })()}
                          </div>
                          <div>
                            <div style={labelStyle}>Customer</div>
                            <input style={inputStyle} value={editJob!.customer || ''} onChange={e => setEditingJob({ ...editJob!, customer: e.target.value })} />
                          </div>
                          <div>
                            <div style={labelStyle}>Quantity</div>
                            <input type="number" style={inputStyle} value={editJob!.quantity} onChange={e => setEditingJob({ ...editJob!, quantity: parseInt(e.target.value) || 1 })} />
                          </div>
                          <div>
                            <div style={labelStyle}>PO Number</div>
                            <input style={inputStyle} value={editJob!.po_number || ''} onChange={e => setEditingJob({ ...editJob!, po_number: e.target.value || null })} placeholder="e.g. PO-12345" />
                          </div>
                          <div>
                            <div style={labelStyle}>Priority</div>
                            <select style={inputStyle} value={editJob!.priority} onChange={e => setEditingJob({ ...editJob!, priority: e.target.value as any })}>
                              <option value="low">Low</option>
                              <option value="normal">Normal</option>
                              <option value="high">High</option>
                              <option value="rush">Rush</option>
                            </select>
                          </div>
                          <div>
                            <div style={labelStyle}>Due Date</div>
                            <input type="date" style={inputStyle} value={toDateInputValue(editJob!.due_date)} onChange={e => setEditingJob({ ...editJob!, due_date: e.target.value })} />
                          </div>
                          <div>
                            <div style={labelStyle}>Scheduled Install Date</div>
                            {editJob!.scheduled_install_date === 'N/A' ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>N/A</div>
                                <button type="button" onClick={() => setEditingJob({ ...editJob!, scheduled_install_date: '' })} style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>Set Date</button>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <input type="date" style={{ ...inputStyle, flex: 1 }} value={toDateInputValue(editJob!.scheduled_install_date)} onChange={e => setEditingJob({ ...editJob!, scheduled_install_date: e.target.value })} />
                                <button type="button" onClick={() => setEditingJob({ ...editJob!, scheduled_install_date: 'N/A' })} style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>N/A</button>
                              </div>
                            )}
                            {editJob!.calendar_event_id && <div style={{ fontSize: '9px', color: '#22d3ee', marginTop: '2px' }}>Synced to Google Calendar</div>}
                          </div>
                          <div style={{ gridColumn: '1 / -1' }}>
                            <AssignmentPicker
                              jobType="graphics_job"
                              jobId={editJob!.id}
                              selectedIds={jobAssignments[editJob!.id] || []}
                              onChange={(ids) => saveJobAssignments(editJob!.id, ids, editJob!.title)}
                              roles={['graphics_production', 'production', 'admin', 'field_tech', 'shop_tech']}
                              label="Assigned Team (select one or more)"
                            />
                          </div>
                        </div>

                        <div style={{ marginBottom: '10px' }}>
                          <div style={labelStyle}>Content / Special Instructions (unit numbers, addresses, etc.)</div>
                          <textarea
                            style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
                            value={editJob!.content || ''}
                            onChange={e => setEditingJob({ ...editJob!, content: e.target.value })}
                            placeholder="Unit numbers, addresses, or other unit-specific details..."
                          />
                        </div>

                        <div style={labelStyle}>Vinyl Specifications</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Vinyl Type</div>
                            <input style={inputStyle} value={editJob!.vinyl_type || ''} onChange={e => setEditingJob({ ...editJob!, vinyl_type: e.target.value })} placeholder="e.g. 3M IJ180Cv3" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Color</div>
                            <input style={inputStyle} value={editJob!.vinyl_color || ''} onChange={e => setEditingJob({ ...editJob!, vinyl_color: e.target.value })} placeholder="e.g. White" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Laminate</div>
                            <select style={inputStyle} value={editJob!.laminate || ''} onChange={e => setEditingJob({ ...editJob!, laminate: e.target.value })}>
                              <option value="">Select...</option>
                              <option value="N/A">N/A</option>
                              <option value="8428G">8428G</option>
                              <option value="8418">8418</option>
                              <option value="8508">8508</option>
                              <option value="Other">Other</option>
                            </select>
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Print</div>
                            <input style={inputStyle} value={editJob!.print_method || ''} onChange={e => setEditingJob({ ...editJob!, print_method: e.target.value })} placeholder="e.g. Solvent" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Cut</div>
                            <input style={inputStyle} value={editJob!.cut_method || ''} onChange={e => setEditingJob({ ...editJob!, cut_method: e.target.value })} placeholder="e.g. Contour" />
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Premask</div>
                            <input style={inputStyle} value={editJob!.premask || ''} onChange={e => setEditingJob({ ...editJob!, premask: e.target.value })} placeholder="e.g. R-Tape 4075" />
                          </div>
                        </div>

                        <div style={labelStyle}>Shipping</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '6px' }}>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Carrier</div>
                            <select style={inputStyle} value={editJob!.carrier || ''} onChange={e => setEditingJob({ ...editJob!, carrier: e.target.value })}>
                              <option value="">—</option>
                              <option>UPS</option>
                              <option>FedEx</option>
                              <option>USPS</option>
                              <option>LTL</option>
                              <option>Hand Delivery</option>
                            </select>
                          </div>
                          <div>
                            <div style={{ ...labelStyle, fontSize: '8px' }}>Tracking #</div>
                            <input style={inputStyle} value={editJob!.tracking_number || ''} onChange={e => setEditingJob({ ...editJob!, tracking_number: e.target.value })} />
                          </div>
                        </div>
                        <div style={{ marginBottom: '10px' }}>
                          <div style={{ ...labelStyle, fontSize: '8px' }}>Ship To Address</div>
                          <textarea style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }} value={editJob!.ship_to || ''} onChange={e => setEditingJob({ ...editJob!, ship_to: e.target.value })}
                            placeholder={'Company Name\n123 Street Address\nCity, State ZIP'}
                          />
                        </div>

                        <div style={{ marginBottom: '10px' }}>
                          <div style={labelStyle}>Internal Notes</div>
                          <textarea
                            style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }}
                            value={editJob!.notes || ''}
                            onChange={e => setEditingJob({ ...editJob!, notes: e.target.value })}
                          />
                        </div>

                        <div style={{ marginBottom: '10px' }}>
                          <div style={labelStyle}>Files &amp; Attachments</div>
                          {(jobFiles[job.id] || []).length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
                              {(jobFiles[job.id] || []).map(f => {
                                const isImage = f.file_type?.startsWith('image/');
                                const isPdf = f.file_type === 'application/pdf';
                                return (
                                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', background: 'var(--subtle-bg)' }}>
                                    <span style={{ fontSize: '14px', flexShrink: 0 }}>{isImage ? '🖼️' : isPdf ? '📄' : '📎'}</span>
                                    <a href={getFileUrl(f.storage_path)} target="_blank" rel="noopener noreferrer" style={{ flex: 1, fontSize: '11px', fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {f.file_name}
                                    </a>
                                    {f.file_size && <span style={{ fontSize: '9px', color: 'var(--text-muted)', flexShrink: 0 }}>{formatFileSize(f.file_size)}</span>}
                                    <button onClick={() => deleteJobFile(f)} style={{ padding: '2px 6px', borderRadius: '4px', border: 'none', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '10px', fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>✕</button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <input
                            type="file"
                            multiple
                            id={`edit-files-${job.id}`}
                            onChange={async (e) => {
                              const files = Array.from(e.target.files || []) as File[];
                              if (files.length > 0) await uploadFilesToJob(job.id, files);
                              e.target.value = '';
                            }}
                            style={{ display: 'none' }}
                          />
                          <button
                            type="button"
                            onClick={() => document.getElementById(`edit-files-${job.id}`)?.click()}
                            disabled={uploadingFiles}
                            style={{ width: '100%', padding: '8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'var(--subtle-bg)', border: '1px dashed var(--border)', color: uploadingFiles ? 'var(--text-muted)' : 'var(--text-secondary)' }}
                          >
                            {uploadingFiles ? 'Uploading...' : '+ Upload Files (proofs, logos, photos)'}
                          </button>
                        </div>

                        <div style={{
                          position: 'sticky',
                          bottom: 'calc(env(safe-area-inset-bottom, 0px))',
                          display: 'flex',
                          gap: '6px',
                          padding: '10px',
                          marginLeft: '-14px',
                          marginRight: '-14px',
                          marginBottom: '-16px',
                          background: 'var(--card)',
                          borderTop: '1px solid var(--border)',
                          backdropFilter: 'blur(6px)',
                          zIndex: 5,
                        }}>
                          <button
                            onClick={saveJob}
                            disabled={saving}
                            style={{ flex: 1, padding: '12px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontSize: '13px', fontWeight: 800, border: 'none', cursor: 'pointer', opacity: saving ? 0.5 : 1, boxShadow: '0 4px 12px rgba(34,197,94,0.25)' }}
                          >
                            {saving ? 'Saving...' : 'Save Changes'}
                          </button>
                          <button
                            onClick={() => setEditingJob(null)}
                            style={{ padding: '12px 18px', borderRadius: '8px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ═══════════ CREATE JOB MODAL ═══════════ */}
      {showCreate && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: '0' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowCreate(false); setCreateStep('category'); } }}
        >
          <div style={{ background: 'var(--card)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '14px 14px 0 0', padding: '18px', paddingBottom: 'calc(18px + env(safe-area-inset-bottom, 0px))', maxWidth: '500px', width: '100%', maxHeight: '90vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>

            {/* ─── STEP 1: Choose Job Type ─── */}
            {createStep === 'category' && (
              <>
                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '6px' }}>New Job</div>
                <div style={{ fontSize: '12px', color: 'var(--text-label)', marginBottom: '16px' }}>What type of job is this?</div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
                  {([
                    { id: 'production' as const, title: 'Production', desc: 'Full production job — printing, cutting, packing, shipping, install' },
                    { id: 'customer_supplied' as const, title: 'Customer Supplied', desc: 'Graphics supplied by customer — track shipping, install date, and proof' },
                    { id: 'proofing' as const, title: 'Proofing', desc: 'Design and proof approval only — no production steps yet' },
                    { id: 'internal' as const, title: 'Internal Project', desc: 'Internal work like T-Mobile design, samples, or R&D' },
                  ]).map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => {
                        setCreateForm({ ...createForm, job_category: cat.id });
                        setCreateStep('details');
                      }}
                      style={{
                        padding: '16px', borderRadius: '12px', textAlign: 'left', cursor: 'pointer',
                        background: 'var(--bg)', border: `1px solid ${GRAPHICS_CATEGORY_COLORS[cat.id]}33`,
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = GRAPHICS_CATEGORY_COLORS[cat.id]; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = `${GRAPHICS_CATEGORY_COLORS[cat.id]}33`; }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '14px', fontWeight: 800, color: GRAPHICS_CATEGORY_COLORS[cat.id] }}>{cat.title}</span>
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-body)', lineHeight: 1.4 }}>{cat.desc}</div>
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => { setShowCreate(false); setCreateStep('category'); }}
                  style={{ width: '100%', padding: '10px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </>
            )}

            {/* ─── STEP 2: Job Details (conditional on category) ─── */}
            {createStep === 'details' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                  <button
                    onClick={() => setCreateStep('category')}
                    style={{ background: 'none', border: 'none', color: 'var(--text-label)', fontSize: '16px', cursor: 'pointer', padding: '0' }}
                  >
                    ←
                  </button>
                  <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-body)' }}>
                    New {GRAPHICS_CATEGORY_LABELS[createForm.job_category as GraphicsJobCategory]} Job
                  </div>
                  <span style={{
                    padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                    background: `${GRAPHICS_CATEGORY_COLORS[createForm.job_category as GraphicsJobCategory]}18`,
                    color: GRAPHICS_CATEGORY_COLORS[createForm.job_category as GraphicsJobCategory],
                  }}>
                    {GRAPHICS_CATEGORY_LABELS[createForm.job_category as GraphicsJobCategory]}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={labelStyle}>{createForm.job_category === 'internal' ? 'Project Name *' : 'Job Title *'}</div>
                    <input style={inputStyle} value={createForm.title} onChange={e => setCreateForm({ ...createForm, title: e.target.value })}
                      placeholder={createForm.job_category === 'internal' ? 'e.g. T-Mobile Spring Campaign' : createForm.job_category === 'proofing' ? 'e.g. PROOF - Fleet Graphics Redesign' : 'e.g. GRAPHIC KIT - FORD TRANSIT'}
                      onKeyDown={e => { if (e.key === 'Enter' && createForm.title.trim() && !creating) createJob(); }}
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={labelStyle}>Part Number(s) — PO Line Items</div>
                    {createForm.part_numbers.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '4px' }}>
                        {createForm.part_numbers.map((pn, i) => (
                          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.2)' }}>
                            {pn}
                            <span onClick={() => setCreateForm(f => ({ ...f, part_numbers: f.part_numbers.filter((_, j) => j !== i) }))} style={{ cursor: 'pointer', fontSize: '14px', marginLeft: '2px' }}>&times;</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <input style={inputStyle} value={createForm.partInput} onChange={e => setCreateForm({ ...createForm, partInput: e.target.value })}
                      placeholder="Type each part # and press Enter to add (supports multiple PO lines)"
                      onKeyDown={e => {
                        if ((e.key === 'Enter' || e.key === ',') && createForm.partInput.trim()) {
                          e.preventDefault();
                          setCreateForm(f => ({ ...f, part_numbers: [...f.part_numbers, f.partInput.trim()], partInput: '' }));
                        }
                      }}
                    />
                  </div>
                  <div style={{ position: 'relative' }}>
                    <div style={labelStyle}>{createForm.job_category === 'internal' ? 'Department / Requestor' : 'Customer'}</div>
                    <input style={inputStyle} value={createForm.customer}
                      onChange={e => createForm.job_category !== 'internal' ? searchCustomers(e.target.value) : setCreateForm({ ...createForm, customer: e.target.value })}
                      placeholder={createForm.job_category === 'internal' ? 'e.g. Marketing' : 'Start typing to search...'}
                    />
                    {customerResults.length > 0 && createForm.job_category !== 'internal' && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', maxHeight: '150px', overflowY: 'auto', marginTop: '2px' }}>
                        {customerResults.map(c => (
                          <button key={c.company_name} onClick={() => selectCustomer(c.company_name)} style={{ width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none', background: 'transparent', color: 'var(--text-body)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                            {c.company_name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={labelStyle}>Quantity</div>
                    <input type="number" style={inputStyle} value={createForm.quantity} onChange={e => setCreateForm({ ...createForm, quantity: parseInt(e.target.value) || 1 })} />
                  </div>
                  <div>
                    <div style={labelStyle}>PO Number</div>
                    <input style={inputStyle} value={createForm.po_number} onChange={e => setCreateForm({ ...createForm, po_number: e.target.value })} placeholder="e.g. PO-12345" />
                  </div>
                  <div>
                    <div style={labelStyle}>Priority</div>
                    <select style={inputStyle} value={createForm.priority} onChange={e => setCreateForm({ ...createForm, priority: e.target.value as any })}>
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="rush">Rush</option>
                    </select>
                  </div>
                  <div>
                    <div style={labelStyle}>Due Date</div>
                    <input type="date" style={inputStyle} value={createForm.due_date} onChange={e => setCreateForm({ ...createForm, due_date: e.target.value })} />
                  </div>
                  {/* Production, Proofing & Customer Supplied get install date */}
                  {createForm.job_category !== 'internal' && (
                    <div>
                      <div style={labelStyle}>Scheduled Install Date</div>
                      {createForm.scheduled_install_date === 'N/A' ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>N/A</div>
                          <button type="button" onClick={() => setCreateForm({ ...createForm, scheduled_install_date: '' })} style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>Set Date</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <input type="date" style={{ ...inputStyle, flex: 1 }} value={createForm.scheduled_install_date} onChange={e => setCreateForm({ ...createForm, scheduled_install_date: e.target.value })} />
                          <button type="button" onClick={() => setCreateForm({ ...createForm, scheduled_install_date: 'N/A' })} style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>N/A</button>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Production & Customer Supplied get ship-to */}
                  {(createForm.job_category === 'production' || createForm.job_category === 'customer_supplied') && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div style={labelStyle}>Ship To Address</div>
                      <textarea style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }} value={createForm.ship_to} onChange={e => setCreateForm({ ...createForm, ship_to: e.target.value })}
                        placeholder={'Company Name\n123 Street Address\nCity, State ZIP'}
                      />
                    </div>
                  )}
                </div>

                <div style={{ marginBottom: '10px' }}>
                  <div style={labelStyle}>{createForm.job_category === 'proofing' ? 'Design Brief / Instructions' : 'Content / Special Instructions'}</div>
                  <textarea
                    style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
                    value={createForm.content}
                    onChange={e => setCreateForm({ ...createForm, content: e.target.value })}
                    placeholder={createForm.job_category === 'proofing' ? 'Describe what needs to be designed or proofed...' : 'Unit numbers, addresses, custom text per unit...'}
                  />
                </div>

                {/* Vinyl specs — production only */}
                {createForm.job_category === 'production' && (
                  <>
                    <div style={labelStyle}>Vinyl Specifications</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
                      <div>
                        <div style={{ ...labelStyle, fontSize: '8px' }}>Vinyl Type</div>
                        <select style={inputStyle} value={createForm.vinyl_type} onChange={e => setCreateForm({ ...createForm, vinyl_type: e.target.value })}>
                          <option value="">Select...</option>
                          <option value="IJ280 CV4">IJ280 CV4</option>
                          <option value="IJ175 CV3">IJ175 CV3</option>
                          <option value="IJ40C">IJ40C</option>
                          <option value="IJ780CR">IJ780CR</option>
                          <option value="IJ680CR">IJ680CR</option>
                          <option value="Banner">Banner</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div>
                        <div style={{ ...labelStyle, fontSize: '8px' }}>Color</div>
                        <input style={inputStyle} value={createForm.vinyl_color} onChange={e => setCreateForm({ ...createForm, vinyl_color: e.target.value })} placeholder="e.g. White" />
                      </div>
                      <div>
                        <div style={{ ...labelStyle, fontSize: '8px' }}>Laminate</div>
                        <select style={inputStyle} value={createForm.laminate} onChange={e => setCreateForm({ ...createForm, laminate: e.target.value })}>
                          <option value="">Select...</option>
                          <option value="N/A">N/A</option>
                          <option value="8428G">8428G</option>
                          <option value="8418">8418</option>
                          <option value="8508">8508</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div>
                        <div style={{ ...labelStyle, fontSize: '8px' }}>Print</div>
                        <input style={inputStyle} value={createForm.print_method} onChange={e => setCreateForm({ ...createForm, print_method: e.target.value })} placeholder="e.g. Solvent" />
                      </div>
                      <div>
                        <div style={{ ...labelStyle, fontSize: '8px' }}>Cut</div>
                        <input style={inputStyle} value={createForm.cut_method} onChange={e => setCreateForm({ ...createForm, cut_method: e.target.value })} placeholder="e.g. Contour" />
                      </div>
                      <div>
                        <div style={{ ...labelStyle, fontSize: '8px' }}>Premask</div>
                        <input style={inputStyle} value={createForm.premask} onChange={e => setCreateForm({ ...createForm, premask: e.target.value })} placeholder="e.g. R-Tape 4075" />
                      </div>
                    </div>
                  </>
                )}

                {/* Customer Supplied fields */}
                {createForm.job_category === 'customer_supplied' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div style={labelStyle}>Graphics Supplier</div>
                      <input style={inputStyle} value={createForm.supplier} onChange={e => setCreateForm({ ...createForm, supplier: e.target.value })} placeholder="Who is supplying the graphics?" />
                    </div>
                    <div>
                      <div style={labelStyle}>Ship Date</div>
                      <input type="date" style={inputStyle} value={createForm.due_date} onChange={e => setCreateForm({ ...createForm, due_date: e.target.value })} />
                    </div>
                    <div>
                      <div style={labelStyle}>Scheduled Install Date</div>
                      {createForm.scheduled_install_date === 'N/A' ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>N/A</div>
                          <button type="button" onClick={() => setCreateForm({ ...createForm, scheduled_install_date: '' })} style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>Set Date</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <input type="date" style={{ ...inputStyle, flex: 1 }} value={createForm.scheduled_install_date} onChange={e => setCreateForm({ ...createForm, scheduled_install_date: e.target.value })} />
                          <button type="button" onClick={() => setCreateForm({ ...createForm, scheduled_install_date: 'N/A' })} style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>N/A</button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: '12px' }}>
                  <div style={labelStyle}>Internal Notes</div>
                  <textarea style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }} value={createForm.notes} onChange={e => setCreateForm({ ...createForm, notes: e.target.value })} />
                </div>

                {/* File Attachments */}
                <div style={{ marginBottom: '12px' }}>
                  <div style={labelStyle}>File Attachments</div>
                  {createFiles.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
                      {createFiles.map((f, i) => (
                        <span key={i} style={{
                          display: 'flex', alignItems: 'center', gap: '4px',
                          padding: '3px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 600,
                          background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa',
                        }}>
                          {f.name}
                          <span onClick={() => setCreateFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ cursor: 'pointer', fontSize: '9px', opacity: 0.7 }}>✕</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    ref={createFileInputRef}
                    type="file"
                    multiple
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []) as File[];
                      if (files.length > 0) setCreateFiles(prev => [...prev, ...files]);
                      e.target.value = '';
                    }}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    onClick={() => createFileInputRef.current?.click()}
                    style={{
                      width: '100%', padding: '10px', borderRadius: '8px',
                      fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                      background: 'var(--subtle-bg)', border: '1px dashed var(--border)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    + Add Files (proofs, logos, photos, PDFs)
                  </button>
                </div>

                {/* Assign Team Members */}
                <div style={{ marginBottom: '12px' }}>
                  <AssignmentPicker
                    jobType="graphics_job"
                    selectedIds={createAssignees}
                    onChange={setCreateAssignees}
                    roles={['graphics_production', 'production', 'admin', 'field_tech', 'shop_tech']}
                    label="Assign Team Members (select one or more)"
                  />
                </div>

                {/* Priority note for internal */}
                {createForm.job_category === 'internal' && (
                  <div style={{
                    padding: '10px', borderRadius: '8px', marginBottom: '12px',
                    background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)',
                    fontSize: '11px', color: '#f59e0b', lineHeight: 1.5,
                  }}>
                    Internal projects are lower priority unless marked as High or Rush.
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px' }}>
                  <button
                    onClick={createJob}
                    disabled={creating || !createForm.title.trim()}
                    style={{
                      width: '100%', padding: '16px', borderRadius: '12px',
                      background: creating || !createForm.title.trim() ? 'var(--border)' : GRAPHICS_CATEGORY_COLORS[createForm.job_category as GraphicsJobCategory] || '#22c55e',
                      color: '#fff', fontWeight: 800, fontSize: '15px', border: 'none', cursor: 'pointer',
                      opacity: creating || !createForm.title.trim() ? 0.5 : 1,
                      minHeight: '48px',
                    }}
                  >
                    {creating ? 'Creating...' : !createForm.title.trim() ? 'Enter a title to continue' : `Create ${GRAPHICS_CATEGORY_LABELS[createForm.job_category as GraphicsJobCategory]} Job`}
                  </button>
                  <button
                    onClick={() => { setShowCreate(false); setCreateStep('category'); }}
                    style={{ width: '100%', padding: '12px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Status change comment modal. zIndex must clear the expanded-job
          modal (500) and the invoice modal (1000) so it stays on top
          when triggered from inside either of them — otherwise the
          "verify status change" panel lands underneath the job card. */}
      {pendingStatus && (
        <div style={{
          position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1500,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }} onClick={() => setPendingStatus(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: 'var(--card)', borderRadius: '14px', padding: '20px',
            width: '100%', maxWidth: '400px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Change Status
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              {pendingStatus.job.title} — <span style={{ color: GRAPHICS_STATUS_COLORS[pendingStatus.job.status] }}>{GRAPHICS_STATUS_LABELS[pendingStatus.job.status]}</span> → <span style={{ color: GRAPHICS_STATUS_COLORS[pendingStatus.status], fontWeight: 700 }}>{GRAPHICS_STATUS_LABELS[pendingStatus.status]}</span>
            </div>
            <textarea
              autoFocus
              value={statusComment}
              onChange={e => setStatusComment(e.target.value)}
              placeholder="Add a comment (optional)..."
              style={{
                width: '100%', padding: '10px', borderRadius: '8px', fontSize: '12px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', minHeight: '70px', resize: 'vertical',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button
                onClick={() => setPendingStatus(null)}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--text-body)', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmStatusChange}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  background: GRAPHICS_STATUS_COLORS[pendingStatus.status] + '22',
                  border: `1px solid ${GRAPHICS_STATUS_COLORS[pendingStatus.status]}55`,
                  color: GRAPHICS_STATUS_COLORS[pendingStatus.status], cursor: 'pointer',
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {invoiceJob && (
        <GraphicsInvoiceReviewModal
          job={invoiceJob}
          onClose={() => setInvoiceJob(null)}
          onComplete={async (result) => {
            const job = invoiceJob;
            setInvoiceJob(null);
            if (job) {
              // Reflect the new invoice locally right away.
              setJobs(prev => prev.map(j => j.id === job.id ? {
                ...j,
                netsuite_invoice_id: result.invoiceId ?? j.netsuite_invoice_id,
                netsuite_invoice_number: result.invoiceNumber ?? j.netsuite_invoice_number,
                invoice_amount: result.invoiceAmount ?? j.invoice_amount,
                invoiced_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              } : j));
              loadHistory(job.id);
            }
            const printNow = await dialog.confirm(
              `Invoice ${result.invoiceNumber || result.invoiceId || 'created'} in FleetSuite.\n\nPrint packing list now?`
            );
            // Reuse the verified lines so the packing list matches the invoice.
            if (printNow && job) {
              printPackingList(job, {
                netsuite_invoice_id: result.invoiceId ?? null,
                netsuite_invoice_number: result.invoiceNumber ?? null,
              }, result.lines);
            }
            // Best-effort: pull the invoice PDF and store it on the record.
            if (job) storeInvoicePdf(job.id, true);
          }}
        />
      )}
    </div>
  );
}
