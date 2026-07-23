/**
 * Incoming-parts math for the Parts Mail page: fold the synced open
 * vendor-PO lines (what's still to receive, with the email-scanned ETA /
 * tracking that lives on the PO) against on-hand stock (netsuite_parts) and
 * job reservations (part_allocations) so the shop can see, per part, what's
 * arriving and when — and where stock plus what's on order still won't cover
 * what's been promised to jobs.
 *
 * Pure and client-safe (no server-only imports) so it unit-tests in
 * isolation and runs inside the browser Parts Mail component. The normalize
 * / open-status helpers mirror vendor-po-sync.ts — which is server-only (it
 * imports the NetSuite client), so we can't import them from there — and the
 * inventory page keeps its own copy for the same reason.
 */

/** NetSuite sub-item ids come back as "PARENT : CHILD" — key on the last segment. */
export function normalizeItemNumber(s: string | null | undefined): string {
  const segs = String(s || '').split(':');
  return segs[segs.length - 1].trim().toUpperCase();
}

/** PO statuses with nothing left to receive (Fully Billed / Closed / Cancelled). */
const CLOSED_PO_STATUSES = ['F', 'G', 'H'];
export function isOpenPoStatus(status: string | null | undefined): boolean {
  return !CLOSED_PO_STATUSES.includes(String(status || '').toUpperCase());
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

/** Sort key for ETAs: real dates ascending (ISO strings compare lexically), nulls last. */
export function compareEta(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

// ── Raw row shapes (as fetched from Supabase) ────────────────────────────
export interface RawPoLine {
  item_number: string | null;
  /** PO line memo — used as the part name when the catalog has none. */
  description?: string | null;
  quantity: number | string | null;
  quantity_received: number | string | null;
  netsuite_vendor_pos: {
    tranid: string | null;
    vendor_name: string | null;
    status: string | null;
    eta_date: string | null;
    tracking_number: string | null;
    carrier: string | null;
    trandate: string | null;
  } | null;
}
export interface RawPart {
  item_number: string | null;
  display_name: string | null;
  quantity_on_hand: number | string | null;
  quantity_available: number | string | null;
}
export interface RawAllocation {
  item_number: string | null;
  quantity: number | string | null;
  project_name: string | null;
}

// ── Assembled shapes ─────────────────────────────────────────────────────
export interface IncomingShipment {
  tranid: string | null;
  vendor: string | null;
  eta: string | null;
  tracking: string | null;
  carrier: string | null;
  trandate: string | null;
  remaining: number;
}
export type IncomingState = 'short' | 'incoming_covers' | 'stocked';
export interface IncomingPartRow {
  item_number: string;
  display_name: string | null;
  /** Physical count per NetSuite. */
  on_hand: number;
  /** NetSuite available — on hand minus NetSuite-side commitments. */
  available: number;
  /** Reserved to jobs in FleetSuite, summed across every job. */
  allocated: number;
  allocations: { project: string; qty: number }[];
  /** Still to receive across all open vendor POs. */
  incoming: number;
  /** available − allocated, floored at 0: uncommitted stock right now. */
  free: number;
  /** allocated − available − incoming, floored at 0: still uncovered after everything on order lands. */
  shortfall: number;
  /** available + incoming − allocated: net position once everything on order arrives (can be negative). */
  net_after: number;
  state: IncomingState;
  /** Earliest ETA among the open shipments (null when nothing has an ETA yet). */
  soonest_eta: string | null;
  shipments: IncomingShipment[];
}

export interface IncomingSummary {
  /** Distinct parts with something on order. */
  parts: number;
  /** Open vendor-PO lines feeding those parts. */
  shipments: number;
  /** Parts where stock + incoming still won't cover job reservations. */
  short: number;
}

/**
 * Pure fold — pinned by tests. Only parts that are actually incoming (an
 * open PO line with a remaining quantity) become rows; stock and allocation
 * for everything else is ignored. A part with no stock row is treated as
 * zero on hand (the honest, conservative read for a shortfall).
 */
export function assembleIncomingParts(input: {
  poLines: RawPoLine[];
  parts: RawPart[];
  allocations: RawAllocation[];
}): { rows: IncomingPartRow[]; summary: IncomingSummary } {
  // Stock, keyed by normalized item number (dupes summed).
  const stock = new Map<string, { on_hand: number; available: number; display_name: string | null }>();
  for (const p of input.parts) {
    const key = normalizeItemNumber(p.item_number);
    if (!key) continue;
    const s = stock.get(key) || { on_hand: 0, available: 0, display_name: null };
    s.on_hand += num(p.quantity_on_hand);
    s.available += num(p.quantity_available);
    if (!s.display_name && p.display_name) s.display_name = p.display_name;
    stock.set(key, s);
  }

  // Reservations to jobs — total plus the per-job breakdown for the chips.
  const alloc = new Map<string, { total: number; byProject: { project: string; qty: number }[] }>();
  for (const a of input.allocations) {
    const key = normalizeItemNumber(a.item_number);
    if (!key) continue;
    const qty = num(a.quantity);
    if (qty <= 0) continue;
    const g = alloc.get(key) || { total: 0, byProject: [] };
    g.total += qty;
    g.byProject.push({ project: a.project_name || 'Unknown project', qty });
    alloc.set(key, g);
  }

  // Incoming — open PO lines with something left to receive.
  const incoming = new Map<string, { qty: number; shipments: IncomingShipment[]; description: string | null }>();
  let shipmentCount = 0;
  for (const l of input.poLines) {
    const po = l.netsuite_vendor_pos;
    if (!isOpenPoStatus(po?.status)) continue;
    const remaining = Math.max(0, num(l.quantity) - num(l.quantity_received));
    if (remaining <= 0) continue;
    const key = normalizeItemNumber(l.item_number);
    if (!key) continue;
    const g = incoming.get(key) || { qty: 0, shipments: [], description: null };
    g.qty += remaining;
    if (!g.description) {
      const memo = String(l.description ?? '').trim();
      if (memo) g.description = memo;
    }
    g.shipments.push({
      tranid: po?.tranid || null,
      vendor: po?.vendor_name || null,
      eta: po?.eta_date || null,
      tracking: po?.tracking_number || null,
      carrier: po?.carrier || null,
      trandate: po?.trandate || null,
      remaining,
    });
    incoming.set(key, g);
    shipmentCount++;
  }

  const rows: IncomingPartRow[] = [];
  for (const [key, inc] of incoming) {
    const s = stock.get(key) || { on_hand: 0, available: 0, display_name: null };
    const a = alloc.get(key) || { total: 0, byProject: [] };
    const on_hand = Math.max(0, s.on_hand);
    const available = Math.max(0, s.available);
    const allocated = a.total;
    const incomingQty = inc.qty;
    const free = Math.max(0, available - allocated);
    const shortfall = Math.max(0, allocated - available - incomingQty);
    const net_after = available + incomingQty - allocated;
    const state: IncomingState =
      shortfall > 0 ? 'short'
        : available < allocated ? 'incoming_covers'
          : 'stocked';
    const shipments = inc.shipments
      .slice()
      .sort((x, y) => compareEta(x.eta, y.eta) || (y.remaining - x.remaining));
    const soonest_eta = shipments.find(sh => sh.eta)?.eta || null;
    rows.push({
      item_number: key,
      // Catalog name first, then the PO line memo, so a part missing from the
      // catalog still shows a description instead of a bare item number.
      display_name: s.display_name || inc.description,
      on_hand,
      available,
      allocated,
      allocations: a.byProject.slice().sort((x, y) => y.qty - x.qty),
      incoming: incomingQty,
      free,
      shortfall,
      net_after,
      state,
      soonest_eta,
      shipments,
    });
  }

  // Timeline read: soonest arrival first (nulls last), problems before the
  // rest at the same ETA, then part number for a stable order.
  const statePriority: Record<IncomingState, number> = { short: 0, incoming_covers: 1, stocked: 2 };
  rows.sort((x, y) =>
    compareEta(x.soonest_eta, y.soonest_eta)
    || (statePriority[x.state] - statePriority[y.state])
    || x.item_number.localeCompare(y.item_number),
  );

  return {
    rows,
    summary: {
      parts: rows.length,
      shipments: shipmentCount,
      short: rows.filter(r => r.state === 'short').length,
    },
  };
}
