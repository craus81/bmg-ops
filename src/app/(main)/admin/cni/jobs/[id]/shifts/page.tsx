'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import NumberInput from '@/components/NumberInput';

interface Member { profile_id: string; full_name: string; share_weight: number }
interface Credit {
  id: string;
  shift_id: string;
  profile_id: string;
  profile_name: string;
  scan_log_id: string | null;
  cni_job_vin_id: string | null;
  vin: string | null;
  rate_per_vehicle: number | null;
  share_weight: number;
  crew_size: number;
  amount: number | null;
  payout_id: string | null;
  created_at: string;
  edited_at: string | null;
}
interface Shift {
  id: string;
  started_by_name: string;
  started_at: string;
  ended_at: string | null;
  members: Member[];
  credits: Credit[];
}
interface CompletedVin {
  id: string;
  vin: string;
  vehicle: string;
  completed_at: string | null;
  scannedBy: string | null;
  scannedByName: string | null;
}

/**
 * Admin crew & pay editor for one CNI job: every shift with its roster and
 * per-vehicle credit snapshots. Two correction levels (see pay-credits.ts):
 * edit a shift's roster then recompute all its unlocked vehicles, or rewrite
 * a single vehicle's split. Credits on a payout are locked.
 */
export default function CniJobShiftsPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { isAdmin, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [roster, setRoster] = useState<{ profile_id: string; full_name: string }[]>([]);
  const [jobTitle, setJobTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Shift roster editor
  const [editShift, setEditShift] = useState<Shift | null>(null);
  const [draft, setDraft] = useState<Map<string, number>>(new Map());

  // Per-vehicle editor: key = scan_log_id || cni_job_vin_id
  const [editVehicle, setEditVehicle] = useState<{ credits: Credit[] } | null>(null);
  const [vehicleDraft, setVehicleDraft] = useState<Map<string, number>>(new Map());

  // Retroactive back-pay: completed vehicles that have no credits yet (work
  // done before crew tagging existed).
  const [uncoveredCount, setUncoveredCount] = useState(0);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillDraft, setBackfillDraft] = useState<Map<string, number>>(new Map());

  // Per-vehicle installer tagging: every completed VIN, assignable one at a time.
  const [completedVins, setCompletedVins] = useState<CompletedVin[]>([]);
  const [assignVin, setAssignVin] = useState<CompletedVin | null>(null);
  const [assignDraft, setAssignDraft] = useState<Map<string, number>>(new Map());

  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    } as Record<string, string>;
  };

  const load = useCallback(async () => {
    const headers = await authHeaders();
    const [creditsRes, shiftRes, jobRes] = await Promise.all([
      fetch(`/api/admin/credits?cniJobId=${jobId}`, { headers }),
      fetch(`/api/shifts?cniJobId=${jobId}`, { headers }),
      supabase.from('cni_jobs').select('title, job_number, pay_per_vehicle').eq('id', jobId).single(),
    ]);
    const loadedShifts: Shift[] = creditsRes.ok ? ((await creditsRes.json()).shifts || []) : [];
    setShifts(loadedShifts);
    if (shiftRes.ok) setRoster((await shiftRes.json()).roster || []);
    if (jobRes.data) setJobTitle(`${jobRes.data.job_number} — ${jobRes.data.title}`);

    // Completed vehicles with no live credits yet → candidates for back-pay.
    const credited = new Set<string>();
    for (const s of loadedShifts) for (const c of s.credits) if (c.cni_job_vin_id) credited.add(c.cni_job_vin_id);
    const { data: completed } = await supabase
      .from('cni_job_vins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, completed_at, completed_by')
      .eq('job_id', jobId).eq('status', 'completed')
      .order('completed_at', { ascending: true });
    const completedRows = (completed || []) as {
      id: string; vin: string; vehicle_year: string | null; vehicle_make: string | null;
      vehicle_model: string | null; completed_at: string | null; completed_by: string | null;
    }[];
    // Resolve the name of whoever scanned/completed each vehicle, so vehicles
    // brought in from outside the CNI tab can be paid to the person who did it.
    const scannerIds = [...new Set(completedRows.map(v => v.completed_by).filter(Boolean))] as string[];
    const scannerNames = new Map<string, string>();
    if (scannerIds.length > 0) {
      const { data: sp } = await supabase.from('profiles').select('id, full_name').in('id', scannerIds);
      for (const p of sp || []) scannerNames.set(p.id, p.full_name);
    }
    setCompletedVins(completedRows.map(v => ({
      id: v.id,
      vin: v.vin,
      vehicle: [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' '),
      completed_at: v.completed_at,
      scannedBy: v.completed_by,
      scannedByName: v.completed_by ? (scannerNames.get(v.completed_by) || null) : null,
    })));
    setUncoveredCount(completedRows.filter(v => !credited.has(v.id)).length);

    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAdmin, jobId]);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  // ── Retroactive back-pay for already-completed vehicles ──
  const openBackfill = () => {
    setBackfillDraft(new Map());
    setError('');
    setBackfillOpen(true);
  };

  const applyBackfill = async () => {
    if (backfillDraft.size === 0) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/credits', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({
          action: 'backfill_job',
          cniJobId: jobId,
          entries: [...backfillDraft.entries()].map(([profileId, weight]) => ({ profileId, weight })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Back-pay failed'); return; }
      setBackfillOpen(false);
      flash(`Backfilled ${json.created} vehicle${json.created === 1 ? '' : 's'}${json.skipped ? `, skipped ${json.skipped} already credited` : ''}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  // ── Shift roster edit + recompute ──
  const openShiftEditor = (s: Shift) => {
    setDraft(new Map(s.members.map(m => [m.profile_id, m.share_weight])));
    setError('');
    setEditShift(s);
  };

  const applyShiftEdit = async () => {
    if (!editShift) return;
    setBusy(true);
    setError('');
    try {
      const headers = await authHeaders();
      const current = new Map(editShift.members.map(m => [m.profile_id, m.share_weight]));
      const add = [...draft.entries()].filter(([id]) => !current.has(id)).map(([profileId, weight]) => ({ profileId, weight }));
      const remove = [...current.keys()].filter(id => !draft.has(id));
      const setWeight = [...draft.entries()]
        .filter(([id, w]) => current.has(id) && current.get(id) !== w)
        .map(([profileId, weight]) => ({ profileId, weight }));

      const memRes = await fetch('/api/shifts/members', {
        method: 'POST', headers,
        body: JSON.stringify({ shiftId: editShift.id, add, remove, setWeight }),
      });
      const memJson = await memRes.json().catch(() => ({}));
      if (!memRes.ok) { setError(memJson.error || 'Failed to update roster'); return; }

      const rcRes = await fetch('/api/admin/credits', {
        method: 'POST', headers,
        body: JSON.stringify({ action: 'recompute_shift', shiftId: editShift.id }),
      });
      const rcJson = await rcRes.json().catch(() => ({}));
      if (!rcRes.ok) { setError(rcJson.error || 'Roster saved but recompute failed'); return; }

      setEditShift(null);
      flash(`Roster updated — ${rcJson.rewritten} vehicle${rcJson.rewritten === 1 ? '' : 's'} recomputed${rcJson.lockedSkipped ? `, ${rcJson.lockedSkipped} locked (paid out) skipped` : ''}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const endShiftNow = async (s: Shift) => {
    setBusy(true);
    try {
      await fetch('/api/shifts/end', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ shiftId: s.id }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  // ── Per-vehicle edit ──
  const openVehicleEditor = (credits: Credit[]) => {
    setVehicleDraft(new Map(credits.map(c => [c.profile_id, Number(c.share_weight)])));
    setError('');
    setEditVehicle({ credits });
  };

  const applyVehicleEdit = async () => {
    if (!editVehicle) return;
    const tpl = editVehicle.credits[0];
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/credits', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({
          action: 'rewrite_vehicle',
          scanLogId: tpl.scan_log_id,
          cniJobVinId: tpl.cni_job_vin_id,
          entries: [...vehicleDraft.entries()].map(([profileId, weight]) => ({ profileId, weight })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Failed to rewrite credits'); return; }
      setEditVehicle(null);
      flash('Vehicle split updated');
      await load();
    } finally {
      setBusy(false);
    }
  };

  // ── Per-vehicle installer tagging ──
  const openAssign = (v: CompletedVin, currentCredits: Credit[]) => {
    if (currentCredits.length > 0) {
      // Editing an existing split — start from who's already credited.
      setAssignDraft(new Map(currentCredits.map(c => [c.profile_id, Number(c.share_weight)])));
    } else if (v.scannedBy) {
      // Unassigned — default to paying whoever scanned it (the common case for
      // vehicles imported from outside the CNI tab). Admin can still adjust.
      setAssignDraft(new Map([[v.scannedBy, 1]]));
    } else {
      setAssignDraft(new Map());
    }
    setError('');
    setAssignVin(v);
  };

  const applyAssign = async () => {
    if (!assignVin || assignDraft.size === 0) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/credits', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({
          action: 'assign_vehicle',
          cniJobVinId: assignVin.id,
          entries: [...assignDraft.entries()].map(([profileId, weight]) => ({ profileId, weight })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Failed to assign installer'); return; }
      setAssignVin(null);
      flash('Installer tagged for vehicle');
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  // Per-person totals across the job (live credits only — voided are excluded
  // server-side).
  const totals = new Map<string, { name: string; vehicles: number; amount: number; unpriced: number }>();
  for (const s of shifts) {
    for (const c of s.credits) {
      const t = totals.get(c.profile_id) || { name: c.profile_name, vehicles: 0, amount: 0, unpriced: 0 };
      t.vehicles++;
      if (c.amount != null) t.amount += Number(c.amount);
      else t.unpriced++;
      totals.set(c.profile_id, t);
    }
  }

  // Live credits keyed by completed VIN id, for the per-vehicle tagging list.
  const creditsByVin = new Map<string, Credit[]>();
  for (const s of shifts) {
    for (const c of s.credits) {
      if (!c.cni_job_vin_id) continue;
      const arr = creditsByVin.get(c.cni_job_vin_id) || [];
      arr.push(c);
      creditsByVin.set(c.cni_job_vin_id, arr);
    }
  }

  // Group a shift's credits by vehicle.
  const vehicleGroups = (s: Shift): Credit[][] => {
    const groups = new Map<string, Credit[]>();
    for (const c of s.credits) {
      const key = c.scan_log_id || c.cni_job_vin_id || c.id;
      const arr = groups.get(key) || [];
      arr.push(c);
      groups.set(key, arr);
    }
    return [...groups.values()];
  };

  const weightEditor = (
    map: Map<string, number>,
    setMap: (m: Map<string, number>) => void,
    people: { profile_id: string; full_name: string }[],
  ) => (
    <div>
      {people.map(p => {
        const checked = map.has(p.profile_id);
        return (
          <div key={p.profile_id} style={{
            display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
            borderRadius: '10px', marginBottom: '6px',
            background: checked ? 'var(--success-bg)' : 'var(--input-bg)',
            border: checked ? '1px solid var(--success-border)' : '1px solid var(--border)',
          }}>
            <button
              onClick={() => {
                const next = new Map(map);
                if (checked) next.delete(p.profile_id); else next.set(p.profile_id, 1);
                setMap(next);
              }}
              style={{
                width: '22px', height: '22px', borderRadius: '6px', flexShrink: 0,
                border: checked ? '2px solid var(--success)' : '2px solid var(--border)',
                background: checked ? 'var(--success)' : 'transparent',
                color: '#fff', fontSize: '13px', fontWeight: 800, cursor: 'pointer',
              }}
            >{checked ? '✓' : ''}</button>
            <div style={{ flex: 1, fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{p.full_name}</div>
            {checked && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>share</span>
                <NumberInput
                  min="0.5" step="0.5" value={map.get(p.profile_id)}
                  onChange={e => {
                    const w = parseFloat(e.target.value);
                    if (!isNaN(w) && w > 0) setMap(new Map(map).set(p.profile_id, w));
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
      })}
    </div>
  );

  // People available in editors: company roster plus anyone already credited
  // or on a shift (covers legacy installers not yet linked to the company).
  const editorPeople = (extra: { profile_id: string; full_name: string }[]) => {
    const byId = new Map(roster.map(r => [r.profile_id, r.full_name]));
    for (const p of extra) if (!byId.has(p.profile_id)) byId.set(p.profile_id, p.full_name);
    return [...byId.entries()].map(([profile_id, full_name]) => ({ profile_id, full_name }));
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push(`/admin/cni/jobs/${jobId}`)} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Crew &amp; Pay</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{jobTitle}</div>
        </div>
      </div>

      {notice && (
        <div style={{ padding: '10px 14px', borderRadius: '10px', marginBottom: '12px', background: 'var(--success-bg)', border: '1px solid var(--success-border)', color: 'var(--success)', fontSize: '12px', fontWeight: 700 }}>
          ✓ {notice}
        </div>
      )}

      {/* Per-person totals */}
      {totals.size > 0 && (
        <div style={{ padding: '14px 16px', borderRadius: '12px', marginBottom: '14px', background: 'var(--card)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>EARNINGS ON THIS JOB</div>
          {[...totals.values()].sort((a, b) => b.amount - a.amount).map(t => (
            <div key={t.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{t.name}</div>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                {t.vehicles} vehicle{t.vehicles === 1 ? '' : 's'} ·{' '}
                <span style={{ fontWeight: 800, color: 'var(--success)' }}>${t.amount.toFixed(2)}</span>
                {t.unpriced > 0 && <span style={{ color: 'var(--warning)' }}> +{t.unpriced} unpriced</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Retroactive back-pay for vehicles completed before crew tagging */}
      {uncoveredCount > 0 && (
        <div style={{ padding: '14px 16px', borderRadius: '12px', marginBottom: '14px', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--warning)', marginBottom: '2px' }}>
            {uncoveredCount} completed vehicle{uncoveredCount === 1 ? '' : 's'} with no pay yet
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
            These were finished before the crew was tagged. Pick who worked the job and their shares — pay
            splits across them for each of these vehicles at the job&apos;s per-vehicle rate.
          </div>
          <button onClick={openBackfill} disabled={busy} style={{
            padding: '10px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
            background: 'var(--orange)', color: '#fff', border: 'none',
          }}>Back-Pay These Vehicles</button>
        </div>
      )}

      {/* Per-vehicle installer tagging */}
      {completedVins.length > 0 && (
        <div style={{ padding: '14px 16px', borderRadius: '12px', marginBottom: '14px', background: 'var(--card)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>VEHICLES — TAG AN INSTALLER</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            Assign who completed each vehicle one at a time. The per-vehicle rate splits across whoever you tag.
          </div>
          {completedVins.map(v => {
            const credits = creditsByVin.get(v.id) || [];
            const locked = credits.some(c => c.payout_id);
            const assigned = credits.length > 0;
            return (
              <div key={v.id} style={{
                padding: '10px 12px', borderRadius: '10px', marginBottom: '6px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{v.vin}</div>
                    {v.vehicle && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{v.vehicle}</div>}
                  </div>
                  {locked ? (
                    <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', flexShrink: 0 }}>locked (paid out)</span>
                  ) : (
                    <button onClick={() => openAssign(v, credits)} disabled={busy} style={{
                      padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, flexShrink: 0,
                      background: assigned ? 'var(--subtle-bg)' : 'var(--orange)',
                      color: assigned ? 'var(--text-secondary)' : '#fff',
                      border: assigned ? '1px solid var(--border)' : 'none',
                    }}>{assigned ? 'Reassign' : 'Tag Installer'}</button>
                  )}
                </div>
                <div style={{ marginTop: '6px' }}>
                  {assigned ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {credits.map(c => (
                        <span key={c.id} style={{
                          fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                          background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-primary)',
                        }}>
                          {c.profile_name}: {c.amount != null ? `$${Number(c.amount).toFixed(2)}` : '—'}
                          {Number(c.share_weight) !== 1 ? ` (×${c.share_weight})` : ''}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>Unassigned — no pay yet</span>
                      {v.scannedByName && (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          Scanned by <strong style={{ color: 'var(--text-secondary)' }}>{v.scannedByName}</strong>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Shifts */}
      {shifts.length === 0 ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px' }}>
          No shifts yet — one is created when the crew tags in (or on the first completed vehicle).
        </div>
      ) : shifts.map(s => (
        <div key={s.id} style={{ padding: '14px 16px', borderRadius: '12px', marginBottom: '14px', background: 'var(--card)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                {new Date(s.started_at).toLocaleDateString()} shift
                {!s.ended_at && <span style={{ marginLeft: '8px', fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success-border)' }}>OPEN</span>}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Started by {s.started_by_name} · {new Date(s.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                {s.ended_at ? ` — ended ${new Date(s.ended_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-primary)', marginTop: '4px' }}>
                Crew: <strong>{s.members.map(m => `${m.full_name}${m.share_weight !== 1 ? ` ×${m.share_weight}` : ''}`).join(', ') || '—'}</strong>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
              <button onClick={() => openShiftEditor(s)} disabled={busy} style={{
                padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
              }}>Edit Roster</button>
              {!s.ended_at && (
                <button onClick={() => endShiftNow(s)} disabled={busy} style={{
                  padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                  background: 'transparent', color: 'var(--error)', border: '1px solid var(--error-border)',
                }}>End</button>
              )}
            </div>
          </div>

          {/* Vehicles completed on this shift */}
          {vehicleGroups(s).map(group => {
            const locked = group.some(c => c.payout_id);
            return (
              <div key={group[0].id} style={{
                padding: '10px 12px', borderRadius: '10px', marginBottom: '6px',
                background: 'var(--input-bg)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{group[0].vin || '—'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {group[0].rate_per_vehicle != null ? `$${Number(group[0].rate_per_vehicle).toFixed(2)} ÷ crew` : 'unpriced'}
                      {group[0].edited_at ? ' · edited' : ''}
                      {locked ? ' · locked (paid out)' : ''}
                    </div>
                  </div>
                  {!locked && (
                    <button onClick={() => openVehicleEditor(group)} disabled={busy} style={{
                      padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                      background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                    }}>Edit Split</button>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                  {group.map(c => (
                    <span key={c.id} style={{
                      fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px',
                      background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-primary)',
                    }}>
                      {c.profile_name}: {c.amount != null ? `$${Number(c.amount).toFixed(2)}` : '—'}
                      {Number(c.share_weight) !== 1 ? ` (×${c.share_weight})` : ''}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
          {s.credits.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No vehicles completed on this shift yet.</div>
          )}
        </div>
      ))}

      {/* Back-pay crew picker modal */}
      {backfillOpen && (
        <div onClick={() => setBackfillOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '16px', padding: '20px', maxWidth: '420px', width: '100%', maxHeight: 'calc(85vh / var(--ts))', overflowY: 'auto', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Who worked this job?
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Each of the {uncoveredCount} uncredited vehicle{uncoveredCount === 1 ? '' : 's'} pays out split across the
              people below (even split by default; change a share for an uneven split). Vehicles that already have
              pay are skipped.
            </div>
            {weightEditor(backfillDraft, setBackfillDraft, editorPeople([]))}
            {error && <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{error}</div>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={applyBackfill} disabled={busy || backfillDraft.size === 0} style={{
                flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                background: busy || backfillDraft.size === 0 ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
              }}>{busy ? 'Working...' : 'Back-Pay'}</button>
              <button onClick={() => setBackfillOpen(false)} disabled={busy} style={{
                padding: '12px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Shift roster editor modal */}
      {editShift && (
        <div onClick={() => setEditShift(null)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '16px', padding: '20px', maxWidth: '420px', width: '100%', maxHeight: 'calc(85vh / var(--ts))', overflowY: 'auto', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Edit Shift Roster — {new Date(editShift.started_at).toLocaleDateString()}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Saving recomputes every vehicle on this shift from the new roster/shares.
              Vehicles already on a payout are locked and skipped.
            </div>
            {weightEditor(draft, setDraft, editorPeople(editShift.members))}
            {error && <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{error}</div>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={applyShiftEdit} disabled={busy || draft.size === 0} style={{
                flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                background: busy || draft.size === 0 ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
              }}>{busy ? 'Applying...' : 'Apply & Recompute'}</button>
              <button onClick={() => setEditShift(null)} disabled={busy} style={{
                padding: '12px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Per-vehicle split editor modal */}
      {editVehicle && (
        <div onClick={() => setEditVehicle(null)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '16px', padding: '20px', maxWidth: '420px', width: '100%', maxHeight: 'calc(85vh / var(--ts))', overflowY: 'auto', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Edit Split — <span style={{ fontFamily: 'monospace' }}>{editVehicle.credits[0].vin}</span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              {editVehicle.credits[0].rate_per_vehicle != null
                ? `$${Number(editVehicle.credits[0].rate_per_vehicle).toFixed(2)} splits across the people below by share.`
                : 'Unpriced — the split records who gets credit; amounts fill in when the rate is set.'}
              {' '}Only this vehicle changes.
            </div>
            {weightEditor(vehicleDraft, setVehicleDraft, editorPeople(editVehicle.credits.map(c => ({ profile_id: c.profile_id, full_name: c.profile_name }))))}
            {error && <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{error}</div>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={applyVehicleEdit} disabled={busy || vehicleDraft.size === 0} style={{
                flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                background: busy || vehicleDraft.size === 0 ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
              }}>{busy ? 'Saving...' : 'Save Split'}</button>
              <button onClick={() => setEditVehicle(null)} disabled={busy} style={{
                padding: '12px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Per-vehicle assign-installer modal */}
      {assignVin && (
        <div onClick={() => setAssignVin(null)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', borderRadius: '16px', padding: '20px', maxWidth: '420px', width: '100%', maxHeight: 'calc(85vh / var(--ts))', overflowY: 'auto', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Tag Installer — <span style={{ fontFamily: 'monospace' }}>{assignVin.vin}</span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Pick who completed this vehicle. The per-vehicle rate splits across them by share (even by default;
              change a share for an uneven split). Only this vehicle changes.
              {assignVin.scannedByName && (
                <> Pre-filled with <strong style={{ color: 'var(--text-secondary)' }}>{assignVin.scannedByName}</strong>, who scanned it.</>
              )}
            </div>
            {weightEditor(assignDraft, setAssignDraft, editorPeople([
              ...(creditsByVin.get(assignVin.id) || []).map(c => ({ profile_id: c.profile_id, full_name: c.profile_name })),
              ...(assignVin.scannedBy && assignVin.scannedByName ? [{ profile_id: assignVin.scannedBy, full_name: assignVin.scannedByName }] : []),
            ]))}
            {error && <div style={{ padding: '8px 12px', borderRadius: '8px', margin: '8px 0', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{error}</div>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button onClick={applyAssign} disabled={busy || assignDraft.size === 0} style={{
                flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                background: busy || assignDraft.size === 0 ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
              }}>{busy ? 'Saving...' : 'Save'}</button>
              <button onClick={() => setAssignVin(null)} disabled={busy} style={{
                padding: '12px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
