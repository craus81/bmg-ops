import type { SupabaseClient } from '@supabase/supabase-js';
import { fleetMembers, type FleetMember } from '@/lib/estimate-fleet';

/**
 * One graphics job for a fleet order (migration 411, Craig 2026-10-19):
 * the order's estimates (migration 410) share one job, and each estimate is
 * one kit, identical except for its unit number. Design, proof and printing
 * happen once; each kit is installed when its vehicle shows up.
 */

/** Where a kit's vehicle is, from its check-in. */
export type KitVan =
  | { state: 'not_here' }
  | { state: 'here'; since: string; checkinId: string }
  | { state: 'done'; since: string; checkinId: string };

export interface JobKit {
  estimateId: string;
  estimateNumber: string;
  unitNumber: string | null;
  vin: string | null;
  soNumber: string | null;
  van: KitVan;
  installedAt: string | null;
}

/** The fleet order's live graphics job, if it has one. */
export async function fleetJobFor(
  supabase: SupabaseClient,
  groupId: string,
): Promise<{ id: string; job_number: string | null; status: string } | null> {
  const { data } = await supabase
    .from('graphics_jobs')
    .select('id, job_number, status')
    .eq('fleet_group_id', groupId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as any) || null;
}

const sameVin = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && String(a).trim().toUpperCase() === String(b).trim().toUpperCase();

/**
 * The kits of a fleet job: one per current estimate in its order, with the
 * vehicle's check-in (by the estimate's own check-in link, the check-in's
 * source estimate, or a vehicle on this job with the same VIN) and whether
 * the kit is installed.
 */
export async function loadJobKits(
  supabase: SupabaseClient,
  job: { id: string; fleet_group_id: string | null },
): Promise<JobKit[]> {
  if (!job.fleet_group_id) return [];
  const members = await fleetMembers(supabase, job.fleet_group_id);
  if (members.length === 0) return [];
  const ids = members.map(m => m.id);

  const [{ data: links }, { data: installs }] = await Promise.all([
    supabase.from('estimates').select('id, fleet_checkin_id').in('id', ids),
    supabase.from('graphics_job_kits').select('estimate_id, installed_at').eq('job_id', job.id),
  ]);
  const linkedCheckin = new Map((links || []).map(l => [l.id as string, l.fleet_checkin_id as string | null]));
  const checkinIds = [...new Set([...linkedCheckin.values()].filter(Boolean))] as string[];

  const cols = 'id, vin, status, created_at, updated_at, source_estimate_id, matched_graphics_job_id, archived_at';
  const [bySource, byLink, byJob] = await Promise.all([
    supabase.from('fleet_checkins').select(cols).in('source_estimate_id', ids),
    checkinIds.length ? supabase.from('fleet_checkins').select(cols).in('id', checkinIds) : Promise.resolve({ data: [] as any[] }),
    supabase.from('fleet_checkins').select(cols).eq('matched_graphics_job_id', job.id),
  ]);
  const checkins = new Map<string, any>();
  for (const c of [...(bySource.data || []), ...(byLink.data || []), ...(byJob.data || [])]) checkins.set(c.id, c);
  const all = [...checkins.values()];
  const installedAt = new Map((installs || []).map(k => [k.estimate_id as string, k.installed_at as string]));

  return members.map((m: FleetMember) => {
    const mine = all
      .filter(c => c.id === linkedCheckin.get(m.id) || c.source_estimate_id === m.id || (c.matched_graphics_job_id === job.id && sameVin(c.vin, m.vin)))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const c = mine[0];
    const van: KitVan = !c
      ? { state: 'not_here' }
      : c.status === 'complete' || c.archived_at
        ? { state: 'done', since: c.updated_at || c.created_at, checkinId: c.id }
        : { state: 'here', since: c.created_at, checkinId: c.id };
    return {
      estimateId: m.id,
      estimateNumber: m.estimate_number,
      unitNumber: m.unit_number,
      vin: m.vin,
      soNumber: m.netsuite_so_number,
      van,
      installedAt: installedAt.get(m.id) || null,
    };
  });
}

/** "Fleet order, 3 kits: units 101, 102, 103. Only the unit number changes." */
export function fleetContentLine(units: (string | null)[]): string {
  const named = units.map(u => String(u || '').trim()).filter(Boolean);
  const n = units.length;
  return `Fleet order, ${n} kit${n === 1 ? '' : 's'}${named.length ? `: unit${named.length === 1 ? '' : 's'} ${named.join(', ')}` : ''}. Same graphics on each, only the unit number changes.`;
}

/**
 * Point the order's check-ins at its graphics job: vehicles that arrived
 * before the job existed, and ones checked in since. Only vehicles linked
 * to no job are touched; they leave the Needs Graphics queue.
 */
export async function linkFleetCheckins(supabase: SupabaseClient, jobId: string, estimateIds: string[]): Promise<number> {
  if (estimateIds.length === 0) return 0;
  const { data: ests } = await supabase.from('estimates').select('fleet_checkin_id').in('id', estimateIds);
  const linked = (ests || []).map(e => e.fleet_checkin_id).filter(Boolean) as string[];
  const filter = linked.length
    ? `source_estimate_id.in.(${estimateIds.join(',')}),id.in.(${linked.join(',')})`
    : `source_estimate_id.in.(${estimateIds.join(',')})`;
  const { data } = await supabase
    .from('fleet_checkins')
    .update({ matched_graphics_job_id: jobId, needs_graphics: false })
    .is('matched_graphics_job_id', null)
    .or(filter)
    .select('id');
  return (data || []).length;
}

/**
 * A vehicle joined or left a fleet order: keep its graphics job's kit count
 * in step and say so in the job's history. A vehicle added later is covered
 * by the proof the customer already approved (Craig, 2026-10-19), so the
 * note says that rather than asking again.
 */
export async function noteFleetKitsChanged(
  supabase: SupabaseClient,
  groupId: string,
  note: string,
  userId: string | null,
): Promise<void> {
  const job = await fleetJobFor(supabase, groupId);
  if (!job) return;
  const members = await fleetMembers(supabase, groupId);
  await supabase.from('graphics_jobs').update({ quantity: Math.max(1, members.length), updated_at: new Date().toISOString() }).eq('id', job.id);
  await supabase.from('graphics_status_history').insert({
    job_id: job.id,
    from_status: job.status,
    to_status: job.status,
    changed_by: userId,
    note: `${note} Now ${members.length} kit${members.length === 1 ? '' : 's'}.`,
  });
}
