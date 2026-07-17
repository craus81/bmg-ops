'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import PartPicker, { type PickedPart } from '@/components/PartPicker';
import { loadCompaniesWithCounts } from '@/lib/cni-companies';
import JobAttachments from '@/components/JobAttachments';
import { isVerizonRfidPart, validateSerial, validateImei, validateIccid } from '@/lib/rfid';
import VinScanner from '@/components/VinScanner';
import { theme } from '@/lib/theme';

interface CniJob {
  id: string;
  job_number: string;
  title: string;
  description: string | null;
  scope: string | null;
  customer_name: string | null;
  part_number: string | null;
  part_description: string | null;
  billable_customer: string | null;
  address: any;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  site_contact_email: string | null;
  is_multi_unit: boolean;
  vin_count: number;
  target_quantity: number | null;
  budget: number | null;
  pay_per_vehicle: number | null;
  deadline: string | null;
  estimated_hours: number | null;
  requires_shipment: boolean;
  shipping_address: any;
  tracking_number: string | null;
  carrier: string | null;
  material_delivered: boolean;
  assigned_installer_id: string | null;
  assigned_company_id: string | null;
  assigned_at: string | null;
  status: string;
  proposed_schedule_start: string | null;
  proposed_schedule_end: string | null;
  confirmed_schedule_start: string | null;
  confirmed_schedule_end: string | null;
  schedule_confirmed_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  schedule_decline_note: string | null;
  completed_at: string | null;
  invoice_status: string;
  invoice_file_path: string | null;
  netsuite_bill_id: string | null;
  payout_mode: 'company' | 'individual';
  distribution_type: string;
  published_at: string | null;
  bid_count: number;
  created_by: string;
  created_at: string;
}

interface CniVin {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  status: string;
  completed_at: string | null;
  photos_submitted: boolean;
  photos_approved: boolean;
  serial_number: string | null;
  imei: string | null;
  iccid: string | null;
  scan_log_id: string | null;
}

interface StatusHistoryEntry {
  id: string;
  from_status: string | null;
  to_status: string;
  changed_by: string | null;
  note: string | null;
  created_at: string;
  changer_name?: string;
}

// Locations a vendor bill can post to (must match NetSuite location names).
const BILL_LOCATIONS = ['Wentzville', 'Kansas City', "O'Fallon", 'Social Circle'] as const;

const STATUS_LABELS: Record<string, string> = {
  awaiting_assignment: 'Awaiting Assignment',
  bidding_open: 'Bidding Open',
  assigned_awaiting_scheduling: 'Assigned — Awaiting Scheduling',
  scheduling_proposed: 'Scheduling Proposed',
  scheduled_pending_confirmation: 'Awaiting Installer Acceptance',
  scheduled_confirmed: 'Scheduled (Confirmed)',
  in_progress: 'In Progress',
  completed_pending_review: 'Completed — Pending Review',
  approved_closed: 'Approved / Closed',
};

const STATUS_COLORS: Record<string, string> = {
  awaiting_assignment: 'var(--warning)',
  bidding_open: '#f59e0b',
  assigned_awaiting_scheduling: 'var(--text-secondary)',
  scheduling_proposed: '#60a5fa',
  scheduled_pending_confirmation: '#a78bfa',
  scheduled_confirmed: 'var(--success)',
  in_progress: 'var(--orange)',
  completed_pending_review: '#fbbf24',
  approved_closed: 'var(--success)',
};

// Define valid next statuses for coordinator
const NEXT_STATUSES: Record<string, string[]> = {
  awaiting_assignment: ['bidding_open', 'assigned_awaiting_scheduling'],
  bidding_open: ['assigned_awaiting_scheduling'],
  assigned_awaiting_scheduling: [],
  scheduling_proposed: [],
  scheduled_pending_confirmation: [],
  scheduled_confirmed: ['in_progress'],
  in_progress: ['completed_pending_review'],
  completed_pending_review: ['approved_closed'],
  approved_closed: [],
};

export default function CniJobDetailPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [job, setJob] = useState<CniJob | null>(null);
  const [vins, setVins] = useState<CniVin[]>([]);
  const [history, setHistory] = useState<StatusHistoryEntry[]>([]);
  const [installerName, setInstallerName] = useState('');
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Assignment modal
  const [showAssign, setShowAssign] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [companies, setCompanies] = useState<{ id: string; name: string; memberCount: number }[]>([]);
  const [rateDraft, setRateDraft] = useState('');
  const [editingRate, setEditingRate] = useState(false);
  const [rateBusy, setRateBusy] = useState(false);
  const [rateNotice, setRateNotice] = useState('');

  // Scheduling (admin proposes a date+time)
  const [schedStart, setSchedStart] = useState('');   // datetime-local value
  const [schedEnd, setSchedEnd] = useState('');
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState('');

  // Per-vehicle device-ID editor (serial / IMEI / CCID)
  const [editDeviceVin, setEditDeviceVin] = useState<string | null>(null);
  const [deviceDraft, setDeviceDraft] = useState({ serial_number: '', imei: '', iccid: '' });
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState('');

  const openDeviceEditor = (v: CniVin) => {
    setDeviceDraft({ serial_number: v.serial_number || '', imei: v.imei || '', iccid: v.iccid || '' });
    setDeviceError('');
    setEditDeviceVin(v.id);
  };

  const saveDevices = async (vinId: string) => {
    setDeviceBusy(true);
    setDeviceError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/cni/edit-vin-devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ vinId, ...deviceDraft }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setDeviceError(json.error || 'Failed to save'); return; }
      setEditDeviceVin(null);
      await loadJob();
    } finally {
      setDeviceBusy(false);
    }
  };

  // Import vehicles already scanned (under the job's part) but not on the job.
  const [importCandidates, setImportCandidates] = useState<{ scanLogId: string; vin: string; vehicle: string; hasDevices: boolean; scanned_at: string; scanned_by_name: string }[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importSel, setImportSel] = useState<Set<string>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importPartLike, setImportPartLike] = useState('');

  const fetchImportCandidates = async (partLike?: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    const q = (partLike ?? '').trim() ? `&partLike=${encodeURIComponent((partLike ?? '').trim())}` : '';
    const res = await fetch(`/api/cni/import-scans?cniJobId=${jobId}${q}`, {
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    });
    if (res.ok) setImportCandidates((await res.json()).candidates || []);
  };

  useEffect(() => {
    if (job?.part_number) fetchImportCandidates();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when the job/part loads
  }, [job?.part_number, jobId]);

  const openImport = async () => {
    setImportError('');
    setImportOpen(true);
    // RFID / device-capture jobs: field scans were usually logged under the
    // free-text part "rfid", not the job's catalog part. If the exact-part
    // search turned up nothing, probe "rfid" automatically so those scans show
    // up without the admin having to guess the search term.
    if (importCandidates.length === 0 && (isVerizonRfidPart(job?.part_number) || !!(job as any)?.device_capture)) {
      setImportPartLike('rfid');
      await fetchImportCandidates('rfid');
    }
    setImportSel(new Set(importCandidates.map(c => c.scanLogId)));
  };

  const searchImport = async () => {
    await fetchImportCandidates(importPartLike);
    setImportSel(new Set());
  };

  const submitImport = async () => {
    if (importSel.size === 0) return;
    setImportBusy(true);
    setImportError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/cni/import-scans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ cniJobId: jobId, partLike: importPartLike.trim() || undefined, scanLogIds: [...importSel] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setImportError(json.error || 'Import failed'); return; }
      setImportOpen(false);
      await loadJob();
      await fetchImportCandidates();
    } finally {
      setImportBusy(false);
    }
  };

  // Add a completed vehicle that was never scanned, crediting a chosen crew.
  const [addVinOpen, setAddVinOpen] = useState(false);
  const [addForm, setAddForm] = useState({ vin: '', vehicle_year: '', vehicle_make: '', vehicle_model: '', serial_number: '', imei: '', iccid: '' });
  const [addSkipDevices, setAddSkipDevices] = useState(false);
  const [addRoster, setAddRoster] = useState<{ profile_id: string; full_name: string }[]>([]);
  const [addCrew, setAddCrew] = useState<Map<string, number>>(new Map());
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState('');
  // Camera scanning — shared by the Add Vehicle form and the per-vehicle
  // device editor. `apply` drops the scanned value into the right field.
  const [scanReq, setScanReq] = useState<null | { label: string; validate?: (raw: string) => string | null; apply: (v: string) => void }>(null);

  const handleScanResult = (value: string) => {
    scanReq?.apply(value);
    setScanReq(null);
  };

  const openAddVin = async () => {
    setAddForm({ vin: '', vehicle_year: '', vehicle_make: '', vehicle_model: '', serial_number: '', imei: '', iccid: '' });
    setAddSkipDevices(false);
    setAddCrew(new Map());
    setAddError('');
    setScanReq(null);
    setAddVinOpen(true);
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`/api/shifts?cniJobId=${jobId}`, {
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    });
    if (res.ok) setAddRoster((await res.json()).roster || []);
  };

  const submitAddVin = async () => {
    if (!addForm.vin.trim() || addCrew.size === 0) return;
    setAddBusy(true);
    setAddError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/cni/add-completed-vin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({
          jobId,
          vin: addForm.vin,
          vehicle_year: addForm.vehicle_year || null,
          vehicle_make: addForm.vehicle_make || null,
          vehicle_model: addForm.vehicle_model || null,
          serial_number: addForm.serial_number || null,
          imei: addForm.imei || null,
          iccid: addForm.iccid || null,
          skip_devices: addSkipDevices,
          entries: [...addCrew.entries()].map(([profileId, weight]) => ({ profileId, weight })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setAddError(json.error || 'Failed to add vehicle'); return; }
      setAddVinOpen(false);
      await loadJob();
    } finally {
      setAddBusy(false);
    }
  };

  // Distribution
  const [showInvite, setShowInvite] = useState(false);
  const [inviteCompanies, setInviteCompanies] = useState<{ id: string; name: string; memberCount: number }[]>([]);
  const [invitedIds, setInvitedIds] = useState<string[]>([]); // invited company ids
  const [bidCount, setBidCount] = useState(0);

  // Phase 3: photos + messages
  const [photoStats, setPhotoStats] = useState({ total: 0, pending: 0, approved: 0, denied: 0 });
  const [unreadMsgCount, setUnreadMsgCount] = useState(0);

  // Phase 4: invoice + closure
  const [nsBillId, setNsBillId] = useState('');
  const [budgetExceeded, setBudgetExceeded] = useState(false);

  // Completed vehicles that still have no live pay credit — they need an
  // installer tagged in Crew & Pay. Surfaced here so retroactive crediting is
  // discoverable from the job page.
  const [uncreditedCount, setUncreditedCount] = useState(0);

  // Individual payout mode: per-employee payouts generated from credits.
  const [payoutData, setPayoutData] = useState<{
    payouts: { id: string; profile_name: string; total_amount: number | null; status: string; netsuite_bill_id: string | null; netsuite_vendor_id: string | null; items: { id: string }[] }[];
    pending: { profile_id: string; profile_name: string; netsuite_vendor_id: string | null; vehicles: number; total: number; unpriced: number }[];
  } | null>(null);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState('');
  const [payoutBillDrafts, setPayoutBillDrafts] = useState<Record<string, string>>({});
  // Location chosen per payout before creating its NetSuite vendor bill.
  const [payoutBillLocation, setPayoutBillLocation] = useState<Record<string, string>>({});
  // The single payout whose NetSuite bill is currently being created (so only
  // that row shows a busy state, not every approved payout at once).
  const [billingId, setBillingId] = useState<string | null>(null);
  // Order the per-installer payout lists by installer name, vehicle count, or pay.
  const [payoutSort, setPayoutSort] = useState<'total' | 'name' | 'vehicles'>('total');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadJob();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin, jobId]);

  const saveDeviceCapture = async (on: boolean) => {
    if (!job) return;
    setUpdating(true);
    await supabase.from('cni_jobs').update({ device_capture: on }).eq('id', jobId);
    await loadJob();
    setUpdating(false);
  };

  const savePart = async (p: PickedPart | null) => {
    await supabase.from('cni_jobs').update({
      part_number: p?.part_number || null,
      part_description: p?.part_description || null,
      billable_customer: p?.billable_customer || null,
    }).eq('id', jobId);
    await loadJob();
  };

  const loadJob = async () => {
    const { data: jobData } = await supabase
      .from('cni_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (!jobData) { router.push('/admin/cni'); return; }
    setJob(jobData);

    // Load VINs
    const { data: vinData } = await supabase
      .from('cni_job_vins')
      .select('*')
      .eq('job_id', jobId)
      .order('sort_order');
    setVins(vinData || []);

    // Count completed vehicles that have no live pay credit yet — these need an
    // installer tagged in Crew & Pay. Mirrors the shifts page's credited set.
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/admin/credits?cniJobId=${jobId}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      if (res.ok) {
        const { shifts } = await res.json();
        const credited = new Set<string>();
        for (const s of shifts || []) for (const c of (s.credits || [])) if (c.cni_job_vin_id) credited.add(c.cni_job_vin_id);
        const completed = (vinData || []).filter((v: any) => v.status === 'completed');
        setUncreditedCount(completed.filter((v: any) => !credited.has(v.id)).length);
      }
    } catch { /* non-fatal — count just won't show */ }

    // Load installer name
    if (jobData.assigned_installer_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', jobData.assigned_installer_id)
        .single();
      if (profile) setInstallerName(profile.full_name);
    }

    // Load assigned company name
    if (jobData.assigned_company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', jobData.assigned_company_id)
        .single();
      if (company) setCompanyName(company.name);
    }

    // Load bid count + invited IDs
    const { count: bCount } = await supabase
      .from('cni_job_bids')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', jobId);
    setBidCount(bCount || 0);

    const { data: inviteData } = await supabase
      .from('cni_job_invites')
      .select('company_id')
      .eq('job_id', jobId);
    setInvitedIds((inviteData || []).map((i: any) => i.company_id).filter(Boolean));

    // Load photo stats
    const { data: photoData } = await supabase
      .from('cni_job_photos')
      .select('review_status')
      .eq('job_id', jobId);
    if (photoData) {
      setPhotoStats({
        total: photoData.length,
        pending: photoData.filter((p: any) => p.review_status === 'pending').length,
        approved: photoData.filter((p: any) => p.review_status === 'approved').length,
        denied: photoData.filter((p: any) => p.review_status === 'denied').length,
      });
    }

    // Load unread message count
    if (user) {
      const { count: mCount } = await supabase
        .from('cni_job_messages')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .neq('sender_id', user.id)
        .is('read_at', null);
      setUnreadMsgCount(mCount || 0);
    }

    // Load status history
    const { data: historyData } = await supabase
      .from('cni_job_status_history')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });
    if (historyData) {
      const changerIds = [...new Set(historyData.filter((h: any) => h.changed_by).map((h: any) => h.changed_by))];
      let nameMap: Record<string, string> = {};
      if (changerIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', changerIds);
        if (profiles) profiles.forEach((p: any) => { nameMap[p.id] = p.full_name; });
      }
      setHistory(historyData.map((h: any) => ({ ...h, changer_name: h.changed_by ? nameMap[h.changed_by] : undefined })));
    }

    setLoading(false);
  };

  const updateStatus = async (newStatus: string) => {
    if (!job || updating) return;
    setUpdating(true);
    const patch: Record<string, any> = { status: newStatus, updated_by: user?.id };
    // Stamp completion time when an admin marks the job complete (the auto-
    // advance that used to set this was removed — completion is explicit now).
    if (newStatus === 'completed_pending_review') patch.completed_at = new Date().toISOString();
    const { error } = await supabase
      .from('cni_jobs')
      .update(patch)
      .eq('id', job.id);
    if (!error) {
      await loadJob();
    }
    setUpdating(false);
  };

  // Reopen a completed (or closed) job back to In Progress so the
  // crew can finish more vehicles or so credits can be tagged. Clears the
  // completion timestamp; the status-history trigger logs the change.
  const reopenJob = async () => {
    if (!job || updating) return;
    if (!window.confirm('Reopen this job and move it back to In Progress? Use this if it was marked complete too early — e.g. more vehicles still need to be scanned or installers still need to be tagged for pay.')) return;
    setUpdating(true);
    const { error } = await supabase
      .from('cni_jobs')
      .update({ status: 'in_progress', completed_at: null, updated_by: user?.id })
      .eq('id', job.id);
    if (!error) await loadJob();
    setUpdating(false);
  };

  // ISO timestamp → value for <input type="datetime-local"> (local time).
  const toLocalInput = (iso: string) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  // Admin proposes a start date+time → installer accepts/declines.
  const proposeSchedule = async () => {
    if (!job || !schedStart) return;
    setUpdating(true);
    setScheduleError('');
    const { error } = await supabase.from('cni_jobs').update({
      scheduled_start_at: new Date(schedStart).toISOString(),
      scheduled_end_at: schedEnd ? new Date(schedEnd).toISOString() : null,
      schedule_decline_note: null,
      schedule_confirmed_at: null,
      status: 'scheduled_pending_confirmation',
      updated_by: user?.id,
    }).eq('id', job.id);
    setUpdating(false);
    if (error) { setScheduleError(error.message); return; }
    setEditingSchedule(false);
    await loadJob();
  };

  // Accept on the installer's behalf (e.g. a verbal commitment).
  const confirmForInstaller = async () => {
    if (!job) return;
    setUpdating(true);
    setScheduleError('');
    const { error } = await supabase.from('cni_jobs').update({
      schedule_confirmed_at: new Date().toISOString(),
      status: 'scheduled_confirmed',
      updated_by: user?.id,
    }).eq('id', job.id);
    setUpdating(false);
    if (error) { setScheduleError(error.message); return; }
    await loadJob();
  };

  // Assignment is company-based: any installer at the company works the job.
  const loadCompanyList = async () => {
    setCompanies(await loadCompaniesWithCounts(supabase));
    setShowAssign(true);
  };

  const assignCompany = async (companyId: string) => {
    if (!job || updating) return;
    setUpdating(true);
    const { error } = await supabase
      .from('cni_jobs')
      .update({
        assigned_company_id: companyId,
        assigned_at: new Date().toISOString(),
        status: job.status === 'awaiting_assignment' || job.status === 'bidding_open'
          ? 'assigned_awaiting_scheduling'
          : job.status,
        updated_by: user?.id,
      })
      .eq('id', job.id);
    if (!error) {
      setShowAssign(false);
      await loadJob();
    }
    setUpdating(false);
  };

  const savePayRate = async () => {
    if (!job) return;
    const rate = rateDraft === '' ? null : parseFloat(rateDraft);
    if (rate !== null && (isNaN(rate) || rate < 0)) return;
    setRateBusy(true);
    setRateNotice('');
    try {
      // Server updates the rate AND re-prices existing unlocked credits so the
      // change applies retroactively to vehicles already completed.
      const res = await fetch('/api/cni/update-pay-rate', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ jobId: job.id, rate }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setRateNotice(json.error || 'Failed to update rate'); return; }
      const parts: string[] = [];
      if (json.repriced > 0) parts.push(`re-priced ${json.repriced} vehicle${json.repriced === 1 ? '' : 's'}`);
      if (json.lockedSkipped > 0) parts.push(`${json.lockedSkipped} already paid left unchanged`);
      setRateNotice(parts.length ? `Rate saved — ${parts.join(', ')}.` : 'Rate saved.');
      setEditingRate(false);
      await loadJob();
      if (job.payout_mode === 'individual') await loadPayouts();
    } finally {
      setRateBusy(false);
    }
  };

  // ── Individual payouts ──
  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    } as Record<string, string>;
  };

  const loadPayouts = async () => {
    const res = await fetch(`/api/admin/payouts?cniJobId=${jobId}`, { headers: await authHeaders() });
    if (res.ok) setPayoutData(await res.json());
  };

  useEffect(() => {
    if (job?.payout_mode === 'individual') loadPayouts();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when mode flips or job reloads
  }, [job?.payout_mode, jobId]);

  const setPayoutMode = async (mode: 'company' | 'individual') => {
    if (!job || job.payout_mode === mode) return;
    await supabase.from('cni_jobs').update({ payout_mode: mode }).eq('id', job.id);
    await loadJob();
  };

  const payoutAction = async (body: Record<string, unknown>) => {
    setPayoutBusy(true);
    setPayoutError('');
    try {
      const res = await fetch('/api/admin/payouts', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setPayoutError(json.error || 'Payout action failed'); return; }
      await loadPayouts();
    } finally {
      setPayoutBusy(false);
    }
  };

  // Create one installer's NetSuite vendor bill. Tracked per-payout so only
  // the clicked row shows "Creating bill…" — not every approved payout.
  const createBill = async (payoutId: string, location: string) => {
    setBillingId(payoutId);
    setPayoutError('');
    try {
      const res = await fetch('/api/admin/payouts', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ action: 'create_bill', payoutId, location }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setPayoutError(json.error || 'Failed to create vendor bill'); return; }
      await loadPayouts();
    } finally {
      setBillingId(null);
    }
  };

  const loadInviteList = async () => {
    setInviteCompanies(await loadCompaniesWithCounts(supabase));
    setShowInvite(true);
  };

  const sendInvite = async (companyId: string) => {
    if (!job || !user) return;
    setUpdating(true);
    await supabase.from('cni_job_invites').upsert({
      job_id: job.id,
      company_id: companyId,
      installer_id: null,
      invite_type: 'direct',
      invited_by: user.id,
    }, { onConflict: 'job_id,company_id' });
    setInvitedIds(prev => [...prev, companyId]);
    setUpdating(false);
  };

  const publishToBoard = async () => {
    if (!job) return;
    setUpdating(true);
    await supabase.from('cni_jobs').update({
      distribution_type: 'published',
      published_at: new Date().toISOString(),
      status: job.status === 'awaiting_assignment' ? 'bidding_open' : job.status,
    }).eq('id', job.id);
    await loadJob();
    setUpdating(false);
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const statusColor = STATUS_COLORS[job.status] || 'var(--text-muted)';
  const nextStatuses = NEXT_STATUSES[job.status] || [];
  const addr = job.address || {};

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>
            {job.title}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {job.job_number} {job.customer_name ? `• ${job.customer_name}` : ''}
          </div>
        </div>
      </div>

      {/* Status Badge */}
      <div style={{
        padding: '12px 16px', borderRadius: '12px', marginBottom: '14px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: `color-mix(in srgb, ${statusColor} 10%, var(--card))`,
        border: `1px solid color-mix(in srgb, ${statusColor} 25%, transparent)`,
      }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>STATUS</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: statusColor, marginTop: '2px' }}>
            {STATUS_LABELS[job.status]}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(job.status === 'completed_pending_review' || job.status === 'approved_closed') && (
            <button
              onClick={reopenJob}
              disabled={updating}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)',
              }}
            >
              ↺ Reopen
            </button>
          )}
          {nextStatuses.map(ns => (
            <button
              key={ns}
              onClick={() => updateStatus(ns)}
              disabled={updating}
              style={{
                padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: 'var(--orange)', color: '#fff', border: 'none',
              }}
            >
              → {STATUS_LABELS[ns]?.split(' ')[0] || ns}
            </button>
          ))}
        </div>
      </div>

      {/* Assignment */}
      <div style={{
        padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>ASSIGNED COMPANY</div>
        {job.assigned_company_id ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{companyName}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Assigned {job.assigned_at ? new Date(job.assigned_at).toLocaleDateString() : ''} — every installer at the company can work this job
              </div>
            </div>
            <button
              onClick={() => router.push(`/admin/cni/companies/${job.assigned_company_id}`)}
              style={{
                padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
                background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
              }}
            >
              View Company
            </button>
          </div>
        ) : job.assigned_installer_id ? (
          /* Legacy direct-installer assignment (pre-company jobs) */
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{installerName}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Assigned {job.assigned_at ? new Date(job.assigned_at).toLocaleDateString() : ''}
              </div>
            </div>
            <button
              onClick={() => router.push(`/admin/cni/installers/${job.assigned_installer_id}`)}
              style={{
                padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 600,
                background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
              }}
            >
              View Profile
            </button>
          </div>
        ) : (
          <button
            onClick={loadCompanyList}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'var(--orange)', color: '#fff', border: 'none',
            }}
          >
            Assign Company
          </button>
        )}
      </div>

      {/* Distribution & Bids — show when not yet assigned or bidding */}
      {(!job.assigned_installer_id && !job.assigned_company_id || job.status === 'bidding_open') && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>DISTRIBUTION</div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <button
              onClick={loadInviteList}
              style={{
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--subtle-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              }}
            >
              Invite Companies {invitedIds.length > 0 ? `(${invitedIds.length})` : ''}
            </button>
            {job.distribution_type !== 'published' ? (
              <button
                onClick={publishToBoard}
                disabled={updating}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  background: 'var(--orange)', color: '#fff', border: 'none',
                }}
              >
                Publish to Board
              </button>
            ) : (
              <div style={{
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--success-bg)', color: 'var(--success)', textAlign: 'center',
                border: '1px solid var(--success-border)',
              }}>
                ✓ Published
              </div>
            )}
          </div>

          {bidCount > 0 && (
            <button
              onClick={() => router.push(`/admin/cni/jobs/${job.id}/bids`)}
              style={{
                width: '100%', padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'color-mix(in srgb, var(--orange) 10%, var(--card))',
                color: 'var(--orange)', border: '1px solid var(--orange)',
              }}
            >
              Review Bids ({bidCount} response{bidCount !== 1 ? 's' : ''})
            </button>
          )}
        </div>
      )}

      {/* Schedule — admin proposes a date+time; installer accepts/declines,
          or the admin accepts on their behalf (verbal commitment). */}
      {['assigned_awaiting_scheduling', 'scheduled_pending_confirmation', 'scheduled_confirmed'].includes(job.status) && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>SCHEDULE</div>

          {scheduleError && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '10px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>
              {/column .* does not exist/i.test(scheduleError)
                ? 'Scheduling columns are missing from the database — run the consolidated SQL (migration 113) in the Supabase SQL editor, then retry.'
                : scheduleError}
            </div>
          )}

          {job.schedule_decline_note && job.status === 'assigned_awaiting_scheduling' && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '10px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>
              Installer declined the last time — &ldquo;{job.schedule_decline_note}&rdquo;
            </div>
          )}

          {job.status === 'scheduled_confirmed' ? (
            <>
              <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--success)' }}>
                {job.scheduled_start_at ? new Date(job.scheduled_start_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                {job.scheduled_end_at ? ` — ${new Date(job.scheduled_end_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
              </div>
              {job.schedule_confirmed_at && (
                <div style={{ fontSize: '11px', color: 'var(--success)', marginTop: '2px' }}>
                  ✓ Accepted {new Date(job.schedule_confirmed_at).toLocaleDateString()}
                </div>
              )}
            </>
          ) : (job.status === 'scheduled_pending_confirmation' && !editingSchedule) ? (
            <>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#60a5fa' }}>
                {job.scheduled_start_at ? new Date(job.scheduled_start_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                {job.scheduled_end_at ? ` — ${new Date(job.scheduled_end_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', marginBottom: '10px' }}>
                Waiting for the installer to accept or decline.
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={confirmForInstaller}
                  disabled={updating}
                  style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--success)', color: '#fff', border: 'none' }}
                >
                  Accept for Installer
                </button>
                <button
                  onClick={() => {
                    setSchedStart(job.scheduled_start_at ? toLocalInput(job.scheduled_start_at) : '');
                    setSchedEnd(job.scheduled_end_at ? toLocalInput(job.scheduled_end_at) : '');
                    setEditingSchedule(true);
                  }}
                  disabled={updating}
                  style={{ padding: '10px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  Change Time
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                Propose a start date and time. The installer accepts or declines — or you can accept for them.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                <div>
                  <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>Start *</label>
                  <input type="datetime-local" value={schedStart} onChange={e => setSchedStart(e.target.value)}
                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '13px' }} />
                </div>
                <div>
                  <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', display: 'block', marginBottom: '4px' }}>End (optional)</label>
                  <input type="datetime-local" value={schedEnd} onChange={e => setSchedEnd(e.target.value)}
                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '13px' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={proposeSchedule}
                  disabled={!schedStart || updating}
                  style={{ flex: 1, padding: '11px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: schedStart ? 'var(--orange)' : 'var(--text-muted)', color: '#fff', border: 'none' }}
                >
                  {updating ? 'Sending...' : 'Propose to Installer'}
                </button>
                {editingSchedule && (
                  <button onClick={() => setEditingSchedule(false)} disabled={updating}
                    style={{ padding: '11px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Job Info */}
      <div style={{
        padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>JOB DETAILS</div>
        {job.scope && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Scope</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>{job.scope}</div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          {job.budget && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Budget</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)' }}>${job.budget.toLocaleString()}</div>
            </div>
          )}
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Payout Mode</div>
            <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
              {(['company', 'individual'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setPayoutMode(mode)}
                  style={{
                    padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                    background: job.payout_mode === mode ? 'var(--orange)' : 'var(--input-bg)',
                    color: job.payout_mode === mode ? '#fff' : 'var(--text-muted)',
                    border: job.payout_mode === mode ? '1px solid var(--orange)' : '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  {mode === 'company' ? 'Company' : 'Individual'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Pay / Vehicle</div>
            {editingRate ? (
              <div style={{ display: 'flex', gap: '4px', marginTop: '2px' }}>
                <input
                  type="number" value={rateDraft} autoFocus disabled={rateBusy}
                  onChange={e => setRateDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') savePayRate(); }}
                  style={{
                    width: '80px', padding: '4px 8px', borderRadius: '6px', fontSize: '13px', fontWeight: 700,
                    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
                  }}
                />
                <button onClick={savePayRate} disabled={rateBusy} style={{ fontSize: '11px', fontWeight: 700, color: 'var(--success)', background: 'transparent', border: 'none', cursor: rateBusy ? 'default' : 'pointer' }}>{rateBusy ? 'Saving…' : 'Save'}</button>
                <button onClick={() => setEditingRate(false)} disabled={rateBusy} style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>✕</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: job.pay_per_vehicle != null ? 'var(--success)' : 'var(--text-muted)' }}>
                  {job.pay_per_vehicle != null ? `$${Number(job.pay_per_vehicle).toFixed(2)}` : 'Not set'}
                </div>
                <button
                  onClick={() => { setRateDraft(job.pay_per_vehicle != null ? String(job.pay_per_vehicle) : ''); setRateNotice(''); setEditingRate(true); }}
                  style={{ fontSize: '10px', fontWeight: 700, color: 'var(--orange)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                >Edit</button>
              </div>
            )}
            {rateNotice && (
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', marginTop: '3px', maxWidth: '180px' }}>{rateNotice}</div>
            )}
          </div>
          {job.deadline && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Deadline</div>
              <div style={{
                fontSize: '14px', fontWeight: 700,
                color: new Date(job.deadline) < new Date() && job.status !== 'approved_closed' ? 'var(--error)' : 'var(--text-primary)',
              }}>
                {new Date(job.deadline).toLocaleDateString()}
              </div>
            </div>
          )}
          {job.estimated_hours && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Est. Hours</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{job.estimated_hours}h</div>
            </div>
          )}
        </div>
        {(addr.street || addr.city) && (
          <div style={{ marginTop: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Location</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {[addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')}
            </div>
          </div>
        )}
        {job.site_contact_name && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Site Contact</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {job.site_contact_name} {job.site_contact_phone ? `• ${job.site_contact_phone}` : ''}
            </div>
          </div>
        )}
      </div>

      {/* Files & Proofs */}
      <div style={{
        padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>FILES &amp; PROOFS</div>
        <JobAttachments jobId={job.id} attachments={(job as any).attachments || []} editable onChange={loadJob} />
      </div>

      {/* Part */}
      <div style={{
        padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>PART</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          Completed VINs log to the scan log under this part. The Verizon RFID part (06CS901033) prompts the installer to scan SN / IMEI / CCID.
        </div>
        <PartPicker
          value={job.part_number ? { part_number: job.part_number, part_description: job.part_description, billable_customer: job.billable_customer } : null}
          onChange={savePart}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginTop: '12px' }}>
          <input
            type="checkbox"
            checked={isVerizonRfidPart(job.part_number) || !!(job as any).device_capture}
            disabled={isVerizonRfidPart(job.part_number) || updating}
            onChange={e => saveDeviceCapture(e.target.checked)}
            style={{ width: '18px', height: '18px', accentColor: 'var(--orange)' }}
          />
          <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>
            Require device capture — installer scans serial #, IMEI, and CCID per vehicle
            {isVerizonRfidPart(job.part_number) && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (always on for the Verizon RFID part)</span>}
          </span>
        </label>
      </div>

      {/* VINs */}
      <div style={{
        padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>
            {(() => {
              const done = vins.filter(v => v.status === 'completed').length;
              const target = job.target_quantity;
              return target
                ? `VINS (${done} of ${target} target · ${Math.max(target - done, 0)} left)`
                : `VINS (${vins.length})`;
            })()}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={openImport} style={{
              padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
              background: 'color-mix(in srgb, var(--orange) 12%, var(--card))', color: 'var(--orange)', border: '1px solid var(--orange)',
            }}>Import Scanned{importCandidates.length > 0 ? ` (${importCandidates.length})` : ''}</button>
            <button onClick={openAddVin} style={{
              padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
              background: 'var(--orange)', color: '#fff', border: 'none',
            }}>+ Add Vehicle</button>
          </div>
        </div>
        {vins.length === 0 && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '4px 0' }}>
            No vehicles on this job yet. Use <strong>+ Add Vehicle</strong> to add one that was installed but never scanned (and credit the installer), or add VINs when creating the job.
          </div>
        )}
        {vins.map(v => {
            const deviceJob = isVerizonRfidPart(job.part_number) || !!(job as any).device_capture;
            const hasDevices = !!(v.serial_number && v.imei && v.iccid);
            return (
            <div key={v.id} style={{
              padding: '10px 12px', borderRadius: '8px', marginBottom: '6px',
              background: 'var(--input-bg)', border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                    {v.vin}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {[v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}
                  </div>
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                  color: v.status === 'completed' ? 'var(--success)' : v.status === 'in_progress' ? 'var(--orange)' : 'var(--text-muted)',
                  background: v.status === 'completed' ? 'var(--success-bg)' : v.status === 'in_progress' ? 'var(--orange-soft)' : 'var(--subtle-bg)',
                }}>
                  {v.status === 'completed' ? '✓ Complete' : v.status === 'in_progress' ? 'In Progress' : 'Pending'}
                </span>
              </div>

              {/* Device IDs (RFID / device-capture jobs) */}
              {deviceJob && editDeviceVin !== v.id && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '10px', fontFamily: 'monospace', color: hasDevices ? 'var(--text-secondary)' : 'var(--warning)' }}>
                    {hasDevices
                      ? <>SN {v.serial_number} · IMEI {v.imei} · CCID {v.iccid}</>
                      : 'No device IDs captured'}
                  </div>
                  <button onClick={() => openDeviceEditor(v)} style={{
                    flexShrink: 0, padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                    background: hasDevices ? 'var(--subtle-bg)' : 'var(--orange)',
                    color: hasDevices ? 'var(--text-secondary)' : '#fff',
                    border: hasDevices ? '1px solid var(--border)' : 'none',
                  }}>
                    {hasDevices ? 'Edit' : 'Add Device IDs'}
                  </button>
                </div>
              )}

              {/* Inline device editor */}
              {deviceJob && editDeviceVin === v.id && (
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {([
                    { key: 'serial_number' as const, label: 'Serial #', scanLabel: 'Serial #', validate: validateSerial },
                    { key: 'imei' as const, label: 'IMEI (15 digits)', scanLabel: 'IMEI', validate: validateImei },
                    { key: 'iccid' as const, label: 'CCID (18–22 digits)', scanLabel: 'CCID', validate: validateIccid },
                  ]).map(f => (
                    <div key={f.key} style={{ display: 'flex', gap: '6px' }}>
                      <input
                        value={deviceDraft[f.key]}
                        onChange={e => setDeviceDraft(d => ({ ...d, [f.key]: e.target.value }))}
                        placeholder={f.label}
                        style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '13px', fontFamily: 'monospace', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-body)' }}
                      />
                      <button onClick={() => setScanReq({ label: f.scanLabel, validate: f.validate, apply: val => setDeviceDraft(d => ({ ...d, [f.key]: val })) })} title={`Scan ${f.scanLabel}`} style={{ flexShrink: 0, padding: '0 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--subtle-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>Scan</button>
                    </div>
                  ))}
                  {deviceError && (
                    <div style={{ fontSize: '11px', color: 'var(--error)', fontWeight: 600 }}>{deviceError}</div>
                  )}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={() => saveDevices(v.id)} disabled={deviceBusy} style={{
                      flex: 1, padding: '9px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                      background: deviceBusy ? 'var(--text-muted)' : 'var(--success)', color: '#fff', border: 'none',
                    }}>{deviceBusy ? 'Saving...' : 'Save Device IDs'}</button>
                    <button onClick={() => setEditDeviceVin(null)} disabled={deviceBusy} style={{
                      padding: '9px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                      background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
                    }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
            );
          })}
      </div>

      {/* Photos + Messages + Crew quick actions */}
      {(job.assigned_installer_id || job.assigned_company_id) && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <button
            onClick={() => router.push(`/admin/cni/jobs/${job.id}/photos`)}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', textAlign: 'center',
              background: photoStats.pending > 0
                ? 'color-mix(in srgb, var(--warning) 8%, var(--card))'
                : 'var(--card)',
              border: photoStats.pending > 0 ? '1px solid var(--warning)' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>Photos</div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Photos {photoStats.total > 0 ? `(${photoStats.total})` : ''}
            </div>
            {photoStats.pending > 0 && (
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>
                {photoStats.pending} pending review
              </div>
            )}
          </button>
          <button
            onClick={() => router.push(`/admin/cni/jobs/${job.id}/messages`)}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', textAlign: 'center',
              background: unreadMsgCount > 0
                ? 'color-mix(in srgb, var(--orange) 8%, var(--card))'
                : 'var(--card)',
              border: unreadMsgCount > 0 ? '1px solid var(--orange)' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>Msgs</div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>Messages</div>
            {unreadMsgCount > 0 && (
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--orange)' }}>
                {unreadMsgCount} unread
              </div>
            )}
          </button>
          <button
            onClick={() => router.push(`/admin/cni/jobs/${job.id}/shifts`)}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', textAlign: 'center',
              background: uncreditedCount > 0 ? 'color-mix(in srgb, var(--warning) 8%, var(--card))' : 'var(--card)',
              border: uncreditedCount > 0 ? '1px solid var(--warning)' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>Pay</div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>Crew &amp; Pay</div>
            {uncreditedCount > 0 ? (
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>
                {uncreditedCount} need pay
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>shifts · splits</div>
            )}
          </button>
        </div>
      )}

      {/* Individual payouts: per-employee statements generated from credits.
          Replaces the company invoice flow when payout_mode = individual. */}
      {job.payout_mode === 'individual' && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>EMPLOYEE PAYOUTS</div>
            {((payoutData?.payouts || []).length + (payoutData?.pending || []).length) > 1 && (
              <div style={{ display: 'flex', gap: '4px' }}>
                {([
                  { id: 'total' as const, label: 'Pay' },
                  { id: 'vehicles' as const, label: 'Vehicles' },
                  { id: 'name' as const, label: 'Installer' },
                ]).map(s => (
                  <button key={s.id} onClick={() => setPayoutSort(s.id)} style={{
                    padding: '4px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                    background: payoutSort === s.id ? 'var(--orange)' : 'var(--card)',
                    color: payoutSort === s.id ? '#fff' : 'var(--text-secondary)',
                    border: payoutSort === s.id ? 'none' : '1px solid var(--border)',
                  }}>{s.label}</button>
                ))}
              </div>
            )}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            Each employee is paid directly from their vehicle credits — no company invoice on this job.
            Approve each payout, create the vendor bill in NetSuite, then record the bill ID here.
          </div>

          {payoutError && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{payoutError}</div>
          )}

          {/* Existing payouts */}
          {[...(payoutData?.payouts || [])].sort((a, b) =>
            payoutSort === 'name' ? a.profile_name.localeCompare(b.profile_name)
            : payoutSort === 'vehicles' ? b.items.length - a.items.length
            : (b.total_amount || 0) - (a.total_amount || 0),
          ).map(p => (
            <div key={p.id} style={{
              padding: '10px 12px', borderRadius: '10px', marginBottom: '6px',
              background: 'var(--input-bg)', border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {p.profile_name}
                    <span style={{
                      marginLeft: '8px', fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px',
                      textTransform: 'uppercase', letterSpacing: '0.5px',
                      background: p.status === 'paid' || p.status === 'billed' ? 'var(--success-bg)' : 'var(--subtle-bg)',
                      color: p.status === 'paid' || p.status === 'billed' ? 'var(--success)' : p.status === 'approved' ? '#60a5fa' : 'var(--text-muted)',
                      border: '1px solid var(--border)',
                    }}>{p.status}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {p.items.length} vehicle{p.items.length === 1 ? '' : 's'}
                    {p.netsuite_bill_id ? ` · Bill ${p.netsuite_bill_id}` : ''}
                    {!p.netsuite_vendor_id && p.status !== 'paid' && (
                      <span style={{ color: 'var(--warning)', fontWeight: 700 }}> · no NetSuite vendor on file</span>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--success)' }}>
                  ${(p.total_amount || 0).toFixed(2)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                {p.status === 'draft' && (
                  <>
                    <button onClick={() => payoutAction({ action: 'approve', payoutId: p.id })} disabled={payoutBusy} style={{
                      padding: '7px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                      background: 'var(--success)', color: '#fff', border: 'none',
                    }}>Approve</button>
                    <button onClick={() => payoutAction({ action: 'delete_draft', payoutId: p.id })} disabled={payoutBusy} style={{
                      padding: '7px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                      background: 'transparent', color: 'var(--error)', border: '1px solid var(--error-border)',
                    }}>Delete Draft</button>
                  </>
                )}
                {p.status === 'approved' && (() => {
                  const loc = payoutBillLocation[p.id] || '';
                  const billing = billingId === p.id;
                  const otherBilling = billingId !== null && !billing;
                  const canBill = !!p.netsuite_vendor_id && !!loc && !billing && !otherBilling && !payoutBusy;
                  return (
                  <>
                    <select
                      value={loc}
                      onChange={e => setPayoutBillLocation(prev => ({ ...prev, [p.id]: e.target.value }))}
                      disabled={payoutBusy || billing || !p.netsuite_vendor_id}
                      style={{
                        padding: '7px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                        border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-body)',
                      }}
                    >
                      <option value="">Location…</option>
                      {BILL_LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <button
                      onClick={() => createBill(p.id, loc)}
                      disabled={!canBill}
                      title={!p.netsuite_vendor_id ? 'This installer has no NetSuite vendor ID on file' : !loc ? 'Choose a location first' : 'Create the vendor bill in NetSuite'}
                      style={{
                        padding: '7px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                        background: canBill ? 'var(--success)' : 'var(--text-muted)',
                        color: '#fff', border: 'none', cursor: canBill ? 'pointer' : 'default',
                      }}
                    >{billing ? 'Creating bill…' : 'Create Bill in NetSuite'}</button>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', alignSelf: 'center' }}>or paste an existing one:</span>
                    <input
                      value={payoutBillDrafts[p.id] || ''}
                      onChange={e => setPayoutBillDrafts(prev => ({ ...prev, [p.id]: e.target.value }))}
                      placeholder="NetSuite Bill ID"
                      style={{
                        flex: 1, minWidth: '120px', padding: '7px 10px', borderRadius: '8px', fontSize: '12px',
                        border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-body)',
                      }}
                    />
                    <button
                      onClick={() => payoutAction({ action: 'record_bill', payoutId: p.id, netsuiteBillId: (payoutBillDrafts[p.id] || '').trim() })}
                      disabled={payoutBusy || !(payoutBillDrafts[p.id] || '').trim()}
                      style={{
                        padding: '7px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                        background: (payoutBillDrafts[p.id] || '').trim() ? 'var(--orange)' : 'var(--text-muted)',
                        color: '#fff', border: 'none',
                      }}
                    >Record Bill</button>
                  </>
                  );
                })()}
                {p.status === 'billed' && (
                  <button onClick={() => payoutAction({ action: 'mark_paid', payoutId: p.id })} disabled={payoutBusy} style={{
                    padding: '7px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                    background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                  }}>Mark Paid</button>
                )}
              </div>
            </div>
          ))}

          {/* Pending (not yet on a payout) */}
          {(payoutData?.pending || []).length > 0 && (
            <>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', margin: '10px 0 6px' }}>
                NOT YET ON A PAYOUT
              </div>
              {[...(payoutData?.pending || [])].sort((a, b) =>
                payoutSort === 'name' ? a.profile_name.localeCompare(b.profile_name)
                : payoutSort === 'vehicles' ? b.vehicles - a.vehicles
                : b.total - a.total,
              ).map(p => (
                <div key={p.profile_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', fontSize: '12px' }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                    {p.profile_name}
                    {!p.netsuite_vendor_id && <span style={{ color: 'var(--warning)', fontWeight: 600 }}> (no vendor ID)</span>}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {p.vehicles} vehicle{p.vehicles === 1 ? '' : 's'} ·{' '}
                    <span style={{ fontWeight: 800, color: 'var(--success)' }}>${p.total.toFixed(2)}</span>
                    {p.unpriced > 0 && <span style={{ color: 'var(--warning)' }}> +{p.unpriced} unpriced</span>}
                  </span>
                </div>
              ))}
              <button
                onClick={() => payoutAction({ action: 'generate', cniJobId: job.id })}
                disabled={payoutBusy}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                  marginTop: '8px', background: 'var(--orange)', color: '#fff', border: 'none',
                }}
              >
                {payoutBusy ? 'Working...' : 'Generate Payout Statements'}
              </button>
            </>
          )}

          {(payoutData?.payouts || []).length === 0 && (payoutData?.pending || []).length === 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              No credits yet — payouts generate from completed vehicles.
            </div>
          )}
        </div>
      )}

      {/* Invoice & Closure */}
      {job.invoice_status !== 'none' && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: job.invoice_status === 'submitted'
            ? 'color-mix(in srgb, var(--warning) 8%, var(--card))'
            : 'var(--card)',
          border: job.invoice_status === 'submitted'
            ? '1px solid var(--warning-border)'
            : '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>INVOICE</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            {job.invoice_status === 'submitted' ? 'Submitted — Awaiting Your Review' :
             job.invoice_status === 'approved' ? 'Approved — Create Bill in NetSuite' :
             job.invoice_status === 'billed_in_netsuite' ? 'Billed in NetSuite' : job.invoice_status}
          </div>

          {/* Budget comparison warning */}
          {job.invoice_status === 'submitted' && job.budget && (
            <div style={{
              padding: '8px 12px', borderRadius: '8px', marginBottom: '10px',
              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
              fontSize: '12px', color: 'var(--text-muted)',
            }}>
              Job Budget: <strong style={{ color: 'var(--success)' }}>${Number(job.budget).toLocaleString()}</strong>
              <span style={{ marginLeft: '8px', fontSize: '11px' }}>
                (Review invoice against this amount)
              </span>
            </div>
          )}

          {/* Invoice file link */}
          {job.invoice_file_path && (
            <div style={{
              padding: '8px 12px', borderRadius: '8px', marginBottom: '10px',
              background: 'var(--input-bg)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>File</span>
              <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-primary)' }}>
                {job.invoice_file_path.split('/').pop()}
              </div>
            </div>
          )}

          {/* Approve / reject actions for submitted invoices */}
          {job.invoice_status === 'submitted' && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={async () => {
                  setUpdating(true);
                  await supabase.from('cni_jobs').update({
                    invoice_status: 'approved',
                    invoice_approved_at: new Date().toISOString(),
                    invoice_approved_by: user?.id,
                  }).eq('id', job.id);
                  await loadJob();
                  setUpdating(false);
                }}
                disabled={updating}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  background: 'var(--success)', color: '#fff', border: 'none',
                }}
              >
                ✓ Approve Invoice
              </button>
            </div>
          )}

          {/* NetSuite bill ID entry for approved invoices */}
          {job.invoice_status === 'approved' && !job.netsuite_bill_id && (
            <div style={{ marginTop: '8px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                Enter NetSuite Bill ID after creating the bill manually:
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  placeholder="NS Bill ID (e.g. BILL-12345)"
                  value={nsBillId}
                  onChange={e => setNsBillId(e.target.value)}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: '8px',
                    border: '1px solid var(--border)', background: 'var(--input-bg)',
                    color: 'var(--text-body)', fontSize: '13px',
                  }}
                />
                <button
                  onClick={async () => {
                    if (!nsBillId.trim()) return;
                    setUpdating(true);
                    await supabase.from('cni_jobs').update({
                      netsuite_bill_id: nsBillId.trim(),
                      invoice_status: 'billed_in_netsuite',
                    }).eq('id', job.id);
                    setNsBillId('');
                    await loadJob();
                    setUpdating(false);
                  }}
                  disabled={!nsBillId.trim() || updating}
                  style={{
                    padding: '10px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                    background: nsBillId.trim() ? 'var(--orange)' : 'var(--text-muted)',
                    color: '#fff', border: 'none',
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {job.netsuite_bill_id && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
              NetSuite Bill: <strong>{job.netsuite_bill_id}</strong>
            </div>
          )}
        </div>
      )}

      {/* Job Closure Check */}
      {job.status === 'completed_pending_review' && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
          background: 'color-mix(in srgb, var(--success) 5%, var(--card))',
          border: '1px solid var(--success-border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>CLOSURE CHECKLIST</div>
          {(() => {
            const allVinsComplete = vins.length > 0 && vins.every(v => v.status === 'completed');
            const allPhotosApproved = photoStats.total > 0 && photoStats.denied === 0 && photoStats.pending === 0;
            // Individual payout mode has no job invoice — the pay gate is
            // instead "every credit is on an approved-or-beyond payout".
            const individual = job.payout_mode === 'individual';
            const payoutsSettled = individual
              && (payoutData?.pending || []).length === 0
              && (payoutData?.payouts || []).length > 0
              && (payoutData?.payouts || []).every(p => p.status !== 'draft');
            const invoiceApproved = individual
              ? payoutsSettled
              : ['approved', 'billed_in_netsuite'].includes(job.invoice_status);
            const canClose = allVinsComplete && allPhotosApproved && invoiceApproved;

            return (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                  <div style={{ fontSize: '13px', color: allVinsComplete ? 'var(--success)' : 'var(--error)' }}>
                    {allVinsComplete ? '✓' : '✕'} All VINs completed ({vins.filter(v => v.status === 'completed').length}/{vins.length})
                  </div>
                  <div style={{ fontSize: '13px', color: allPhotosApproved ? 'var(--success)' : 'var(--error)' }}>
                    {allPhotosApproved ? '✓' : '✕'} All photos approved ({photoStats.approved}/{photoStats.total})
                  </div>
                  <div style={{ fontSize: '13px', color: invoiceApproved ? 'var(--success)' : 'var(--error)' }}>
                    {individual
                      ? `${invoiceApproved ? '✓' : '✕'} Employee payouts ${invoiceApproved ? 'approved' : 'pending'}`
                      : `${invoiceApproved ? '✓' : '✕'} Invoice ${invoiceApproved ? 'approved' : 'pending'}`}
                  </div>
                </div>
                {canClose ? (
                  <button
                    onClick={() => updateStatus('approved_closed')}
                    disabled={updating}
                    style={{
                      width: '100%', padding: '12px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
                      background: 'var(--success)', color: '#fff', border: 'none',
                    }}
                  >
                    Close Job — All Requirements Met
                  </button>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    Complete all checklist items above before closing this job
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Status History */}
      <button
        onClick={() => setShowHistory(!showHistory)}
        style={{
          width: '100%', padding: '12px 16px', borderRadius: '12px', textAlign: 'left',
          background: 'var(--card)', border: '1px solid var(--border)', marginBottom: '14px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>
          STATUS HISTORY ({history.length})
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{showHistory ? '▲' : '▼'}</span>
      </button>
      {showHistory && history.length > 0 && (
        <div style={{
          padding: '14px 16px', borderRadius: '12px', marginBottom: '14px', marginTop: '-8px',
          background: 'var(--card)', border: '1px solid var(--border)',
        }}>
          {history.map(h => (
            <div key={h.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600 }}>
                {STATUS_LABELS[h.to_status] || h.to_status}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {h.changer_name || 'System'} • {new Date(h.created_at).toLocaleString()}
              </div>
              {h.note && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{h.note}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Invite Company Modal */}
      {showInvite && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }}>
          <div style={{
            background: 'var(--card)', borderRadius: '16px', padding: '20px',
            maxWidth: '400px', width: '100%', maxHeight: '80vh', overflowY: 'auto',
            border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Invite Companies</div>
              <button onClick={() => setShowInvite(false)} style={{ fontSize: '18px', color: 'var(--text-muted)' }}>✕</button>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              Send direct invites — every installer at the company will see the job and can respond
            </div>
            {inviteCompanies.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                No CNI companies available
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {inviteCompanies.map(c => {
                  const alreadyInvited = invitedIds.includes(c.id);
                  return (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 14px', borderRadius: '10px',
                        background: alreadyInvited ? 'color-mix(in srgb, var(--success) 5%, var(--input-bg))' : 'var(--input-bg)',
                        border: alreadyInvited ? '1px solid var(--success-border)' : '1px solid var(--border)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{c.name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {c.memberCount} installer{c.memberCount !== 1 ? 's' : ''}
                        </div>
                      </div>
                      {alreadyInvited ? (
                        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--success)' }}>✓ Invited</span>
                      ) : (
                        <button
                          onClick={() => sendInvite(c.id)}
                          disabled={updating}
                          style={{
                            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                            background: 'var(--orange)', color: '#fff', border: 'none',
                          }}
                        >
                          Invite
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import already-scanned vehicles modal */}
      {importOpen && (
        <div onClick={() => setImportOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '16px', padding: '20px', maxWidth: '460px', width: '100%', maxHeight: '88vh', overflowY: 'auto', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>Import Scanned Vehicles</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              Pull in vehicles already in the scan log that aren&apos;t on any CNI job. By default this matches the job&apos;s part (<strong>{job.part_number || '—'}</strong>); search another part (e.g. <strong>rfid</strong>) to find scans logged under a different name. Imported scans are re-stamped to this job&apos;s part.
            </div>

            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              <input
                value={importPartLike}
                onChange={e => setImportPartLike(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') searchImport(); }}
                placeholder={`Part contains… (default: ${job.part_number || 'job part'})`}
                style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }}
              />
              <button onClick={searchImport} style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--subtle-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>Search</button>
            </div>

            {importCandidates.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No unattached scans match. Try a different part above (e.g. &ldquo;rfid&rdquo;).</div>
            ) : (
            <>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <button onClick={() => setImportSel(new Set(importCandidates.map(c => c.scanLogId)))} style={{ fontSize: '11px', fontWeight: 700, color: 'var(--orange)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Select all</button>
              <button onClick={() => setImportSel(new Set())} style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Clear</button>
            </div>

            {importCandidates.map(c => {
              const checked = importSel.has(c.scanLogId);
              return (
                <div key={c.scanLogId} onClick={() => { const n = new Set(importSel); if (checked) n.delete(c.scanLogId); else n.add(c.scanLogId); setImportSel(n); }}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', borderRadius: '8px', marginBottom: '5px', cursor: 'pointer', background: checked ? 'var(--success-bg)' : 'var(--input-bg)', border: checked ? '1px solid var(--success-border)' : '1px solid var(--border)' }}>
                  <div style={{ width: '18px', height: '18px', borderRadius: '5px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: checked ? '2px solid var(--success)' : '2px solid var(--border)', background: checked ? 'var(--success)' : 'transparent', color: '#fff', fontSize: '11px', fontWeight: 800 }}>{checked ? '✓' : ''}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{c.vin}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      {c.vehicle || '—'} · {new Date(c.scanned_at).toLocaleDateString()} · {c.scanned_by_name}
                      {!c.hasDevices && <span style={{ color: 'var(--warning)' }}> · no device IDs</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            </>
            )}

            {importError && <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{importError}</div>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              <button onClick={submitImport} disabled={importBusy || importSel.size === 0} style={{
                flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                background: importBusy || importSel.size === 0 ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
              }}>{importBusy ? 'Importing...' : `Import ${importSel.size} Vehicle${importSel.size === 1 ? '' : 's'}`}</button>
              <button onClick={() => setImportOpen(false)} disabled={importBusy} style={{ padding: '12px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Camera scanner overlay for the Add Vehicle form */}
      {scanReq && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 320, background: 'rgba(0,0,0,0.9)', display: 'flex', flexDirection: 'column', padding: '16px', paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))' }}>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: '16px', marginBottom: '4px' }}>Scan {scanReq.label}</div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px', marginBottom: '12px' }}>Point the camera at the barcode. It fills in automatically.</div>
          <VinScanner
            onScan={handleScanResult}
            theme={theme as unknown as Record<string, string>}
            validate={scanReq.validate}
            scanLabel={scanReq.label}
          />
          <button onClick={() => setScanReq(null)} style={{ marginTop: '14px', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 700, background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)' }}>Cancel</button>
        </div>
      )}

      {/* Add Completed Vehicle (never-scanned) modal */}
      {addVinOpen && (() => {
        const deviceJob = isVerizonRfidPart(job.part_number) || !!(job as any).device_capture;
        const people = addRoster;
        return (
        <div onClick={() => setAddVinOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '16px', padding: '20px', maxWidth: '440px', width: '100%', maxHeight: '88vh', overflowY: 'auto', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>Add a Completed Vehicle</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              For a vehicle that was installed but never scanned. It&apos;s added to the job as completed, logged to the scan log, and credited to the crew you pick.
            </div>

            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              <input value={addForm.vin} onChange={e => setAddForm(f => ({ ...f, vin: e.target.value.toUpperCase() }))} placeholder="VIN" maxLength={17}
                style={{ flex: 1, padding: '10px 12px', borderRadius: '8px', fontSize: '14px', fontFamily: 'monospace', letterSpacing: '0.5px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }} />
              <button onClick={() => setScanReq({ label: 'VIN', apply: v => setAddForm(f => ({ ...f, vin: v.toUpperCase() })) })} title="Scan VIN" style={{ flexShrink: 0, padding: '0 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: 'var(--orange)', color: '#fff', border: 'none' }}>Scan</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginBottom: '8px' }}>
              <input value={addForm.vehicle_year} onChange={e => setAddForm(f => ({ ...f, vehicle_year: e.target.value }))} placeholder="Year" style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }} />
              <input value={addForm.vehicle_make} onChange={e => setAddForm(f => ({ ...f, vehicle_make: e.target.value }))} placeholder="Make" style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }} />
              <input value={addForm.vehicle_model} onChange={e => setAddForm(f => ({ ...f, vehicle_model: e.target.value }))} placeholder="Model" style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }} />
            </div>

            {deviceJob && (
              <div style={{ marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>DEVICE IDS {addSkipDevices ? '(skipped)' : '(required)'}</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={addSkipDevices} onChange={e => setAddSkipDevices(e.target.checked)} style={{ cursor: 'pointer' }} />
                    No device IDs — credit anyway
                  </label>
                </div>
                {addSkipDevices ? (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '4px 0 2px' }}>
                    The VIN will be logged and credited without serial / IMEI / CCID. Add them later from the vehicle&apos;s device editor.
                  </div>
                ) : ([
                  { ph: 'Serial #', field: 'serial_number' as const, label: 'Serial #', validate: validateSerial },
                  { ph: 'IMEI (15 digits)', field: 'imei' as const, label: 'IMEI', validate: validateImei },
                  { ph: 'CCID (18–22 digits)', field: 'iccid' as const, label: 'CCID', validate: validateIccid },
                ]).map(d => (
                  <div key={d.field} style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                    <input value={addForm[d.field]} onChange={e => setAddForm(f => ({ ...f, [d.field]: e.target.value }))} placeholder={d.ph}
                      style={{ flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '13px', fontFamily: 'monospace', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)' }} />
                    <button onClick={() => setScanReq({ label: d.label, validate: d.validate, apply: v => setAddForm(f => ({ ...f, [d.field]: v })) })} title={`Scan ${d.ph}`} style={{ flexShrink: 0, padding: '0 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'var(--subtle-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>Scan</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>WHO INSTALLED IT? (credit)</div>
            {people.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>No installers found for the assigned company.</div>
            ) : people.map(p => {
              const checked = addCrew.has(p.profile_id);
              return (
                <div key={p.profile_id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '8px', marginBottom: '5px', background: checked ? 'var(--success-bg)' : 'var(--input-bg)', border: checked ? '1px solid var(--success-border)' : '1px solid var(--border)' }}>
                  <button onClick={() => { const next = new Map(addCrew); if (checked) next.delete(p.profile_id); else next.set(p.profile_id, 1); setAddCrew(next); }}
                    style={{ width: '20px', height: '20px', borderRadius: '5px', flexShrink: 0, border: checked ? '2px solid var(--success)' : '2px solid var(--border)', background: checked ? 'var(--success)' : 'transparent', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: 'pointer' }}>{checked ? '✓' : ''}</button>
                  <div style={{ flex: 1, fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{p.full_name}</div>
                  {checked && (
                    <input type="number" min="0.5" step="0.5" value={addCrew.get(p.profile_id)}
                      onChange={e => { const w = parseFloat(e.target.value); if (!isNaN(w) && w > 0) setAddCrew(new Map(addCrew).set(p.profile_id, w)); }}
                      style={{ width: '54px', padding: '5px 8px', borderRadius: '6px', fontSize: '13px', fontWeight: 700, textAlign: 'center', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)' }} />
                  )}
                </div>
              );
            })}

            {addError && <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{addError}</div>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              <button onClick={submitAddVin} disabled={addBusy || !addForm.vin.trim() || addCrew.size === 0} style={{
                flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                background: addBusy || !addForm.vin.trim() || addCrew.size === 0 ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
              }}>{addBusy ? 'Adding...' : 'Add & Credit Vehicle'}</button>
              <button onClick={() => setAddVinOpen(false)} disabled={addBusy} style={{ padding: '12px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>Cancel</button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Assign Company Modal */}
      {showAssign && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }}>
          <div style={{
            background: 'var(--card)', borderRadius: '16px', padding: '20px',
            maxWidth: '400px', width: '100%', maxHeight: '80vh', overflowY: 'auto',
            border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Assign Installation Company</div>
              <button onClick={() => setShowAssign(false)} style={{ fontSize: '18px', color: 'var(--text-muted)' }}>✕</button>
            </div>
            {companies.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                No CNI companies available
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {companies.map(c => (
                  <button
                    key={c.id}
                    onClick={() => assignCompany(c.id)}
                    disabled={updating}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', borderRadius: '10px', textAlign: 'left', width: '100%',
                      background: 'var(--input-bg)', border: '1px solid var(--border)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{c.name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {c.memberCount} installer{c.memberCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    <span style={{ color: 'var(--orange)', fontWeight: 700, fontSize: '12px' }}>Assign →</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
