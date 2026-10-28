/**
 * The customer's Order status page — where an approved estimate stands, in
 * the customer's words (Craig, 2026-10-28, thread "Keep customers updated
 * after approval"). The rep's "We got your approval" email links here, and
 * the page moves on its own; no further emails go out.
 *
 *   Approved       the customer said yes (or a rep recorded a phone/PO yes)
 *   Parts ordered  every part requested from the estimate is on a PO
 *   All parts in   set BY HAND (Mark all parts in) — Craig doesn't trust
 *                  inventory or receiving to drive it yet
 *   Scheduled      a drop-off / install date is set
 *   In the shop    the vehicle is checked in
 *   Done           the vehicle is finished, or the graphics are installed
 *   Invoiced       the sales order is billed
 *
 * Pure: order-status-server.ts loads the rows, this decides what they mean,
 * so tests pin it. Nothing here carries a price or an internal note.
 */

export type OrderStageKey =
  | 'approved' | 'parts_ordered' | 'parts_in' | 'scheduled' | 'in_shop' | 'done' | 'invoiced';

export const ORDER_STAGES: { key: OrderStageKey; label: string; waiting: string }[] = [
  { key: 'approved', label: 'Approved', waiting: '' },
  { key: 'parts_ordered', label: 'Parts ordered', waiting: "We'll order anything we don't have on the shelf" },
  { key: 'parts_in', label: 'All parts in', waiting: "We'll let you know when everything arrives" },
  { key: 'scheduled', label: 'Scheduled', waiting: "We'll call you to set a date" },
  { key: 'in_shop', label: 'In the shop', waiting: '' },
  { key: 'done', label: 'Done', waiting: '' },
  { key: 'invoiced', label: 'Invoiced', waiting: '' },
];

export interface OrderStatusInput {
  approved: boolean;
  approvedAt: string | null;
  /** Who approved (the per-person link's address), when known. */
  approvedBy: string | null;
  /** Purchase requests from the estimate or its upfit project. */
  requests: { item_number: string | null; status: string; ordered_at: string | null }[];
  /** Drop ship POs made from the estimate — ordered by definition. */
  dropShips: { item_numbers: string[]; created_at: string | null }[];
  partsAllInAt: string | null;
  /** The earliest live date: a shop booking, the Arriving list, or a
   *  graphics job's install date. */
  schedule: { date: string; time: string | null; place: 'shop' | 'onsite' } | null;
  inShopAt: string | null;
  done: { at: string | null; label: string } | null;
  invoiced: { at: string | null; number: string | null } | null;
}

export type OrderStageState = 'done' | 'now' | 'todo';

export interface OrderStageView {
  key: OrderStageKey;
  label: string;
  state: OrderStageState;
  detail: string;
}

export interface OrderStatusView {
  current: OrderStageKey;
  currentLabel: string;
  stages: OrderStageView[];
}

const TZ = 'America/Chicago';

/** "Oct 28" — date-only strings stay on their own day. */
export function fmtDay(iso: string | null | undefined, opts: { weekday?: boolean } = {}): string {
  if (!iso) return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    timeZone: dateOnly ? 'UTC' : TZ,
    ...(opts.weekday ? { weekday: 'short' } : {}),
    month: 'short', day: 'numeric',
  });
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

/** "08:00:00" → "8:00 AM". */
export function fmtTimeOfDay(t: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

const key = (s: string | null | undefined) => String(s || '').trim().toUpperCase();

function partsOrdered(input: OrderStatusInput): { total: number; ordered: number; lastAt: string | null } {
  // One entry per part number; a part is ordered when every live row for it
  // is (a partial order splits the request and leaves the rest pending).
  const parts = new Map<string, boolean>();
  let lastAt: string | null = null;
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a > b ? a : b));
  for (const r of input.requests) {
    if (r.status === 'cancelled') continue;
    const k = key(r.item_number) || `#${parts.size}`;
    const ordered = r.status === 'ordered';
    parts.set(k, (parts.get(k) ?? true) && ordered);
    if (ordered) lastAt = later(lastAt, r.ordered_at);
  }
  for (const d of input.dropShips) {
    for (const item of d.item_numbers) {
      const k = key(item);
      if (k) parts.set(k, true);
    }
    lastAt = later(lastAt, d.created_at);
  }
  return { total: parts.size, ordered: [...parts.values()].filter(Boolean).length, lastAt };
}

export function deriveOrderStatus(input: OrderStatusInput): OrderStatusView {
  const parts = partsOrdered(input);
  const reached: Record<OrderStageKey, boolean> = {
    approved: input.approved,
    parts_ordered: parts.total > 0 && parts.ordered === parts.total,
    parts_in: !!input.partsAllInAt,
    scheduled: !!input.schedule,
    in_shop: !!input.inShopAt,
    done: !!input.done,
    invoiced: !!input.invoiced,
  };
  // The furthest stage reached is where the order is; everything before it
  // is done even when it left no trace (a job billed without a check-in).
  let currentIdx = 0;
  ORDER_STAGES.forEach((s, i) => { if (reached[s.key]) currentIdx = i; });
  const lastIdx = ORDER_STAGES.length - 1;

  const doneDetail = (k: OrderStageKey): string => {
    switch (k) {
      case 'approved':
        return [fmtDay(input.approvedAt), input.approvedBy ? `by ${input.approvedBy}` : ''].filter(Boolean).join(' · ');
      case 'parts_ordered':
        if (parts.total === 0) return 'Nothing needed ordering';
        if (parts.ordered < parts.total) return '';
        return [parts.total === 1 ? 'The part is ordered' : `All ${parts.total} parts ordered`, fmtDay(parts.lastAt)].filter(Boolean).join(' · ');
      case 'parts_in':
        return input.partsAllInAt ? `Everything is here · ${fmtDay(input.partsAllInAt)}` : '';
      case 'scheduled': {
        const s = input.schedule;
        if (!s) return '';
        const time = fmtTimeOfDay(s.time);
        const where = s.place === 'onsite'
          ? (time ? `install at your location, arriving ${time}` : 'install at your location')
          : (time ? `drop off ${time} at our O'Fallon shop` : "at our O'Fallon shop");
        return `${fmtDay(s.date, { weekday: true })} · ${where}`;
      }
      case 'in_shop':
        return input.inShopAt ? `Checked in ${fmtDay(input.inShopAt, { weekday: true })} · ${fmtClock(input.inShopAt)}` : '';
      case 'done':
        return input.done ? [input.done.label, fmtDay(input.done.at, { weekday: true })].filter(Boolean).join(' · ') : '';
      case 'invoiced':
        return input.invoiced
          ? [input.invoiced.number ? `Invoice ${input.invoiced.number}` : 'Invoice sent', fmtDay(input.invoiced.at)].filter(Boolean).join(' · ')
          : '';
    }
  };

  const stages: OrderStageView[] = ORDER_STAGES.map((s, i) => {
    const state: OrderStageState = i < currentIdx || (i === currentIdx && i === lastIdx) ? 'done' : i === currentIdx ? 'now' : 'todo';
    let detail = state === 'todo' ? s.waiting : doneDetail(s.key);
    // Waiting on parts: say how far along the ordering is.
    if (state === 'todo' && s.key === 'parts_ordered' && parts.total > 0) {
      detail = `${parts.ordered} of ${parts.total} parts ordered`;
    }
    return { key: s.key, label: s.label, state, detail };
  });

  const current = ORDER_STAGES[currentIdx];
  return { current: current.key, currentLabel: current.label, stages };
}
