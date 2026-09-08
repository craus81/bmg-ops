import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Ready-for-pickup queue + nudge decisions (R5-17 part 2). Auto-archive
 * only covers SHIPPED vehicles — a completed vehicle whose customer never
 * comes sits in the lot indefinitely with no aging view and no follow-up.
 * This ranks complete-but-not-shipped vehicles by days since completion
 * and decides which get an automated reminder (with the booking link) and
 * which escalate to the sales rep.
 */

export interface ReadyVehicle {
  id: string;
  label: string;
  customerName: string | null;
  daysReady: number;
  hasBooking: boolean;
  portalToken: string | null;
  nudgeCount: number;
  lastNudgeAt: string | null;
  escalatedAt: string | null;
  /** The rep who sold it (source estimate's creator), for escalation. */
  salesRepId: string | null;
}

export interface NudgePlan {
  nudges: ReadyVehicle[];
  escalations: ReadyVehicle[];
}

/** Reminders repeat weekly, not daily. */
const REPEAT_DAYS = 7;
/** Vehicles ready longer than this predate the feature (or are data
 *  debris) — surface them in the queue but never auto-email a customer
 *  about a van that's been sitting for months. */
const MAX_NUDGE_AGE_DAYS = 60;

/**
 * Pure nudge policy: first reminder at nudgeDays after completion, weekly
 * repeats, one-time sales-rep escalation at 2× nudgeDays. Booked vehicles
 * and vehicles with no booking token are left alone.
 */
export function decideNudges(vehicles: ReadyVehicle[], nudgeDays: number, nowMs: number): NudgePlan {
  const nudges: ReadyVehicle[] = [];
  const escalations: ReadyVehicle[] = [];
  for (const v of vehicles) {
    if (v.hasBooking || v.daysReady > MAX_NUDGE_AGE_DAYS) continue;
    if (v.daysReady >= nudgeDays && v.portalToken) {
      const lastMs = v.lastNudgeAt ? Date.parse(v.lastNudgeAt) : null;
      if (lastMs == null || nowMs - lastMs >= REPEAT_DAYS * 86_400_000) nudges.push(v);
    }
    if (v.daysReady >= nudgeDays * 2 && !v.escalatedAt) escalations.push(v);
  }
  return { nudges, escalations };
}

/**
 * Complete-but-not-shipped vehicles ranked by days ready. "Ready since" is
 * the LATEST transition into 'complete' (a returning vehicle's earlier
 * visit must not age this one — the m229 rule), falling back to updated_at
 * for rows with no history.
 */
export async function loadReadyForPickup(service: SupabaseClient): Promise<ReadyVehicle[]> {
  const { data: rows, error } = await fetchAllRows<any>((from, to) => service
    .from('fleet_checkins')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, customer_portal_token, pickup_scheduled_date, pickup_nudge_sent_at, pickup_nudge_count, pickup_escalated_at, source_estimate_id, updated_at')
    .eq('status', 'complete')
    .is('archived_at', null)
    .order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const vehicles = rows || [];
  if (vehicles.length === 0) return [];

  const ids = vehicles.map((v: any) => v.id);
  const completeAt = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: hist } = await service
      .from('vehicle_status_history')
      .select('vehicle_id, created_at')
      .eq('to_status', 'complete')
      .in('vehicle_id', ids.slice(i, i + 100))
      .order('created_at', { ascending: false });
    // Descending scan → first seen per vehicle = the LATEST completion.
    for (const h of hist || []) {
      if (!completeAt.has(h.vehicle_id)) completeAt.set(h.vehicle_id, h.created_at);
    }
  }

  // Sales rep = the source estimate's creator (best escalation target).
  const estIds = [...new Set(vehicles.map((v: any) => v.source_estimate_id).filter(Boolean))] as string[];
  const repByEstimate = new Map<string, string>();
  for (let i = 0; i < estIds.length; i += 100) {
    const { data: ests } = await service
      .from('estimates').select('id, created_by').in('id', estIds.slice(i, i + 100));
    for (const e of ests || []) if (e.created_by) repByEstimate.set(e.id, e.created_by);
  }

  const now = Date.now();
  return vehicles
    .map((v: any): ReadyVehicle => {
      const readySince = completeAt.get(v.id) || v.updated_at;
      const daysReady = readySince ? Math.max(0, Math.floor((now - Date.parse(readySince)) / 86_400_000)) : 0;
      return {
        id: v.id,
        label: [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')
          || (v.vin ? `VIN …${String(v.vin).slice(-8)}` : 'Vehicle'),
        customerName: v.customer_name,
        daysReady,
        hasBooking: v.pickup_scheduled_date != null,
        portalToken: v.customer_portal_token || null,
        nudgeCount: v.pickup_nudge_count || 0,
        lastNudgeAt: v.pickup_nudge_sent_at,
        escalatedAt: v.pickup_escalated_at,
        salesRepId: v.source_estimate_id ? repByEstimate.get(v.source_estimate_id) || null : null,
      };
    })
    .sort((a, b) => b.daysReady - a.daysReady);
}
