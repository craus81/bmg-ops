'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import RfidCapture, { type RfidCompletion } from '@/components/RfidCapture';
import VinScanner from '@/components/VinScanner';
import PartPicker, { type PickedPart } from '@/components/PartPicker';
import { isVerizonRfidPart } from '@/lib/rfid';
import InstallerPreviewBanner from '@/components/InstallerPreviewBanner';
import { getInstallerPreview } from '@/lib/installer-preview';
import JobAttachments from '@/components/JobAttachments';

const STATUS_LABELS: Record<string, string> = {
  assigned_awaiting_scheduling: 'Awaiting Schedule from BMG',
  bidding_open: 'Open for Bids',
  scheduling_proposed: 'Schedule Proposed',
  scheduled_pending_confirmation: 'Accept or Decline Your Schedule',
  scheduled_confirmed: 'Scheduled',
  in_progress: 'In Progress',
  completed_pending_review: 'Under Review',
  approved_closed: 'Completed & Closed',
};

export default function InstallerJobDetailPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { user, isInstaller, isAdmin } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();

  const [job, setJob] = useState<any>(null);
  const [vins, setVins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const [photoCount, setPhotoCount] = useState(0);
  const [unreadMsgCount, setUnreadMsgCount] = useState(0);

  // Verizon RFID device capture (modal, one VIN at a time)
  const [captureVin, setCaptureVin] = useState<any | null>(null);
  // Error from a direct (non-RFID) "Mark Complete"; RFID errors show in the modal.
  const [actionError, setActionError] = useState('');

  // Crew shift (pay splits): the open shift on this job, the company roster
  // for the tag checklist, and the job's per-vehicle rate.
  const [shiftInfo, setShiftInfo] = useState<{
    shift: {
      id: string;
      part_number: string | null;
      part_description: string | null;
      billable_customer: string | null;
      members: { profile_id: string; full_name: string; share_weight: number }[];
    } | null;
    roster: { profile_id: string; full_name: string }[];
    ratePerVehicle: number | null;
  } | null>(null);
  const [crewOpen, setCrewOpen] = useState(false);
  const [crewDraft, setCrewDraft] = useState<Map<string, number>>(new Map());
  const [crewError, setCrewError] = useState('');
  const [crewBusy, setCrewBusy] = useState(false);
  // Part picked for the shift: the start-shift draft, and a mid-shift "change
  // part" panel. Held on the open shift; defaults to the job's part (§1.2).
  const [partDraft, setPartDraft] = useState<PickedPart | null>(null);
  const [changePartOpen, setChangePartOpen] = useState(false);
  const [partBusy, setPartBusy] = useState(false);

  // The job's default part, as a picker value (pre-fills the shift part).
  const jobPart: PickedPart | null = job?.part_number
    ? { part_number: job.part_number, part_description: job.part_description ?? null, billable_customer: job.billable_customer ?? null }
    : null;
  // The part the open shift is scanning under (what actually bills), if any.
  const shiftPart: PickedPart | null = shiftInfo?.shift?.part_number
    ? { part_number: shiftInfo.shift.part_number, part_description: shiftInfo.shift.part_description, billable_customer: shiftInfo.shift.billable_customer }
    : null;
  // The effective part: the shift's choice wins; else the job default. Drives
  // the RFID device-capture UI just like the server keys completion off it.
  const effectivePart = shiftPart || jobPart;
  const isRfidJob = isVerizonRfidPart(effectivePart?.part_number) || !!job?.device_capture;

  // Admin preview: "you"-style displays and crew prechecks follow the
  // previewed installer; actions still happen as the signed-in account.
  const [preview] = useState(() => getInstallerPreview());
  const effectiveId = (isAdmin && preview?.profileId) || user?.id;

  useEffect(() => {
    if (!user) return;
    loadJob();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, jobId]);

  const loadJob = async () => {
    const { data } = await supabase
      .from('cni_jobs')
      .select('*')
      .eq('id', jobId)
      .single();
    if (!data) { router.push('/installer'); return; }
    setJob(data);

    const { data: vinData } = await supabase
      .from('cni_job_vins')
      .select('*')
      .eq('job_id', jobId)
      .order('sort_order');
    setVins(vinData || []);

    // Photo count
    const { count: pCount } = await supabase
      .from('cni_job_photos')
      .select('*', { count: 'exact', head: true })
      .eq('job_id', jobId);
    setPhotoCount(pCount || 0);

    // Unread message count
    if (user) {
      const { count: mCount } = await supabase
        .from('cni_job_messages')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', jobId)
        .neq('sender_id', user.id)
        .is('read_at', null);
      setUnreadMsgCount(mCount || 0);
    }

    setLoading(false);
  };

  // Admin proposes the schedule; the installer accepts it...
  const acceptSchedule = async () => {
    if (!job) return;
    setUpdating(true);
    setActionError('');
    const { error } = await supabase.from('cni_jobs').update({
      schedule_confirmed_at: new Date().toISOString(),
      status: 'scheduled_confirmed',
      updated_by: user?.id,
    }).eq('id', job.id);
    setUpdating(false);
    if (error) { setActionError(error.message); return; }
    await loadJob();
  };

  // ...or declines it (with an optional reason), bouncing it back to the
  // admin to propose a new time.
  const declineSchedule = async () => {
    if (!job) return;
    const note = (await dialog.prompt('Optional: why are you declining this time? (helps BMG pick a new one)')) || null;
    setUpdating(true);
    setActionError('');
    const { error } = await supabase.from('cni_jobs').update({
      status: 'assigned_awaiting_scheduling',
      schedule_decline_note: note,
      scheduled_start_at: null,
      scheduled_end_at: null,
      updated_by: user?.id,
    }).eq('id', job.id);
    setUpdating(false);
    if (error) { setActionError(error.message); return; }
    await loadJob();
  };

  // Complete a VIN via the server route, which logs to scan_logs when the job
  // has a part number (installers can't write scan_logs directly) and advances
  // the job to review once every VIN is done. Returns an error message, or null
  // on success.
  const completeVin = async (
    vinId: string,
    device?: { serial_number: string; imei: string; iccid: string },
  ): Promise<string | null> => {
    if (!job) return 'No job loaded';
    setUpdating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/cni/complete-vin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ jobId: job.id, vinId, ...device }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return json.error || 'Failed to complete VIN';
      await loadJob();
      return null;
    } finally {
      setUpdating(false);
    }
  };

  // ── Crew shift (pay splits) ──
  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    };
  };

  const loadShift = async () => {
    try {
      const res = await fetch(`/api/shifts?cniJobId=${jobId}`, { headers: await authHeaders() });
      if (res.ok) setShiftInfo(await res.json());
    } catch {}
  };

  useEffect(() => {
    if (job?.status === 'in_progress') loadShift();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when the job page (re)loads
  }, [job?.status, jobId]);

  const openCrewPanel = () => {
    const draft = new Map<string, number>();
    if (shiftInfo?.shift) {
      for (const m of shiftInfo.shift.members) draft.set(m.profile_id, m.share_weight);
    } else if (user) {
      draft.set(effectiveId || user.id, 1);
    }
    setCrewDraft(draft);
    // Pre-fill the part: the open shift's choice, else the job's default part.
    setPartDraft(shiftPart || jobPart);
    setCrewError('');
    setCrewOpen(true);
  };

  const saveCrew = async () => {
    if (!user) return;
    setCrewBusy(true);
    setCrewError('');
    try {
      const headers = await authHeaders();
      if (!shiftInfo?.shift) {
        const res = await fetch('/api/shifts', {
          method: 'POST', headers,
          body: JSON.stringify({
            context: 'cni', cniJobId: jobId,
            partNumber: partDraft?.part_number ?? null,
            partDescription: partDraft?.part_description ?? null,
            billableCustomer: partDraft?.billable_customer ?? null,
            members: [...crewDraft.entries()].map(([profileId, weight]) => ({ profileId, weight })),
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setCrewError(json.error || 'Failed to start shift'); return; }
      } else {
        const current = new Map(shiftInfo.shift.members.map(m => [m.profile_id, m.share_weight]));
        const add = [...crewDraft.entries()].filter(([id]) => !current.has(id)).map(([profileId, weight]) => ({ profileId, weight }));
        const remove = [...current.keys()].filter(id => !crewDraft.has(id));
        const setWeight = [...crewDraft.entries()]
          .filter(([id, w]) => current.has(id) && current.get(id) !== w)
          .map(([profileId, weight]) => ({ profileId, weight }));
        const res = await fetch('/api/shifts/members', {
          method: 'POST', headers,
          body: JSON.stringify({ shiftId: shiftInfo.shift.id, add, remove, setWeight }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setCrewError(json.error || 'Failed to update crew'); return; }
      }
      setCrewOpen(false);
      await loadShift();
    } finally {
      setCrewBusy(false);
    }
  };

  const endShift = async () => {
    if (!shiftInfo?.shift) return;
    setCrewBusy(true);
    try {
      await fetch('/api/shifts/end', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ shiftId: shiftInfo.shift.id }),
      });
      await loadShift();
    } finally {
      setCrewBusy(false);
    }
  };

  // Switch the part the open shift scans under (held on the shift, §1.2).
  // Vehicles completed after this bill under the new part; already-logged
  // scans keep theirs.
  const saveShiftPart = async (part: PickedPart | null) => {
    if (!shiftInfo?.shift) return;
    setPartBusy(true);
    try {
      const res = await fetch('/api/shifts/part', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({
          shiftId: shiftInfo.shift.id,
          partNumber: part?.part_number ?? null,
          partDescription: part?.part_description ?? null,
          billableCustomer: part?.billable_customer ?? null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setCrewError(json.error || 'Failed to set the part');
        return;
      }
      setChangePartOpen(false);
      await loadShift();
    } finally {
      setPartBusy(false);
    }
  };

  // Explicit completion: vehicles are scanned as the crew works (no fixed list
  // to "finish"), so the installer says when the job is done. Ends any open
  // shift, then moves the job to review. See docs/cni-redesign.md §2.5.
  const markJobComplete = async () => {
    if (!job) return;
    if (!(await dialog.confirm('Mark this job complete and send it to BMG for review? You can still upload photos afterward.'))) return;
    setUpdating(true);
    try {
      if (shiftInfo?.shift) {
        await fetch('/api/shifts/end', {
          method: 'POST', headers: await authHeaders(),
          body: JSON.stringify({ shiftId: shiftInfo.shift.id }),
        });
      }
      const { error } = await supabase.from('cni_jobs').update({
        status: 'completed_pending_review',
        completed_at: new Date().toISOString(),
        // The 045 status-history trigger logs changed_by = updated_by; without
        // this, installer-driven completions audit as changed_by NULL.
        updated_by: user?.id ?? null,
      }).eq('id', job.id);
      if (error) { setActionError('Failed to mark complete: ' + error.message); return; }
      await loadJob();
    } finally {
      setUpdating(false);
    }
  };

  // Your cut per vehicle on the current crew: rate × your weight / Σ weights.
  const myCut = (() => {
    if (!shiftInfo?.shift || shiftInfo.ratePerVehicle == null || !user) return null;
    const members = shiftInfo.shift.members;
    const me = members.find(m => m.profile_id === effectiveId);
    if (!me) return null;
    const total = members.reduce((s, m) => s + m.share_weight, 0);
    if (total <= 0) return null;
    return (shiftInfo.ratePerVehicle * me.share_weight) / total;
  })();

  const openCapture = (v: any) => { setActionError(''); setCaptureVin(v); };
  const closeCapture = () => setCaptureVin(null);

  // RfidCapture has the VIN already (job-loaded), so it captures SN/IMEI/CCID
  // then hands them here to log. Returns the error string for its review screen.
  const handleRfidComplete = async (d: RfidCompletion): Promise<string | null> => {
    if (!captureVin) return 'No vehicle selected';
    return completeVin(captureVin.id, { serial_number: d.serial_number, imei: d.imei, iccid: d.iccid });
  };

  const markComplete = async (vinId: string) => {
    const err = await completeVin(vinId);
    if (err) setActionError(err);
  };

  // Scan a vehicle straight onto the job (VINs aren't pre-loaded). The server
  // adds it, logs the scan, and credits the active crew shift.
  const [scanNewOpen, setScanNewOpen] = useState(false);
  const [scanNewError, setScanNewError] = useState('');
  const [scanNewBusy, setScanNewBusy] = useState(false);

  const postScanVehicle = async (payload: { vin: string; serial_number?: string; imei?: string; iccid?: string }): Promise<string | null> => {
    if (!job) return 'No job loaded';
    const v = payload.vin.trim().toUpperCase();
    if (v.length < 5) return 'VIN too short';
    setScanNewBusy(true);
    try {
      const res = await fetch('/api/cni/scan-vehicle', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ jobId: job.id, ...payload, vin: v }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return json.error || 'Failed to add vehicle';
      await loadJob();
      return null;
    } finally {
      setScanNewBusy(false);
    }
  };

  // RFID job: RfidCapture scans VIN + SN/IMEI/CCID, then hands them here.
  const handleScanNewRfid = async (d: RfidCompletion): Promise<string | null> => {
    return postScanVehicle({ vin: d.vin, serial_number: d.serial_number, imei: d.imei, iccid: d.iccid });
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const addr = job.address || {};
  const shipAddr = job.shipping_address || {};

  const sectionStyle: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 14px', borderRadius: '10px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', fontSize: '14px',
  };

  return (
    <div>
      <InstallerPreviewBanner preview={isAdmin ? preview : null} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/installer')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>{job.title}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {job.job_number} {job.customer_name ? `• ${job.customer_name}` : ''}
          </div>
        </div>
      </div>

      {/* Status */}
      <div style={{
        ...sectionStyle,
        background: job.status === 'in_progress' ? 'var(--orange-soft)' : 'var(--card)',
        borderColor: job.status === 'in_progress' ? 'var(--orange)' : 'var(--border)',
      }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>STATUS</div>
        <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
          {STATUS_LABELS[job.status] || job.status}
        </div>
      </div>

      {/* Awaiting a schedule from BMG (admin proposes, not the installer) */}
      {job.status === 'assigned_awaiting_scheduling' && (
        <div style={{ ...sectionStyle, background: 'var(--warning-bg)', borderColor: 'var(--warning-border)' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--warning)', marginBottom: '4px' }}>
            Awaiting a Proposed Time
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
            BMG will propose a start date and time. You&apos;ll be able to accept or decline it here.
          </div>
        </div>
      )}

      {/* Action: Accept or Decline the proposed schedule */}
      {job.status === 'scheduled_pending_confirmation' && (
        <div style={{ ...sectionStyle, background: 'var(--success-bg)', borderColor: 'var(--success-border)' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)', marginBottom: '8px' }}>
            Proposed Schedule
          </div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px' }}>
            {job.scheduled_start_at
              ? new Date(job.scheduled_start_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
              : 'Time TBD'}
            {job.scheduled_end_at
              ? ` — ${new Date(job.scheduled_end_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
              : ''}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={acceptSchedule}
              disabled={updating}
              style={{
                flex: 1, padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
                background: 'var(--success)', color: '#fff', border: 'none',
              }}
            >
              {updating ? '...' : 'Accept'}
            </button>
            <button
              onClick={declineSchedule}
              disabled={updating}
              style={{
                padding: '14px 18px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
                background: 'transparent', color: 'var(--error)', border: '1px solid var(--error-border)',
              }}
            >
              Decline
            </button>
          </div>
          {actionError && (
            <div style={{ marginTop: '10px', padding: '8px 12px', borderRadius: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>
              {/column .* does not exist/i.test(actionError)
                ? 'Scheduling isn’t set up in the database yet — ask BMG to run the latest SQL update.'
                : actionError}
            </div>
          )}
        </div>
      )}

      {/* Confirmed Schedule */}
      {job.scheduled_start_at && job.status !== 'scheduled_pending_confirmation' && job.status !== 'assigned_awaiting_scheduling' && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>SCHEDULE</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)' }}>
            {new Date(job.scheduled_start_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {job.scheduled_end_at
              ? ` — ${new Date(job.scheduled_end_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
              : ''}
          </div>
        </div>
      )}

      {/* Project Overview */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>PROJECT OVERVIEW</div>
        {job.scope && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Scope</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>{job.scope}</div>
          </div>
        )}
        {(addr.street || addr.city) && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Install Location</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {[addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')}
            </div>
          </div>
        )}
        {job.site_contact_name && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Site Contact</div>
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginTop: '2px' }}>
              {job.site_contact_name} {job.site_contact_phone ? `• ${job.site_contact_phone}` : ''}
            </div>
          </div>
        )}
        {job.budget && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Budget</div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--success)', marginTop: '2px' }}>
              ${Number(job.budget).toLocaleString()}
            </div>
          </div>
        )}
        {job.deadline && (
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Deadline</div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '2px' }}>
              {new Date(job.deadline).toLocaleDateString()}
            </div>
          </div>
        )}
      </div>

      {/* Files & Proofs (read-only for installers) */}
      {Array.isArray(job.attachments) && job.attachments.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>FILES &amp; PROOFS</div>
          <JobAttachments jobId={job.id} attachments={job.attachments} />
        </div>
      )}

      {/* Material Shipment */}
      {job.requires_shipment && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>MATERIALS</div>
          <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
            {job.material_delivered
              ? 'Materials delivered'
              : job.tracking_number
                ? `In transit — ${job.carrier || ''} ${job.tracking_number}`
                : 'Awaiting shipment'}
          </div>
          {(shipAddr.street || shipAddr.city) && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Ship to: {[shipAddr.street, shipAddr.city, shipAddr.state, shipAddr.zip].filter(Boolean).join(', ')}
            </div>
          )}
          {!job.material_delivered && job.tracking_number && (
            <button
              onClick={async () => {
                setUpdating(true);
                await supabase.from('cni_jobs').update({
                  material_delivered: true,
                  material_delivered_at: new Date().toISOString(),
                }).eq('id', job.id);
                await loadJob();
                setUpdating(false);
              }}
              disabled={updating}
              style={{
                marginTop: '10px', width: '100%', padding: '10px', borderRadius: '8px',
                fontSize: '12px', fontWeight: 700,
                background: 'var(--success)', color: '#fff', border: 'none',
              }}
            >
              ✓ Confirm Materials Received
            </button>
          )}
        </div>
      )}

      {/* Quick Actions: Photos + Messages */}
      {['in_progress', 'scheduled_confirmed', 'completed_pending_review'].includes(job.status) && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <button
            onClick={() => router.push(`/installer/jobs/${job.id}/photos`)}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', textAlign: 'center',
              background: 'var(--card)', border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' }}>Photos</div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>Photos</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{photoCount} uploaded</div>
          </button>
          <button
            onClick={() => router.push(`/installer/jobs/${job.id}/messages`)}
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
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--orange)' }}>{unreadMsgCount} new</div>
            )}
          </button>
        </div>
      )}

      {/* Crew shift (pay splits) */}
      {job.status === 'in_progress' && shiftInfo && (
        <div style={{
          ...sectionStyle,
          background: shiftInfo.shift ? 'var(--success-bg)' : 'var(--card)',
          borderColor: shiftInfo.shift ? 'var(--success-border)' : 'var(--border)',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>CREW SHIFT</div>
          {shiftInfo.shift ? (
            <>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
                On shift: {shiftInfo.shift.members.map(m =>
                  `${m.profile_id === effectiveId ? 'you' : m.full_name}${m.share_weight !== 1 ? ` ×${m.share_weight}` : ''}`
                ).join(' + ')}
              </div>
              {myCut != null && (
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--success)', marginBottom: '8px' }}>
                  ${myCut.toFixed(2)}/vehicle to you ({shiftInfo.shift.members.length === 1 ? 'solo' : `split ${shiftInfo.shift.members.length} ways`})
                </div>
              )}
              {myCut == null && <div style={{ marginBottom: '8px' }} />}
              {/* Part the shift scans under — what each completed vehicle bills. */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                padding: '8px 10px', borderRadius: '8px', marginBottom: '8px',
                background: shiftPart ? 'var(--card)' : 'var(--warning-bg)',
                border: shiftPart ? '1px solid var(--border)' : '1px solid var(--warning-border)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>SCANNING PART</div>
                  {shiftPart ? (
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{shiftPart.part_number}</div>
                  ) : (
                    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--warning)' }}>No part — set one so scans can be billed</div>
                  )}
                </div>
                <button onClick={() => { setCrewError(''); setPartDraft(shiftPart); setChangePartOpen(true); }} disabled={crewBusy || partBusy} style={{
                  padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, flexShrink: 0,
                  background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-primary)',
                }}>{shiftPart ? 'Change Part' : 'Pick Part'}</button>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={openCrewPanel} disabled={crewBusy} style={{
                  flex: 1, padding: '10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-primary)',
                }}>Edit Crew</button>
                <button onClick={endShift} disabled={crewBusy} style={{
                  padding: '10px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
                }}>End Shift</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Tag who&apos;s working before you scan — each completed vehicle splits
                {shiftInfo.ratePerVehicle != null ? ` $${shiftInfo.ratePerVehicle.toFixed(2)}` : ' the per-vehicle pay'} across the crew.
              </div>
              <button onClick={openCrewPanel} style={{
                width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                background: 'var(--orange)', color: '#fff', border: 'none',
              }}>Start Shift — Tag Your Crew</button>
            </>
          )}
        </div>
      )}

      {/* Vehicles — scanned onto the job (nothing pre-loaded) */}
      {(vins.length > 0 || job.status === 'in_progress') && (
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>
              {(() => {
                const done = vins.filter(v => v.status === 'completed').length;
                const target = job.target_quantity as number | null;
                return target
                  ? `VEHICLES (${done} of ${target} · ${Math.max(target - done, 0)} left)`
                  : `VEHICLES (${done}/${vins.length} complete)`;
              })()}
            </div>
            {job.status === 'in_progress' && (
              <button onClick={() => { setScanNewError(''); setScanNewOpen(true); }} style={{
                padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--orange)', color: '#fff', border: 'none',
              }}>+ Scan a Vehicle</button>
            )}
          </div>
          {vins.length === 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '4px 0 8px' }}>
              No vehicles yet — tap <strong>Scan a Vehicle</strong> to scan each one as you complete it.
            </div>
          )}
          {vins.map(v => (
            <div key={v.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 12px', borderRadius: '8px', marginBottom: '6px',
              background: v.status === 'completed' ? 'var(--success-bg)' : 'var(--input-bg)',
              border: v.status === 'completed' ? '1px solid var(--success-border)' : '1px solid var(--border)',
            }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                  {v.vin}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {[v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')}
                </div>
                {v.imei && (
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '2px' }}>
                    IMEI {v.imei}{v.iccid ? ` · CCID ${v.iccid}` : ''}
                  </div>
                )}
              </div>
              {v.status === 'completed' ? (
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--success)' }}>✓ Done</span>
              ) : job.status === 'in_progress' ? (
                <button
                  onClick={() => isRfidJob ? openCapture(v) : markComplete(v.id)}
                  disabled={updating}
                  style={{
                    padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                    background: 'var(--success)', color: '#fff', border: 'none',
                  }}
                >
                  {isRfidJob ? 'Capture & Complete' : 'Mark Complete'}
                </button>
              ) : (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Pending</span>
              )}
            </div>
          ))}
          {actionError && (
            <div style={{ marginTop: '8px', padding: '8px 12px', borderRadius: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{actionError}</div>
          )}
          {job.status === 'in_progress' && (
            <button
              onClick={markJobComplete}
              disabled={updating}
              style={{
                marginTop: '12px', width: '100%', padding: '12px', borderRadius: '10px',
                fontSize: '13px', fontWeight: 700,
                background: 'var(--success)', color: '#fff', border: 'none',
              }}
            >
              ✓ Mark Job Complete
            </button>
          )}
        </div>
      )}

      {/* Invoice — or, on individual-payout jobs, pay statements generated
          from scans (no invoice upload). */}
      {job.payout_mode === 'individual' ? (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>PAY</div>
          <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '10px' }}>
            This job pays each installer individually — your pay statement is generated
            automatically from the vehicles you complete. No invoice upload needed.
          </div>
          <button
            onClick={() => router.push('/earnings')}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'var(--success)', color: '#fff', border: 'none',
            }}
          >
            View My Earnings
          </button>
        </div>
      ) : (
      <div style={sectionStyle}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>INVOICE</div>
        {job.invoice_status === 'none' || !job.invoice_status ? (
          <>
            {['in_progress', 'completed_pending_review'].includes(job.status) ? (
              <button
                onClick={() => router.push(`/installer/jobs/${job.id}/invoice`)}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                  background: 'var(--orange)', color: '#fff', border: 'none',
                }}
              >
                Upload Invoice
              </button>
            ) : (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Invoice upload available once job is in progress
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
              {job.invoice_status === 'submitted' ? 'Submitted — Under Review' :
               job.invoice_status === 'approved' ? 'Approved — Bill Pending' :
               job.invoice_status === 'billed_in_netsuite' ? 'Billed in NetSuite' :
               job.invoice_status}
            </div>
            {job.netsuite_bill_id && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                NetSuite Bill: {job.netsuite_bill_id}
              </div>
            )}
            {job.invoice_status === 'submitted' && (
              <button
                onClick={() => router.push(`/installer/jobs/${job.id}/invoice`)}
                style={{
                  marginTop: '8px', padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
                  background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                }}
              >
                View / Replace Invoice
              </button>
            )}
          </>
        )}
      </div>
      )}

      {/* Crew tag checklist (company roster; weights default to an even split). */}
      {crewOpen && shiftInfo && (
        <div onClick={() => setCrewOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '520px', background: 'var(--card)', borderTopLeftRadius: '18px', borderTopRightRadius: '18px', padding: '16px', maxHeight: '92vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Who&apos;s working this shift?</div>
              <button onClick={() => setCrewOpen(false)} style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Pay splits evenly by default — change a share for an uneven split (2 = double share).
              You can tag and untag people during the shift; it only affects vehicles completed after the change.
            </div>

            {/* Part for this shift — every vehicle you complete bills under it.
                Pre-filled from the job's default; pick another to switch. Only
                shown when starting; mid-shift use "Change Part" on the shift. */}
            {!shiftInfo.shift && (
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>
                  PART FOR THIS SHIFT
                </div>
                <PartPicker value={partDraft} onChange={setPartDraft} />
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Optional — without a part, scans land in the Scan Log flagged “needs part.”
                </div>
              </div>
            )}

            {(() => {
              // Roster plus anyone already on the shift (e.g. legacy installer
              // not yet linked to the company).
              const byId = new Map(shiftInfo.roster.map(r => [r.profile_id, r.full_name]));
              for (const m of shiftInfo.shift?.members || []) {
                if (!byId.has(m.profile_id)) byId.set(m.profile_id, m.full_name);
              }
              if (effectiveId && !byId.has(effectiveId)) byId.set(effectiveId, 'You');
              return [...byId.entries()].map(([id, name]) => {
                const checked = crewDraft.has(id);
                return (
                  <div key={id} style={{
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                    borderRadius: '10px', marginBottom: '6px',
                    background: checked ? 'var(--success-bg)' : 'var(--input-bg)',
                    border: checked ? '1px solid var(--success-border)' : '1px solid var(--border)',
                  }}>
                    <button
                      onClick={() => {
                        const next = new Map(crewDraft);
                        if (checked) next.delete(id); else next.set(id, 1);
                        setCrewDraft(next);
                      }}
                      style={{
                        width: '22px', height: '22px', borderRadius: '6px', flexShrink: 0,
                        border: checked ? '2px solid var(--success)' : '2px solid var(--border)',
                        background: checked ? 'var(--success)' : 'transparent',
                        color: '#fff', fontSize: '13px', fontWeight: 800, cursor: 'pointer',
                      }}
                    >{checked ? '✓' : ''}</button>
                    <div style={{ flex: 1, fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {id === effectiveId ? `${name === 'You' ? 'You' : name + ' (you)'}` : name}
                    </div>
                    {checked && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>share</span>
                        <input
                          type="number" min="0.5" step="0.5" value={crewDraft.get(id)}
                          onChange={e => {
                            const w = parseFloat(e.target.value);
                            if (!isNaN(w) && w > 0) setCrewDraft(new Map(crewDraft).set(id, w));
                          }}
                          style={{
                            width: '56px', padding: '6px 8px', borderRadius: '8px', fontSize: '13px',
                            fontWeight: 700, textAlign: 'center',
                            border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)',
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              });
            })()}

            {crewError && (
              <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{crewError}</div>
            )}

            <button
              onClick={saveCrew}
              disabled={crewBusy || crewDraft.size === 0}
              style={{
                width: '100%', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 800,
                marginTop: '8px', border: 'none', color: '#fff',
                background: crewBusy || crewDraft.size === 0 ? 'var(--text-muted)' : 'var(--success)',
              }}
            >
              {crewBusy ? 'Saving...' : shiftInfo.shift ? 'Update Crew' : `Start Shift (${crewDraft.size} ${crewDraft.size === 1 ? 'person' : 'people'})`}
            </button>
          </div>
        </div>
      )}

      {/* Change the part the open shift scans under (mid-shift, §1.2). */}
      {changePartOpen && shiftInfo?.shift && (
        <div onClick={() => setChangePartOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '520px', background: 'var(--card)', borderTopLeftRadius: '18px', borderTopRightRadius: '18px', padding: '16px', maxHeight: '92vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Part for this shift</div>
              <button onClick={() => setChangePartOpen(false)} style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Vehicles you complete after this bill under the new part. Already-scanned vehicles keep the part they were logged with.
            </div>
            <PartPicker value={partDraft} onChange={setPartDraft} />
            {crewError && (
              <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{crewError}</div>
            )}
            <button
              onClick={() => saveShiftPart(partDraft)}
              disabled={partBusy}
              style={{
                width: '100%', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 800,
                marginTop: '10px', border: 'none', color: '#fff',
                background: partBusy ? 'var(--text-muted)' : 'var(--success)',
              }}
            >
              {partBusy ? 'Saving...' : partDraft ? 'Use This Part' : 'Clear Part'}
            </button>
          </div>
        </div>
      )}

      {/* Verizon RFID device capture modal (VIN known from the job). */}
      {captureVin && (
        <div onClick={closeCapture} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '520px', background: 'var(--card)', borderTopLeftRadius: '18px', borderTopRightRadius: '18px', padding: '16px', maxHeight: '92vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Verizon RFID Capture</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{captureVin.vin}</div>
              </div>
              <button onClick={closeCapture} style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
            </div>

            <RfidCapture
              includeVin={false}
              lockedVin={captureVin.vin}
              onComplete={handleRfidComplete}
              onLogged={closeCapture}
              theme={theme as unknown as Record<string, string>}
            />
          </div>
        </div>
      )}

      {/* Scan a new vehicle onto the job (VINs aren't pre-loaded). */}
      {scanNewOpen && (
        <div onClick={() => setScanNewOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '520px', background: 'var(--card)', borderTopLeftRadius: '18px', borderTopRightRadius: '18px', padding: '16px', maxHeight: '92vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                {isRfidJob ? 'Scan Vehicle & Device' : 'Scan Vehicle'}
              </div>
              <button onClick={() => setScanNewOpen(false)} style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
            </div>

            {scanNewError && (
              <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{scanNewError}</div>
            )}

            {isRfidJob ? (
              <RfidCapture
                includeVin
                onComplete={handleScanNewRfid}
                onLogged={() => setScanNewOpen(false)}
                theme={theme as unknown as Record<string, string>}
              />
            ) : (
              <>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Scan or point the camera at the VIN barcode.</div>
                <VinScanner
                  onScan={async (vin) => {
                    setScanNewError('');
                    const err = await postScanVehicle({ vin });
                    if (err) setScanNewError(err);
                    else setScanNewOpen(false);
                  }}
                  theme={theme as unknown as Record<string, string>}
                />
                {scanNewBusy && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>Saving…</div>}
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
