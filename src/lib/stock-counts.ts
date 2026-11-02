/**
 * Counts (Books part 69, migration 499, docs/books.md "Counts"; the NetSuite
 * Exit Checklist's "Count screen": count sheets by location, a variance review
 * and one approved adjustment, tried on a partial count in September 2027). A
 * count lists the items to count at one location, everything NetSuite has
 * there, the items matching a search, or items picked one by one, on a sheet
 * to print or to type into on a phone. Each count typed in is kept with
 * NetSuite's live count when it was saved, and the difference is from that,
 * so it stays right when stock moves afterwards. Once it's counted, its
 * differences are asked for as one, and a super admin who didn't ask approves
 * them, which makes one NetSuite Inventory Adjustment at the location to 52000
 * Inventory Adjustment, a line for each item that differs.
 *
 * Built switched off (`stock_counts`, Books → Switches): until it's on, only
 * super admins count and ask, to see what it would post, and nothing goes to
 * NetSuite. Pure rules, shared by the Counts pages (/admin/inventory/counts)
 * and /api/inventory/counts. Nobody is alerted (Craig, 2026-10-30: no alerts
 * for adjustments).
 */
import { QUANTITY_PLACES, hasTooManyPlaces, quantityText, roundQuantity } from '@/lib/inventory-transfers';

export type CountStatus = 'counting' | 'asked' | 'sending' | 'unsure' | 'made' | 'cancelled';

/** Not made or stopped yet: an item is on one of these at a time per location. */
export const OPEN_STATUSES: readonly CountStatus[] = ['counting', 'asked', 'sending', 'unsure'];

/** The most items one count takes. */
export const MAX_LINES = 500;
/** The most one count of an item takes. */
export const COUNTED_MAX = 1_000_000;
export const WHY_MAX = 300;
/** How long a press of Approve can say it's posting before FleetSuite asks NetSuite what became of it; the route stops at 60 seconds. */
export const STALE_MS = 5 * 60 * 1000;

export const STATUS_TEXT: Readonly<Record<CountStatus, string>> = {
  counting: 'Being counted',
  asked: 'Waiting for approval',
  sending: 'Being posted to NetSuite',
  unsure: "Posted, but NetSuite didn't say whether it took it",
  made: 'Done',
  cancelled: 'Stopped',
};

/** Why it can't be done to the count now, by where the count is. */
export const NOT_NOW_TEXT: Readonly<Record<CountStatus, string>> = {
  counting: "It's being counted, so it isn't waiting for approval.",
  asked: "It's waiting for approval, so it can't be changed. Whoever asked can withdraw it, or a super admin can turn it down.",
  sending: "It's being posted to NetSuite now.",
  unsure: "It was posted, but NetSuite didn't say whether it took it. Press Ask NetSuite to find out.",
  made: "It's done already.",
  cancelled: 'It was stopped.',
};

/** A count, as the pages show it. */
export interface StockCount {
  id: string;
  number: number;
  /** CNT-0001. */
  label: string;
  locationId: string;
  locationName: string;
  what: string;
  /** The day its adjustment is dated in NetSuite. */
  countDate: string;
  status: CountStatus;
  startedBy: string | null;
  startedByName: string | null;
  startedAt: string;
  askedBy: string | null;
  askedByName: string | null;
  askedAt: string | null;
  sentByName: string | null;
  sentAt: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  turnedDownByName: string | null;
  turnedDownAt: string | null;
  why: string | null;
  netsuiteAdjustmentId: string | null;
  netsuiteNumber: string | null;
  error: string | null;
  updatedAt: string;
}

/** An item on a count, as the pages show it. */
export interface CountLine {
  netsuiteItemId: string;
  itemNumber: string;
  displayName: string | null;
  position: number;
  /** NetSuite's live count at the location when it went on the count. */
  onHandStart: number;
  /** What was counted; null until it is. */
  counted: number | null;
  /** NetSuite's live count when the count was saved, which the difference is from. */
  onHandThen: number | null;
  countedByName: string | null;
  countedAt: string | null;
}

/** An item that differs and can't be posted as counted (stock_count_blocked). */
export interface BlockedLine {
  netsuiteItemId: string;
  itemNumber: string;
  why: 'adjusted' | 'asked';
  byName: string | null;
  at: string | null;
}

export const COUNT_COLUMNS = 'id, number, location_id, location_name, what, count_date, status, started_by, started_by_name, started_at, '
  + 'asked_by, asked_by_name, asked_at, sent_by_name, sent_at, decided_by_name, decided_at, turned_down_by_name, turned_down_at, why, '
  + 'netsuite_adjustment_id, netsuite_adjustment_number, error, updated_at';
export const LINE_COLUMNS = 'netsuite_item_id, item_number, display_name, position, on_hand_start, counted, on_hand_then, counted_by_name, counted_at';

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const quantity = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export const countLabel = (number: number) => `CNT-${String(number).padStart(4, '0')}`;

/** FleetSuite's own name for a count's adjustment in NetSuite (its External ID): NetSuite never takes two under one. */
export const countExternalId = (id: string) => `fleetsuite-count-${id}`;

/** A row of stock_counts, or one its functions answered with, as the pages show it. */
export function countFromRow(row: Record<string, unknown>): StockCount {
  const number = Number(row.number);
  return {
    id: String(row.id),
    number,
    label: countLabel(number),
    locationId: String(row.location_id),
    locationName: String(row.location_name),
    what: String(row.what),
    countDate: String(row.count_date).slice(0, 10),
    status: row.status as CountStatus,
    startedBy: text(row.started_by),
    startedByName: text(row.started_by_name),
    startedAt: String(row.started_at),
    askedBy: text(row.asked_by),
    askedByName: text(row.asked_by_name),
    askedAt: text(row.asked_at),
    sentByName: text(row.sent_by_name),
    sentAt: text(row.sent_at),
    decidedByName: text(row.decided_by_name),
    decidedAt: text(row.decided_at),
    turnedDownByName: text(row.turned_down_by_name),
    turnedDownAt: text(row.turned_down_at),
    why: text(row.why),
    netsuiteAdjustmentId: text(row.netsuite_adjustment_id),
    netsuiteNumber: text(row.netsuite_adjustment_number),
    error: text(row.error),
    updatedAt: String(row.updated_at),
  };
}

/** A row of stock_count_lines as the pages show it. */
export function lineFromRow(row: Record<string, unknown>): CountLine {
  return {
    netsuiteItemId: String(row.netsuite_item_id),
    itemNumber: String(row.item_number),
    displayName: text(row.display_name),
    position: Number(row.position),
    onHandStart: Number(row.on_hand_start),
    counted: quantity(row.counted),
    onHandThen: quantity(row.on_hand_then),
    countedByName: text(row.counted_by_name),
    countedAt: text(row.counted_at),
  };
}

/** What stock_count_blocked answered, as the pages show it. */
export function blockedFromRows(rows: unknown): BlockedLine[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r: Record<string, unknown>) => ({
    netsuiteItemId: String(r.netsuite_item_id),
    itemNumber: String(r.item_number),
    why: r.why === 'asked' ? 'asked' : 'adjusted',
    byName: text(r.by_name),
    at: text(r.at),
  }));
}

/** The count less NetSuite's count when it was saved, to four places; null until it's counted. */
export function differenceOf(line: Pick<CountLine, 'counted' | 'onHandThen'>): number | null {
  if (line.counted === null || line.onHandThen === null) return null;
  return roundQuantity(line.counted - line.onHandThen);
}

/**
 * Whether NetSuite's count changed between the item going on the count and its count being saved. Stock moved while
 * the count was open: right when it was counted as it was typed, worth a look when it was counted on paper earlier.
 */
export function movedWhileCounting(line: Pick<CountLine, 'onHandThen' | 'onHandStart'>): boolean {
  return line.onHandThen !== null && roundQuantity(line.onHandThen) !== roundQuantity(line.onHandStart);
}

/** A count as typed in its box: blank for not counted, or a number of no more than four places from 0 to 1,000,000. */
export function parseCounted(typed: string): { value: number | null } | { error: string } {
  const t = typed.trim().replace(/,/g, '');
  if (t === '') return { value: null };
  if (!/^\d*\.?\d*$/.test(t) || t === '.') {
    return { error: t.startsWith('-') ? "A count can't be below 0." : 'Type the number counted, or leave it blank.' };
  }
  const value = Number(t);
  if (value > COUNTED_MAX) return { error: `A count takes ${COUNTED_MAX.toLocaleString('en-US')} at most.` };
  if (hasTooManyPlaces(value)) return { error: `A count takes ${QUANTITY_PLACES} places at most.` };
  return { value };
}

/** How the review adds up a count, in units and, where NetSuite's average cost is known, in cents. */
export interface CountReview {
  items: number;
  counted: number;
  notCounted: number;
  matched: number;
  differ: number;
  /** Units found over NetSuite's count, and short of it. */
  unitsOver: number;
  unitsShort: number;
  /** null when no averages were given (someone who doesn't see money). */
  centsOver: number | null;
  centsShort: number | null;
  /** Items that differ with no average cost to value them at. */
  noCost: number;
}

/**
 * Adds a count up: how many items are counted, how many match NetSuite, and what the differences come to, each at
 * NetSuite's average cost at the location (`averages`, by NetSuite item id) where it's known.
 */
export function reviewCount(lines: CountLine[], averages: Readonly<Record<string, number>> | null): CountReview {
  const review: CountReview = {
    items: lines.length, counted: 0, notCounted: 0, matched: 0, differ: 0, unitsOver: 0, unitsShort: 0,
    centsOver: averages ? 0 : null, centsShort: averages ? 0 : null, noCost: 0,
  };
  for (const line of lines) {
    const diff = differenceOf(line);
    if (diff === null) { review.notCounted += 1; continue; }
    review.counted += 1;
    if (diff === 0) { review.matched += 1; continue; }
    review.differ += 1;
    if (diff > 0) review.unitsOver = roundQuantity(review.unitsOver + diff);
    else review.unitsShort = roundQuantity(review.unitsShort - diff);
    if (!averages) continue;
    const average = averages[line.netsuiteItemId];
    if (average === undefined || !Number.isFinite(average)) { review.noCost += 1; continue; }
    const cents = Math.round(Math.abs(diff) * average * 100);
    if (diff > 0) review.centsOver! += cents;
    else review.centsShort! += cents;
  }
  return review;
}

const signed = (n: number) => `${n > 0 ? '+' : '−'}${quantityText(Math.abs(n))}`;

/** One line for an item's difference: "+3 (12 counted, NetSuite 9)", or "Matches (7)". */
export function describeLine(line: Pick<CountLine, 'counted' | 'onHandThen'>): string {
  const diff = differenceOf(line);
  if (diff === null) return 'Not counted';
  if (diff === 0) return `Matches (${quantityText(line.counted!)})`;
  return `${signed(diff)} (${quantityText(line.counted!)} counted, NetSuite ${quantityText(line.onHandThen!)})`;
}

/** Why an item that differs can't be posted as counted, and what to do. */
export function blockedText(b: Pick<BlockedLine, 'itemNumber' | 'why' | 'byName'>): string {
  if (b.why === 'asked') {
    return `${b.itemNumber} has an adjustment asked for by ${b.byName || 'someone'} on Adjustments to approve. Once it's decided, count it again.`;
  }
  return `${b.itemNumber} was adjusted with Adjust by ${b.byName || 'someone'} after it was counted, so its difference may be corrected already. Count it again.`;
}

/** The memo NetSuite shows on a count's adjustment. */
export function countMemo(count: Pick<StockCount, 'label' | 'locationName'>, askedByName: string | null, approvedByName: string | null): string {
  return `FleetSuite count ${count.label} at ${count.locationName} · by ${askedByName || 'someone'}, approved by ${approvedByName || 'a super admin'}`.slice(0, 999);
}

export type CountKind = 'all' | 'search' | 'picked';

/**
 * What a count is of, in words, from how its items were chosen. Everything on hand that's more than one count
 * takes, or that's partly on another count, is counted a part at a time, each part named by its first and last item.
 */
export function countWhat(kind: CountKind, search: string | null, items: number, part?: { first: string; last: string } | null): string {
  const q = (search ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const cut = (n: string) => (n.length > 40 ? `${n.slice(0, 39)}…` : n);
  if (kind === 'all') return part ? `Everything NetSuite has on hand, ${cut(part.first)} to ${cut(part.last)}` : 'Everything NetSuite has on hand';
  if (kind === 'search') return `Items matching “${q}”`;
  return items === 1 ? '1 item picked' : `${items} items picked`;
}

/** Item numbers in shelf order: numbers within them by value (BK-2 before BK-10), case only between equals, then by NetSuite id. */
export function byItemNumber<T extends { itemNumber: string; netsuiteItemId: string }>(a: T, b: T): number {
  return a.itemNumber.localeCompare(b.itemNumber, 'en', { numeric: true }) || Number(a.netsuiteItemId) - Number(b.netsuiteItemId);
}

/**
 * Each item's average cost at a location from NetSuite's own counts and values (the stock copy), by NetSuite id:
 * its value over its count, where it has both and the count isn't 0.
 */
export function averageCosts(rows: Array<{ item_id: string; quantity: number | string | null; value: number | string | null }>): Record<string, number> {
  const averages: Record<string, number> = {};
  for (const r of rows) {
    if (r.value === null || r.value === undefined || r.value === '' || r.quantity === null || r.quantity === undefined || r.quantity === '') continue;
    const quantity = Number(r.quantity);
    const value = Number(r.value);
    if (!Number.isFinite(quantity) || !Number.isFinite(value) || quantity === 0) continue;
    averages[String(r.item_id)] = value / quantity;
  }
  return averages;
}

/**
 * The location a count starts at when nobody picks one: NETSUITE_DEFAULT_LOCATION_ID when it's one of them, then
 * O'Fallon (BMG's stock location), then the first.
 */
export function defaultLocationId(locations: ReadonlyArray<{ id: string; name: string }>, envDefault?: string | null): string | null {
  if (envDefault && locations.some((l) => l.id === envDefault)) return envDefault;
  return locations.find((l) => /fallon/i.test(l.name))?.id ?? locations[0]?.id ?? null;
}

/** Whether a super admin can ask NetSuite what became of a press: it didn't say, or a press is taking longer than one takes. */
export function needsAsking(c: Pick<StockCount, 'status' | 'sentAt'>, now = Date.now()): boolean {
  if (c.status === 'unsure') return true;
  if (c.status !== 'sending' || !c.sentAt) return false;
  return now - Date.parse(c.sentAt) >= STALE_MS;
}
