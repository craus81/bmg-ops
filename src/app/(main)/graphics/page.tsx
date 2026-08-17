'use client';

/**
 * The Graphics board — a thin sortable table over graphics_jobs. Rows
 * navigate to the standalone Job Record (/graphics/<id>), which owns all
 * per-job viewing, editing, and status changes; nothing expands or edits
 * inline here anymore. What stays board-level: search / filters / header
 * sort, the metric tiles (overdue / due soon / stuck), the create wizard
 * (+ its ?new=1&fromPo prefill flow), the Awaiting Graphics queue, and
 * the mentions inbox.
 *
 * Legacy deep links (?editJob= / ?id=) predate the record page and are
 * forwarded there so old notification URLs keep working. ?invoiceJob=
 * (the bell notification's "create invoice?" prompt) stays here: the
 * record page has no query-param handling, so the confirm + invoice
 * review modal flow lives on the board for that deep link only.
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { deepLinks } from '@/lib/deep-links';
import { storage } from '@/lib/storage';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import AssignmentPicker from '@/components/AssignmentPicker';
import GraphicsInvoiceReviewModal from '@/components/GraphicsInvoiceReviewModal';
import EmailInvoicesModal, { type EmailableInvoice } from '@/components/EmailInvoicesModal';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import MentionsInbox from '@/components/MentionsInbox';
import { DropZone } from '@/components/DropZone';
import UploadProgressBar, { type UploadProgress } from '@/components/UploadProgressBar';
import { buildGraphicsJobPrefillFromPo, attachPartFilesToGraphicsJob } from '@/lib/graphics-job-from-po';
import { INSTALL_LOCATIONS, SHOP_INSTALL_LOCATION } from '@/lib/shop-inbound';
import { exportPackingListPDF, packingListFromJob, type PackingListLine } from '@/lib/packing-list-pdf';
import { fetchAllRows } from '@/lib/fetch-all';
import { SortableTh, useTableSort } from '@/components/ui/SortableTh';
import FilterButton, { FilterLabel } from '@/components/ui/FilterButton';
import type { GraphicsJob, GraphicsJobStatus, GraphicsJobCategory, GraphicsJobView } from '@/lib/types';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';
import {
  GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS, GRAPHICS_STATUS_ORDER,
  GRAPHICS_CATEGORY_LABELS, GRAPHICS_CATEGORY_COLORS,
} from '@/lib/types';

type FilterStatus = GraphicsJobStatus | 'all' | 'active';
type FilterCategory = GraphicsJobCategory | 'all';
type MetricFilter = 'overdue' | 'dueWeek' | 'stuck';

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

// Active statuses (not terminal)
const ACTIVE_STATUSES: GraphicsJobStatus[] = ['flagged', 'received', 'designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing', 'ready', 'ready_to_pickup'];

// Statuses past which the due date has done its job — no overdue warning.
const DONE_STATUSES: GraphicsJobStatus[] = ['shipped', 'picked_up', 'installed', 'cancelled'];

const PRIORITY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, rush: 3 };

// Everything ships UPS — tracking numbers link straight to their site.
const upsTrackingUrl = (trackingNumber: string) =>
  `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber.trim())}`;

export default function GraphicsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isAdmin, isProduction, isSales, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [jobs, setJobs] = useState<GraphicsJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('active');
  const [filterCategory, setFilterCategory] = useState<FilterCategory>('all');
  // Installed/cancelled jobs are archived off the active board. This toggle
  // loads them back in so a job set to "installed" can be found again.
  const [showArchived, setShowArchived] = useState(false);
  const showArchivedRef = useRef(false);
  showArchivedRef.current = showArchived;
  // Metric-tile filter: clicking Overdue / Due in 7 days / Stuck narrows the
  // board to just those jobs; clicking the active tile again clears it.
  const [metricFilter, setMetricFilter] = useState<MetricFilter | null>(null);
  // When each job entered its current stage (latest real status transition).
  const [stageSince, setStageSince] = useState<Record<string, string>>({});
  // "My jobs" filter: printers/cutters see only what's assigned to them.
  const [myJobsOnly, setMyJobsOnly] = useState(false);
  const [myAssignedIds, setMyAssignedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data } = await supabase
        .from('job_assignments')
        .select('job_id')
        .eq('job_type', 'graphics_job')
        .eq('user_id', user.id);
      setMyAssignedIds(new Set((data || []).map((a: any) => a.job_id)));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [user?.id]);

  const isMine = (j: GraphicsJob) => j.assigned_to === user?.id || myAssignedIds.has(j.id);
  const [search, setSearch] = useState('');
  // Deep link: ?q=<term> (universal search "View all") prefills the board search.
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) setSearch(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: read once on mount
  }, []);

  // ?invoiceJob= deep-link flow (bell notification → confirm → invoice modal)
  const [invoiceJob, setInvoiceJob] = useState<GraphicsJob | null>(null);
  const [emailInvoiceTarget, setEmailInvoiceTarget] = useState<{ customerName: string; invoices: EmailableInvoice[] } | null>(null);
  const invoicePromptHandled = useRef<Set<string>>(new Set());

  // Create job state
  const [showCreate, setShowCreate] = useState(false);
  const [createStep, setCreateStep] = useState<'category' | 'details'>('category');
  // Set when /tracking or the post-check-in prompt deep-links into the
  // create modal; we re-link the resulting graphics_job to the source
  // check-in so the "Needs Graphics" chip clears automatically.
  const [prefillCheckinId, setPrefillCheckinId] = useState<string | null>(null);
  // Set when another screen (the PO page today) deep-links the create modal
  // prefilled from a purchase order (?new=1&fromPo=<id>[&poLine=<id>]). The
  // submit uses it to write po_id / po_line_item_id and attach the parts'
  // catalog files — nothing is created until the user submits the wizard.
  const [prefillPoLink, setPrefillPoLink] = useState<{
    poId: string; poLineItemId: string | null; customerNetsuiteId: string | null; partNumbers: string[];
  } | null>(null);
  const [awaitingGraphics, setAwaitingGraphics] = useState<any[]>([]);
  const [createForm, setCreateForm] = useState({
    job_category: '' as GraphicsJobCategory | '',
    title: '', part_number: '', part_numbers: [] as string[], partInput: '', customer: '', quantity: 1,
    content: '', notes: '',
    vinyl_type: '', vinyl_color: '', laminate: '', print_method: '', cut_method: '', premask: '',
    priority: 'normal' as 'low' | 'normal' | 'high' | 'rush',
    due_date: '',
    scheduled_install_date: '',
    install_location: '',
    ship_to: '',
    supplier: '',
    po_number: '',
  });
  const [createAssignees, setCreateAssignees] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // Customer autocomplete
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<{ company_name: string }[]>([]);
  const customerTimeout = useRef<any>(null);

  const searchCustomers = (query: string) => {
    setCustomerSearch(query);
    setCreateForm(f => ({ ...f, customer: query }));
    if (customerTimeout.current) clearTimeout(customerTimeout.current);
    if (query.length < 2) { setCustomerResults([]); return; }
    customerTimeout.current = setTimeout(async () => {
      const { data } = await supabase
        .from('customers')
        .select('company_name')
        .ilike('company_name', `%${query}%`)
        .eq('active', true)
        .order('company_name')
        .limit(8);
      setCustomerResults(data || []);
    }, 250);
  };

  const selectCustomer = (name: string) => {
    setCreateForm(f => ({ ...f, customer: name }));
    setCustomerSearch(name);
    setCustomerResults([]);
  };

  // Files attached in the create wizard, uploaded after the job row exists
  const [createFiles, setCreateFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const createFileInputRef = useRef<HTMLInputElement>(null);

  // Job views — record of who has opened each job (read receipts). Loaded
  // eagerly for all jobs so the table can show the unread-activity dot.
  const [jobViews, setJobViews] = useState<Record<string, GraphicsJobView[]>>({});

  useEffect(() => {
    // Wait for auth to finish before role-gating: on a fresh tab (deep links
    // like /graphics?editJob=…) `user` is set a render before the profile
    // loads, so the role flags are all false for a moment — bailing then
    // bounced legitimate users to /home.
    if (authLoading || !user) return;
    if (!isProduction && !isAdmin && !isSales) {
      // Old notification emails still carry legacy record links
      // (?editJob=/?id=). The forward effect below sends those to
      // /graphics/<id>, which now admits every staff role — don't race
      // that navigation to /home.
      if (!searchParams.get('editJob') && !searchParams.get('id')) router.push('/home');
      return;
    }
    loadJobs();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, isAdmin, isProduction, authLoading]);

  // Keep the board fresh so unread-activity dots appear while the page is
  // open — without this, jobs/views load once on mount and a change made by
  // someone else can't light a dot until a full page reload. Poll every 60s
  // while the tab is visible and refresh on focus/return.
  useEffect(() => {
    if (!user) return;
    const refresh = () => { if (document.visibilityState === 'visible') loadJobs(); };
    const timer = setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadJobs is stable per mount
  }, [user]);

  // Legacy deep links (?editJob=<id> from mention notifications, ?id=<id>
  // from bell/new-job notifications) used to expand a card here — the
  // record page owns per-job viewing/editing now, so forward them there.
  useEffect(() => {
    const target = searchParams.get('editJob') || searchParams.get('id');
    if (target) router.replace(`/graphics/${target}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: forward once per URL change
  }, [searchParams]);

  // Admin "create invoice in FleetSuite?" prompt — opens when navigated
  // from the bell notification with ?invoiceJob=<id>. Confirms once; on
  // yes, opens the invoice review modal. Either way, clears the param.
  useEffect(() => {
    if (loading) return;
    const invoiceJobId = searchParams.get('invoiceJob');
    if (!invoiceJobId) return;
    if (invoicePromptHandled.current.has(invoiceJobId)) return;
    invoicePromptHandled.current.add(invoiceJobId);
    router.replace('/graphics', { scroll: false });
    (async () => {
      // The loaded list excludes installed/cancelled jobs, so fall back to
      // fetching by id — the prompt should never silently no-op.
      let job = jobs.find(j => j.id === invoiceJobId) || null;
      if (!job) {
        const { data } = await supabase
          .from('graphics_jobs')
          .select('*')
          .eq('id', invoiceJobId)
          .maybeSingle();
        job = (data as GraphicsJob) || null;
      }
      if (!job) {
        await dialog.alert('Could not find that graphics job — it may have been deleted.');
        return;
      }
      if (job.netsuite_invoice_id) {
        await dialog.alert(`Already invoiced as #${job.netsuite_invoice_number || job.netsuite_invoice_id}.`);
        return;
      }
      const label = job.title || `Job #${job.job_number || job.id.slice(0, 8)}`;
      if (await dialog.confirm(`Create invoice in FleetSuite for ${label}?`)) {
        setInvoiceJob(job);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams, jobs]);

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
      // From a purchase order (the PO page's "+ Graphics Job" buttons):
      // prefill the whole wizard from the PO and jump to the details step —
      // the user reviews/edits and submits; only then is the job created.
      const fromPo = searchParams.get('fromPo');
      if (fromPo) {
        const poLine = searchParams.get('poLine');
        (async () => {
          const prefill = await buildGraphicsJobPrefillFromPo(supabase, fromPo, poLine);
          if (!prefill) return;
          setCreateForm(f => ({ ...f, job_category: 'production', partInput: '', ...prefill.form }));
          setCustomerSearch(prefill.form.customer);
          setCreateStep('details');
          setPrefillPoLink(prefill.link);
        })();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams]);

  // "Job created" confirmation toast — set after creating a job here, or via
  // ?created=<job number> when another page (e.g. the PO page) just created
  // one and navigated over. Auto-dismisses.
  const [createdToast, setCreatedToast] = useState<string | null>(null);
  useEffect(() => {
    if (!createdToast) return;
    const t = setTimeout(() => setCreatedToast(null), 6000);
    return () => clearTimeout(t);
  }, [createdToast]);
  useEffect(() => {
    const created = searchParams.get('created');
    if (created) setCreatedToast(created);
  }, [searchParams]);

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

  const loadJobs = async (includeArchived: boolean = showArchivedRef.current) => {
    // Exclude installed/cancelled by default — they're archived off the active
    // board. The archive toggle brings them back; with them included the set
    // grows unboundedly, so paginate past PostgREST's 1000-row cap (a plain
    // read would silently drop the oldest jobs). Deterministic order + a unique
    // id tiebreaker keeps pages from skipping/duplicating rows mid-read.
    const { data: jobsData, error: jobsErr } = await fetchAllRows<GraphicsJob>((from, to) => {
      let q = supabase.from('graphics_jobs').select('*');
      if (!includeArchived) q = q.not('status', 'in', '("installed","cancelled")');
      return q.order('created_at', { ascending: false }).order('id').range(from, to);
    });
    // On a failed/partial read keep the last known-good board rather than
    // overwriting it with a truncated or empty set — this runs on the 60s/focus
    // poll too, so a transient failure must not blank a working board.
    if (jobsErr) { setLoading(false); return; }
    setJobs(jobsData);
    setLoading(false);

    // Time-in-stage: latest real status TRANSITION per job (note rows write
    // from_status === to_status and must not reset the clock). Best-effort —
    // metrics degrade to created_at if history can't load.
    try {
      const ids = jobsData.map(j => j.id);
      const since: Record<string, string> = {};
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        // Paginate: a 200-job chunk of full-pipeline histories easily exceeds
        // PostgREST's 1000-row cap (.limit does NOT raise it), which would drop
        // the oldest jobs' newest transition and silently inflate their stage
        // clock. created_at desc + id tiebreaker keeps pages stable.
        const { data: hist } = await fetchAllRows<{ job_id: string; from_status: string | null; to_status: string; created_at: string }>((from, to) =>
          supabase
            .from('graphics_status_history')
            .select('job_id, from_status, to_status, created_at')
            .in('job_id', chunk)
            .order('created_at', { ascending: false })
            .order('id')
            .range(from, to)
        );
        for (const h of hist) {
          if (h.from_status === h.to_status) continue;
          if (!since[h.job_id]) since[h.job_id] = h.created_at;
        }
      }
      setStageSince(since);
    } catch { /* chips just fall back to created_at */ }

    // Views are best-effort — if the graphics_job_views table or RPC
    // hasn't been migrated yet, the page should still render the jobs.
    try {
      // One row per (user, opened job): unbounded, so paginate past the
      // 1000-row cap or the unread dots silently misfire for some jobs
      // once the table fills up. id gives the deterministic unique order.
      const { data: viewsData } = await fetchAllRows<GraphicsJobView>((from, to) =>
        supabase
          .from('graphics_job_views')
          .select('*')
          .order('id')
          .range(from, to)
      );
      setJobViews(groupViewsByJob(viewsData));
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

  // Upload the create wizard's attachments once the job row exists.
  const uploadFilesToJob = async (jobId: string, files: File[]) => {
    if (files.length === 0) return;
    setUploadingFiles(true);
    const errors: string[] = [];
    let uploaded = 0;
    for (const [i, file] of files.entries()) {
      const ext = file.name.split('.').pop() || 'bin';
      const path = `graphics-files/${jobId}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
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
    setUploadProgress(null);
    setUploadingFiles(false);
    if (errors.length > 0) {
      await dialog.alert(`Uploaded ${uploaded} of ${files.length} file${files.length === 1 ? '' : 's'}.\n\n${errors.join('\n')}`);
    }
  };

  // Create new job
  const createJob = async () => {
    setCreating(true);
    const cat = createForm.job_category || 'production';
    const prefix = cat === 'proofing' ? 'PRF' : cat === 'internal' ? 'INT' : cat === 'customer_supplied' ? 'CSG' : 'GFX';
    const jobNumber = await nextJobNumber(supabase, prefix, () => legacyJobNumber.gfx(prefix));
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
        install_location: cat !== 'internal' ? (createForm.install_location || null) : null,
        ship_to: (cat === 'production' || cat === 'customer_supplied') ? (createForm.ship_to || null) : null,
        supplier: cat === 'customer_supplied' ? (createForm.supplier || null) : null,
        po_number: createForm.po_number || null,
        status: initialStatus,
        created_by: user?.id,
        // Link back to the source PO / line item when the wizard was opened
        // from one, so the PO screen's job panels and dedupe logic see it.
        ...(prefillPoLink ? {
          po_id: prefillPoLink.poId,
          po_line_item_id: prefillPoLink.poLineItemId,
          customer_netsuite_id: prefillPoLink.customerNetsuiteId,
        } : {}),
      })
      .select()
      .single();

    if (error) {
      await dialog.alert('Failed to create job: ' + error.message);
      setCreating(false);
      return;
    }

    if (data) {
      // Notify teammates @mentioned in the new job's notes.
      if (createForm.notes) {
        reportMentions({
          text: createForm.notes,
          sourceType: 'graphics_note',
          sourceId: data.id,
          contextLabel: createForm.title || jobNumber,
          contextUrl: `/graphics/${data.id}`,
        });
      }

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
        note: `${GRAPHICS_CATEGORY_LABELS[cat]} job created${prefillPoLink && createForm.po_number ? ` from PO #${createForm.po_number}` : ''}`,
      });

      // Sync install date to Google Calendar if set
      if (createForm.scheduled_install_date) {
        fetch('/api/calendar/sync-graphics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: data.id }),
        }).catch(() => {});
      }

      // Installing at our shop → put the vehicle on the shop arrival schedule
      if (createForm.install_location === SHOP_INSTALL_LOCATION) {
        fetch('/api/shop-inbound', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceType: 'graphics_job', sourceId: data.id }),
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
              url: deepLinks.graphicsJob(data.id),
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

      // Jobs created from a PO also carry the parts' catalog files (proofs,
      // install guides), same as the PO PDFs above.
      if (prefillPoLink) {
        await attachPartFilesToGraphicsJob(supabase, prefillPoLink.partNumbers, data.id, user?.id);
      }

      setJobs(prev => [data as GraphicsJob, ...prev]);
      setCreatedToast(data.job_number || jobNumber);
      setShowCreate(false);
      setCreateStep('category');
      setCreateForm({
        job_category: '', title: '', part_number: '', part_numbers: [], partInput: '', customer: '', quantity: 1,
        content: '', notes: '',
        vinyl_type: '', vinyl_color: '', laminate: '', print_method: '', cut_method: '', premask: '',
        priority: 'normal', due_date: '', scheduled_install_date: '', install_location: '', ship_to: '', supplier: '', po_number: '',
      });
      setCreateAssignees([]);
      setCreateFiles([]);
      setPrefillPoLink(null);
    }
    setCreating(false);
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

  // Best-effort: pull the invoice PDF from NetSuite and store it on the job
  // record right after invoicing (the record page has the on-demand button).
  const storeInvoicePdf = async (jobId: string) => {
    try {
      const res = await fetch('/api/graphics/invoice-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json();
      if (data.success && data.url) {
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, invoice_pdf_url: data.url } : j));
      }
    } catch { /* best-effort */ }
  };

  // Open the shared email-invoice modal for a job's NetSuite invoice. The
  // override carries the just-created invoice id/number, which may not be on
  // the job row in state yet.
  const openEmailInvoice = (job: GraphicsJob, override?: { invoiceId?: string | null; invoiceNumber?: string | null }) => {
    const invoiceId = override?.invoiceId ?? job.netsuite_invoice_id;
    const invoiceNumber = override?.invoiceNumber ?? job.netsuite_invoice_number;
    if (!invoiceId && !invoiceNumber) return;
    setEmailInvoiceTarget({
      customerName: job.customer || '',
      invoices: [{
        invoiceId: invoiceId || undefined,
        invoiceNumber: invoiceNumber || String(invoiceId),
        po: job.po_number || undefined,
      }],
    });
  };

  // ── Production metrics (time-in-stage + due risk) ──
  const PRODUCTION_STAGES: GraphicsJobStatus[] = ['received', 'designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing'];
  const stageDays = (j: GraphicsJob): number => {
    const since = stageSince[j.id] || j.created_at;
    return Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000);
  };
  const metricJobs = jobs.filter(j => PRODUCTION_STAGES.includes(j.status));
  // Shared predicates so the metric tiles and the tile-click filter always
  // agree on which jobs they're counting.
  const metricToday = new Date().toISOString().slice(0, 10);
  const isOverdue = (j: GraphicsJob) =>
    (PRODUCTION_STAGES.includes(j.status) || j.status === 'flagged') && !!j.due_date && j.due_date.slice(0, 10) < metricToday;
  const isDueWeek = (j: GraphicsJob) => {
    if (!(PRODUCTION_STAGES.includes(j.status) || j.status === 'flagged') || !j.due_date) return false;
    const due = j.due_date.slice(0, 10);
    const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    return due >= metricToday && due <= week;
  };
  const isStuck = (j: GraphicsJob) => PRODUCTION_STAGES.includes(j.status) && stageDays(j) >= 5;
  const metricPredicates: Record<MetricFilter, (j: GraphicsJob) => boolean> = {
    overdue: isOverdue, dueWeek: isDueWeek, stuck: isStuck,
  };
  const metrics = {
    overdue: jobs.filter(isOverdue).length,
    dueWeek: jobs.filter(isDueWeek).length,
    stuck: jobs.filter(isStuck).length,
    avgStageDays: metricJobs.length > 0
      ? metricJobs.reduce((s, j) => s + stageDays(j), 0) / metricJobs.length
      : 0,
  };

  // Filter jobs
  const filteredJobs = jobs.filter(j => {
    // Flagged jobs only visible to admins
    if (j.status === 'flagged' && !isAdmin) return false;
    // My-jobs filter: assigned directly or via the assignment picker
    if (myJobsOnly && !isMine(j)) return false;
    // Category filter
    if (filterCategory !== 'all' && (j.job_category || 'production') !== filterCategory) return false;
    // Metric tile filter (overdue / due this week / stuck)
    if (metricFilter && !metricPredicates[metricFilter](j)) return false;
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
  });

  // Sort — click-to-sort table headers (SortableTh). Missing values (no due
  // date, no PO) sort last in either direction. Default: due date ascending.
  const { sorted, sort, toggle } = useTableSort(filteredJobs, {
    title: j => j.title?.toLowerCase() || null,
    customer: j => j.customer?.toLowerCase() || null,
    po: j => j.po_number || null,
    qty: j => j.quantity,
    priority: j => PRIORITY_RANK[j.priority] ?? 1,
    due: j => j.due_date ? j.due_date.slice(0, 10) : null,
    status: j => GRAPHICS_STATUS_ORDER.indexOf(j.status),
  }, { key: 'due', dir: 'asc' });

  // Tab counts (hide flagged from non-admins)
  const visibleJobs = isAdmin ? jobs : jobs.filter(j => j.status !== 'flagged');
  const activeCount = visibleJobs.filter(j => ACTIVE_STATUSES.includes(j.status)).length;

  const priorityColor = (p: string) => {
    switch (p) {
      case 'rush': return '#ef4444';
      case 'high': return '#f59e0b';
      case 'normal': return '#60a5fa';
      case 'low': return '#6b7280';
      default: return '#6b7280';
    }
  };

  // Whether the popover's per-status select (not the tabs) is narrowing
  const statusSelectActive = filterStatus !== 'active' && filterStatus !== 'all';

  const toggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    // Open onto "All" so BOTH installed and cancelled show at once —
    // filtering to Active would hide the entire archived set just loaded.
    // "All" also keeps the current active rows visible while the archived
    // set loads, avoiding an empty-board flash. Back to Active on close.
    setFilterStatus(next ? 'all' : 'active');
    setMetricFilter(null);
    loadJobs(next);
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
      {/* "Job created" confirmation toast */}
      {createdToast && (
        <div
          onClick={() => setCreatedToast(null)}
          style={{
            position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
            zIndex: 3000, padding: '12px 20px', borderRadius: '12px', cursor: 'pointer',
            background: '#16a34a', color: '#fff', fontSize: '14px', fontWeight: 800,
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', gap: '8px',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: '16px' }}>✓</span> Job {createdToast} created
        </div>
      )}

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

      <MentionsInbox />

      {/* Production metrics strip — bottleneck + due-date risk at a glance */}
      {metricJobs.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {[
            { id: 'overdue' as const, label: 'Overdue', value: String(metrics.overdue), color: metrics.overdue > 0 ? '#ef4444' : '#22c55e' },
            { id: 'dueWeek' as const, label: 'Due in 7 days', value: String(metrics.dueWeek), color: metrics.dueWeek > 0 ? '#fbbf24' : 'var(--text-muted)' },
            { id: 'stuck' as const, label: 'Stuck 5+ days in stage', value: String(metrics.stuck), color: metrics.stuck > 0 ? '#fbbf24' : '#22c55e' },
            { id: null, label: 'Avg days in stage', value: metrics.avgStageDays.toFixed(1), color: 'var(--text-primary)' },
          ].map(t => {
            const active = t.id !== null && metricFilter === t.id;
            return (
              <button
                key={t.label}
                disabled={t.id === null}
                title={t.id === null ? undefined : active ? 'Show all jobs again' : 'Show only these jobs'}
                onClick={t.id === null ? undefined : () => {
                  const next = metricFilter === t.id ? null : t.id;
                  setMetricFilter(next);
                  // Tiles span several statuses — widen a narrowed status
                  // filter so every matching job is actually visible.
                  if (next && filterStatus !== 'all') setFilterStatus('active');
                }}
                style={{
                  flex: '1 0 110px', padding: '8px 12px', borderRadius: '10px', textAlign: 'center',
                  background: active ? `${t.color}18` : 'var(--card)',
                  border: `1px solid ${active ? t.color : 'var(--border)'}`,
                  cursor: t.id === null ? 'default' : 'pointer',
                }}
              >
                <div style={{ fontSize: '16px', fontWeight: 800, color: t.color }}>{t.value}</div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: active ? t.color : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px', whiteSpace: 'nowrap' }}>
                  {t.label}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Toolbar: Active/All tabs + search + Filter popover */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => { setFilterStatus('active'); setMetricFilter(null); }}
          style={{
            padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: filterStatus === 'active' ? 'rgba(34,197,94,0.15)' : 'var(--subtle-bg)',
            border: `1px solid ${filterStatus === 'active' ? 'rgba(34,197,94,0.5)' : 'var(--border)'}`,
            color: filterStatus === 'active' ? '#22c55e' : 'var(--text-label)',
            whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
          }}
        >
          Active ({activeCount})
        </button>
        <button
          onClick={() => { setFilterStatus('all'); setMetricFilter(null); }}
          style={{
            padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: filterStatus === 'all' ? 'rgba(59,130,246,0.2)' : 'var(--subtle-bg)',
            border: `1px solid ${filterStatus === 'all' ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
            color: filterStatus === 'all' ? '#60a5fa' : 'var(--text-label)',
            whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
          }}
        >
          All ({visibleJobs.length})
        </button>
        <input
          placeholder="Search jobs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            ...inputStyle, flex: 1, minWidth: '160px', marginBottom: 0,
            background: 'var(--subtle-bg)', border: '1px solid var(--border)',
          }}
        />
        <FilterButton
          activeCount={(filterCategory !== 'all' ? 1 : 0) + (statusSelectActive ? 1 : 0) + (myJobsOnly ? 1 : 0) + (showArchived ? 1 : 0)}
          onClear={() => {
            setFilterCategory('all');
            setMyJobsOnly(false);
            setFilterStatus('active');
            if (showArchived) { setShowArchived(false); loadJobs(false); }
          }}
        >
          <FilterLabel>Category</FilterLabel>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
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
                    padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                    background: filterCategory === c.id ? `${c.color}22` : 'var(--subtle-bg)',
                    border: `1px solid ${filterCategory === c.id ? `${c.color}55` : 'var(--border)'}`,
                    color: filterCategory === c.id ? c.color : 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.label} ({count})
                </button>
              );
            })}
          </div>
          <FilterLabel>Status</FilterLabel>
          <select
            value={statusSelectActive ? filterStatus : ''}
            onChange={e => {
              const v = e.target.value as GraphicsJobStatus | '';
              setFilterStatus(v || (showArchived ? 'all' : 'active'));
              if (v) setMetricFilter(null);
            }}
            style={{ width: '100%', padding: '6px 8px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          >
            <option value="">Any status</option>
            {GRAPHICS_STATUS_ORDER.filter(s => s !== 'flagged' || isAdmin).map(s => (
              <option key={s} value={s}>{GRAPHICS_STATUS_LABELS[s]}</option>
            ))}
          </select>
          <FilterLabel>Other</FilterLabel>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            <button
              onClick={() => setMyJobsOnly(v => !v)}
              title="Only jobs assigned to you"
              style={{
                padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                background: myJobsOnly ? 'rgba(34,197,94,0.18)' : 'var(--subtle-bg)',
                border: `1px solid ${myJobsOnly ? 'rgba(34,197,94,0.5)' : 'var(--border)'}`,
                color: myJobsOnly ? '#22c55e' : 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              ★ My Jobs ({jobs.filter(j => (isAdmin || j.status !== 'flagged') && isMine(j)).length})
            </button>
            <button
              onClick={toggleArchived}
              title={showArchived ? 'Hide installed & cancelled jobs' : 'Show installed & cancelled (archived) jobs'}
              style={{
                padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                background: showArchived ? 'rgba(148,163,184,0.22)' : 'var(--subtle-bg)',
                border: `1px solid ${showArchived ? 'rgba(148,163,184,0.5)' : 'var(--border)'}`,
                color: showArchived ? 'var(--text-primary)' : 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              Archived{showArchived ? ' ✓' : ''}
            </button>
          </div>
        </FilterButton>
      </div>

      {/* Job table — every row opens the job record */}
      {sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-label)', fontSize: '13px' }}>
          {search ? 'No matching jobs found.' : 'No graphics jobs yet.'}
        </div>
      ) : (() => {
        const thStyle: React.CSSProperties = {
          fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px',
          color: 'var(--text-muted)', padding: '10px 12px', borderBottom: '1px solid var(--border-strong)',
        };
        const tdStyle: React.CSSProperties = {
          padding: '9px 12px', borderBottom: '1px solid var(--border)', fontSize: '12.5px', whiteSpace: 'nowrap',
        };
        const flagChip = (color: string): React.CSSProperties => ({
          fontSize: '10px', fontWeight: 700, color, padding: '1px 6px', borderRadius: '4px',
          background: `${color}15`, border: `1px solid ${color}33`, whiteSpace: 'nowrap',
        });
        const todayStr = new Date().toISOString().slice(0, 10);
        return (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
            <div className="responsive-table">
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: '820px' }}>
                <thead><tr>
                  <SortableTh label="Title" sortKey="title" sort={sort} onToggle={toggle} style={thStyle} />
                  <SortableTh label="Customer" sortKey="customer" sort={sort} onToggle={toggle} style={thStyle} />
                  <SortableTh label="PO #" sortKey="po" sort={sort} onToggle={toggle} style={thStyle} />
                  <SortableTh label="Qty" sortKey="qty" sort={sort} onToggle={toggle} align="right" style={thStyle} />
                  <SortableTh label="Priority" sortKey="priority" sort={sort} onToggle={toggle} defaultDir="desc" style={thStyle} />
                  <SortableTh label="Due" sortKey="due" sort={sort} onToggle={toggle} style={thStyle} />
                  <SortableTh label="Status" sortKey="status" sort={sort} onToggle={toggle} style={thStyle} />
                  <th style={{ ...thStyle, textAlign: 'left' }}>Flags</th>
                </tr></thead>
                <tbody>
                  {sorted.map(job => {
                    const statusColor = GRAPHICS_STATUS_COLORS[job.status];
                    // Unread: activity (status change, note, edit) since this
                    // viewer last opened the job. No view row = never opened =
                    // unread. Cleared when the record page stamps a view.
                    const myView = (jobViews[job.id] || []).find(v => v.user_id === user?.id);
                    const hasNew = !myView || new Date(job.updated_at).getTime() > new Date(myView.last_viewed_at).getTime();
                    const overdue = !!job.due_date && job.due_date.slice(0, 10) < todayStr && !DONE_STATUSES.includes(job.status);
                    // Flags: stuck-in-stage, proof aging, invoice, tracking
                    const flags: React.ReactNode[] = [];
                    if (PRODUCTION_STAGES.includes(job.status)) {
                      const d = stageDays(job);
                      if (d >= 4) {
                        flags.push(
                          <span
                            key="stage"
                            title={`In ${GRAPHICS_STATUS_LABELS[job.status]} since ${new Date(stageSince[job.id] || job.created_at).toLocaleDateString()}`}
                            style={flagChip(d >= 7 ? '#ef4444' : '#fbbf24')}
                          >⏱ {d}d</span>
                        );
                      }
                    }
                    const ja = job as any;
                    if (!ja.customer_approved && !ja.customer_rejected_at && ja.sent_for_approval_at) {
                      const waitDays = Math.floor((Date.now() - new Date(ja.sent_for_approval_at).getTime()) / 86_400_000);
                      if (waitDays >= 3) {
                        flags.push(
                          <span
                            key="proof"
                            title={`Proof sent ${new Date(ja.sent_for_approval_at).toLocaleDateString()}${ja.approval_reminder_count ? ` · ${ja.approval_reminder_count} auto-reminder${ja.approval_reminder_count !== 1 ? 's' : ''}` : ''}${ja.approval_escalated_at ? ' · escalated' : ''}`}
                            style={flagChip(waitDays >= 7 ? '#ef4444' : '#fbbf24')}
                          >⏱ proof {waitDays}d</span>
                        );
                      }
                    }
                    if (job.netsuite_invoice_number) {
                      flags.push(
                        <span key="inv" style={{ fontSize: '10px', fontWeight: 700, color: '#22c55e', whiteSpace: 'nowrap' }}>
                          INV {job.netsuite_invoice_number}
                        </span>
                      );
                    }
                    if (job.tracking_number) {
                      flags.push(
                        <a
                          key="track"
                          href={upsTrackingUrl(job.tracking_number)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          title="Track on ups.com"
                          style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', whiteSpace: 'nowrap' }}
                        >{job.tracking_number}</a>
                      );
                    }
                    return (
                      <tr
                        key={job.id}
                        className="table-row-link"
                        onClick={() => router.push(`/graphics/${job.id}`)}
                        title={job.notes ? (job.notes.length > 120 ? job.notes.slice(0, 120) + '...' : job.notes) : undefined}
                      >
                        <td style={{ ...tdStyle, maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {hasNew && (
                            <span title="New activity since you last viewed this job" style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', flexShrink: 0, marginRight: '6px', verticalAlign: '1px' }} />
                          )}
                          <span style={{ color: '#60a5fa', fontWeight: 800 }}>{job.title}</span>
                          {job.job_category && job.job_category !== 'production' && (
                            <span style={{
                              marginLeft: '6px', fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px',
                              background: `${GRAPHICS_CATEGORY_COLORS[job.job_category]}18`,
                              color: GRAPHICS_CATEGORY_COLORS[job.job_category],
                              textTransform: 'uppercase', letterSpacing: '0.3px', verticalAlign: '1px',
                            }}>
                              {GRAPHICS_CATEGORY_LABELS[job.job_category]}
                            </span>
                          )}
                        </td>
                        <td style={{ ...tdStyle, maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {job.customer || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={tdStyle}>
                          {job.po_number
                            ? <span style={{ color: '#a78bfa', fontWeight: 700 }}>{job.po_number}</span>
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{job.quantity}</td>
                        <td style={tdStyle}>
                          {job.priority !== 'normal'
                            ? (
                              <span style={{
                                fontSize: '9px', fontWeight: 800, color: priorityColor(job.priority), textTransform: 'uppercase',
                                padding: '2px 6px', borderRadius: '4px',
                                background: `${priorityColor(job.priority)}15`, border: `1px solid ${priorityColor(job.priority)}33`,
                              }}>
                                {job.priority}
                              </span>
                            )
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={tdStyle}>
                          {job.due_date
                            ? (
                              <span style={{ color: overdue ? '#ef4444' : '#fbbf24', fontWeight: overdue ? 700 : 600 }}>
                                {overdue ? '⚠ ' : ''}{displayDate(job.due_date)}
                              </span>
                            )
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={tdStyle}>
                          <span style={{
                            fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '4px',
                            background: `${statusColor}18`, border: `1px solid ${statusColor}44`,
                            color: statusColor, whiteSpace: 'nowrap',
                          }}>
                            {GRAPHICS_STATUS_LABELS[job.status].replace('Job ', '')}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          {flags.length > 0
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{flags}</span>
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ═══════════ CREATE JOB MODAL ═══════════ */}
      {showCreate && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: '0' }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowCreate(false); setCreateStep('category'); setPrefillPoLink(null); } }}
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
                  onClick={() => { setShowCreate(false); setCreateStep('category'); setPrefillPoLink(null); }}
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
                  {/* Where the graphics get installed — O'Fallon Shop routes
                      the vehicle onto the shop arrival schedule */}
                  {createForm.job_category !== 'internal' && (
                    <div>
                      <div style={labelStyle}>Install Location</div>
                      <select style={inputStyle} value={createForm.install_location} onChange={e => setCreateForm({ ...createForm, install_location: e.target.value })}>
                        <option value="">Not set</option>
                        {INSTALL_LOCATIONS.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                      </select>
                      {createForm.install_location === SHOP_INSTALL_LOCATION && (
                        <div style={{ fontSize: '9px', color: '#38bdf8', marginTop: '2px' }}>Vehicle will appear on the shop arrival schedule</div>
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
                  <MentionTextArea style={{ ...inputStyle, minHeight: '40px', resize: 'vertical' }} value={createForm.notes} onChange={v => setCreateForm({ ...createForm, notes: v })} placeholder="@ tags a teammate" />
                </div>

                {/* File Attachments */}
                <DropZone
                  onFiles={(files) => setCreateFiles(prev => [...prev, ...files])}
                  multiple
                  style={{ marginBottom: '12px' }}
                >
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
                </DropZone>

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
                    disabled={creating || uploadingFiles || !createForm.title.trim()}
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
                    onClick={() => { setShowCreate(false); setCreateStep('category'); setPrefillPoLink(null); }}
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

      {/* Invoice review modal — reached only via the ?invoiceJob= deep link
          (the record page owns the on-page Review & Invoice button). */}
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
            if (job) storeInvoicePdf(job.id);
            // Offer to email the fresh invoice to the customer — same flow as
            // the Scans screen.
            if (job) {
              const emailNow = await dialog.confirm(
                `Email invoice ${result.invoiceNumber || result.invoiceId || ''} to the customer now?`
              );
              if (emailNow) {
                openEmailInvoice(job, {
                  invoiceId: result.invoiceId ?? null,
                  invoiceNumber: result.invoiceNumber ?? null,
                });
              }
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

      <UploadProgressBar progress={uploadProgress} />
    </div>
  );
}
