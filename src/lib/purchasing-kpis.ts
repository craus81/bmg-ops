/**
 * Purchasing cycle-time KPIs (R6-7). Every timestamp needed already
 * exists — a request is raised, ordered onto a PO, and received at the
 * dock — and nothing ever measured the gaps. This turns them into the
 * numbers a buyer can act on: how long asks sit before they're ordered,
 * how long orders take to arrive, and whether needed-by dates are met.
 *
 * Pure. Medians rather than means throughout: one back-ordered part that
 * took ninety days shouldn't redefine a normal week.
 */

export interface RequestRecord {
  id: string;
  itemNumber: string;
  vendorName: string | null;
  createdAt: string;
  orderedAt: string | null;
  neededBy: string | null;
  status: 'pending' | 'ordered' | 'cancelled' | string;
  orderedPoId: string | null;
}

export interface ReceiptRecord {
  poId: string;
  itemNumber: string;
  receivedAt: string;
}

const DAY = 86_400_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(m * 10) / 10;
}

const daysBetween = (from: string, to: string): number | null => {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = (b - a) / DAY;
  // A negative gap means the data lies (a receipt before its order);
  // exclude it rather than let it drag a median below zero.
  return d < 0 || d > 400 ? null : Math.round(d * 10) / 10;
};

export interface AgingBuckets { d0_3: number; d4_7: number; d8_14: number; d15_30: number; d30plus: number }

export interface PurchasingKpis {
  requests: number;
  ordered: number;
  cancelled: number;
  cancellationRate: number | null;
  medianRequestToOrderDays: number | null;
  requestToOrderSamples: number;
  medianOrderToReceiptDays: number | null;
  orderToReceiptSamples: number;
  /** Of requests with a needed_by, the share received on or before it. */
  neededByHitRate: number | null;
  neededBySamples: number;
  openAging: AgingBuckets;
  oldestOpenDays: number;
  byVendor: { vendor: string; ordered: number; medianOrderToReceiptDays: number | null }[];
  byMonth: { month: string; ordered: number; medianRequestToOrderDays: number | null }[];
}

export function computePurchasingKpis(
  requests: RequestRecord[],
  receipts: ReceiptRecord[],
  nowMs = Date.now(),
): PurchasingKpis {
  // First receipt per (po, item) — a partial delivery still starts the clock.
  const firstReceipt = new Map<string, string>();
  for (const r of receipts) {
    const key = `${r.poId}|${r.itemNumber.trim().toUpperCase()}`;
    const seen = firstReceipt.get(key);
    if (!seen || r.receivedAt < seen) firstReceipt.set(key, r.receivedAt);
  }

  const reqToOrder: number[] = [];
  const orderToReceipt: number[] = [];
  const byVendor = new Map<string, number[]>();
  const byMonth = new Map<string, { ordered: number; gaps: number[] }>();
  const openAging: AgingBuckets = { d0_3: 0, d4_7: 0, d8_14: 0, d15_30: 0, d30plus: 0 };

  let ordered = 0;
  let cancelled = 0;
  let neededByMet = 0;
  let neededByTotal = 0;
  let oldestOpenDays = 0;

  for (const r of requests) {
    if (r.status === 'cancelled') cancelled++;

    if (r.status === 'pending') {
      const age = Math.max(0, Math.floor((nowMs - Date.parse(r.createdAt)) / DAY));
      oldestOpenDays = Math.max(oldestOpenDays, Number.isFinite(age) ? age : 0);
      if (age <= 3) openAging.d0_3++;
      else if (age <= 7) openAging.d4_7++;
      else if (age <= 14) openAging.d8_14++;
      else if (age <= 30) openAging.d15_30++;
      else openAging.d30plus++;
    }

    if (!r.orderedAt) continue;
    ordered++;

    const gap = daysBetween(r.createdAt, r.orderedAt);
    if (gap != null) {
      reqToOrder.push(gap);
      const month = r.orderedAt.slice(0, 7);
      const m = byMonth.get(month) || { ordered: 0, gaps: [] };
      m.ordered += 1;
      m.gaps.push(gap);
      byMonth.set(month, m);
    }

    const received = r.orderedPoId
      ? firstReceipt.get(`${r.orderedPoId}|${r.itemNumber.trim().toUpperCase()}`)
      : undefined;
    if (received) {
      const arrival = daysBetween(r.orderedAt, received);
      if (arrival != null) {
        orderToReceipt.push(arrival);
        const vendor = r.vendorName?.trim() || 'Unknown vendor';
        byVendor.set(vendor, [...(byVendor.get(vendor) || []), arrival]);
      }
      // Needed-by is only answerable once something actually arrived.
      if (r.neededBy) {
        neededByTotal++;
        if (received.slice(0, 10) <= r.neededBy.slice(0, 10)) neededByMet++;
      }
    }
  }

  return {
    requests: requests.length,
    ordered,
    cancelled,
    cancellationRate: requests.length > 0 ? Math.round((cancelled / requests.length) * 1000) / 1000 : null,
    medianRequestToOrderDays: median(reqToOrder),
    requestToOrderSamples: reqToOrder.length,
    medianOrderToReceiptDays: median(orderToReceipt),
    orderToReceiptSamples: orderToReceipt.length,
    neededByHitRate: neededByTotal > 0 ? Math.round((neededByMet / neededByTotal) * 1000) / 1000 : null,
    neededBySamples: neededByTotal,
    openAging,
    oldestOpenDays,
    byVendor: [...byVendor.entries()]
      .map(([vendor, gaps]) => ({ vendor, ordered: gaps.length, medianOrderToReceiptDays: median(gaps) }))
      .sort((a, b) => (b.medianOrderToReceiptDays || 0) - (a.medianOrderToReceiptDays || 0)),
    byMonth: [...byMonth.entries()]
      .map(([month, m]) => ({ month, ordered: m.ordered, medianRequestToOrderDays: median(m.gaps) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}
