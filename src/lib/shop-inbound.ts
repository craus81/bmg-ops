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
  // sales_order rows only — omitted (and so never written) by the other
  // sources, since JSON.stringify drops undefined keys before the upsert.
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
    .select('id, estimate_number, title, customer_name, status, netsuite_so_id, netsuite_so_number')
    .eq('id', estimateId)
    .maybeSingle();
  if (!est) return;

  // A vehicle is expected once the estimate becomes a Sales Order and hasn't
  // been cancelled/lost. Estimates carry no drop-off date, so there's no
  // expected_date — the row lands under "Further Out / No Date" until a date
  // is known. Keyed on the estimate UUID (see migration 185).
  const qualifies =
    !!est.netsuite_so_id && !['cancelled', 'rejected', 'lost'].includes(est.status);

  await upsertInbound(service, 'sales_order', est.id, qualifies, {
    vehicle_desc: est.title || `Estimate ${est.estimate_number}`,
    customer_name: est.customer_name || null,
    work_summary: est.netsuite_so_number ? `Sales Order #${est.netsuite_so_number}` : 'Sales Order',
    install_location: SHOP_INSTALL_LOCATION,
    expected_date: null,
    need_back_date: null,
    netsuite_so_id: est.netsuite_so_id || null,
    netsuite_so_number: est.netsuite_so_number || null,
    vin: null,
  });
}

export async function syncShopInboundForUpfitProject(
  service: SupabaseClient,
  projectId: string,
): Promise<void> {
  const { data: project } = await service
    .from('upfit_projects')
    .select('id, project_name, customer_name, status, customer_dropoff_date, need_back_date')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return;

  const qualifies =
    !!project.customer_dropoff_date &&
    !['completed', 'cancelled'].includes(project.status);

  await upsertInbound(service, 'upfit_project', project.id, qualifies, {
    vehicle_desc: project.project_name || null,
    customer_name: project.customer_name || null,
    work_summary: 'Upfit',
    install_location: SHOP_INSTALL_LOCATION,
    expected_date: project.customer_dropoff_date,
    need_back_date: project.need_back_date,
  });
}
