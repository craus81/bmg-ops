/**
 * Checklist tasks generated from a sales order's own lines (R6-10).
 *
 * The curated template says how to work safely and what to verify at the
 * end. It cannot say what to INSTALL — that's whatever the customer
 * bought, which lives on the sales order. So when install starts on a
 * check-in with a linked SO, each stockable line becomes its own task
 * carrying the part number, quantity, expected hours and catalog photo.
 *
 * Two rules keep this from making the floor worse:
 *
 *   1. **An SO-line task is never `required`.** The completion gate blocks
 *      on required tasks. These rows are synced data — a mirror that
 *      dropped a line, or a service item that slipped past the type
 *      filter, would strand a finished vehicle nobody could close. Only
 *      the human-curated template gets to block a completion.
 *
 *   2. **Unpriced labor stays unknown.** netsuite_parts.labor_hours is
 *      NULL when nobody has priced the part and 0 when the part
 *      deliberately carries no labor (the migration-258 rule). Rendering
 *      NULL as "0h" would quietly understate a day's work, so the total
 *      reports its own coverage instead.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isStockableItemType } from './parts-demand';
import { fetchAllRows } from './fetch-all';
import { normalizeItemNumber } from './vendor-po-sync';

/** Line items the estimate builder and SO push use as placeholders. */
const PLACEHOLDER_ITEMS = new Set(['FS-CUSTOM']);

export interface SoTaskLine {
  item_number: string | null;
  description: string | null;
  quantity: number | null;
}

export interface TaskCatalogEntry {
  item_number: string;
  display_name?: string | null;
  description?: string | null;
  item_type?: string | null;
  /** NULL = unpriced. 0 = no labor charged. Never conflate them. */
  labor_hours?: number | null;
  image_path?: string | null;
}

export interface SoLineTask {
  itemNumber: string;
  label: string;
  quantity: number;
  /** quantity x labor_hours, or null when the part is unpriced. */
  expectedHours: number | null;
  imagePath: string | null;
  /** False when no catalog row matched — shown, but nothing enriched it. */
  inCatalog: boolean;
}

const norm = (s: string | null | undefined) => String(s || '').trim().toUpperCase();

/** "2× AS-4200 — Steel shelving unit" — what a tech reads off the wall. */
export function taskLabel(itemNumber: string, name: string | null, quantity: number): string {
  const qty = quantity === 1 ? '' : `${Number.isInteger(quantity) ? quantity : quantity.toFixed(2)}× `;
  const trimmed = (name || '').trim();
  return trimmed ? `${qty}${itemNumber} — ${trimmed}` : `${qty}${itemNumber}`;
}

/**
 * Roll SO lines into one task per part.
 *
 * Quantities SUM across duplicate lines rather than producing two tasks
 * for the same part: a sales order that lists a bracket on three lines is
 * still one thing to fetch and install, and two half-checked rows for one
 * part is how a checklist stops being trusted.
 */
export function buildSoLineTasks(
  lines: SoTaskLine[],
  catalog: Map<string, TaskCatalogEntry>,
): SoLineTask[] {
  const byItem = new Map<string, { quantity: number; description: string | null }>();

  for (const line of lines) {
    const key = norm(line.item_number);
    if (!key || PLACEHOLDER_ITEMS.has(key)) continue;
    const cat = catalog.get(key);
    // A line whose catalog row is a service/labor item is not something
    // anybody installs. An item MISSING from the catalog is kept — the
    // customer bought it, so it belongs on the wall even unenriched.
    if (cat && !isStockableItemType(cat.item_type)) continue;

    const qty = Number(line.quantity);
    const add = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const existing = byItem.get(key);
    if (existing) {
      existing.quantity += add;
      if (!existing.description && line.description) existing.description = line.description;
    } else {
      byItem.set(key, { quantity: add, description: line.description || null });
    }
  }

  const out: SoLineTask[] = [];
  for (const [itemNumber, agg] of byItem) {
    const cat = catalog.get(itemNumber);
    const name = cat?.display_name || cat?.description || agg.description || null;
    const hours = cat?.labor_hours;
    out.push({
      itemNumber,
      label: taskLabel(itemNumber, name, agg.quantity),
      quantity: agg.quantity,
      expectedHours: hours === null || hours === undefined
        ? null
        : Math.round(Number(hours) * agg.quantity * 100) / 100,
      imagePath: cat?.image_path || null,
      inCatalog: Boolean(cat),
    });
  }
  out.sort((a, b) => a.itemNumber.localeCompare(b.itemNumber));
  return out;
}

export interface TaskHoursSummary {
  /** Sum over the parts that HAVE a priced labor figure. */
  hours: number;
  /** Parts counted in that sum. */
  priced: number;
  /** Parts with no labor figure at all — the sum is short by these. */
  unpriced: number;
  total: number;
}

/** The honest total: what's priced, and how much is missing from it. */
export function summarizeTaskHours(tasks: SoLineTask[]): TaskHoursSummary {
  let hours = 0, priced = 0, unpriced = 0;
  for (const t of tasks) {
    if (t.expectedHours === null) unpriced++;
    else { hours += t.expectedHours; priced++; }
  }
  return { hours: Math.round(hours * 100) / 100, priced, unpriced, total: tasks.length };
}

/** One line for the checklist header. Never claims a total it can't back. */
export function hoursNote(s: TaskHoursSummary): string {
  if (s.total === 0) return '';
  if (s.priced === 0) return `${s.total} part${s.total !== 1 ? 's' : ''} · no labor priced yet`;
  const h = `${s.hours}h`;
  return s.unpriced > 0
    ? `${h} across ${s.priced} part${s.priced !== 1 ? 's' : ''} · ${s.unpriced} unpriced`
    : `${h} across ${s.priced} part${s.priced !== 1 ? 's' : ''}`;
}

/** Rows for job_tasks. `required` is hard-coded false — see the header. */
export function buildSoTaskRows(tasks: SoLineTask[], vehicleId: string, startSort: number) {
  return tasks.map((t, i) => ({
    job_type: 'fleet_checkin',
    job_id: vehicleId,
    label: t.label,
    required: false,
    sort_order: startSort + i,
    source: 'so_line',
    item_number: t.itemNumber,
    quantity: t.quantity,
    expected_hours: t.expectedHours,
    image_path: t.imagePath,
  }));
}

/**
 * Generate checklist tasks from the check-in's linked sales order.
 *
 * Never throws into the caller: a vehicle with no SO, an unsynced mirror,
 * or a failed read all leave the curated checklist exactly as it was. The
 * parts list is an addition to the checklist, never a precondition for
 * having one.
 */
export async function appendSoLineTasks(
  service: SupabaseClient<any, any, any>,
  vehicleId: string,
  startSort: number,
): Promise<number> {
  const { data: checkin } = await service
    .from('fleet_checkins')
    .select('netsuite_sales_order_id, sales_order_number')
    .eq('id', vehicleId)
    .maybeSingle();
  if (!checkin?.netsuite_sales_order_id && !checkin?.sales_order_number) return 0;

  // Find the mirrored SO by id first, then by number — the same precedence
  // the migration-085 handoff trigger uses.
  let soRow: any = null;
  if (checkin.netsuite_sales_order_id) {
    const { data } = await service
      .from('netsuite_sales_orders').select('id')
      .eq('netsuite_id', String(checkin.netsuite_sales_order_id))
      .maybeSingle();
    soRow = data;
  }
  if (!soRow && checkin.sales_order_number) {
    const { data } = await service
      .from('netsuite_sales_orders').select('id')
      .eq('tranid', checkin.sales_order_number)
      .maybeSingle();
    soRow = data;
  }
  if (!soRow) return 0;

  const lineRead = await fetchAllRows<any>((from, to) => service
    .from('netsuite_sales_order_lines')
    .select('item_number, description, quantity')
    .eq('so_id', soRow.id)
    .order('id')
    .range(from, to));
  if (lineRead.error || lineRead.data.length === 0) return 0;

  const keys = [...new Set(lineRead.data
    .map(l => normalizeItemNumber(l.item_number))
    .filter(Boolean))];
  const catalog = new Map<string, any>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data } = await service
      .from('netsuite_parts')
      .select('item_number, display_name, description, item_type, labor_hours, image_path')
      .in('item_number', keys.slice(i, i + 200));
    for (const c of data || []) catalog.set(normalizeItemNumber(c.item_number), c);
  }

  const tasks = buildSoLineTasks(lineRead.data, catalog);
  if (tasks.length === 0) return 0;

  // NOT an upsert. Migration 290's unique index is PARTIAL (so_line rows
  // with an item number), and Postgres cannot infer ON CONFLICT from a
  // partial index — the upsert would fail outright. So read what's
  // already on the wall and insert only the parts that aren't, which is
  // also what keeps a tech's ticks from being wiped by a re-run.
  const { data: existing } = await service
    .from('job_tasks')
    .select('item_number')
    .eq('job_type', 'fleet_checkin')
    .eq('job_id', vehicleId)
    .eq('source', 'so_line');
  const already = new Set((existing || [])
    .map((r: any) => String(r.item_number || '').toUpperCase())
    .filter(Boolean));

  const fresh = tasks.filter(t => !already.has(t.itemNumber.toUpperCase()));
  if (fresh.length === 0) return 0;

  const { error } = await service
    .from('job_tasks')
    .insert(buildSoTaskRows(fresh, vehicleId, startSort + already.size));
  if (error) {
    console.error('appendSoLineTasks insert failed:', error.message);
    return 0;
  }
  return fresh.length;
}
