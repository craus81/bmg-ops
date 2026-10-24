import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * One vehicle, one arrival (Craig 2026-10-24). shop_inbound keeps a row per
 * REASON a vehicle is coming (graphics job, sales order, upfit project), so a
 * van with a graphics job and an SO showed on the Arriving list twice. This
 * folds those rows into one group per van:
 *
 *  - Same van = the graphics job / upfit project came from the same estimate
 *    as the SO row (SO rows are keyed on the estimate UUID), the rows share
 *    an SO number, or the VIN matches. Never customer name alone — a fleet
 *    has several vans coming.
 *  - One estimate covering several vans (one SO, several graphics jobs) stays
 *    one group per graphics job; the SO / upfit rows ride along on each as
 *    `shared` rows.
 *  - The van arrives once: on its drop-off date (SO booking, upfit drop-off,
 *    manual date). Only with no drop-off date does the graphics install date
 *    stand in. Install dates are carried as work on their own day.
 */

export type InboundSource = 'graphics_job' | 'upfit_project' | 'manual' | 'sales_order';

export interface InboundLike {
  id: string;
  source_type: InboundSource;
  source_id: string | null;
  expected_date: string | null;
  need_back_date?: string | null;
  vin?: string | null;
  netsuite_so_number?: string | null;
  vehicle_desc?: string | null;
}

export interface ArrivalLinks {
  /** graphics job id → estimate id */
  graphicsEstimate: Map<string, string>;
  /** upfit project id → estimate id */
  upfitEstimate: Map<string, string>;
}

export interface ArrivalGroup<R extends InboundLike> {
  key: string;
  /** Rows that belong to this van alone. */
  own: R[];
  /** Rows shared with other vans of the same estimate (multi-van SO). */
  shared: R[];
  /** own + shared, SO first, then upfit, graphics, manual. */
  rows: R[];
  /** The row that names the van on the list. */
  lead: R;
  /** The day the van shows up; null = no date yet. */
  arrivalDate: string | null;
  /** True when arrivalDate is a real drop-off date, not a graphics install stand-in. */
  hasDropoff: boolean;
  needBack: string | null;
  /** Graphics installs for this van, with their dates. */
  installs: { row: R; date: string }[];
  /** An install is scheduled before the van is due in. */
  installBeforeArrival: boolean;
}

const ORDER: Record<InboundSource, number> = { sales_order: 0, upfit_project: 1, graphics_job: 2, manual: 3 };
const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : null);
const minDay = (ds: (string | null | undefined)[]) =>
  ds.map(day).filter((d): d is string => !!d).sort()[0] || null;

export function groupArrivals<R extends InboundLike>(rows: R[], links: ArrivalLinks): ArrivalGroup<R>[] {
  // Union-find over rows, joined by shared keys.
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstByKey = new Map<string, number>();
  const join = (i: number, key: string) => {
    const j = firstByKey.get(key);
    if (j === undefined) firstByKey.set(key, i);
    else parent[find(i)] = find(j);
  };

  rows.forEach((r, i) => {
    if (r.source_type === 'manual' || !r.source_id) return;
    const est =
      r.source_type === 'sales_order' ? r.source_id
        : r.source_type === 'graphics_job' ? links.graphicsEstimate.get(r.source_id)
          : links.upfitEstimate.get(r.source_id);
    if (est) join(i, `e:${est}`);
    const so = (r.netsuite_so_number || '').trim();
    if (so) join(i, `so:${so}`);
    const vin = (r.vin || '').trim().toUpperCase();
    if (vin) join(i, `v:${vin}`);
  });

  const comps = new Map<number, R[]>();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!comps.has(root)) comps.set(root, []);
    comps.get(root)!.push(r);
  });

  const groups: ArrivalGroup<R>[] = [];
  for (const members of comps.values()) {
    const graphics = members.filter(r => r.source_type === 'graphics_job');
    if (graphics.length > 1) {
      const rest = members.filter(r => r.source_type !== 'graphics_job');
      for (const g of graphics) groups.push(build([g], rest));
    } else {
      groups.push(build(members, []));
    }
  }

  return groups.sort((a, b) => {
    if (a.arrivalDate !== b.arrivalDate) {
      if (!a.arrivalDate) return 1;
      if (!b.arrivalDate) return -1;
      return a.arrivalDate < b.arrivalDate ? -1 : 1;
    }
    return a.key < b.key ? -1 : 1;
  });
}

function build<R extends InboundLike>(own: R[], shared: R[]): ArrivalGroup<R> {
  const byOrder = (a: R, b: R) => ORDER[a.source_type] - ORDER[b.source_type];
  const sortedOwn = [...own].sort(byOrder);
  const rows = [...own, ...shared].sort(byOrder);
  const dropoff = minDay(rows.filter(r => r.source_type !== 'graphics_job').map(r => r.expected_date));
  const installs = rows
    .filter(r => r.source_type === 'graphics_job' && day(r.expected_date))
    .map(r => ({ row: r, date: day(r.expected_date)! }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const arrivalDate = dropoff || installs[0]?.date || null;
  return {
    key: sortedOwn[0].id,
    own: sortedOwn,
    shared,
    rows,
    // A multi-van group's own row is its graphics job — that title tells
    // the vans apart; otherwise the SO row (it carries the unit number).
    lead: sortedOwn[0],
    arrivalDate,
    hasDropoff: !!dropoff,
    needBack: minDay(rows.map(r => r.need_back_date)),
    installs,
    installBeforeArrival: !!dropoff && installs.some(i => i.date < dropoff),
  };
}

/**
 * The rows that close when this van is marked arrived or cancelled: its own
 * rows, plus shared rows no other van on the list still needs.
 */
export function rowsToClose<R extends InboundLike>(group: ArrivalGroup<R>, all: ArrivalGroup<R>[]): R[] {
  const sharedElsewhere = new Set<string>();
  for (const g of all) {
    if (g.key === group.key) continue;
    for (const r of g.shared) sharedElsewhere.add(r.id);
  }
  return [...group.own, ...group.shared.filter(r => !sharedElsewhere.has(r.id))];
}

/** Look up the estimate behind each graphics job and upfit project row. */
export async function loadArrivalLinks(client: SupabaseClient, rows: InboundLike[]): Promise<ArrivalLinks> {
  const ids = (t: InboundSource) => [...new Set(rows.filter(r => r.source_type === t && r.source_id).map(r => r.source_id!))];
  const links: ArrivalLinks = { graphicsEstimate: new Map(), upfitEstimate: new Map() };
  const fill = async (table: string, list: string[], into: Map<string, string>) => {
    for (let i = 0; i < list.length; i += 100) {
      const { data } = await client.from(table).select('id, estimate_id').in('id', list.slice(i, i + 100));
      for (const r of (data || []) as { id: string; estimate_id: string | null }[]) {
        if (r.estimate_id) into.set(r.id, r.estimate_id);
      }
    }
  };
  await Promise.all([
    fill('graphics_jobs', ids('graphics_job'), links.graphicsEstimate),
    fill('upfit_projects', ids('upfit_project'), links.upfitEstimate),
  ]);
  return links;
}
