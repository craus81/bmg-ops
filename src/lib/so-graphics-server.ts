/**
 * Server side of graphics jobs from a sales order (src/lib/so-graphics.ts):
 * the catalog read that decides which lines are graphics, and the jobs that
 * belong to an order (made from it, made from its estimate, or the fleet
 * order's one job).
 */

import { soItemKey, type SoGraphicsCatalog } from './so-graphics';

type Db = { from: (table: string) => any };

export const SO_GRAPHICS_JOB_COLUMNS = 'id, job_number, title, status, quantity, created_at, estimate_id, netsuite_so_id, fleet_group_id';

export interface SoGraphicsJob {
  id: string;
  jobNumber: string | null;
  title: string | null;
  status: string;
  quantity: number | null;
  createdAt: string | null;
}

/** netsuite_parts.catalog for the order's item numbers. */
export async function loadSoGraphicsCatalog(service: Db, itemNumbers: (string | null | undefined)[]): Promise<SoGraphicsCatalog> {
  const keys = [...new Set(itemNumbers.map(soItemKey).filter(Boolean))];
  const out: SoGraphicsCatalog = new Map();
  for (let i = 0; i < keys.length; i += 200) {
    const { data } = await service.from('netsuite_parts').select('item_number, catalog').in('item_number', keys.slice(i, i + 200));
    for (const c of (data || []) as { item_number: string; catalog: string | null }[]) out.set(soItemKey(c.item_number), { catalog: c.catalog });
  }
  return out;
}

/** The order's live graphics jobs (not cancelled), newest first. */
export async function loadSoGraphicsJobs(service: Db, soId: string, estimateId: string | null): Promise<SoGraphicsJob[]> {
  let fleetGroupId: string | null = null;
  if (estimateId) {
    const { data } = await service.from('estimates').select('fleet_group_id').eq('id', estimateId).maybeSingle();
    fleetGroupId = data?.fleet_group_id || null;
  }
  const ors = [`netsuite_so_id.eq.${soId}`];
  if (estimateId) ors.push(`estimate_id.eq.${estimateId}`);
  if (fleetGroupId) ors.push(`fleet_group_id.eq.${fleetGroupId}`);
  const { data } = await service.from('graphics_jobs')
    .select(SO_GRAPHICS_JOB_COLUMNS)
    .or(ors.join(','))
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(20);
  return ((data || []) as any[]).map(j => ({
    id: j.id, jobNumber: j.job_number || null, title: j.title || null, status: j.status,
    quantity: j.quantity ?? null, createdAt: j.created_at || null,
  }));
}
