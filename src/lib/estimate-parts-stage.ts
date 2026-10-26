/**
 * Where an approved estimate stands on parts — the tag on the customer
 * record and the Estimates list, and the green banner on the estimate
 * (Craig, 2026-10-26, thread "Show approved and parts-ordered status on
 * estimates").
 *
 *   Approved       the customer said yes, parts not all ordered yet
 *   Parts ordered  every part requested from it is ordered (1A: all, not any)
 *   Parts in stock nothing was requested and the stock check finds every
 *                  part on the shelf (2B)
 *
 * Client-safe and pure: the server half (estimate-parts-status.ts) loads the
 * rows and the stock verdict, this decides what they mean, so tests pin it.
 */

export type PartsStage = 'approved' | 'parts_ordered' | 'parts_in_stock';

export interface PartsStageRequest {
  item_number: string | null;
  status: string;
  po_number: string | null;
}

export interface PartsStageInput {
  /** customer_approved, or status 'accepted' (phone / PO approvals). */
  approved: boolean;
  /** Its sales order is billed, closed or cancelled: the job is done, so
   *  there is nothing left to flag. */
  soClosed: boolean;
  /** Purchase requests from the estimate or its upfit project. */
  requests: PartsStageRequest[];
  /** Drop ship POs made from the estimate (migration 429). */
  dropShips: { po_number: string | null; item_numbers: string[] }[];
  /** The stock check's answer when nothing was requested. null = not run. */
  stock: { parts: number; short: number; unknown: number; onOrder: number } | null;
}

export interface PartsStageResult {
  stage: PartsStage;
  label: string;
  /** The banner's second line. */
  detail: string;
  ordered: number;
  total: number;
  poNumbers: string[];
}

export const PARTS_STAGE_LABELS: Record<PartsStage, string> = {
  approved: 'Approved',
  parts_ordered: 'Parts ordered',
  parts_in_stock: 'Parts in stock',
};

const key = (s: string | null | undefined) => String(s || '').trim().toUpperCase();

export function derivePartsStage(input: PartsStageInput): PartsStageResult | null {
  if (!input.approved || input.soClosed) return null;

  // One entry per part number. A part counts as ordered when every live row
  // for it is ordered: a partial order splits the request (migration 331),
  // leaving the rest pending, and that part isn't done yet.
  const parts = new Map<string, boolean>();
  const poNumbers = new Set<string>();
  for (const r of input.requests) {
    if (r.status === 'cancelled') continue;
    const k = key(r.item_number) || `#${parts.size}`;
    const ordered = r.status === 'ordered';
    parts.set(k, (parts.get(k) ?? true) && ordered);
    if (ordered && r.po_number) poNumbers.add(r.po_number);
  }
  for (const d of input.dropShips) {
    for (const item of d.item_numbers) {
      const k = key(item);
      if (k) parts.set(k, true);
    }
    if (d.po_number) poNumbers.add(d.po_number);
  }

  const total = parts.size;
  const ordered = [...parts.values()].filter(Boolean).length;
  const pos = [...poNumbers].sort();

  if (total > 0) {
    if (ordered === total) {
      return {
        stage: 'parts_ordered', label: PARTS_STAGE_LABELS.parts_ordered,
        detail: `${total === 1 ? 'The part is' : `All ${total} parts`} ordered${pos.length ? ` on ${pos.join(', ')}` : ''}`,
        ordered, total, poNumbers: pos,
      };
    }
    return {
      stage: 'approved', label: PARTS_STAGE_LABELS.approved,
      detail: `${ordered} of ${total} parts ordered`,
      ordered, total, poNumbers: pos,
    };
  }

  const s = input.stock;
  if (s && s.short === 0 && s.unknown === 0 && s.onOrder === 0) {
    return {
      stage: 'parts_in_stock', label: PARTS_STAGE_LABELS.parts_in_stock,
      detail: s.parts === 0 ? 'No parts to order'
        : s.parts === 1 ? 'The part is on the shelf'
          : `All ${s.parts} parts are on the shelf`,
      ordered: 0, total: 0, poNumbers: [],
    };
  }
  let detail = 'Parts not ordered yet';
  if (s && s.short > 0) detail = `${s.short} part${s.short === 1 ? '' : 's'} short · nothing requested yet`;
  else if (s && s.unknown > 0) detail = `${s.unknown} part${s.unknown === 1 ? '' : 's'} not in the catalog · nothing requested yet`;
  else if (s && s.onOrder > 0) detail = `${s.onOrder} part${s.onOrder === 1 ? '' : 's'} waiting on another PO · nothing requested yet`;
  return { stage: 'approved', label: PARTS_STAGE_LABELS.approved, detail, ordered: 0, total: 0, poNumbers: [] };
}
