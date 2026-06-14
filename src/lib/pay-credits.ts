/**
 * Per-vehicle pay credits (docs/pay-splits-design.md).
 *
 * Every completed vehicle writes one install_credits row per crew member on
 * the active shift, snapshotting the rate, weights, and dollar amount at that
 * moment. Snapshots are the source of truth: roster edits or rate changes
 * never silently rewrite history — corrections go through the explicit
 * rewrite/recompute helpers below, which void the old rows (keeping the
 * audit trail) and insert replacements, and refuse to touch credits already
 * linked to a payout.
 *
 * Server-only: callers pass a service-role Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ShiftMember {
  profile_id: string;
  share_weight: number;
}

interface CreditAmount extends ShiftMember {
  amount: number | null;
}

/**
 * Split `rate` across members by weight, in integer cents so the per-vehicle
 * invariant Σ amounts = rate holds exactly. Any rounding remainder lands on
 * the first member. A null rate (field scan with no configured rate yet)
 * yields null amounts — priced later via priceUnpricedCredits.
 */
export function splitAmounts(rate: number | null, members: ShiftMember[]): CreditAmount[] {
  if (rate == null || members.length === 0) {
    return members.map(m => ({ ...m, amount: null }));
  }
  const totalWeight = members.reduce((s, m) => s + Number(m.share_weight), 0);
  const rateCents = Math.round(rate * 100);
  const cents = members.map(m => Math.round((rateCents * Number(m.share_weight)) / totalWeight));
  const remainder = rateCents - cents.reduce((s, c) => s + c, 0);
  cents[0] += remainder;
  return members.map((m, i) => ({ ...m, amount: cents[i] / 100 }));
}

/** The job's open shift (most recently started, not ended), if any. */
export async function getOpenCniShift(service: SupabaseClient, cniJobId: string) {
  const { data } = await service
    .from('work_shifts')
    .select('id, started_by, started_at')
    .eq('cni_job_id', cniJobId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

/**
 * Open shift for the job, creating an implicit solo shift for `userId` if
 * none exists — completing a vehicle without tagging a crew is just a crew
 * of one, and the shift stays open so coworkers can still be tagged in.
 */
export async function ensureCniShift(
  service: SupabaseClient,
  cniJobId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const open = await getOpenCniShift(service, cniJobId);
  if (open) return open;
  const { data: shift, error } = await service
    .from('work_shifts')
    .insert({ context: 'cni', cni_job_id: cniJobId, started_by: userId })
    .select('id')
    .single();
  if (error || !shift) return null;
  await service.from('work_shift_members').insert({
    shift_id: shift.id,
    profile_id: userId,
    added_by: userId,
  });
  return shift;
}

/** Members currently tagged in (not removed). */
export async function getActiveMembers(
  service: SupabaseClient,
  shiftId: string,
): Promise<ShiftMember[]> {
  const { data } = await service
    .from('work_shift_members')
    .select('profile_id, share_weight')
    .eq('shift_id', shiftId)
    .is('removed_at', null);
  return (data || []) as ShiftMember[];
}

export interface CompletionRef {
  scanLogId?: string | null;
  cniJobVinId?: string | null;
  vin: string;
  partNumber?: string | null;
}

/**
 * Snapshot credits for one completed vehicle from the shift's current active
 * roster. Idempotent per vehicle: if live (non-voided) credits already exist
 * for this scan/VIN, nothing is written (re-completions don't double-pay).
 */
export async function createCompletionCredits(
  service: SupabaseClient,
  opts: {
    shiftId: string;
    source: 'cni' | 'field';
    ratePerVehicle: number | null;
    completion: CompletionRef;
  },
): Promise<{ ok: boolean; error?: string }> {
  const { shiftId, source, ratePerVehicle, completion } = opts;

  const ref = completion.scanLogId
    ? { col: 'scan_log_id', val: completion.scanLogId }
    : { col: 'cni_job_vin_id', val: completion.cniJobVinId };
  if (!ref.val) return { ok: false, error: 'Completion reference required' };

  const { data: existing } = await service
    .from('install_credits')
    .select('id')
    .eq(ref.col, ref.val)
    .is('voided_at', null)
    .limit(1);
  if (existing && existing.length > 0) return { ok: true };

  const members = await getActiveMembers(service, shiftId);
  if (members.length === 0) return { ok: false, error: 'Shift has no active members' };

  const totalWeight = members.reduce((s, m) => s + Number(m.share_weight), 0);
  const rows = splitAmounts(ratePerVehicle, members).map(m => ({
    shift_id: shiftId,
    profile_id: m.profile_id,
    scan_log_id: completion.scanLogId ?? null,
    cni_job_vin_id: completion.cniJobVinId ?? null,
    vin: completion.vin,
    part_number: completion.partNumber ?? null,
    source,
    rate_per_vehicle: ratePerVehicle,
    share_weight: m.share_weight,
    crew_size: members.length,
    total_weight: totalWeight,
    amount: m.amount,
  }));

  const { error } = await service.from('install_credits').insert(rows);
  if (error) return { ok: false, error: 'Failed to write pay credits: ' + error.message };
  return { ok: true };
}

/**
 * Retroactively pay out a CNI job whose vehicles were completed before crew
 * tagging existed. Creates one closed "backfill" shift with the given crew and
 * snapshots credits for every completed VIN on the job that doesn't already
 * have live credits (so it's safe to run after a partial tagging, and safe to
 * re-run). Uses the job's pay_per_vehicle; unpriced if that's null.
 */
export async function backfillJobCredits(
  service: SupabaseClient,
  opts: { cniJobId: string; entries: ShiftMember[]; createdBy: string },
): Promise<{ ok: boolean; created: number; skipped: number; error?: string }> {
  const { cniJobId, entries, createdBy } = opts;
  if (entries.length === 0) return { ok: false, created: 0, skipped: 0, error: 'At least one crew member required' };

  const { data: job } = await service
    .from('cni_jobs').select('id, pay_per_vehicle, part_number').eq('id', cniJobId).single();
  if (!job) return { ok: false, created: 0, skipped: 0, error: 'Job not found' };
  const rate = job.pay_per_vehicle != null ? Number(job.pay_per_vehicle) : null;

  const { data: vins } = await service
    .from('cni_job_vins')
    .select('id, vin, status')
    .eq('job_id', cniJobId)
    .eq('status', 'completed');
  if (!vins || vins.length === 0) {
    return { ok: false, created: 0, skipped: 0, error: 'No completed vehicles on this job to pay out' };
  }

  // A closed shift to hang the backfilled credits on.
  const now = new Date().toISOString();
  const { data: shift, error: shiftErr } = await service
    .from('work_shifts')
    .insert({ context: 'cni', cni_job_id: cniJobId, started_by: createdBy, started_at: now, ended_at: now })
    .select('id')
    .single();
  if (shiftErr || !shift) {
    return { ok: false, created: 0, skipped: 0, error: 'Failed to create shift: ' + (shiftErr?.message || 'unknown') };
  }
  const { error: memErr } = await service.from('work_shift_members').insert(
    entries.map(m => ({ shift_id: shift.id, profile_id: m.profile_id, share_weight: m.share_weight, added_by: createdBy })),
  );
  if (memErr) return { ok: false, created: 0, skipped: 0, error: 'Failed to add crew: ' + memErr.message };

  let created = 0;
  let skipped = 0;
  for (const v of vins) {
    // createCompletionCredits skips vehicles that already have live credits.
    const { data: existing } = await service
      .from('install_credits').select('id').eq('cni_job_vin_id', v.id).is('voided_at', null).limit(1);
    if (existing && existing.length > 0) { skipped++; continue; }
    const r = await createCompletionCredits(service, {
      shiftId: shift.id,
      source: 'cni',
      ratePerVehicle: rate,
      completion: { cniJobVinId: v.id, vin: v.vin, partNumber: job.part_number },
    });
    if (!r.ok) return { ok: false, created, skipped, error: r.error };
    created++;
  }
  return { ok: true, created, skipped };
}

/** Field rate lookup: active install_pay_rates row for this part/custom job. */
export async function getFieldRate(
  service: SupabaseClient,
  partNumber: string | null | undefined,
): Promise<number | null> {
  if (!partNumber) return null;
  const { data } = await service
    .from('install_pay_rates')
    .select('rate_per_vehicle')
    .eq('part_number', partNumber)
    .eq('active', true)
    .maybeSingle();
  return data ? Number(data.rate_per_vehicle) : null;
}

/**
 * Admin correction for one vehicle: void its live credits and write a fresh
 * set from `entries` at the same rate. Refuses if any credit is on a payout
 * (locked — void + reissue through the payout flow instead).
 */
export async function rewriteVehicleCredits(
  service: SupabaseClient,
  opts: {
    scanLogId?: string | null;
    cniJobVinId?: string | null;
    entries: ShiftMember[];
    editedBy: string;
    /** Override the rate; defaults to the existing credits' snapshot rate. */
    ratePerVehicle?: number | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const ref = opts.scanLogId
    ? { col: 'scan_log_id', val: opts.scanLogId }
    : { col: 'cni_job_vin_id', val: opts.cniJobVinId };
  if (!ref.val) return { ok: false, error: 'Completion reference required' };
  if (opts.entries.length === 0) return { ok: false, error: 'At least one crew member required' };

  const { data: live } = await service
    .from('install_credits')
    .select('id, shift_id, vin, part_number, source, rate_per_vehicle, payout_id')
    .eq(ref.col, ref.val)
    .is('voided_at', null);
  if (!live || live.length === 0) return { ok: false, error: 'No credits found for this vehicle' };
  if (live.some(c => c.payout_id)) {
    return { ok: false, error: 'Credits are on a payout and locked — void the payout first' };
  }

  const tpl = live[0];
  const rate = opts.ratePerVehicle !== undefined ? opts.ratePerVehicle : (tpl.rate_per_vehicle != null ? Number(tpl.rate_per_vehicle) : null);
  const now = new Date().toISOString();

  const { error: voidErr } = await service
    .from('install_credits')
    .update({ voided_at: now, voided_by: opts.editedBy })
    .in('id', live.map(c => c.id));
  if (voidErr) return { ok: false, error: 'Failed to void credits: ' + voidErr.message };

  const totalWeight = opts.entries.reduce((s, m) => s + Number(m.share_weight), 0);
  const rows = splitAmounts(rate, opts.entries).map(m => ({
    shift_id: tpl.shift_id,
    profile_id: m.profile_id,
    scan_log_id: opts.scanLogId ?? null,
    cni_job_vin_id: opts.cniJobVinId ?? null,
    vin: tpl.vin,
    part_number: tpl.part_number,
    source: tpl.source,
    rate_per_vehicle: rate,
    share_weight: m.share_weight,
    crew_size: opts.entries.length,
    total_weight: totalWeight,
    amount: m.amount,
    edited_by: opts.editedBy,
    edited_at: now,
  }));
  const { error } = await service.from('install_credits').insert(rows);
  if (error) return { ok: false, error: 'Failed to rewrite credits: ' + error.message };
  return { ok: true };
}

/**
 * Admin correction for a whole shift ("Joe wasn't there Tuesday"): rewrite
 * every unlocked vehicle on the shift from the shift's CURRENT active
 * roster/weights, keeping each vehicle's original rate. Locked (paid-out)
 * vehicles are skipped and reported.
 */
export async function recomputeShiftCredits(
  service: SupabaseClient,
  shiftId: string,
  editedBy: string,
): Promise<{ ok: boolean; rewritten: number; lockedSkipped: number; error?: string }> {
  const members = await getActiveMembers(service, shiftId);
  if (members.length === 0) {
    return { ok: false, rewritten: 0, lockedSkipped: 0, error: 'Shift has no active members' };
  }

  const { data: live } = await service
    .from('install_credits')
    .select('scan_log_id, cni_job_vin_id, payout_id')
    .eq('shift_id', shiftId)
    .is('voided_at', null);

  // Group per vehicle; skip any vehicle with a locked credit.
  const groups = new Map<string, { scanLogId: string | null; cniJobVinId: string | null; locked: boolean }>();
  for (const c of live || []) {
    const key = c.scan_log_id || c.cni_job_vin_id!;
    const g = groups.get(key) || { scanLogId: c.scan_log_id, cniJobVinId: c.cni_job_vin_id, locked: false };
    if (c.payout_id) g.locked = true;
    groups.set(key, g);
  }

  let rewritten = 0;
  let lockedSkipped = 0;
  for (const g of groups.values()) {
    if (g.locked) { lockedSkipped++; continue; }
    const r = await rewriteVehicleCredits(service, {
      scanLogId: g.scanLogId,
      cniJobVinId: g.cniJobVinId,
      entries: members,
      editedBy,
    });
    if (!r.ok) return { ok: false, rewritten, lockedSkipped, error: r.error };
    rewritten++;
  }
  return { ok: true, rewritten, lockedSkipped };
}

/**
 * Fill in field credits that were captured before their part had a rate.
 * Groups by vehicle so each group splits the new rate by its stored weights.
 */
export async function priceUnpricedCredits(
  service: SupabaseClient,
  partNumber: string,
  rate: number,
): Promise<{ ok: boolean; priced: number; error?: string }> {
  const { data: rows } = await service
    .from('install_credits')
    .select('id, scan_log_id, cni_job_vin_id, profile_id, share_weight, total_weight')
    .eq('part_number', partNumber)
    .is('amount', null)
    .is('voided_at', null);
  if (!rows || rows.length === 0) return { ok: true, priced: 0 };

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.scan_log_id || r.cni_job_vin_id!;
    const arr = groups.get(key) || [];
    arr.push(r);
    groups.set(key, arr);
  }

  let priced = 0;
  for (const group of groups.values()) {
    const amounts = splitAmounts(rate, group.map(r => ({ profile_id: r.profile_id, share_weight: Number(r.share_weight) })));
    for (let i = 0; i < group.length; i++) {
      const { error } = await service
        .from('install_credits')
        .update({ rate_per_vehicle: rate, amount: amounts[i].amount })
        .eq('id', group[i].id);
      if (error) return { ok: false, priced, error: 'Failed to price credits: ' + error.message };
      priced++;
    }
  }
  return { ok: true, priced };
}
