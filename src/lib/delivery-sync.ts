/**
 * Server side of the shared delivery method (migration 414): write one
 * Delivery to a record and to every record linked to it, so the estimate,
 * its upfit project and the project's Graphics Production jobs all say the
 * same thing (Craig, 2026-10-20: "Project and estimate").
 *
 * Linked set: the estimate(s) and upfit project(s) the source belongs to,
 * plus every open Production job on any of them. Finished jobs (shipped,
 * picked up, installed, cancelled) keep what they went out with.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deliveryText, deliveryToRow, installLocationForDelivery, normalizeDelivery, type Delivery } from '@/lib/delivery';
import { GRAPHICS_FINISHED_STATUSES } from '@/lib/graphics-status';
import { SHOP_INSTALL_LOCATION, syncShopInboundForGraphicsJob } from '@/lib/shop-inbound';

export type DeliverySource = 'estimate' | 'upfit_project' | 'graphics_job';

export interface DeliverySyncResult {
  estimates: string[];
  projects: string[];
  jobs: string[];
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

export async function syncLinkedDelivery(
  supabase: SupabaseClient,
  source: DeliverySource,
  id: string,
  delivery: Partial<Delivery>,
): Promise<DeliverySyncResult> {
  const d = normalizeDelivery(delivery);
  let estimateIds: string[] = [];
  let projectIds: string[] = [];

  if (source === 'estimate') {
    estimateIds = [id];
  } else if (source === 'upfit_project') {
    projectIds = [id];
  } else {
    const { data: job } = await supabase.from('graphics_jobs').select('estimate_id, upfit_project_id').eq('id', id).maybeSingle();
    estimateIds = uniq([job?.estimate_id]);
    projectIds = uniq([job?.upfit_project_id]);
  }

  // Projects ↔ estimates, one hop each way.
  if (projectIds.length > 0) {
    const { data } = await supabase.from('upfit_projects').select('estimate_id').in('id', projectIds);
    estimateIds = uniq([...estimateIds, ...(data || []).map((p: any) => p.estimate_id)]);
  }
  if (estimateIds.length > 0) {
    const { data } = await supabase.from('upfit_projects').select('id').in('estimate_id', estimateIds);
    projectIds = uniq([...projectIds, ...(data || []).map((p: any) => p.id)]);
  }

  const result: DeliverySyncResult = { estimates: [], projects: [], jobs: [] };

  if (estimateIds.length > 0) {
    const { data, error } = await supabase.from('estimates')
      .update({ ...deliveryToRow(d, 'estimates'), ...(d.method ? { delivery_preferences: deliveryText(d) } : {}) }).in('id', estimateIds).select('estimate_number');
    if (error) throw new Error(`estimates: ${error.message}`);
    result.estimates = (data || []).map((e: any) => e.estimate_number).filter(Boolean);
  }
  if (projectIds.length > 0) {
    const { data, error } = await supabase.from('upfit_projects')
      .update(deliveryToRow(d, 'upfit_projects')).in('id', projectIds).select('project_name');
    if (error) throw new Error(`projects: ${error.message}`);
    result.projects = (data || []).map((p: any) => p.project_name).filter(Boolean);
  }

  // Open Production jobs on any linked estimate or project, plus the source
  // job itself.
  const filters: string[] = [];
  if (estimateIds.length > 0) filters.push(`estimate_id.in.(${estimateIds.join(',')})`);
  if (projectIds.length > 0) filters.push(`upfit_project_id.in.(${projectIds.join(',')})`);
  if (source === 'graphics_job') filters.push(`id.eq.${id}`);
  if (filters.length > 0) {
    const { data: jobs } = await supabase.from('graphics_jobs')
      .select('id, job_number, job_category, status, install_location')
      .or(filters.join(','));
    const open = (jobs || []).filter((j: any) =>
      (j.id === id && source === 'graphics_job') ||
      ((j.job_category || 'production') === 'production' && !GRAPHICS_FINISHED_STATUSES.includes(j.status)));
    const loc = installLocationForDelivery(d);
    for (const j of open as any[]) {
      const row: Record<string, any> = { ...deliveryToRow(d, 'graphics_jobs'), updated_at: new Date().toISOString() };
      if (loc && j.install_location !== loc) row.install_location = loc;
      // Shipping or a pickup means the vehicle isn't coming to our shop.
      else if (!loc && d.method && j.install_location === SHOP_INSTALL_LOCATION) row.install_location = null;
      const { error } = await supabase.from('graphics_jobs').update(row).eq('id', j.id);
      if (error) throw new Error(`${j.job_number || 'graphics job'}: ${error.message}`);
      if (row.install_location !== undefined) await syncShopInboundForGraphicsJob(supabase, j.id).catch(() => {});
      if (j.job_number) result.jobs.push(j.job_number);
    }
  }

  return result;
}
