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
import { partNumberPattern } from './part-number';
import { fetchAllRows } from '@/lib/fetch-all';

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

/**
 * The job's open shift (most recently started, not ended), if any. Carries the
 * part the crew picked for the shift (CNI field-shift model, §1.2) — completion
 * bills under this part, falling back to the job's default when it's null.
 */
export async function getOpenCniShift(service: SupabaseClient, cniJobId: string) {
  const { data } = await service
    .from('work_shifts')
    .select('id, started_by, started_at, part_number, part_description, billable_customer')
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

  // Paginated (R3-1 MAJOR sweep): a big fleet job can pass 1000 completed
  // VINs, and vehicles past the cap silently got no credits. This moves
  // pay — a failed read must abort, not back-pay a partial list.
  const { data: vins, error: vinsErr } = await fetchAllRows<{ id: string; vin: string; status: string }>((from, to) =>
    service
      .from('cni_job_vins')
      .select('id, vin, status')
      .eq('job_id', cniJobId)
      .eq('status', 'completed')
      .order('id')
      .range(from, to));
  if (vinsErr) {
    return { ok: false, created: 0, skipped: 0, error: 'Could not read the job\'s vehicles: ' + vinsErr.message };
  }
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

/**
 * Tag the installer(s) for a single completed vehicle — one VIN at a time
 * instead of bulk back-pay. Works whether or not the vehicle already has
 * credits: if it does, they're voided first (refusing if any is locked on a
 * payout); then a fresh closed one-vehicle shift is created with `entries` and
 * credits are snapshotted at the job's pay_per_vehicle. Also stamps the VIN's
 * shift_id so the Crew & Pay view groups it correctly.
 */
export async function assignVehicleCredits(
  service: SupabaseClient,
  opts: { cniJobVinId: string; entries: ShiftMember[]; assignedBy: string },
): Promise<{ ok: boolean; error?: string }> {
  const { cniJobVinId, entries, assignedBy } = opts;
  if (entries.length === 0) return { ok: false, error: 'At least one crew member required' };

  const { data: vin } = await service
    .from('cni_job_vins')
    .select('id, vin, job_id, scan_log_id, status')
    .eq('id', cniJobVinId)
    .single();
  if (!vin) return { ok: false, error: 'Vehicle not found' };

  const { data: job } = await service
    .from('cni_jobs').select('id, pay_per_vehicle, part_number').eq('id', vin.job_id).single();
  if (!job) return { ok: false, error: 'Job not found' };
  const rate = job.pay_per_vehicle != null ? Number(job.pay_per_vehicle) : null;

  // Void any existing live credits for this vehicle (refuse if locked). Match
  // on the VIN row id and on the scan it came from, since older credits may be
  // keyed by scan_log_id only.
  const orRef = vin.scan_log_id
    ? `cni_job_vin_id.eq.${cniJobVinId},scan_log_id.eq.${vin.scan_log_id}`
    : `cni_job_vin_id.eq.${cniJobVinId}`;
  const { data: live } = await service
    .from('install_credits')
    .select('id, payout_id')
    .or(orRef)
    .is('voided_at', null);
  if (live && live.some(c => c.payout_id)) {
    return { ok: false, error: 'Credits are on a payout and locked — void the payout first' };
  }
  const now = new Date().toISOString();
  if (live && live.length > 0) {
    const { error: voidErr } = await service
      .from('install_credits')
      .update({ voided_at: now, voided_by: assignedBy })
      .in('id', live.map(c => c.id));
    if (voidErr) return { ok: false, error: 'Failed to void existing credits: ' + voidErr.message };
  }

  // A closed one-vehicle shift to hang the assignment on.
  const { data: shift, error: shiftErr } = await service
    .from('work_shifts')
    .insert({ context: 'cni', cni_job_id: vin.job_id, started_by: assignedBy, started_at: now, ended_at: now })
    .select('id')
    .single();
  if (shiftErr || !shift) {
    return { ok: false, error: 'Failed to create shift: ' + (shiftErr?.message || 'unknown') };
  }
  const { error: memErr } = await service.from('work_shift_members').insert(
    entries.map(m => ({ shift_id: shift.id, profile_id: m.profile_id, share_weight: m.share_weight, added_by: assignedBy })),
  );
  if (memErr) return { ok: false, error: 'Failed to add crew: ' + memErr.message };

  const r = await createCompletionCredits(service, {
    shiftId: shift.id,
    source: 'cni',
    ratePerVehicle: rate,
    completion: { cniJobVinId, scanLogId: vin.scan_log_id, vin: vin.vin, partNumber: job.part_number },
  });
  if (!r.ok) return { ok: false, error: r.error };

  await service
    .from('cni_job_vins')
    .update({ shift_id: shift.id })
    .eq('id', cniJobVinId);

  return { ok: true };
}

/** Field rate lookup: active install_pay_rates row for this part/custom job. */
export async function getFieldRate(
  service: SupabaseClient,
  partNumber: string | null | undefined,
): Promise<number | null> {
  if (!partNumber) return null;
  // ilike (wildcards escaped): rates and scans can carry different casing
  // for the same part — a rate keyed 06U166 must still price a 06u166 scan.
  const { data } = await service
    .from('install_pay_rates')
    .select('rate_per_vehicle')
    .ilike('part_number', partNumberPattern(partNumber))
    .eq('active', true)
    .limit(1);
  return data?.[0] ? Number(data[0].rate_per_vehicle) : null;
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
 * Apply a CNI job's pay_per_vehicle change to credits already on the books:
 * re-price every live (non-voided), unlocked credit for the job's completed
 * vehicles at `rate`, preserving each vehicle's exact roster and weights.
 * Vehicles whose credits are on a payout are locked and left unchanged (and
 * reported). Vehicles already at `rate` are skipped. Each re-price voids the
 * old snapshot rows and inserts fresh ones, so the audit trail is preserved.
 */
export async function repriceJobCredits(
  service: SupabaseClient,
  opts: { cniJobId: string; rate: number | null; editedBy: string },
): Promise<{ ok: boolean; repriced: number; lockedSkipped: number; error?: string }> {
  const { cniJobId, rate, editedBy } = opts;

  // The job's vehicles, with the scan each came from (older credits key on
  // scan_log_id, newer ones on cni_job_vin_id — match on either).
  const { data: vins } = await service
    .from('cni_job_vins')
    .select('id, scan_log_id')
    .eq('job_id', cniJobId);
  if (!vins || vins.length === 0) return { ok: true, repriced: 0, lockedSkipped: 0 };

  const vinIds = vins.map(v => v.id);
  const scanIds = vins.map(v => v.scan_log_id).filter(Boolean) as string[];
  const orParts: string[] = [];
  if (vinIds.length) orParts.push(`cni_job_vin_id.in.(${vinIds.join(',')})`);
  if (scanIds.length) orParts.push(`scan_log_id.in.(${scanIds.join(',')})`);
  if (orParts.length === 0) return { ok: true, repriced: 0, lockedSkipped: 0 };

  const { data: live } = await service
    .from('install_credits')
    .select('id, scan_log_id, cni_job_vin_id, profile_id, share_weight, rate_per_vehicle, payout_id')
    .or(orParts.join(','))
    .is('voided_at', null);
  if (!live || live.length === 0) return { ok: true, repriced: 0, lockedSkipped: 0 };

  // Group per vehicle; track lock state, whether the rate already matches, and
  // the current roster so the re-price keeps the same split.
  type Group = { scanLogId: string | null; cniJobVinId: string | null; locked: boolean; sameRate: boolean; members: ShiftMember[] };
  const groups = new Map<string, Group>();
  for (const c of live) {
    const key = c.scan_log_id || c.cni_job_vin_id!;
    const g: Group = groups.get(key) || { scanLogId: c.scan_log_id, cniJobVinId: c.cni_job_vin_id, locked: false, sameRate: true, members: [] };
    if (c.payout_id) g.locked = true;
    const cur = c.rate_per_vehicle != null ? Number(c.rate_per_vehicle) : null;
    if (cur !== rate) g.sameRate = false;
    g.members.push({ profile_id: c.profile_id, share_weight: Number(c.share_weight) });
    groups.set(key, g);
  }

  let repriced = 0;
  let lockedSkipped = 0;
  for (const g of groups.values()) {
    if (g.locked) { lockedSkipped++; continue; }
    if (g.sameRate) continue;
    const r = await rewriteVehicleCredits(service, {
      scanLogId: g.scanLogId,
      cniJobVinId: g.cniJobVinId,
      entries: g.members,
      editedBy,
      ratePerVehicle: rate,
    });
    if (!r.ok) return { ok: false, repriced, lockedSkipped, error: r.error };
    repriced++;
  }
  return { ok: true, repriced, lockedSkipped };
}

/**
 * Fill in field credits that were captured before their part had a rate.
 * Groups by vehicle so each group splits the new rate by its stored weights.
 * FIELD credits only: CNI credits price from their job's pay_per_vehicle
 * (repriceJobCredits) — without the source filter, setting a field rate for
 * a part silently priced unpriced CNI credits for the same part at the
 * field rate.
 */
export async function priceUnpricedCredits(
  service: SupabaseClient,
  partNumber: string,
  rate: number,
): Promise<{ ok: boolean; priced: number; error?: string }> {
  const { data: rows } = await service
    .from('install_credits')
    .select('id, scan_log_id, cni_job_vin_id, profile_id, share_weight, total_weight')
    .ilike('part_number', partNumberPattern(partNumber))
    .eq('source', 'field')
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
