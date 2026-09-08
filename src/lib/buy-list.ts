/**
 * One-click buy list (R6-7): turn the whole demand tab into one round of
 * purchase requests instead of a part-at-a-time prompt.
 *
 * The suggestion per row is the same arithmetic the single-row button
 * already uses — needed, minus what's on a vendor PO, minus what's already
 * sitting in the pending queue. Rows whose suggestion is zero or negative
 * are COVERED and never enter the list: queueing them would double-order,
 * which is the exact failure the demand tab's separate On-order and In-queue
 * columns exist to prevent.
 *
 * Grouping is by vendor because that's how the buying actually happens —
 * one PO per vendor. Parts with no vendor on file group together at the end
 * under their own heading rather than being dropped or guessed at: the
 * request still gets raised, and purchasing picks the vendor at PO time.
 */

export interface BuyListSourceRef {
  label: string;
  quantity: number;
}

export interface BuyListInputRow {
  item_number: string;
  description: string | null;
  vendor: string | null;
  netsuite_item_id: string | null;
  in_catalog: boolean;
  needed: number;
  on_order: number;
  requested: number;
  sources: BuyListSourceRef[];
  dismissed: unknown | null;
}

export interface BuyListLine {
  itemNumber: string;
  description: string | null;
  netsuiteItemId: string | null;
  in_catalog: boolean;
  needed: number;
  onOrder: number;
  requested: number;
  /** What to buy: needed less everything already covering it. Always > 0. */
  suggested: number;
  jobCount: number;
  /** "SO12345, SO12388 +2 more" — where the number came from. */
  sourceSummary: string;
}

export interface BuyListGroup {
  /** null = no vendor on file. Rendered last, with its own explanation. */
  vendor: string | null;
  lines: BuyListLine[];
  units: number;
}

export interface BuyList {
  groups: BuyListGroup[];
  lineCount: number;
  units: number;
  /** Rows skipped because on-order + in-queue already covers the need. */
  coveredSkipped: number;
  /** Rows skipped because staff dismissed them. Counted, never silent. */
  dismissedSkipped: number;
  /** Rows with no vendor on file — surfaced so the count isn't a surprise
   *  when the last group turns out to be the biggest one. */
  noVendorCount: number;
}

/** The number the single-row prompt suggests, extracted so both paths
 *  can't drift. Negative is impossible: over-covered means zero. */
export function suggestedQuantity(row: Pick<BuyListInputRow, 'needed' | 'on_order' | 'requested'>): number {
  const raw = Number(row.needed || 0) - Number(row.on_order || 0) - Number(row.requested || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Demand quantities are whole units in every source; round up so a
  // fractional remainder never buys 0.5 of a bracket.
  return Math.ceil(raw * 1000) / 1000;
}

export function summarizeSources(sources: BuyListSourceRef[], max = 2): string {
  if (!sources.length) return '';
  const shown = sources.slice(0, max).map(s => s.label).join(', ');
  const rest = sources.length - Math.min(max, sources.length);
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

const VENDOR_KEY = (v: string | null) => (v || '').trim().toLowerCase();

export function buildBuyList(rows: BuyListInputRow[]): BuyList {
  const byVendor = new Map<string, BuyListGroup>();
  let coveredSkipped = 0;
  let dismissedSkipped = 0;
  let noVendorCount = 0;

  for (const row of rows) {
    if (row.dismissed) { dismissedSkipped++; continue; }
    const suggested = suggestedQuantity(row);
    if (suggested <= 0) { coveredSkipped++; continue; }

    const vendor = (row.vendor || '').trim() || null;
    if (!vendor) noVendorCount++;
    const key = VENDOR_KEY(vendor);
    let group = byVendor.get(key);
    if (!group) {
      group = { vendor, lines: [], units: 0 };
      byVendor.set(key, group);
    }
    group.lines.push({
      itemNumber: row.item_number,
      description: row.description,
      netsuiteItemId: row.netsuite_item_id,
      in_catalog: row.in_catalog,
      needed: Number(row.needed || 0),
      onOrder: Number(row.on_order || 0),
      requested: Number(row.requested || 0),
      suggested,
      jobCount: row.sources.length,
      sourceSummary: summarizeSources(row.sources),
    });
    group.units += suggested;
  }

  const groups = [...byVendor.values()];
  for (const g of groups) g.lines.sort((a, b) => a.itemNumber.localeCompare(b.itemNumber));
  // Biggest vendor first — that's the PO somebody places today. The
  // no-vendor group is always last regardless of size: it isn't a PO yet.
  groups.sort((a, b) => {
    if (!a.vendor !== !b.vendor) return a.vendor ? -1 : 1;
    if (b.lines.length !== a.lines.length) return b.lines.length - a.lines.length;
    return (a.vendor || '').localeCompare(b.vendor || '');
  });

  return {
    groups,
    lineCount: groups.reduce((n, g) => n + g.lines.length, 0),
    units: groups.reduce((n, g) => n + g.units, 0),
    coveredSkipped,
    dismissedSkipped,
    noVendorCount,
  };
}

/** The POST accepts 100 items per call; a full catalog sweep can exceed
 *  that, so the confirm sends chunks rather than silently truncating. */
export const REQUEST_CHUNK_SIZE = 100;

export function chunkItems<T>(items: T[], size = REQUEST_CHUNK_SIZE): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
