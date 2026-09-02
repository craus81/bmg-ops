import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * shop_inbound keeps one row per vehicle expected at the shop, so the Shop
 * Board can show a single coherent arrival schedule. Rows are derived:
 *  - graphics jobs whose install_location is our shop
 *  - upfit projects with a customer drop-off date
 * Re-syncing is idempotent — call after any save that could change the
 * picture. An 'arrived' row is never demoted back to 'expected'; a source
 * that no longer qualifies gets its pending row cancelled.
 */

export const INSTALL_LOCATIONS = [
  "O'Fallon Shop",
  'Wentzville',
  'Kansas City',
  'Social Circle',
  'Customer Site',
  'CNI Installer',
] as const;

/** The location that routes work into the check-in → in-shop process. */
export const SHOP_INSTALL_LOCATION = "O'Fallon Shop";

// Once a graphics job is out the door (or installed) there's no arrival to
// expect anymore.
const GRAPHICS_DONE_STATUSES = ['shipped', 'picked_up', 'installed'];

interface InboundFields {
  vehicle_desc: string | null;
  customer_name: string | null;
  work_summary: string | null;
  install_location: string | null;
  expected_date: string | null;
  need_back_date: string | null;
  // Written by sources that know them (sales_order rows; upfit rows carry
  // the SO pair since the Stage 7 close) — omitted (and so never written)
  // elsewhere, since JSON.stringify drops undefined keys before the upsert.
  netsuite_so_id?: string | null;
  netsuite_so_number?: string | null;
  vin?: string | null;
}

async function upsertInbound(
  service: SupabaseClient,
  sourceType: 'graphics_job' | 'upfit_project' | 'sales_order',
  sourceId: string,
  qualifies: boolean,
  fields: InboundFields,
): Promise<void> {
  const { data: existing } = await service
    .from('shop_inbound')
    .select('id, status')
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)
    .maybeSingle();

  if (!qualifies) {
    if (existing && existing.status === 'expected') {
      await service.from('shop_inbound')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
    return;
  }

  if (existing) {
    await service.from('shop_inbound')
      .update({
        ...fields,
        // Revive a cancelled row if the source qualifies again; leave
        // 'arrived' alone.
        status: existing.status === 'cancelled' ? 'expected' : existing.status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
  } else {
    await service.from('shop_inbound').insert({
      source_type: sourceType,
      source_id: sourceId,
      ...fields,
      status: 'expected',
    });
  }
}

export async function syncShopInboundForGraphicsJob(
  service: SupabaseClient,
  jobId: string,
): Promise<void> {
  const { data: job } = await service
    .from('graphics_jobs')
    .select('id, title, customer, part_number, status, install_location, scheduled_install_date')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return;

  const qualifies =
    job.install_location === SHOP_INSTALL_LOCATION &&
    !GRAPHICS_DONE_STATUSES.includes(job.status);

  const schedDate =
    job.scheduled_install_date && job.scheduled_install_date !== 'N/A'
      ? job.scheduled_install_date
      : null;

  await upsertInbound(service, 'graphics_job', job.id, qualifies, {
    vehicle_desc: job.title || null,
    customer_name: job.customer || null,
    work_summary: `Graphics install${job.part_number ? ` — ${job.part_number}` : ''}`,
    install_location: job.install_location,
    expected_date: schedDate,
    need_back_date: null,
  });
}

export async function syncShopInboundForSalesOrder(
  service: SupabaseClient,
  estimateId: string,
): Promise<void> {
  const { data: est } = await service
    .from('estimates')
    .select('id, estimate_number, title, customer_name, status, netsuite_so_id, netsuite_so_number, vin, unit_number')
    .eq('id', estimateId)
    .maybeSingle();
  if (!est) return;

  // A vehicle is expected once the estimate becomes a Sales Order and hasn't
  // been cancelled/lost. Estimates carry no drop-off date, so there's no
  // expected_date — the row lands under "Further Out / No Date" until a date
  // is known. Keyed on the estimate UUID (see migration 185).
  const qualifies =
    !!est.netsuite_so_id && !['cancelled', 'rejected', 'lost'].includes(est.status);

  // K5: the estimate now carries the VIN, so the Arriving row gets it from
  // the estimate chain instead of hoping a NetSuite rep typed one on the SO.
  const unitSuffix = est.unit_number ? ` (Unit ${est.unit_number})` : '';
  await upsertInbound(service, 'sales_order', est.id, qualifies, {
    vehicle_desc: (est.title || `Estimate ${est.estimate_number}`) + unitSuffix,
    customer_name: est.customer_name || null,
    work_summary: est.netsuite_so_number ? `Sales Order #${est.netsuite_so_number}` : 'Sales Order',
    install_location: SHOP_INSTALL_LOCATION,
    expected_date: null,
    need_back_date: null,
    netsuite_so_id: est.netsuite_so_id || null,
    netsuite_so_number: est.netsuite_so_number || null,
    vin: est.vin || null,
  });
}

export async function syncShopInboundForUpfitProject(
  service: SupabaseClient,
  projectId: string,
): Promise<void> {
  const { data: project } = await service
    .from('upfit_projects')
    .select('id, project_name, customer_name, status, customer_dropoff_date, need_back_date, netsuite_so_id, netsuite_so_number')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return;

  const qualifies =
    !!project.customer_dropoff_date &&
    !['completed', 'cancelled'].includes(project.status);

  // Round 3 caveat 14: only sales_order rows carried SO identifiers, so
  // upfit arrivals could never match a check-in by SO. Projects have both
  // columns (migration 075) — pass them through so arrival matching works
  // on this source too.
  await upsertInbound(service, 'upfit_project', project.id, qualifies, {
    vehicle_desc: project.project_name || null,
    customer_name: project.customer_name || null,
    work_summary: 'Upfit',
    install_location: SHOP_INSTALL_LOCATION,
    expected_date: project.customer_dropoff_date,
    need_back_date: project.need_back_date,
    netsuite_so_id: project.netsuite_so_id || null,
    netsuite_so_number: project.netsuite_so_number || null,
  });
}

/**
 * Link an expected arrival to the check-in that fulfilled it (audit item
 * 14 — shop_inbound.fleet_checkin_id existed since migration 160 with no
 * writer, so vehicles read "overdue, expected but not arrived" while
 * sitting in the shop).
 *
 * Match order, strongest first: exact VIN, then the check-in's SO numbers
 * against netsuite_so_number, then customer name — the last only when it
 * matches EXACTLY ONE expected row (guessing between two expected vans for
 * the same fleet would link the wrong custody record). Returns the row it
 * marked arrived, or null when nothing matched.
 */
export async function linkInboundToCheckin(
  service: SupabaseClient,
  checkin: { id: string; vin?: string | null; customer_name?: string | null; soNumbers?: string[] },
): Promise<{ id: string; vehicle_desc: string | null; expected_date: string | null } | null> {
  const { data: expected } = await service
    .from('shop_inbound')
    .select('id, vin, netsuite_so_number, customer_name, vehicle_desc, expected_date')
    .eq('status', 'expected');
  if (!expected || expected.length === 0) return null;

  const vin = (checkin.vin || '').trim().toUpperCase();
  const soNumbers = (checkin.soNumbers || []).map(n => n.trim()).filter(Boolean);
  const custName = (checkin.customer_name || '').trim().toLowerCase();

  let match =
    (vin && expected.find(r => (r.vin || '').trim().toUpperCase() === vin)) ||
    (soNumbers.length > 0 && expected.find(r => r.netsuite_so_number && soNumbers.includes(String(r.netsuite_so_number).trim()))) ||
    null;
  if (!match && custName) {
    const byCustomer = expected.filter(r => (r.customer_name || '').trim().toLowerCase() === custName);
    if (byCustomer.length === 1) match = byCustomer[0];
  }
  if (!match) return null;

  await service
    .from('shop_inbound')
    .update({
      status: 'arrived',
      fleet_checkin_id: checkin.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', match.id);
  return { id: match.id, vehicle_desc: match.vehicle_desc, expected_date: match.expected_date };
}

/**
 * The other direction of item 14: find the active check-in a Shop Board row
 * belongs to when someone presses "Arrived" (or when the arrival brain
 * dedupes a check-in against a row already marked arrived).
 *
 * Round 3 caveat 14: this matched VIN only, and only sales_order rows carry
 * a VIN — so graphics/upfit/manual arrivals could never back-link, and a
 * board-arrival + check-in on the same day double-notified. Match order
 * mirrors linkInboundToCheckin, strongest first: exact VIN, then the row's
 * SO number against the check-in's legacy column or the multi-SO join
 * table, then customer name — the last only when it matches EXACTLY ONE
 * active check-in.
 */
export async function findActiveCheckinForInbound(
  service: SupabaseClient,
  inbound: { vin?: string | null; netsuite_so_number?: string | null; customer_name?: string | null },
): Promise<string | null> {
  const vin = (inbound.vin || '').trim().toUpperCase();
  if (vin) {
    const { data: byVin } = await service
      .from('fleet_checkins')
      .select('id')
      .eq('vin', vin)
      .is('archived_at', null)
      .neq('status', 'shipped')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byVin?.id) return byVin.id;
  }

  const soNumber = (inbound.netsuite_so_number || '').trim();
  if (soNumber) {
    const { data: legacy } = await service
      .from('fleet_checkins')
      .select('id')
      .eq('sales_order_number', soNumber)
      .is('archived_at', null)
      .neq('status', 'shipped')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (legacy?.id) return legacy.id;

    const { data: joins } = await service
      .from('fleet_checkin_sales_orders')
      .select('checkin_id')
      .eq('sales_order_number', soNumber)
      .order('added_at', { ascending: false })
      .limit(5);
    for (const j of joins || []) {
      const { data: c } = await service
        .from('fleet_checkins')
        .select('id')
        .eq('id', j.checkin_id)
        .is('archived_at', null)
        .neq('status', 'shipped')
        .maybeSingle();
      if (c?.id) return c.id;
    }
  }

  const custName = (inbound.customer_name || '').trim();
  if (custName) {
    // Escape LIKE wildcards so the name is matched literally
    // (case-insensitive) — same treatment as the check-in save path.
    const escaped = custName.replace(/[\\%_]/g, '\\$&');
    const { data: byCust } = await service
      .from('fleet_checkins')
      .select('id')
      .ilike('customer_name', escaped)
      .is('archived_at', null)
      .neq('status', 'shipped')
      .limit(2);
    if (byCust && byCust.length === 1) return byCust[0].id;
  }

  return null;
}
