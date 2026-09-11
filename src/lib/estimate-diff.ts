/**
 * What changed between an estimate and the revision that supersedes it
 * (R6-9 counter-offer workbench).
 *
 * A rejected quote comes back as a conversation about specifics — "the racks
 * are too much", "drop the second camera" — and the rep answers it by
 * rebuilding a line list from memory and hoping they changed only what they
 * meant to. This puts the two documents side by side.
 *
 * LINE MATCHING IS THE HONEST PART. Lines have no stable identity across a
 * duplicate: the copy gets fresh ids, so "the same line" has to be inferred.
 * Lines are keyed on item number where there is one and on description
 * otherwise, and duplicates of one key are zipped in order. When that
 * inference cannot pair something up it is reported as an add and a remove
 * rather than dressed up as a change — showing a confident "price changed
 * $400 → $90" for two unrelated lines is worse than showing both.
 */

export interface DiffLineSide {
  quantity: number;
  unitPrice: number;
  laborHours: number | null;
  lineTotal: number;
}

export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffLine {
  key: string;
  itemNumber: string | null;
  description: string | null;
  kind: DiffKind;
  before: DiffLineSide | null;
  after: DiffLineSide | null;
}

export interface Delta {
  before: number;
  after: number;
  change: number;
}

export interface EstimateDiff {
  lines: DiffLine[];
  counts: { added: number; removed: number; changed: number; unchanged: number };
  subtotal: Delta;
  laborHours: Delta;
  laborTotal: Delta;
  tax: Delta;
  grandTotal: Delta;
  vehicleCount: Delta;
  /** True when nothing at all moved — worth saying out loud on a counter. */
  identical: boolean;
}

export interface DiffEstimateHeader {
  subtotal?: unknown;
  labor_total?: unknown;
  labor_hours?: unknown;
  labor_hours_override?: unknown;
  tax_amount?: unknown;
  grand_total?: unknown;
  vehicle_count?: unknown;
}

export interface DiffLineRow {
  item_number?: string | null;
  description?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
  labor_hours?: unknown;
  line_total?: unknown;
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

const delta = (before: unknown, after: unknown): Delta => {
  const b = round2(num(before));
  const a = round2(num(after));
  return { before: b, after: a, change: round2(a - b) };
};

const keyOf = (l: DiffLineRow): string => {
  const item = String(l.item_number || '').trim().toUpperCase();
  if (item) return `#${item}`;
  return `~${String(l.description || '').trim().toLowerCase()}`;
};

const sideOf = (l: DiffLineRow): DiffLineSide => ({
  quantity: round2(num(l.quantity)),
  unitPrice: round2(num(l.unit_price)),
  laborHours: l.labor_hours == null ? null : round2(num(l.labor_hours)),
  lineTotal: round2(num(l.line_total ?? num(l.quantity) * num(l.unit_price))),
});

const sameSide = (a: DiffLineSide, b: DiffLineSide): boolean =>
  a.quantity === b.quantity
  && a.unitPrice === b.unitPrice
  && a.lineTotal === b.lineTotal
  && a.laborHours === b.laborHours;

function group(rows: DiffLineRow[]): Map<string, DiffLineRow[]> {
  const out = new Map<string, DiffLineRow[]>();
  for (const r of rows || []) {
    const k = keyOf(r);
    const arr = out.get(k) || [];
    arr.push(r);
    out.set(k, arr);
  }
  return out;
}

export function diffEstimates(
  before: DiffEstimateHeader,
  beforeLines: DiffLineRow[],
  after: DiffEstimateHeader,
  afterLines: DiffLineRow[],
): EstimateDiff {
  const b = group(beforeLines);
  const a = group(afterLines);
  const keys = [...new Set([...b.keys(), ...a.keys()])];

  const lines: DiffLine[] = [];
  for (const key of keys) {
    const bs = b.get(key) || [];
    const as = a.get(key) || [];
    const n = Math.max(bs.length, as.length);
    for (let i = 0; i < n; i++) {
      const bl = bs[i];
      const al = as[i];
      const source = al || bl;
      const base = {
        key,
        itemNumber: String(source?.item_number || '').trim() || null,
        description: String(source?.description || '').trim() || null,
      };
      if (bl && al) {
        const bside = sideOf(bl);
        const aside = sideOf(al);
        lines.push({ ...base, kind: sameSide(bside, aside) ? 'unchanged' : 'changed', before: bside, after: aside });
      } else if (al) {
        lines.push({ ...base, kind: 'added', before: null, after: sideOf(al) });
      } else {
        lines.push({ ...base, kind: 'removed', before: sideOf(bl), after: null });
      }
    }
  }

  // Changes first, then removals, then additions, then the untouched rest —
  // a counter-offer review is about what moved, not about re-reading the
  // lines that did not.
  const rank: Record<DiffKind, number> = { changed: 0, removed: 1, added: 2, unchanged: 3 };
  lines.sort((x, y) => rank[x.kind] - rank[y.kind]
    || (x.itemNumber || x.description || '').localeCompare(y.itemNumber || y.description || ''));

  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const l of lines) counts[l.kind]++;

  const effLabor = (e: DiffEstimateHeader) =>
    e.labor_hours_override != null ? e.labor_hours_override : e.labor_hours;

  const subtotal = delta(before.subtotal, after.subtotal);
  const laborHours = delta(effLabor(before), effLabor(after));
  const laborTotal = delta(before.labor_total, after.labor_total);
  const tax = delta(before.tax_amount, after.tax_amount);
  const grandTotal = delta(before.grand_total, after.grand_total);
  const vehicleCount = delta(before.vehicle_count ?? 1, after.vehicle_count ?? 1);

  return {
    lines,
    counts,
    subtotal,
    laborHours,
    laborTotal,
    tax,
    grandTotal,
    vehicleCount,
    identical: counts.added === 0 && counts.removed === 0 && counts.changed === 0
      && grandTotal.change === 0 && laborHours.change === 0 && vehicleCount.change === 0,
  };
}

/** "$4,850 lower" / "unchanged" — the headline a rep reads first. */
export function deltaLabel(d: Delta, opts: { money?: boolean } = {}): string {
  if (d.change === 0) return 'unchanged';
  const magnitude = Math.abs(d.change);
  const text = opts.money
    ? `$${magnitude.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : String(round2(magnitude));
  return `${text} ${d.change < 0 ? 'lower' : 'higher'}`;
}
