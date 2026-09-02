'use client';

/**
 * The Graphics Job Record — one graphics job on its own page. Step 1 of
 * replacing the graphics board's open-in-modal cards with a table that
 * links to record pages (same consolidation as the customer record at
 * /admin/prospects/[id]).
 *
 * Route: /graphics/<uuid> (graphics_jobs.id)
 *
 * Ports the board's expanded job view + edit form: status changes (with
 * history, calendar sync, shop-inbound), full field editing, PO linking,
 * estimate/invoice actions, team assignment, files (upload/delete/Dropbox
 * search + read-only linked-PO PDFs), material log, customer approval,
 * and the activity timeline with @mention notes.
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { deepLinks } from '@/lib/deep-links';
import { storage, storageDownloadUrl } from '@/lib/storage';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import AssignmentPicker from '@/components/AssignmentPicker';
import RecordChanges from '@/components/RecordChanges';
import AssignJobPOModal from '@/components/AssignJobPOModal';
import GraphicsInvoiceReviewModal from '@/components/GraphicsInvoiceReviewModal';
import EmailInvoicesModal, { type EmailableInvoice } from '@/components/EmailInvoicesModal';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import { PartLabel } from '@/components/PartLabel';
import { canonicalPartFromCache } from '@/lib/parts-cache';
import DropboxProofSearch from '@/components/DropboxProofSearch';
import GraphicsMaterialsCard from '@/components/GraphicsMaterialsCard';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { DropZone } from '@/components/DropZone';
import UploadProgressBar, { type UploadProgress } from '@/components/UploadProgressBar';
import { INSTALL_LOCATIONS, SHOP_INSTALL_LOCATION } from '@/lib/shop-inbound';
import { exportPackingListPDF, packingListFromJob, type PackingListLine } from '@/lib/packing-list-pdf';
import type { GraphicsJob, GraphicsJobStatus, GraphicsJobView, GraphicsStatusHistory, Profile } from '@/lib/types';
import NumberInput from '@/components/NumberInput';
import {
  GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS, GRAPHICS_STATUS_ORDER,
  GRAPHICS_CATEGORY_LABELS, GRAPHICS_CATEGORY_COLORS,
} from '@/lib/types';
import { requiresReason, proofGateApplies } from '@/lib/graphics-status';

// ── Date helpers (same behavior as the board — avoid UTC shift) ──────────
function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const parts = dateStr.substring(0, 10).split('-');
  if (parts.length !== 3) return new Date(dateStr);
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

function displayDate(dateStr: string | null | undefined): string {
  const d = parseLocalDate(dateStr);
  if (!d) return '';
  return d.toLocaleDateString();
}

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

// Everything ships UPS — tracking numbers link straight to their site.
const upsTrackingUrl = (trackingNumber: string) =>
  `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber.trim())}`;

const priorityColor = (p: string) => {
  switch (p) {
    case 'rush': return '#ef4444';
    case 'high': return '#f59e0b';
    case 'normal': return '#60a5fa';
    case 'low': return '#6b7280';
    default: return '#6b7280';
  }
};

interface JobFile { id: string; job_id: string; file_name: string; file_type: string | null; file_size: number | null; storage_path: string; uploaded_by: string | null; uploaded_at: string; }
interface PoFile { id: string; po_id: string; file_name: string; file_type: string | null; file_size: number | null; storage_path: string; source: string | null; uploaded_at: string; }
interface UpfitProject { id: string; project_name: string; status: string; customer_name: string | null; }

// ── Shared styles (customer-record card language) ────────────────────────
const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px 16px' };
const labelStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
  textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--bg)',
  color: 'var(--text-body)', fontSize: '12px',
};
const chip = (color: string): React.CSSProperties => ({
  fontSize: '9px', fontWeight: 800, color, textTransform: 'uppercase',
  padding: '2px 7px', borderRadius: '4px', letterSpacing: '0.3px',
  background: `${color}15`, border: `1px solid ${color}33`, whiteSpace: 'nowrap',
});

export default function GraphicsJobRecordPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = String(params?.id || '');
  const { user, isAdmin, isProduction, isSales, isInstaller, isFieldTech, isShopTech, hasFeature, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [job, setJob] = useState<GraphicsJob | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [statusHistory, setStatusHistory] = useState<GraphicsStatusHistory[]>([]);
  const [jobFiles, setJobFiles] = useState<JobFile[]>([]);
  const [poFiles, setPoFiles] = useState<PoFile[]>([]);
  const [assignments, setAssignments] = useState<string[]>([]);
  const [upfit, setUpfit] = useState<UpfitProject | null>(null);
  // Bridge: the CNI job spawned from this graphics job, if one exists.
  const [cniJob, setCniJob] = useState<{ id: string; job_number: string | null; title: string; status: string } | null>(null);
  const [views, setViews] = useState<GraphicsJobView[]>([]);

  // Edit mode — a working copy of the job, same as the board's editingJob.
  const [edit, setEdit] = useState<GraphicsJob | null>(null);
  const [saving, setSaving] = useState(false);

  // Status change with comment (+ tracking # when shipping)
  const [pendingStatus, setPendingStatus] = useState<GraphicsJobStatus | null>(null);
  const [statusComment, setStatusComment] = useState('');
  const [shipTracking, setShipTracking] = useState('');
  // Auto-open the materials modal when a job leaves printing with nothing logged.
  const [materialPrompt, setMaterialPrompt] = useState(false);

  // Activity notes
  const [newNote, setNewNote] = useState('');

  // Files
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Modals
  const [linkPoOpen, setLinkPoOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [emailInvoiceTarget, setEmailInvoiceTarget] = useState<{ customerName: string; invoices: EmailableInvoice[] } | null>(null);

  // Estimate & Invoice actions
  const [creatingEstimate, setCreatingEstimate] = useState(false);
  const [fetchingPdf, setFetchingPdf] = useState(false);

  // Customer approval — proof picker + standard compose modal
  const [approvalPickerOpen, setApprovalPickerOpen] = useState(false);
  const [approvalPickerFileId, setApprovalPickerFileId] = useState<string | null>(null);

  // Assignment save generation — invalidates an in-flight load so it can't
  // clobber an optimistic save (same guard the board uses).
  const assignmentsLoadGen = useRef(0);

  const loadStarted = useRef(false);
  useEffect(() => {
    if (authLoading || !user) return;
    // Every graphics notification (assignment, note, status change) deep-links
    // here, and those fan out to assignees of ANY staff role — installers and
    // shop/field techs included, whom RLS already grants full read/write on
    // graphics_jobs. Gating to the board's roles bounced their email/bell
    // clicks to /home, so only customer-only portal accounts are turned away.
    const isStaff = isProduction || isAdmin || isSales || isInstaller || isFieldTech || isShopTech;
    if (!isStaff) { router.push('/home'); return; }
    if (loadStarted.current) return;
    loadStarted.current = true;
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once when auth resolves
  }, [authLoading, user, isAdmin, isProduction, isSales, isInstaller, isFieldTech, isShopTech]);

  const load = async () => {
    const { data } = await supabase
      .from('graphics_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();
    const j = (data as GraphicsJob) || null;
    // Flagged jobs are only visible to admins — same rule as the board.
    if (!j || (j.status === 'flagged' && !isAdmin)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setJob(j);
    setLoading(false);

    loadProfiles();
    loadHistory();
    loadFiles(j.po_id);
    loadAssignments();
    recordJobView();
    if (j.upfit_project_id) {
      const { data: up } = await supabase
        .from('upfit_projects')
        .select('id, project_name, status, customer_name')
        .eq('id', j.upfit_project_id)
        .maybeSingle();
      setUpfit((up as UpfitProject) || null);
    }
    // Bridge: a CNI job created from this graphics job (cni_admin only —
    // the panel and button are hidden for everyone else anyway).
    if (hasFeature('cni_admin')) {
      const { data: cj } = await supabase
        .from('cni_jobs')
        .select('id, job_number, title, status')
        .eq('source_graphics_job_id', jobId)
        .maybeSingle();
      setCniJob((cj as { id: string; job_number: string | null; title: string; status: string }) || null);
    }
  };

  const loadProfiles = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status')
      .eq('status', 'approved');
    setProfiles((data as Profile[]) || []);
  };

  const loadHistory = async () => {
    const { data } = await supabase
      .from('graphics_status_history')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });
    setStatusHistory((data as GraphicsStatusHistory[]) || []);
  };

  const loadFiles = async (poId?: string | null) => {
    const { data } = await supabase
      .from('graphics_job_files')
      .select('*')
      .eq('job_id', jobId)
      .order('uploaded_at', { ascending: false });
    if (data) setJobFiles(data as JobFile[]);
    // If the job is linked to a PO, also surface that PO's PDFs read-only.
    if (poId) {
      const { data: poData } = await supabase
        .from('po_files')
        .select('*')
        .eq('po_id', poId)
        .order('uploaded_at', { ascending: false });
      setPoFiles((poData as PoFile[]) || []);
    }
  };

  const loadAssignments = async () => {
    const gen = assignmentsLoadGen.current + 1;
    assignmentsLoadGen.current = gen;
    const { data } = await supabase
      .from('job_assignments')
      .select('user_id')
      .eq('job_type', 'graphics_job')
      .eq('job_id', jobId);
    if (assignmentsLoadGen.current !== gen) return;
    if (data) setAssignments(data.map((a: any) => a.user_id));
  };

  // Stamp my view so the board's unread dot clears for me (best-effort —
  // the page must render even if the RPC hasn't been migrated).
  const recordJobView = async () => {
    if (!user) return;
    try {
      await supabase.rpc('record_graphics_job_view', { p_job_id: jobId });
    } catch (e) {
      console.warn('record_graphics_job_view unavailable:', e);
    }
    loadViews();
  };

  // Read receipts for the Seen By card. One row per user who has opened the
  // job, so the per-job set is bounded by staff headcount — no pagination.
  const loadViews = async () => {
    const { data } = await supabase
      .from('graphics_job_views')
      .select('*')
      .eq('job_id', jobId)
      .order('last_viewed_at', { ascending: false });
    setViews((data as GraphicsJobView[]) || []);
  };

  const getProfileName = (userId: string | null) => {
    if (!userId) return null;
    const p = profiles.find(pr => pr.id === userId);
    return p?.full_name || p?.email || null;
  };

  // ── Assignments ──────────────────────────────────────────────────────────
  const saveAssignments = async (userIds: string[]) => {
    if (!job) return;
    assignmentsLoadGen.current += 1;
    const prev = assignments;
    setAssignments(userIds);
    try {
      const res = await fetch('/api/jobs/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobType: 'graphics_job',
          jobId: job.id,
          userIds,
          assignedBy: user?.id,
          notifyUsers: true,
          notifyTeam: false,
          jobTitle: job.title,
        }),
      });
      if (!res.ok) {
        console.error('Assignment save failed:', res.status, await res.text());
        setAssignments(prev);
      }
    } catch (err) {
      console.error('Assignment save error:', err);
      setAssignments(prev);
    }
  };

  // ── Status changes (same writes the board performs) ──────────────────────
  const promptStatusChange = (newStatus: GraphicsJobStatus) => {
    if (!job || job.status === newStatus) return;
    setPendingStatus(newStatus);
    setStatusComment('');
    // Prefill from the job so a tracking number entered earlier via Edit
    // Job isn't blanked by the ship dialog.
    setShipTracking(job.tracking_number || '');
  };

  const confirmStatusChange = async () => {
    if (!pendingStatus) return;
    const ship = pendingStatus === 'shipped'
      ? { tracking: shipTracking.trim() || undefined }
      : undefined;
    await changeStatus(pendingStatus, statusComment.trim() || undefined, ship);
    setPendingStatus(null);
    setStatusComment('');
  };

  const jobShortLabel = (j: GraphicsJob) => j.title || j.job_number || 'this job';

  // On-demand customer notifications — staff confirm/edit the email each
  // time; Cancel sends nothing (same flow as the board).
  const promptPickupNotify = async (j: GraphicsJob) => {
    try {
      const res = await apiFetch('/api/graphics/notify-pickup', {
        method: 'POST',
        body: JSON.stringify({ jobId: j.id, preview: true }),
      });
      const info = await res.json();
      const entry = await dialog.prompt(
        `Tell ${j.customer || 'the customer'} that ${jobShortLabel(j)} is ready for pickup? Confirm or edit the email below — Cancel sends nothing.`,
        info?.email || '',
        { title: 'Notify customer?', confirmLabel: 'Send', placeholder: 'customer@company.com' },
      );
      if (entry === null) return;
      const email = entry.trim();
      if (!email) { await dialog.alert('No email address — nothing was sent.'); return; }
      const sendRes = await apiFetch('/api/graphics/notify-pickup', {
        method: 'POST',
        body: JSON.stringify({ jobId: j.id, email }),
      });
      const sent = await sendRes.json();
      if (!sendRes.ok || (!sent?.dispatch?.email?.ok && !sent?.dispatch?.sms?.ok)) {
        await dialog.alert(`Pickup notification failed${sent?.warning ? `: ${sent.warning}` : ' — check the email address.'}`);
      }
    } catch {
      await dialog.alert('Pickup notification failed — network error.');
    }
  };

  const promptShippedNotify = async (j: GraphicsJob) => {
    // The billing prompt must fire regardless of the customer choice, so
    // every path below still POSTs — only notifyCustomer varies.
    let notifyCustomer = false;
    let customerEmail: string | null = null;
    try {
      const res = await apiFetch('/api/graphics/notify-shipped-invoice', {
        method: 'POST',
        body: JSON.stringify({ jobId: j.id, preview: true }),
      });
      const info = await res.json();
      const entry = await dialog.prompt(
        `Email ${j.customer || 'the customer'} that ${jobShortLabel(j)} shipped${j.tracking_number ? ' (includes tracking)' : ''}? Confirm or edit the email below — Cancel sends nothing to the customer.`,
        info?.email || '',
        { title: 'Notify customer?', confirmLabel: 'Send', placeholder: 'customer@company.com' },
      );
      if (entry !== null && entry.trim()) {
        notifyCustomer = true;
        customerEmail = entry.trim();
      }
    } catch { /* fall through — still fire the billing prompt */ }
    apiFetch('/api/graphics/notify-shipped-invoice', {
      method: 'POST',
      body: JSON.stringify({ jobId: j.id, notifyCustomer, customerEmail, trigger: 'shipped' }),
    }).catch(() => {});
  };

  const changeStatus = async (
    newStatus: GraphicsJobStatus,
    note?: string,
    ship?: { tracking?: string },
  ) => {
    if (!job) return;
    const oldStatus = job.status;
    if (oldStatus === newStatus) return;

    // ── Transition rules (src/lib/graphics-status.ts) ────────────────────
    // Forward skips are free; backward moves must carry a reason; printing
    // without an approved proof is an admin override with a reason.
    let gateNote = '';

    if (proofGateApplies(newStatus, job)) {
      if (!isAdmin) {
        await dialog.alert(
          'This proof has not been approved by the customer yet, so printing needs an admin. '
          + 'Send the proof for approval, or ask an admin to override.',
        );
        return;
      }
      // Honor the comment they already typed in the status modal rather than
      // asking twice; only prompt when they left it blank.
      const why = note?.trim() || (await dialog.prompt(
        'The customer has not approved this proof. Why are you printing anyway?',
        '',
        { placeholder: 'e.g. reprint of an already-approved run', confirmLabel: 'Print anyway' },
      ))?.trim();
      if (!why) return;
      gateNote = `Printed without proof approval — ${why}`;
    } else if (requiresReason(oldStatus, newStatus)) {
      const why = note?.trim() || (await dialog.prompt(
        `Moving back from ${GRAPHICS_STATUS_LABELS[oldStatus]} to ${GRAPHICS_STATUS_LABELS[newStatus]}. Why?`,
        '',
        { placeholder: 'e.g. customer changed the artwork', confirmLabel: 'Move back' },
      ))?.trim();
      if (!why) return;
      gateNote = `Moved back — ${why}`;
    }

    const shipFields: Partial<GraphicsJob> = {};
    if (ship?.tracking) shipFields.tracking_number = ship.tracking;

    const { error } = await supabase
      .from('graphics_jobs')
      .update({ status: newStatus, updated_at: new Date().toISOString(), ...shipFields })
      .eq('id', job.id);
    if (error) {
      await dialog.alert('Status change failed: ' + error.message);
      return;
    }

    // Log the transition
    await supabase.from('graphics_status_history').insert({
      job_id: job.id,
      from_status: oldStatus,
      to_status: newStatus,
      changed_by: user?.id,
      note: (gateNote && note?.trim() && gateNote.includes(note.trim())
        ? gateNote
        : [gateNote, note].filter(Boolean).join(' · ')) || null,
    });

    // Tracking number gets its own note row so it's findable in the history
    // independent of the status-change comment.
    if (ship?.tracking && ship.tracking !== job.tracking_number) {
      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: newStatus,
        to_status: newStatus,
        changed_by: user?.id,
        note: `Tracking #: ${ship.tracking}`,
      });
    }

    // Notifications — same split as the board (install-ready targets vs.
    // generic status pings; pickup/shipped prompt the staff per send).
    if (newStatus === 'ready') {
      fetch('/api/graphics/notify-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      }).catch(() => {});
    } else if (newStatus === 'ready_to_pickup') {
      promptPickupNotify(job);
    } else if (newStatus === 'shipped') {
      promptShippedNotify(job);
    } else if (newStatus === 'picked_up' || newStatus === 'installed') {
      // Billing ask on the OTHER terminal exits (audit Stage 9): a job that
      // leaves as a pickup or a direct install is just as billable as a
      // shipped one, but only 'shipped' ever prompted anyone. Billing-only —
      // no customer email; the route skips already-invoiced jobs itself.
      apiFetch('/api/graphics/notify-shipped-invoice', {
        method: 'POST',
        body: JSON.stringify({ jobId: job.id, trigger: newStatus }),
      }).catch(() => {});
    }

    apiFetch('/api/graphics/notify-assignees', {
      method: 'POST',
      body: JSON.stringify({
        jobId: job.id,
        kind: 'status',
        newStatus,
        statusLabel: GRAPHICS_STATUS_LABELS[newStatus],
      }),
    }).catch(() => {});

    // Shop-install jobs: keep the arrival schedule current.
    if (job.install_location === SHOP_INSTALL_LOCATION) {
      fetch('/api/shop-inbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType: 'graphics_job', sourceId: job.id }),
      }).catch(() => {});
    }

    // Sync calendar (updates status in description, or deletes if cancelled)
    if (job.scheduled_install_date || job.calendar_event_id) {
      fetch('/api/calendar/sync-graphics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      }).catch(() => {});
    }

    setJob(prev => prev ? { ...prev, status: newStatus, updated_at: new Date().toISOString(), ...shipFields } : prev);
    recordJobView();
    loadHistory();

    // Leaving printing with nothing logged: prompt for material usage now,
    // while the roll is still on the table.
    if (oldStatus === 'printing' && !['cancelled', 'flagged', 'received', 'designing', 'revision'].includes(newStatus)) {
      const { count } = await supabase
        .from('graphics_job_materials')
        .select('*', { count: 'exact', head: true })
        .eq('graphics_job_id', job.id);
      if (!count) setMaterialPrompt(true);
    }
  };

  // ── Notes (activity thread) ──────────────────────────────────────────────
  const addNote = async () => {
    if (!job || !newNote.trim()) return;
    const { error } = await supabase.from('graphics_status_history').insert({
      job_id: job.id,
      from_status: job.status,
      to_status: job.status,
      changed_by: user?.id,
      note: newNote.trim(),
    });
    if (error) { await dialog.alert(`Note failed to save: ${error.message}`); return; }
    apiFetch('/api/graphics/notify-assignees', {
      method: 'POST',
      body: JSON.stringify({ jobId: job.id, kind: 'note', note: newNote.trim() }),
    }).catch(() => {}).finally(() => recordJobView());
    reportMentions({
      text: newNote.trim(),
      sourceType: 'graphics_note',
      sourceId: job.id,
      contextLabel: job.title || job.job_number || 'Graphics job',
      contextUrl: deepLinks.graphicsJob(job.id),
    });
    setNewNote('');
    await loadHistory();
  };

  // ── Edit / save ──────────────────────────────────────────────────────────
  // Only the fields the edit form actually renders. The old rest-spread
  // wrote back EVERY column at page-load values — silently reverting
  // status, customer approval, invoice ids, and wrap/estimate links that
  // changed while the page sat open. (assigned_to is owned by the
  // AssignmentPicker; status by the pipeline buttons; approval/invoice
  // columns by their flows — none of them belong in this update.)
  const EDITABLE_FIELDS = [
    'title', 'part_number', 'customer', 'quantity', 'po_number', 'priority',
    'due_date', 'scheduled_install_date', 'install_location', 'supplier',
    'content', 'vinyl_type', 'vinyl_color', 'laminate', 'print_method',
    'cut_method', 'premask', 'tracking_number', 'ship_to', 'notes',
  ] as const;
  // Unsaved-changes signal: any editable field differing between the edit
  // copy and the loaded job. Warns on tab close/refresh while dirty (in-app
  // navigation isn't interceptable in the app router without patching Link).
  const isDirty = !!edit && !!job && EDITABLE_FIELDS.some(f => ((edit as any)[f] ?? '') !== ((job as any)[f] ?? ''));
  useEffect(() => {
    if (!isDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const saveJob = async () => {
    if (!edit || !job) return;
    setSaving(true);
    const id = edit.id;
    const picked: Record<string, any> = {};
    for (const f of EDITABLE_FIELDS) picked[f] = (edit as any)[f];
    // Convert non-date values like "N/A" or empty strings to null for date columns
    const sanitized = {
      ...picked,
      due_date: picked.due_date && picked.due_date !== 'N/A' ? picked.due_date : null,
      scheduled_install_date: picked.scheduled_install_date && picked.scheduled_install_date !== 'N/A' ? picked.scheduled_install_date : null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('graphics_jobs')
      .update(sanitized)
      .eq('id', id);

    if (!error) {
      // Notify teammates newly @mentioned in the notes field this save.
      const prevNotes = job.notes || '';
      if ((edit.notes || '') !== prevNotes) {
        reportMentions({
          text: edit.notes || '',
          previousText: prevNotes,
          sourceType: 'graphics_note',
          sourceId: id,
          contextLabel: edit.title || edit.job_number || 'Graphics job',
          contextUrl: deepLinks.graphicsJob(id),
        });
      }

      setJob({ ...job, ...sanitized } as any);
      setEdit(null);

      // Sync install date to Google Calendar (create, update, or delete event)
      fetch('/api/calendar/sync-graphics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: id }),
      }).catch(() => {});

      // Re-derive the shop arrival entry (idempotent — also cancels it when
      // the install location moves away from our shop).
      fetch('/api/shop-inbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType: 'graphics_job', sourceId: id }),
      }).catch(() => {});
    } else {
      await dialog.alert('Save failed: ' + error.message);
    }
    setSaving(false);
  };

  const deleteJob = async () => {
    if (!job) return;
    if (!(await dialog.confirm('Delete this graphics job? This cannot be undone.', { destructive: true, confirmLabel: 'Delete' }))) return;
    // .select() matters: RLS refuses a non-admin delete by matching zero rows,
    // not by erroring (migration 234). Without it a blocked delete looks like a
    // success and routes back to the board as though the job were gone.
    const { data: deleted, error } = await supabase
      .from('graphics_jobs')
      .delete()
      .eq('id', job.id)
      .select('id');
    if (error) { await dialog.alert('Delete failed: ' + error.message); return; }
    if (!deleted || deleted.length === 0) {
      await dialog.alert('Delete failed: only an admin can delete a graphics job.');
      return;
    }
    router.push('/graphics');
  };

  // ── Files ────────────────────────────────────────────────────────────────
  const uploadFilesToJob = async (files: File[]) => {
    if (!job || files.length === 0) return;
    setUploadingFiles(true);
    const errors: string[] = [];
    let uploaded = 0;
    for (const [i, file] of files.entries()) {
      const ext = file.name.split('.').pop() || 'bin';
      const path = `graphics-files/${job.id}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      setUploadProgress({ fileName: file.name, fileIndex: i + 1, fileCount: files.length, loaded: 0, total: file.size });
      const { error: upErr } = await storage.from('graphics-proofs').upload(path, file, {
        contentType: file.type,
        onProgress: (loaded, total) => setUploadProgress({ fileName: file.name, fileIndex: i + 1, fileCount: files.length, loaded, total }),
      });
      if (upErr) {
        console.error('File upload error:', upErr);
        errors.push(`${file.name}: ${upErr.message || 'storage upload failed'}`);
        continue;
      }
      const { error: dbErr } = await supabase.from('graphics_job_files').insert({
        job_id: job.id,
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
    setUploadProgress(null);
    setUploadingFiles(false);
    await loadFiles(job.po_id);
    if (errors.length > 0) {
      await dialog.alert(`Uploaded ${uploaded} of ${files.length} file${files.length === 1 ? '' : 's'}.\n\n${errors.join('\n')}`);
    }
  };

  const deleteJobFile = async (file: JobFile) => {
    if (!(await dialog.confirm(`Delete "${file.file_name}"?`, { destructive: true, confirmLabel: 'Delete' }))) return;
    // Files linked from a PO (po-pdfs/…) or a part's catalog record
    // (part-files/…) share their storage object with the source record —
    // only unlink them from the job. The object itself is deleted only for
    // the job's own uploads (graphics-files/…).
    if (file.storage_path.startsWith('graphics-files/')) {
      await storage.from('graphics-proofs').remove([file.storage_path]);
    }
    await supabase.from('graphics_job_files').delete().eq('id', file.id);
    setJobFiles(prev => prev.filter(f => f.id !== file.id));
  };

  // Serve through the download route so a save keeps the original file_name —
  // the raw public URL saves as the randomized storage key.
  const getFileUrl = (f: { storage_path: string; file_name: string }) =>
    storageDownloadUrl('graphics-proofs', f.storage_path, f.file_name);

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // ── Estimate & Invoice ───────────────────────────────────────────────────
  const createEstimateFromJob = async () => {
    if (!job) return;
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
        setJob(prev => prev ? { ...prev, estimate_id: data.estimate_id, updated_at: new Date().toISOString() } : prev);
        loadHistory();
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
  const printPackingList = async (j: GraphicsJob, overrides?: Partial<GraphicsJob>, lines?: PackingListLine[]) => {
    try {
      exportPackingListPDF(
        packingListFromJob({ ...j, ...overrides }, lines && lines.length > 0 ? { lines } : undefined),
        { print: true },
      );
    } catch (e) {
      console.error('Packing list error:', e);
      await dialog.alert('Could not generate the packing list.');
    }
  };

  // Pull the invoice PDF from NetSuite and store it on the job record.
  const storeInvoicePdf = async (silent = false): Promise<string | null> => {
    if (!job) return null;
    setFetchingPdf(true);
    try {
      const res = await fetch('/api/graphics/invoice-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      const data = await res.json();
      if (data.success && data.url) {
        setJob(prev => prev ? { ...prev, invoice_pdf_url: data.url } : prev);
        return data.url as string;
      }
      if (!silent) await dialog.alert('Could not get the invoice PDF: ' + (data.error || 'Unknown error'));
    } catch {
      if (!silent) await dialog.alert('Network error fetching the invoice PDF — please try again.');
    } finally {
      setFetchingPdf(false);
    }
    return null;
  };

  const openEmailInvoice = (j: GraphicsJob, override?: { invoiceId?: string | null; invoiceNumber?: string | null }) => {
    const invoiceId = override?.invoiceId ?? j.netsuite_invoice_id;
    const invoiceNumber = override?.invoiceNumber ?? j.netsuite_invoice_number;
    if (!invoiceId && !invoiceNumber) return;
    setEmailInvoiceTarget({
      customerName: j.customer || '',
      invoices: [{
        invoiceId: invoiceId || undefined,
        invoiceNumber: invoiceNumber || String(invoiceId),
        po: j.po_number || undefined,
      }],
    });
  };

  // ── Customer approval ────────────────────────────────────────────────────
  // Standard compose screen (docs/customer-email-standard.md): editable
  // recipients, bcc-me, personal message, attachments, live preview. The
  // proof-file radio picker rides along in the modal's intro slot.
  const openApprovalPicker = () => {
    // Pre-fill with the most recently uploaded file (common case: artist
    // uploads the proof, then sends).
    setApprovalPickerOpen(true);
    setApprovalPickerFileId(jobFiles[0]?.id || null);
  };

  const closeApprovalPicker = () => {
    setApprovalPickerOpen(false);
    setApprovalPickerFileId(null);
  };

  const fetchApprovalPreview = async (fields: EmailComposeFields) => {
    if (!job) return { error: 'Job not loaded' };
    try {
      const res = await fetch(`/api/graphics-jobs/${job.id}/send-for-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preview: true,
          proofFileId: approvalPickerFileId,
          emails: fields.emails,
          message: fields.message || undefined,
          attachmentFileIds: fields.attachmentIds,
        }),
      });
      const data = await res.json();
      if (res.ok && data.preview) return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      return { error: data.error || 'Unknown error' };
    } catch {
      return { error: 'Network error — please try again.' };
    }
  };

  const sendForApproval = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    if (!job) return { ok: false };
    if (!approvalPickerFileId) {
      await dialog.alert('Pick a proof file to send.');
      return { ok: false };
    }
    let data: any;
    try {
      const res = await fetch(`/api/graphics-jobs/${job.id}/send-for-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proofFileId: approvalPickerFileId,
          emails: fields.emails,
          bccSelf: fields.bccSelf,
          message: fields.message || undefined,
          attachmentFileIds: fields.attachmentIds,
        }),
      });
      data = await res.json();
      if (!res.ok) {
        await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
        return { ok: false };
      }
    } catch {
      await dialog.alert('Network error — please try again.');
      return { ok: false };
    }
    // Refresh the job row so the approval timestamps render.
    const { data: fresh } = await supabase.from('graphics_jobs').select('*').eq('id', job.id).maybeSingle();
    if (fresh) setJob(fresh as GraphicsJob);
    const emailInfo = data.dispatch?.email
      ? (data.dispatch.email.ok
          ? `Email sent to ${data.dispatch.email.target}${data.dispatch.email.bcc ? ` (bcc ${data.dispatch.email.bcc})` : ''}${data.dispatch.email.attachments ? ` with ${data.dispatch.email.attachments} attachment${data.dispatch.email.attachments !== 1 ? 's' : ''}` : ''}`
          : `Email failed: ${data.dispatch.email.error || 'unknown'}`)
      : null;
    const smsInfo = data.dispatch?.sms
      ? (data.dispatch.sms.skipped
          ? 'SMS skipped (provider disabled)'
          : data.dispatch.sms.ok
            ? `SMS sent to ${data.dispatch.sms.target}`
            : `SMS failed: ${data.dispatch.sms.error || 'unknown'}`)
      : null;
    await dialog.alert(`Proof sent for approval. Link: ${data.approvalUrl}\n\n${[emailInfo, smsInfo].filter(Boolean).join('\n')}`);
    return { ok: true };
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: theme.orange, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: 'var(--text-label)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading graphics job…</div>
      </div>
    );
  }

  if (notFound || !job) {
    return (
      <div style={{ ...card, textAlign: 'center', padding: '40px 16px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-secondary)' }}>Graphics job not found</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>No graphics job matches this link — it may have been deleted.</div>
        <button onClick={() => router.push('/graphics')} style={{
          marginTop: '14px', padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
          cursor: 'pointer', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
        }}>‹ Graphics</button>
      </div>
    );
  }

  const statusColor = GRAPHICS_STATUS_COLORS[job.status];
  const category = job.job_category || 'production';
  const overdue = !!job.due_date && (parseLocalDate(job.due_date) || new Date()) < new Date();
  const ja = job as any; // approval columns aren't in the GraphicsJob type yet

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* ── Header ── */}
      <div style={card}>
        <button onClick={() => router.push('/graphics')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', padding: 0, marginBottom: '8px' }}>‹ Graphics</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text-primary)' }}>{job.title}</div>
          {job.priority !== 'normal' && <span style={chip(priorityColor(job.priority))}>{job.priority}</span>}
          {category !== 'production' && <span style={chip(GRAPHICS_CATEGORY_COLORS[category])}>{GRAPHICS_CATEGORY_LABELS[category]}</span>}
          <span style={chip(statusColor)}>{GRAPHICS_STATUS_LABELS[job.status]}</span>
          {/* Pre-invoice pick/pack sheet (Stage 5): the invoice-based packing
              list only exists after billing — the bench needs one at the
              packing stage, so this renders from the job + material log. */}
          <a
            href={`/api/graphics/packing-list?jobId=${job.id}&print=1`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ marginLeft: 'auto', padding: '5px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', whiteSpace: 'nowrap', textDecoration: 'none' }}
          >
            🖨 Packing List
          </a>
        </div>
        {job.job_number && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px', fontFamily: 'monospace' }}>#{job.job_number}</div>
        )}
        <div style={{ fontSize: '11px', color: 'var(--text-label)', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px' }}>
          {job.customer && <span style={{ color: 'var(--text-body)', fontWeight: 700 }}>{job.customer}</span>}
          {job.part_number && job.part_number.split(',').map((pn, i) => {
            const trimmed = pn.trim();
            if (!trimmed) return null;
            return (
              <span key={i} style={{ background: 'rgba(59,130,246,0.08)', padding: '1px 5px', borderRadius: '3px' }}>
                <PartLabel partNumber={trimmed} />
              </span>
            );
          })}
          <span>Qty: {job.quantity}</span>
          {job.due_date && <span style={{ color: overdue ? '#ef4444' : '#fbbf24', fontWeight: 700 }}>Due: {displayDate(job.due_date)}</span>}
          {job.scheduled_install_date && (
            <span style={{ color: job.scheduled_install_date === 'N/A' ? 'var(--text-muted)' : '#22d3ee' }}>
              Install: {job.scheduled_install_date === 'N/A' ? 'N/A' : displayDate(job.scheduled_install_date)}
            </span>
          )}
          {job.install_location === SHOP_INSTALL_LOCATION && <span style={{ color: '#38bdf8' }}>Shop install</span>}
          {job.po_number && <span style={{ color: '#a78bfa', fontWeight: 700 }}>PO #{job.po_number}</span>}
          {job.tracking_number && (
            <a
              href={upsTrackingUrl(job.tracking_number)}
              target="_blank"
              rel="noopener noreferrer"
              title="Track on ups.com"
              style={{ padding: '0 4px', borderRadius: '3px', background: 'rgba(96,165,250,0.1)', color: '#60a5fa', fontWeight: 700, textDecoration: 'none' }}
            >
              {job.tracking_number}
            </a>
          )}
          {job.ship_to && (
            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '340px' }} title={job.ship_to}>
              Ship to: {job.ship_to.split('\n').map(s => s.trim()).filter(Boolean).join(', ')}
            </span>
          )}
        </div>

        {/* Parent context — upfit project link when this job belongs to one */}
        {upfit && (
          <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(249,115,22,0.05)', border: '1px solid rgba(249,115,22,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ fontSize: '11px', minWidth: 0 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', fontSize: '9px', letterSpacing: '0.4px', marginRight: '6px' }}>Upfit Project</span>
              <span style={{ color: 'var(--text-body)', fontWeight: 600 }}>{upfit.project_name}</span>
              <span style={{ marginLeft: '6px', padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(249,115,22,0.12)', color: '#f97316', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{upfit.status.replace(/_/g, ' ')}</span>
            </div>
            {/* /upfit requires upfit_projects — installers (who can view this
                page via deep links) lack it, so the link would bounce them. */}
            {hasFeature('upfit_projects') && (
              <a href={`/upfit?id=${upfit.id}`} style={{ flexShrink: 0, padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, color: '#f97316', background: 'rgba(249,115,22,0.10)', border: '1px solid rgba(249,115,22,0.35)', textDecoration: 'none', whiteSpace: 'nowrap' }}>Open ↗</a>
            )}
          </div>
        )}

        {/* Bridge — the outsourced CNI install job created from this graphics
            job, or the button to create one (prefilled, one per source). */}
        {hasFeature('cni_admin') && (cniJob ? (
          <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(34,211,238,0.05)', border: '1px solid rgba(34,211,238,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ fontSize: '11px', minWidth: 0 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', fontSize: '9px', letterSpacing: '0.4px', marginRight: '6px' }}>CNI Install Job</span>
              <span style={{ color: 'var(--text-body)', fontWeight: 600 }}>{cniJob.job_number || cniJob.title}</span>
              <span style={{ marginLeft: '6px', padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(34,211,238,0.12)', color: '#22d3ee', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{cniJob.status.replace(/_/g, ' ')}</span>
            </div>
            <a href={deepLinks.cniJob(cniJob.id)} style={{ flexShrink: 0, padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, color: '#22d3ee', background: 'rgba(34,211,238,0.10)', border: '1px solid rgba(34,211,238,0.35)', textDecoration: 'none', whiteSpace: 'nowrap' }}>Open ↗</a>
          </div>
        ) : job.status !== 'cancelled' && (
          <button
            onClick={() => router.push(`/admin/cni/jobs/new?fromGraphics=${job.id}`)}
            style={{ marginTop: '10px', width: '100%', padding: '8px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, color: '#22d3ee', background: 'rgba(34,211,238,0.06)', border: '1px dashed rgba(34,211,238,0.35)', cursor: 'pointer', textAlign: 'center' }}
          >
            Outsource Install → Create CNI Job
          </button>
        ))}
      </div>

      {/* ── Status controls + actions ── */}
      <div style={card}>
        <div style={labelStyle}>Change Status</div>
        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginTop: '4px' }}>
          {GRAPHICS_STATUS_ORDER.filter(s => s !== 'cancelled' && s !== 'flagged').map(s => (
            <button
              key={s}
              onClick={() => promptStatusChange(s)}
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
        <div style={{ display: 'flex', gap: '6px', marginTop: '12px' }}>
          {!edit ? (
            <button
              onClick={() => setEdit({ ...job })}
              style={{ flex: 1, padding: '10px', borderRadius: '8px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
            >
              Edit Job
            </button>
          ) : (
            <>
              <button
                onClick={saveJob}
                disabled={saving}
                style={{ flex: 1, padding: '10px', borderRadius: '8px', background: '#22c55e', border: 'none', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: 'pointer', opacity: saving ? 0.5 : 1 }}
              >
                {saving ? 'Saving...' : isDirty ? 'Save Changes •' : 'Save Changes'}
              </button>
              <button
                onClick={() => setEdit(null)}
                style={{ flex: 1, padding: '10px', borderRadius: '8px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
              >
                Discard Edits
              </button>
            </>
          )}
          {isAdmin && (
            <button
              onClick={deleteJob}
              style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
            >
              Delete
            </button>
          )}
          {job.status !== 'cancelled' && (
            <button
              onClick={() => promptStatusChange('cancelled')}
              style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(107,114,128,0.08)', border: '1px solid rgba(107,114,128,0.2)', color: '#6b7280', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
            >
              Cancel Job
            </button>
          )}
        </div>
      </div>

      {/* ── Details (read-only) or Edit form ── */}
      {!edit ? (
        <div style={card}>
          {job.content && (
            <div style={{ marginBottom: '10px' }}>
              <div style={labelStyle}>Content / Special Instructions</div>
              <div style={{ fontSize: '12px', color: 'var(--text-body)', padding: '8px', borderRadius: '6px', background: 'var(--bg)', whiteSpace: 'pre-wrap' }}>{job.content}</div>
            </div>
          )}

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

          {job.supplier && (
            <div style={{ marginBottom: '10px' }}>
              <div style={labelStyle}>Graphics Supplier</div>
              <div style={{ fontSize: '12px', color: 'var(--text-body)' }}>{job.supplier}</div>
            </div>
          )}

          {(job.tracking_number || job.ship_to) && (
            <div style={{ marginBottom: '10px' }}>
              <div style={labelStyle}>Shipping</div>
              <div style={{ fontSize: '11px' }}>
                {job.tracking_number && (
                  <a
                    href={upsTrackingUrl(job.tracking_number)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Track on ups.com"
                    style={{ color: '#60a5fa', fontWeight: 700 }}
                  >
                    {job.tracking_number}
                  </a>
                )}
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

          <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <span>Created: {new Date(job.created_at).toLocaleDateString()}</span>
            {job.due_date && <span style={{ color: overdue ? '#ef4444' : '#fbbf24' }}>Due: {displayDate(job.due_date)}</span>}
            {job.scheduled_install_date && <span style={{ color: job.scheduled_install_date === 'N/A' ? 'var(--text-muted)' : '#22d3ee' }}>Install: {job.scheduled_install_date === 'N/A' ? 'N/A' : displayDate(job.scheduled_install_date)}</span>}
            {job.install_location && <span>Location: {job.install_location}</span>}
            {getProfileName(job.assigned_to) && <span>Assigned: {getProfileName(job.assigned_to)}</span>}
            {getProfileName(job.created_by) && <span>By: {getProfileName(job.created_by)}</span>}
          </div>
        </div>
      ) : (
        /* ── Edit form (full parity with the board's edit mode) ── */
        <div style={card}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={labelStyle}>Title</div>
              <input style={inputStyle} value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={labelStyle}>Part Number(s) — PO Line Items</div>
              {(() => {
                const parts = (edit.part_number || '').split(',').map(s => s.trim()).filter(Boolean);
                return (
                  <>
                    {parts.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '4px' }}>
                        {parts.map((pn, i) => (
                          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, background: 'rgba(59,130,246,0.1)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.2)' }}>
                            {pn}
                            <span onClick={() => setEdit({ ...edit, part_number: parts.filter((_, j) => j !== i).join(', ') || null })} style={{ cursor: 'pointer', fontSize: '14px', marginLeft: '2px' }}>&times;</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <input style={inputStyle} placeholder="Type each part # and press Enter to add (supports multiple PO lines)"
                      onKeyDown={e => {
                        const val = (e.target as HTMLInputElement).value.trim();
                        if ((e.key === 'Enter' || e.key === ',') && val) {
                          e.preventDefault();
                          setEdit({ ...edit, part_number: [...parts, val].join(', ') });
                          (e.target as HTMLInputElement).value = '';
                          // Swap the typed chip to the catalog's casing (06u166 →
                          // 06U166) once the parts cache resolves, so the job
                          // stores canonical part numbers.
                          canonicalPartFromCache(val).then(canon => {
                            if (canon === val) return;
                            setEdit((prev: any) => prev ? {
                              ...prev,
                              part_number: (prev.part_number || '').split(',').map((s: string) => s.trim()).filter(Boolean).map((p: string) => p === val ? canon : p).join(', '),
                            } : prev);
                          });
                        }
                      }}
                    />
                  </>
                );
              })()}
            </div>
            <div>
              <div style={labelStyle}>Customer</div>
              <input style={inputStyle} value={edit.customer || ''} onChange={e => setEdit({ ...edit, customer: e.target.value })} />
            </div>
            <div>
              <div style={labelStyle}>Quantity</div>
              <NumberInput style={inputStyle} value={edit.quantity} onChange={e => setEdit({ ...edit, quantity: parseInt(e.target.value) || 1 })} />
            </div>
            <div>
              <div style={labelStyle}>PO Number</div>
              <input style={inputStyle} value={edit.po_number || ''} onChange={e => setEdit({ ...edit, po_number: e.target.value || null })} placeholder="e.g. PO-12345" />
            </div>
            <div>
              <div style={labelStyle}>Priority</div>
              <select style={inputStyle} value={edit.priority} onChange={e => setEdit({ ...edit, priority: e.target.value as GraphicsJob['priority'] })}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="rush">Rush</option>
              </select>
            </div>
            <div>
              <div style={labelStyle}>Due Date</div>
              <input type="date" style={inputStyle} value={toDateInputValue(edit.due_date)} onChange={e => setEdit({ ...edit, due_date: e.target.value })} />
            </div>
            <div>
              <div style={labelStyle}>Scheduled Install Date</div>
              {edit.scheduled_install_date === 'N/A' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>N/A</div>
                  <button type="button" onClick={() => setEdit({ ...edit, scheduled_install_date: '' })} style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>Set Date</button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input type="date" style={{ ...inputStyle, flex: 1 }} value={toDateInputValue(edit.scheduled_install_date)} onChange={e => setEdit({ ...edit, scheduled_install_date: e.target.value })} />
                  <button type="button" onClick={() => setEdit({ ...edit, scheduled_install_date: 'N/A' })} style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>N/A</button>
                </div>
              )}
              {edit.calendar_event_id && <div style={{ fontSize: '9px', color: '#22d3ee', marginTop: '2px' }}>Synced to Google Calendar</div>}
            </div>
            <div>
              <div style={labelStyle}>Install Location</div>
              <select style={inputStyle} value={edit.install_location || ''} onChange={e => setEdit({ ...edit, install_location: e.target.value || null })}>
                <option value="">Not set</option>
                {INSTALL_LOCATIONS.map(loc => <option key={loc} value={loc}>{loc}</option>)}
              </select>
              {edit.install_location === SHOP_INSTALL_LOCATION && (
                <div style={{ fontSize: '9px', color: '#38bdf8', marginTop: '2px' }}>On the shop arrival schedule</div>
              )}
            </div>
            {((edit.job_category || 'production') === 'customer_supplied' || edit.supplier) && (
              <div>
                <div style={labelStyle}>Graphics Supplier</div>
                <input style={inputStyle} value={edit.supplier || ''} onChange={e => setEdit({ ...edit, supplier: e.target.value || null })} placeholder="Who is supplying the graphics?" />
              </div>
            )}
          </div>

          <div style={{ marginBottom: '10px' }}>
            <div style={labelStyle}>Content / Special Instructions (unit numbers, addresses, etc.)</div>
            <textarea
              style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
              value={edit.content || ''}
              onChange={e => setEdit({ ...edit, content: e.target.value })}
              placeholder="Unit numbers, addresses, or other unit-specific details..."
            />
          </div>

          {/* Vinyl specs — production jobs (kept visible when legacy values exist) */}
          {((edit.job_category || 'production') === 'production' || edit.vinyl_type || edit.vinyl_color || edit.laminate || edit.print_method || edit.cut_method || edit.premask) && (
            <>
              <div style={labelStyle}>Vinyl Specifications</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '10px' }}>
                <div>
                  <div style={{ ...labelStyle, fontSize: '8px' }}>Vinyl Type</div>
                  <input style={inputStyle} value={edit.vinyl_type || ''} onChange={e => setEdit({ ...edit, vinyl_type: e.target.value })} placeholder="e.g. 3M IJ180Cv3" />
                </div>
                <div>
                  <div style={{ ...labelStyle, fontSize: '8px' }}>Color</div>
                  <input style={inputStyle} value={edit.vinyl_color || ''} onChange={e => setEdit({ ...edit, vinyl_color: e.target.value })} placeholder="e.g. White" />
                </div>
                <div>
                  <div style={{ ...labelStyle, fontSize: '8px' }}>Laminate</div>
                  <select style={inputStyle} value={edit.laminate || ''} onChange={e => setEdit({ ...edit, laminate: e.target.value })}>
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
                  <input style={inputStyle} value={edit.print_method || ''} onChange={e => setEdit({ ...edit, print_method: e.target.value })} placeholder="e.g. Solvent" />
                </div>
                <div>
                  <div style={{ ...labelStyle, fontSize: '8px' }}>Cut</div>
                  <input style={inputStyle} value={edit.cut_method || ''} onChange={e => setEdit({ ...edit, cut_method: e.target.value })} placeholder="e.g. Contour" />
                </div>
                <div>
                  <div style={{ ...labelStyle, fontSize: '8px' }}>Premask</div>
                  <input style={inputStyle} value={edit.premask || ''} onChange={e => setEdit({ ...edit, premask: e.target.value })} placeholder="e.g. R-Tape 4075" />
                </div>
              </div>
            </>
          )}

          <div style={labelStyle}>Shipping</div>
          <div style={{ marginBottom: '6px' }}>
            <div style={{ ...labelStyle, fontSize: '8px' }}>Tracking #</div>
            <input style={inputStyle} value={edit.tracking_number || ''} onChange={e => setEdit({ ...edit, tracking_number: e.target.value })} />
          </div>
          <div style={{ marginBottom: '10px' }}>
            <div style={{ ...labelStyle, fontSize: '8px' }}>Ship To Address</div>
            <textarea style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }} value={edit.ship_to || ''} onChange={e => setEdit({ ...edit, ship_to: e.target.value })}
              placeholder={'Company Name\n123 Street Address\nCity, State ZIP'}
            />
          </div>

          <div style={{ marginBottom: '12px' }}>
            <div style={labelStyle}>Internal Notes</div>
            <MentionTextArea
              style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }}
              value={edit.notes || ''}
              onChange={v => setEdit({ ...edit, notes: v })}
              placeholder="@ tags a teammate"
            />
          </div>

          {/* Sticky so Save is reachable without scrolling back down a
              ~20-field form; bottom offset clears the tab bar + iOS safe area. */}
          <div style={{ display: 'flex', gap: '6px', position: 'sticky', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 64px)', zIndex: 5, background: 'var(--card-bg, rgba(17,24,39,0.92))', padding: '8px', margin: '0 -8px -8px', borderRadius: '10px', backdropFilter: 'blur(6px)' }}>
            <button
              onClick={saveJob}
              disabled={saving}
              style={{ flex: 1, padding: '12px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontSize: '13px', fontWeight: 800, border: 'none', cursor: 'pointer', opacity: saving ? 0.5 : 1, boxShadow: '0 4px 12px rgba(34,197,94,0.25)' }}
            >
              {saving ? 'Saving...' : isDirty ? 'Save Changes •' : 'Save Changes'}
            </button>
            <button
              onClick={() => setEdit(null)}
              style={{ padding: '12px 18px', borderRadius: '8px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Purchase Order ── */}
      <div style={card}>
        <div style={labelStyle}>Purchase Order</div>
        {job.po_id ? (
          <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '11px', color: '#a78bfa', fontWeight: 700 }}>PO #{job.po_number || '—'} Linked</div>
              <button
                onClick={() => router.push(`/admin/pos?id=${job.po_id}`)}
                style={{ fontSize: '10px', fontWeight: 700, color: '#a78bfa', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '5px', padding: '3px 8px', cursor: 'pointer' }}
              >
                Open PO
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setLinkPoOpen(true)}
            style={{ width: '100%', padding: '8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(167,139,250,0.08)', border: '1px dashed rgba(167,139,250,0.3)', color: '#a78bfa' }}
          >
            + Link PO{job.po_number ? ` (PO #${job.po_number} on file, not linked)` : ''}
          </button>
        )}
      </div>

      {/* ── Estimate & Invoice ── */}
      <div style={card}>
        <div style={labelStyle}>Estimate &amp; Invoice</div>

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

        {job.wrap_quote_id && (
          <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)', marginBottom: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '11px', color: '#a78bfa', fontWeight: 700 }}>Wrap Quote Linked</div>
              <button
                onClick={() => router.push(`/admin/wrap-quote?id=${job.wrap_quote_id}`)}
                style={{ fontSize: '10px', fontWeight: 700, color: '#a78bfa', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '5px', padding: '3px 8px', cursor: 'pointer' }}
              >
                Open Wrap Quote
              </button>
            </div>
          </div>
        )}

        {/* Invoice info — id 'external' means "marked invoiced outside
            FleetSuite": no NetSuite record to link to or fetch a PDF from. */}
        {job.netsuite_invoice_id && (
          <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)', marginBottom: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div>
                {job.netsuite_invoice_id === 'external' ? (
                  <span style={{ fontSize: '11px', color: '#22c55e', fontWeight: 700 }}>
                    Invoiced outside FleetSuite{job.netsuite_invoice_number && job.netsuite_invoice_number !== 'External' ? ` — #${job.netsuite_invoice_number}` : ''}
                  </span>
                ) : (
                  <a
                    href={`https://system.netsuite.com/app/accounting/transactions/custinvc.nl?id=${job.netsuite_invoice_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '11px', color: '#22c55e', fontWeight: 700, textDecoration: 'none' }}
                  >
                    Invoice #{job.netsuite_invoice_number || job.netsuite_invoice_id} ↗
                  </a>
                )}
                <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '2px' }}>
                  {job.invoice_amount ? `$${job.invoice_amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''}
                  {job.invoiced_at ? ` — ${new Date(job.invoiced_at).toLocaleDateString()}` : ''}
                  {job.po_number ? ` — PO #${job.po_number}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
                {job.invoice_pdf_url ? (
                  <a
                    href={job.invoice_pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', color: '#60a5fa', whiteSpace: 'nowrap', textDecoration: 'none' }}
                  >
                    View Invoice PDF ↗
                  </a>
                ) : job.netsuite_invoice_id !== 'external' && (
                  <button
                    onClick={() => storeInvoicePdf()}
                    disabled={fetchingPdf}
                    style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: fetchingPdf ? 'default' : 'pointer', background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', color: '#60a5fa', whiteSpace: 'nowrap', opacity: fetchingPdf ? 0.5 : 1 }}
                  >
                    {fetchingPdf ? 'Getting…' : 'Get Invoice PDF'}
                  </button>
                )}
                <button
                  onClick={() => openEmailInvoice(job)}
                  style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', whiteSpace: 'nowrap' }}
                >
                  Email Invoice
                </button>
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

        {job.po_number && !job.netsuite_invoice_id && (
          <div style={{ fontSize: '11px', color: '#a78bfa', marginBottom: '6px', padding: '4px 8px', borderRadius: '6px', background: 'rgba(167,139,250,0.06)' }}>
            PO #{job.po_number} — ready to invoice when job completes
          </div>
        )}

        {job.status !== 'cancelled' && (
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
            {!job.estimate_id && (
              <button
                onClick={createEstimateFromJob}
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
                onClick={() => setInvoiceOpen(true)}
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

      {/* ── Team assignment ── */}
      <div style={card}>
        <AssignmentPicker
          jobType="graphics_job"
          jobId={job.id}
          selectedIds={assignments}
          onChange={saveAssignments}
          roles={['graphics_production', 'production', 'admin', 'field_tech', 'shop_tech']}
          label="Assigned Team"
          compact
        />
      </div>

      {/* ── Material usage log — feeds the Graphics Costs report ── */}
      <div style={card}>
        <GraphicsMaterialsCard
          job={job}
          autoPrompt={materialPrompt}
          onAutoPromptHandled={() => setMaterialPrompt(false)}
        />
      </div>

      {/* ── Customer approval ── */}
      <div style={{ ...card, background: ja.customer_approved ? 'rgba(34,197,94,0.1)' : 'var(--card)', border: '1px solid ' + (ja.customer_approved ? 'rgba(34,197,94,0.3)' : 'var(--border)') }}>
        <div style={{ ...labelStyle, marginBottom: '6px' }}>Customer Approval</div>
        {ja.customer_approved ? (
          <div style={{ fontSize: '11px', color: '#22c55e', fontWeight: 700 }}>
            ✓ Approved {ja.customer_approved_at ? ` · ${new Date(ja.customer_approved_at).toLocaleString()}` : ''}
            {ja.signed_document_storage_path && (
              <button
                onClick={() => router.push(deepLinks.signedDocument('proof', job.id))}
                title="View the frozen approval snapshot with its integrity check"
                style={{ marginLeft: '10px', padding: '3px 9px', borderRadius: '6px', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}
              >⎙ Signed Doc</button>
            )}
          </div>
        ) : ja.customer_rejected_at ? (
          <div>
            <div style={{ fontSize: '11px', color: '#ef4444', fontWeight: 700, marginBottom: '4px' }}>Changes requested</div>
            {ja.customer_rejection_reason && (
              <div style={{ fontSize: '11px', color: 'var(--text-body)', fontStyle: 'italic' }}>{ja.customer_rejection_reason}</div>
            )}
            {!approvalPickerOpen && (
              <button
                onClick={openApprovalPicker}
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
            {ja.sent_for_approval_at && (() => {
              const waitDays = Math.floor((Date.now() - new Date(ja.sent_for_approval_at).getTime()) / 86_400_000);
              const waitColor = waitDays >= 7 ? '#ef4444' : waitDays >= 3 ? '#fbbf24' : 'var(--text-muted)';
              const reminders = ja.approval_reminder_count || 0;
              return (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  <span style={{ fontWeight: 700, color: waitColor }}>
                    ⏱ Awaiting approval — {waitDays}d
                  </span>
                  {' · sent '}{new Date(ja.sent_for_approval_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  {reminders > 0 && ` · ${reminders} auto-reminder${reminders !== 1 ? 's' : ''}`}
                  {ja.approval_escalated_at && <span style={{ color: '#ef4444', fontWeight: 700 }}> · escalated</span>}
                </div>
              );
            })()}
            {!approvalPickerOpen && (
              <button
                onClick={openApprovalPicker}
                style={{
                  padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                  background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)',
                  color: '#60a5fa', cursor: 'pointer',
                }}
              >{ja.sent_for_approval_at ? 'Resend approval link' : 'Send proof for customer approval'}</button>
            )}
          </div>
        )}

        {/* Standard compose screen; the proof picker rides in the intro slot —
            only the chosen file drives what the approval page displays. */}
        {approvalPickerOpen && (
          <EmailComposeModal
            title="Send Proof for Customer Approval"
            sendLabel="Send for Approval"
            messagePlaceholder="Optional note to the customer — shown at the top of the email…"
            attachments={jobFiles.map(f => ({ id: f.id, name: f.file_name, sizeBytes: f.file_size }))}
            initialAttachmentIds={approvalPickerFileId ? [approvalPickerFileId] : []}
            allowSendWithoutTo
            emptyToNote="No email recipients — the approval link goes out by SMS only if the customer has a phone on file."
            previewKey={approvalPickerFileId || ''}
            fetchPreview={fetchApprovalPreview}
            onSend={sendForApproval}
            onClose={closeApprovalPicker}
            intro={
              <div style={{ padding: '10px', borderRadius: '8px', background: 'var(--bg)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
                  Pick the proof to send — the approval page shows this file
                </div>
                {jobFiles.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>
                    No files attached to this job. Upload a proof first.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '140px', overflowY: 'auto' }}>
                    {jobFiles.map(f => (
                      <label key={f.id} style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '6px 8px', borderRadius: '6px',
                        background: approvalPickerFileId === f.id ? 'rgba(59,130,246,0.1)' : 'var(--subtle-bg)',
                        border: '1px solid ' + (approvalPickerFileId === f.id ? 'rgba(59,130,246,0.3)' : 'var(--border)'),
                        cursor: 'pointer',
                      }}>
                        <input
                          type="radio"
                          name="approval-file"
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
              </div>
            }
          />
        )}
      </div>

      {/* ── Files ── */}
      <div style={card}>
        <DropZone
          onFiles={uploadFilesToJob}
          multiple
          disabled={uploadingFiles}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <div style={labelStyle}>Files &amp; Attachments</div>
            {jobFiles.length > 1 && (
              <a
                href={`/api/graphics-jobs/${job.id}/download-all`}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                  background: 'rgba(96,165,250,0.12)',
                  border: '1px solid rgba(96,165,250,0.3)',
                  color: '#60a5fa', textDecoration: 'none',
                }}
              >Download all ({jobFiles.length})</a>
            )}
          </div>
          {jobFiles.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
              {jobFiles.map(f => {
                const isImage = f.file_type?.startsWith('image/');
                const isPdf = f.file_type === 'application/pdf';
                return (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', background: 'var(--subtle-bg)' }}>
                    <a
                      href={getFileUrl(f)}
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
          {poFiles.length > 0 && (
            <div style={{ marginBottom: '6px' }}>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>From linked PO</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {poFiles.map(f => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', background: 'rgba(96,165,250,0.06)', border: '1px dashed rgba(96,165,250,0.3)' }}>
                    <a
                      href={getFileUrl(f)}
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
              if (files.length > 0) await uploadFilesToJob(files);
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

          {/* Dropbox proof search — pre-filled with the customer so users can
              find existing artwork without hand-walking the folder tree. */}
          <div style={{ marginTop: '8px' }}>
            <DropboxProofSearch defaultQuery={job.customer || job.part_number || ''} />
          </div>
        </DropZone>
      </div>

      {/* ── Activity / status history + notes ── */}
      <div style={card}>
        <div style={labelStyle}>Activity</div>
        {statusHistory.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px', maxHeight: '320px', overflowY: 'auto' }}>
            {statusHistory.map(h => {
              const isNote = h.from_status === h.to_status && h.note;
              return (
                <div key={h.id} id={`gfx-hist-${h.id}`} style={{ fontSize: '10px', color: 'var(--text-label)', padding: '4px 6px', borderRadius: '6px', background: isNote ? 'rgba(245,158,11,0.06)' : 'transparent' }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
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
        {/* Add note — @mention a teammate to ping them */}
        <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
          <MentionTextArea
            value={newNote}
            onChange={setNewNote}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && newNote.trim()) { e.preventDefault(); addNote(); } }}
            placeholder="Add a note... @name to tag"
            style={{
              flex: 1, padding: '6px 10px', borderRadius: '6px', fontSize: '11px',
              background: 'var(--input-bg)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', outline: 'none',
            }}
          />
          <button
            onClick={addNote}
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

      {/* ── Seen By — read receipts of who has opened this job ── */}
      <div style={card}>
        <div style={labelStyle}>Seen By</div>
        {(() => {
          const others = views.filter(v => v.user_id !== user?.id);
          if (others.length === 0) {
            return (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                No one else has opened this job yet.
              </div>
            );
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px' }}>
              {others.map(v => (
                <div key={v.id} style={{ fontSize: '11px', color: 'var(--text-body)', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                  <span>
                    {getProfileName(v.user_id) || 'Unknown'}
                    {v.view_count > 1 && (
                      <span style={{ marginLeft: '6px', color: 'var(--text-muted)', fontSize: '10px' }}>
                        ({v.view_count}×)
                      </span>
                    )}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '10px' }} title={new Date(v.last_viewed_at).toLocaleString()}>
                    {relativeTime(v.last_viewed_at)}
                  </span>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {/* ── Status change comment modal ── */}
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
              {job.title} — <span style={{ color: GRAPHICS_STATUS_COLORS[job.status] }}>{GRAPHICS_STATUS_LABELS[job.status]}</span> → <span style={{ color: GRAPHICS_STATUS_COLORS[pendingStatus], fontWeight: 700 }}>{GRAPHICS_STATUS_LABELS[pendingStatus]}</span>
            </div>
            {pendingStatus === 'shipped' && (
              <div style={{ marginBottom: '10px' }}>
                <div style={labelStyle}>Tracking #</div>
                <input
                  value={shipTracking}
                  onChange={e => setShipTracking(e.target.value)}
                  placeholder="e.g. 1Z999AA10123456784"
                  style={{
                    width: '100%', padding: '10px', borderRadius: '8px', fontSize: '12px',
                    background: 'var(--input-bg)', border: '1px solid var(--border)',
                    color: 'var(--text-primary)', outline: 'none',
                  }}
                />
              </div>
            )}
            <textarea
              autoFocus
              value={statusComment}
              onChange={e => setStatusComment(e.target.value)}
              placeholder={pendingStatus === 'shipped' ? 'Shipping notes (optional)...' : 'Add a comment (optional)...'}
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
                  background: GRAPHICS_STATUS_COLORS[pendingStatus] + '22',
                  border: `1px solid ${GRAPHICS_STATUS_COLORS[pendingStatus]}55`,
                  color: GRAPHICS_STATUS_COLORS[pendingStatus], cursor: 'pointer',
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PO link modal ── */}
      {linkPoOpen && (
        <AssignJobPOModal
          open={linkPoOpen}
          onClose={() => setLinkPoOpen(false)}
          jobId={job.id}
          jobPartNumber={job.part_number}
          jobTitle={job.title}
          initialQuery={job.po_number || ''}
          onAssigned={async (result) => {
            setLinkPoOpen(false);
            setJob(prev => prev ? {
              ...prev,
              po_id: result.po_id,
              po_number: result.po_number,
              po_line_item_id: result.matched_line_item_id ?? prev.po_line_item_id,
            } : prev);
            // Surface the newly-linked PO's files read-only, same as at
            // creation time — query directly with the fresh id.
            const { data: poData } = await supabase
              .from('po_files')
              .select('*')
              .eq('po_id', result.po_id)
              .order('uploaded_at', { ascending: false });
            if (poData) setPoFiles(poData as PoFile[]);
          }}
        />
      )}

      {/* ── Invoice review modal ── */}
      {invoiceOpen && (
        <GraphicsInvoiceReviewModal
          job={job}
          onClose={() => setInvoiceOpen(false)}
          onComplete={async (result) => {
            setInvoiceOpen(false);
            // Reflect the new invoice locally right away.
            setJob(prev => prev ? {
              ...prev,
              netsuite_invoice_id: result.invoiceId ?? prev.netsuite_invoice_id,
              netsuite_invoice_number: result.invoiceNumber ?? prev.netsuite_invoice_number,
              invoice_amount: result.invoiceAmount ?? prev.invoice_amount,
              invoiced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } : prev);
            loadHistory();
            const printNow = await dialog.confirm(
              `Invoice ${result.invoiceNumber || result.invoiceId || 'created'} in FleetSuite.\n\nPrint packing list now?`
            );
            // Reuse the verified lines so the packing list matches the invoice.
            if (printNow) {
              printPackingList(job, {
                netsuite_invoice_id: result.invoiceId ?? null,
                netsuite_invoice_number: result.invoiceNumber ?? null,
              }, result.lines);
            }
            // Best-effort: pull the invoice PDF and store it on the record.
            storeInvoicePdf(true);
            // Offer to email the fresh invoice to the customer.
            const emailNow = await dialog.confirm(
              `Email invoice ${result.invoiceNumber || result.invoiceId || ''} to the customer now?`
            );
            if (emailNow) {
              openEmailInvoice(job, {
                invoiceId: result.invoiceId ?? null,
                invoiceNumber: result.invoiceNumber ?? null,
              });
            }
          }}
        />
      )}

      {emailInvoiceTarget && (
        <EmailInvoicesModal
          customerName={emailInvoiceTarget.customerName}
          invoices={emailInvoiceTarget.invoices}
          onClose={() => setEmailInvoiceTarget(null)}
        />
      )}

      {/* Field-level audit history (A2 phase 4) — admin-only per audit_log RLS */}
      {isAdmin && job && <RecordChanges table="graphics_jobs" recordId={job.id} />}

      <UploadProgressBar progress={uploadProgress} />
    </div>
  );
}
