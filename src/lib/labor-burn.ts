import type { SupabaseClient } from '@supabase/supabase-js';
import { getShopLaborForCheckins } from './shop-labor';
import { isAdminRole } from './features';

/**
 * Labor Burn Meter (R6-12).
 *
 * The pick-list has shown hours LOGGED on a vehicle since R3-21, but never
 * against the hours that were SOLD — so a job runs past its quoted labor
 * and nobody finds out until the margin report, months later. This puts the
 * comparison where the work happens: a header chip that goes amber at 80%
 * and red at 100%, a matching badge on the tracking board, and one ping to
 * the assignee and admins the first time a vehicle crosses.
 *
 * The honesty rule: NO sold hours means NO meter. A vehicle whose estimate
 * carries no labor is not "0% burned" and it is certainly not "over" — it
 * is unmeasured, and the chip says so. Reading a missing quote as zero
 * would put every timeless job permanently in the red and make the whole
 * meter noise.
 */

export const BURN_WARN_PCT = 80;
export const BURN_OVER_PCT = 100;

export type BurnTone = 'unknown' | 'ok' | 'warn' | 'over';

export interface Burn {
  loggedHours: number;
  soldHours: number | null;
  /** Null whenever sold hours are unknown — never 0, never 100. */
  pct: number | null;
  tone: BurnTone;
  /** What the chip says. Short enough for a pick-list header. */
  label: string;
  /** Where the sold figure came from, so the number is never anonymous. */
  source: 'estimate' | null;
  sourceLabel: string | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pure. `soldHours` null/0 → an explicitly unmeasured meter. */
export function computeBurn(input: {
  loggedHours: number;
  soldHours: number | null;
  source?: 'estimate' | null;
  sourceLabel?: string | null;
}): Burn {
  const logged = round1(Math.max(0, input.loggedHours || 0));
  const sold = input.soldHours != null && input.soldHours > 0 ? round1(input.soldHours) : null;
  if (sold == null) {
    return {
      loggedHours: logged, soldHours: null, pct: null, tone: 'unknown',
      label: logged > 0 ? `${logged}h logged · no sold hours on file` : 'No sold hours on file',
      source: null, sourceLabel: null,
    };
  }
  const pct = Math.round((logged / sold) * 100);
  return {
    loggedHours: logged,
    soldHours: sold,
    pct,
    tone: pct >= BURN_OVER_PCT ? 'over' : pct >= BURN_WARN_PCT ? 'warn' : 'ok',
    label: `${logged}h of ${sold}h sold`,
    source: input.source ?? null,
    sourceLabel: input.sourceLabel ?? null,
  };
}

/**
 * The labor hours sold on a vehicle, from the estimate linked to it.
 *
 * Both link directions are checked — `fleet_checkins.source_estimate_id`
 * (m080, stamped at check-in) and `estimates.fleet_checkin_id` (m219,
 * stamped by the Link Checked-In Vehicle button) — because either one alone
 * misses half the vehicles. The override wins over the summed hours, the
 * same precedence resolveLaborItem uses when pushing labor to NetSuite, so
 * the meter measures against exactly what was billed.
 *
 * With several estimates linked (a revision chain), the one with the most
 * recent update wins — that is the live quote.
 */
export async function loadSoldHours(
  service: SupabaseClient,
  checkinId: string,
): Promise<{ hours: number | null; source: 'estimate' | null; sourceLabel: string | null }> {
  const { data: checkin } = await service
    .from('fleet_checkins')
    .select('id, source_estimate_id')
    .eq('id', checkinId)
    .maybeSingle();

  const ids = new Set<string>();
  if (checkin?.source_estimate_id) ids.add(checkin.source_estimate_id);

  const { data: linked } = await service
    .from('estimates')
    .select('id')
    .eq('fleet_checkin_id', checkinId);
  for (const e of linked || []) ids.add(e.id);
  if (ids.size === 0) return { hours: null, source: null, sourceLabel: null };

  const { data: rows } = await service
    .from('estimates')
    .select('id, estimate_number, labor_hours, labor_hours_override, status, updated_at')
    .in('id', [...ids])
    .order('updated_at', { ascending: false });

  const best = (rows || [])[0];
  if (!best) return { hours: null, source: null, sourceLabel: null };
  const hours = best.labor_hours_override != null
    ? Number(best.labor_hours_override)
    : (best.labor_hours != null ? Number(best.labor_hours) : null);
  if (hours == null || !(hours > 0)) return { hours: null, source: null, sourceLabel: null };
  return { hours, source: 'estimate', sourceLabel: best.estimate_number || null };
}

/** Everything the chip needs for one vehicle. */
export async function loadBurn(service: SupabaseClient, checkinId: string): Promise<Burn> {
  const [labor, sold] = await Promise.all([
    getShopLaborForCheckins(service, [checkinId]),
    loadSoldHours(service, checkinId),
  ]);
  return computeBurn({
    loggedHours: labor.get(checkinId)?.hours ?? 0,
    soldHours: sold.hours,
    source: sold.source,
    sourceLabel: sold.sourceLabel,
  });
}

/** Burn for many vehicles at once — the tracking board's badges. */
export async function loadBurnForCheckins(
  service: SupabaseClient,
  checkinIds: string[],
): Promise<Map<string, Burn>> {
  const out = new Map<string, Burn>();
  if (checkinIds.length === 0) return out;

  const labor = await getShopLaborForCheckins(service, checkinIds);

  // Both link directions, batched.
  const sold = new Map<string, { hours: number | null; label: string | null; updatedAt: string }>();
  const estimateIds = new Map<string, string>();   // estimate id → checkin id
  for (let i = 0; i < checkinIds.length; i += 200) {
    const slice = checkinIds.slice(i, i + 200);
    const [chkRes, estRes] = await Promise.all([
      service.from('fleet_checkins').select('id, source_estimate_id').in('id', slice),
      service.from('estimates')
        .select('id, estimate_number, labor_hours, labor_hours_override, updated_at, fleet_checkin_id')
        .in('fleet_checkin_id', slice),
    ]);
    for (const c of chkRes.data || []) {
      if (c.source_estimate_id) estimateIds.set(c.source_estimate_id, c.id);
    }
    for (const e of estRes.data || []) keepNewest(sold, e.fleet_checkin_id, e);
  }

  // The m080 direction needs a second read: those estimate ids came off the
  // check-ins, so they carry no fleet_checkin_id of their own.
  const sourceIds = [...estimateIds.keys()];
  for (let i = 0; i < sourceIds.length; i += 200) {
    const { data } = await service
      .from('estimates')
      .select('id, estimate_number, labor_hours, labor_hours_override, updated_at')
      .in('id', sourceIds.slice(i, i + 200));
    for (const e of data || []) keepNewest(sold, estimateIds.get(e.id)!, e);
  }

  for (const id of checkinIds) {
    const s = sold.get(id);
    out.set(id, computeBurn({
      loggedHours: labor.get(id)?.hours ?? 0,
      soldHours: s?.hours ?? null,
      source: s?.hours != null ? 'estimate' : null,
      sourceLabel: s?.label ?? null,
    }));
  }
  return out;
}

function keepNewest(
  sold: Map<string, { hours: number | null; label: string | null; updatedAt: string }>,
  checkinId: string | null,
  e: { estimate_number?: string | null; labor_hours: any; labor_hours_override: any; updated_at: string },
) {
  if (!checkinId) return;
  const hours = e.labor_hours_override != null
    ? Number(e.labor_hours_override)
    : (e.labor_hours != null ? Number(e.labor_hours) : null);
  const value = {
    hours: hours != null && hours > 0 ? hours : null,
    label: e.estimate_number || null,
    updatedAt: e.updated_at,
  };
  const existing = sold.get(checkinId);
  if (!existing || value.updatedAt > existing.updatedAt) sold.set(checkinId, value);
}

/**
 * Ping the assignee and admins the FIRST time a vehicle's logged hours reach
 * the hours sold. One ping per visit — the stamp is the dedupe, not a
 * counter — because a vehicle that crosses, gets pushed back under by a
 * revision, and crosses again is the same conversation, and a ping every
 * time a timer stops would train people to ignore it.
 *
 * Never throws: this rides on the end of a shift, and a notification
 * failure must not fail the tech's Stop button.
 */
export async function maybeNotifyLaborBurn(
  service: SupabaseClient,
  checkinId: string,
  deps: {
    notifyMany: (userIds: string[], payload: any) => Promise<void>;
    adminIds: () => Promise<string[]>;
    pickListUrl: (vin: string, checkinId: string) => string;
  },
): Promise<{ notified: boolean; reason?: string }> {
  try {
    const { data: checkin } = await service
      .from('fleet_checkins')
      .select('id, vin, customer_name, assigned_to, labor_burn_notified_at, status')
      .eq('id', checkinId)
      .maybeSingle();
    if (!checkin) return { notified: false, reason: 'no check-in' };
    if (checkin.labor_burn_notified_at) return { notified: false, reason: 'already notified this visit' };

    const burn = await loadBurn(service, checkinId);
    if (burn.tone !== 'over') return { notified: false, reason: `not over (${burn.tone})` };

    // Stamp BEFORE sending: two timers stopping at once must not both ping.
    // A send that then fails costs one alert, which beats a double alert.
    const { error: stampErr } = await service
      .from('fleet_checkins')
      .update({ labor_burn_notified_at: new Date().toISOString() })
      .eq('id', checkinId)
      .is('labor_burn_notified_at', null);
    if (stampErr) return { notified: false, reason: stampErr.message };

    const audience = new Set<string>(await deps.adminIds());
    if (checkin.assigned_to) audience.add(checkin.assigned_to);
    if (audience.size === 0) return { notified: false, reason: 'no audience' };

    const vehicle = `${checkin.vin}${checkin.customer_name ? ` · ${checkin.customer_name}` : ''}`;
    await deps.notifyMany([...audience], {
      type: 'labor_burn',
      title: `Labor over budget — ${checkin.vin}`,
      body: `${burn.label} (${burn.pct}%)${burn.sourceLabel ? ` on ${burn.sourceLabel}` : ''}. ${vehicle} has used every hour that was sold. Push through, re-scope, or call the customer while it still matters.`,
      url: deps.pickListUrl(checkin.vin, checkin.id),
    });
    return { notified: true };
  } catch (e: any) {
    return { notified: false, reason: String(e?.message || e).slice(0, 200) };
  }
}


/** Approved, active admins — the standing audience for a money-out alarm.
 *  Takes the client so this module stays free of a module-scope Supabase
 *  client (which would make the file untestable under vitest). */
export async function laborBurnAdminIds(service: SupabaseClient): Promise<string[]> {
  const { data } = await service
    .from('profiles')
    .select('id, role, roles, deactivated')
    .eq('status', 'approved');
  return (data || [])
    .filter((p: any) => !p.deactivated)
    .filter((p: any) => isAdminRole(Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : [p.role]))
    .map((p: any) => p.id);
}
