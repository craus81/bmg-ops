import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery } from './netsuite';
import { firstGraphicsMatch, type GraphicsCandidate } from './graphics-detection';

/**
 * Re-run the check-in graphics scan (graphics-detection.ts) on a vehicle that
 * already exists: every linked NetSuite sales order's lines, plus the linked
 * estimate's lines. Owner ask 2026-10-05: a graphics-only vehicle whose SO was
 * made (or linked) outside the check-in showed only the Upfit steps, because
 * the scan only ran at check-in and the status row only knew about graphics
 * jobs.
 *
 * On a match it stores graphics_signal (what the status row keys on) and, when
 * the vehicle had no signal before and no graphics job, raises needs_graphics
 * the same way check-in does — a signal that was already there is left alone,
 * so a dismissed "Needs Graphics" prompt stays dismissed. Always stamps
 * graphics_scanned_at. Returns the matched line text, or null.
 */
export async function scanCheckinForGraphics(
  service: SupabaseClient,
  checkinId: string,
): Promise<{ signal: string | null; scanned: boolean }> {
  const { data: checkin, error } = await service
    .from('fleet_checkins')
    .select('id, netsuite_sales_order_id, source_estimate_id, graphics_signal, matched_graphics_job_id, needs_graphics')
    .eq('id', checkinId)
    .maybeSingle();
  if (error || !checkin) return { signal: null, scanned: false };

  const { data: soRows } = await service
    .from('fleet_checkin_sales_orders')
    .select('netsuite_sales_order_id')
    .eq('checkin_id', checkinId);
  const soIds = [...new Set([
    checkin.netsuite_sales_order_id,
    ...(soRows || []).map((r: any) => r.netsuite_sales_order_id),
  ].map(id => String(id || '').trim()).filter(id => /^\d+$/.test(id)))];

  const lines: GraphicsCandidate[] = [];
  let netsuiteFailed = false;
  if (soIds.length > 0) {
    try {
      const result = await suiteqlQuery(`
        SELECT tl.memo AS description, i.itemid AS item_name
        FROM transactionline tl
        LEFT JOIN item i ON tl.item = i.id
        WHERE tl.transaction IN (${soIds.join(', ')})
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
      `);
      for (const l of result?.items || []) lines.push({ item_name: l.item_name || null, description: l.description || null });
    } catch (err) {
      console.warn('scanCheckinForGraphics: NetSuite lines read failed:', err);
      netsuiteFailed = true;
    }
  }
  if (checkin.source_estimate_id) {
    const { data: estLines } = await service
      .from('estimate_line_items')
      .select('item_number, description')
      .eq('estimate_id', checkin.source_estimate_id);
    lines.push(...(estLines || []));
  }

  const signal = firstGraphicsMatch(lines);
  const update: Record<string, any> = {};
  // A vehicle in a fleet order whose graphics job already exists
  // (migration 411) links straight to it: its kit is on that job, so it
  // never waits on the Needs Graphics queue.
  if (!checkin.matched_graphics_job_id) {
    const fleetJobId = await fleetJobForCheckin(service, checkin.source_estimate_id, soIds);
    if (fleetJobId) {
      update.matched_graphics_job_id = fleetJobId;
      update.needs_graphics = false;
      checkin.matched_graphics_job_id = fleetJobId;
    }
  }
  // A NetSuite outage with nothing found is not "scanned, no graphics" —
  // leave the stamp off so the next open tries again.
  if (!(netsuiteFailed && !signal)) update.graphics_scanned_at = new Date().toISOString();
  if (signal && !checkin.graphics_signal) {
    update.graphics_signal = signal;
    if (!checkin.matched_graphics_job_id && !checkin.needs_graphics) update.needs_graphics = true;
  }
  if (Object.keys(update).length > 0) {
    await service.from('fleet_checkins').update(update).eq('id', checkinId);
  }
  return { signal: signal || checkin.graphics_signal || null, scanned: !!update.graphics_scanned_at };
}

/**
 * The fleet order graphics job (migration 411) a checked-in vehicle's kit
 * is on: its source estimate, or the estimate behind one of its sales
 * orders, is in a fleet order that has a live job.
 */
async function fleetJobForCheckin(
  service: SupabaseClient,
  sourceEstimateId: string | null,
  soIds: string[],
): Promise<string | null> {
  const filters = [
    sourceEstimateId ? `id.eq.${sourceEstimateId}` : null,
    soIds.length ? `netsuite_so_id.in.(${soIds.join(',')})` : null,
  ].filter(Boolean);
  if (filters.length === 0) return null;
  const { data: ests } = await service
    .from('estimates')
    .select('fleet_group_id')
    .not('fleet_group_id', 'is', null)
    .or(filters.join(','));
  const groups = [...new Set((ests || []).map((e: any) => e.fleet_group_id))];
  if (groups.length === 0) return null;
  const { data: job } = await service
    .from('graphics_jobs')
    .select('id')
    .in('fleet_group_id', groups)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return job?.id || null;
}
