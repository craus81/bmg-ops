// The lines a Graphics Builder worksheet puts on its estimate, and how to
// tell whether someone has changed them on the estimate since.
//
// Every builder save deletes the worksheet's lines on the estimate and
// writes them again (addWrapQuoteToEstimate). Before it does, the builder
// asks diffWrapEstimateLines whether the estimate still shows what the LAST
// save wrote — the quote row still holds that save's numbers at that point —
// so a price typed on the estimate is never silently put back.

import { WRAP_VINYL_ITEM, WRAP_LABOR_ITEM, kitLineSplit } from '@/lib/graphics-invoice';
import { cleanCustomLines } from '@/lib/wrap-quote-price-override';

export interface PlannedWrapLine {
  item_number: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  is_custom: boolean;
}

export interface WrapQuoteForLines {
  quote_number: string;
  vehicle_description?: string | null;
  materials_total?: unknown;
  labor_total?: unknown;
  package_qty?: unknown;
  pricing_overrides?: any;
}

const money = (v: unknown) => Math.round((parseFloat(String(v)) || 0) * 100) / 100;

/** The vinyl line, the install line, then the rep's own lines — in that order. */
export function plannedWrapEstimateLines(quote: WrapQuoteForLines): PlannedWrapLine[] {
  const materials = parseFloat(String(quote.materials_total)) || 0;
  const labor = parseFloat(String(quote.labor_total)) || 0;
  const kitQty = Math.max(1, parseInt(String(quote.package_qty), 10) || 1);
  const vehicle = quote.vehicle_description || null;
  const out: PlannedWrapLine[] = [];
  if (materials > 0) {
    const split = kitLineSplit(materials, kitQty);
    out.push({
      item_number: WRAP_VINYL_ITEM,
      description: `Vehicle graphics${vehicle ? ` — ${vehicle}` : ''}${kitQty > 1 ? ` (${kitQty} kits)` : ''} — ${quote.quote_number}`,
      quantity: split.quantity,
      unit_price: split.rate,
      is_custom: false,
    });
  }
  if (labor > 0) {
    out.push({
      item_number: WRAP_LABOR_ITEM,
      description: `Graphics install${vehicle ? ` — ${vehicle}` : ''} — ${quote.quote_number}`,
      quantity: 1,
      unit_price: money(labor),
      is_custom: false,
    });
  }
  for (const l of cleanCustomLines(quote.pricing_overrides?.custom_lines)) {
    out.push({
      item_number: null,
      description: l.description,
      quantity: l.qty,
      unit_price: money(l.unit_price),
      is_custom: true,
    });
  }
  return out;
}

export interface ExistingWrapLine {
  item_number?: string | null;
  description?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
  sort_order?: number | null;
}

export interface WrapLineEdit {
  /** Plain words for the dialog, e.g. "3M Vinyl: $1,562.60 → $1,400.00". */
  summary: string;
}

const fmtMoney = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/**
 * What changed on the estimate compared with what the builder last wrote.
 * Empty = the estimate still matches, so rewriting it loses nothing.
 */
export function diffWrapEstimateLines(planned: PlannedWrapLine[], existing: ExistingWrapLine[]): WrapLineEdit[] {
  const left = [...existing].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const pairs: [PlannedWrapLine, ExistingWrapLine | null][] = [];
  const take = (pred: (e: ExistingWrapLine) => boolean) => {
    const i = left.findIndex(pred);
    return i >= 0 ? left.splice(i, 1)[0] : null;
  };
  // Pair by exact description first, then the two standing items by item
  // number, then whatever is left in order.
  const pending: PlannedWrapLine[] = [];
  for (const p of planned) {
    const e = take(x => String(x.description ?? '') === p.description);
    if (e) pairs.push([p, e]); else pending.push(p);
  }
  const stillPending: PlannedWrapLine[] = [];
  for (const p of pending) {
    const e = p.item_number ? take(x => (x.item_number || null) === p.item_number) : null;
    if (e) pairs.push([p, e]); else stillPending.push(p);
  }
  for (const p of stillPending) pairs.push([p, left.shift() ?? null]);

  const edits: WrapLineEdit[] = [];
  for (const [p, e] of pairs) {
    const name = p.item_number || p.description;
    if (!e) { edits.push({ summary: `${name} was removed from the estimate` }); continue; }
    const bits: string[] = [];
    if (String(e.description ?? '') !== p.description) bits.push(`description changed to "${String(e.description ?? '').trim() || '(blank)'}"`);
    const q = parseFloat(String(e.quantity)) || 0;
    if (Math.abs(q - p.quantity) > 0.005) bits.push(`qty ${fmtQty(p.quantity)} → ${fmtQty(q)}`);
    const r = money(e.unit_price);
    if (Math.abs(r - p.unit_price) > 0.005) bits.push(`${fmtMoney(p.unit_price)} → ${fmtMoney(r)}`);
    if (bits.length) edits.push({ summary: `${name}: ${bits.join(', ')}` });
  }
  for (const e of left) {
    edits.push({ summary: `${String(e.item_number || e.description || 'A graphics line').trim()} was added on the estimate` });
  }
  return edits;
}
