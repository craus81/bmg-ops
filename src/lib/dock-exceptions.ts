/**
 * Structured dock exceptions (R6-7). Receiving records what ARRIVED; this
 * records what was WRONG with it — short, damaged, or the wrong item —
 * so open vendor claims become a list somebody can work instead of a
 * sentence in a free-text note.
 *
 * Pure rules only: labels, the aging that decides what's urgent, and the
 * rollup the purchasing header chip reads.
 */

export type ExceptionKind = 'short' | 'damaged' | 'wrong_item';
export type Resolution = 'vendor_credit' | 'replacement_po' | 'written_off';

export const KIND_LABELS: Record<ExceptionKind, string> = {
  short: 'Short',
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
};

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  vendor_credit: 'Vendor credit requested',
  replacement_po: 'Replacement ordered',
  written_off: 'Written off',
};

export interface DockException {
  id: string;
  poId: string;
  poTranid: string | null;
  vendorName: string | null;
  itemNumber: string;
  kind: ExceptionKind;
  quantity: number | null;
  note: string | null;
  status: 'open' | 'resolved';
  resolution: Resolution | null;
  createdAt: string;
}

/** Days an open claim has been sitting. */
export function ageDays(e: DockException, nowMs = Date.now()): number {
  const t = Date.parse(e.createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

/**
 * Money leaks while a claim ages: vendors stop honouring credits. Amber at
 * a week, red at a fortnight — the same shape as the other aging chips.
 */
export function ageTone(days: number): 'ok' | 'warn' | 'bad' {
  if (days >= 14) return 'bad';
  if (days >= 7) return 'warn';
  return 'ok';
}

export interface ExceptionSummary {
  open: number;
  byKind: Record<ExceptionKind, number>;
  byVendor: { vendor: string; open: number; oldestDays: number }[];
  oldestDays: number;
  /** Open claims past the fortnight mark — the ones actively rotting. */
  stale: number;
}

export function summarizeExceptions(all: DockException[], nowMs = Date.now()): ExceptionSummary {
  const open = all.filter(e => e.status === 'open');
  const byKind: Record<ExceptionKind, number> = { short: 0, damaged: 0, wrong_item: 0 };
  const vendors = new Map<string, { open: number; oldestDays: number }>();
  let oldest = 0;
  let stale = 0;

  for (const e of open) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const days = ageDays(e, nowMs);
    oldest = Math.max(oldest, days);
    if (days >= 14) stale++;
    const name = e.vendorName?.trim() || 'Unknown vendor';
    const v = vendors.get(name) || { open: 0, oldestDays: 0 };
    v.open += 1;
    v.oldestDays = Math.max(v.oldestDays, days);
    vendors.set(name, v);
  }

  return {
    open: open.length,
    byKind,
    byVendor: [...vendors.entries()]
      .map(([vendor, v]) => ({ vendor, ...v }))
      .sort((a, b) => b.oldestDays - a.oldestDays || b.open - a.open),
    oldestDays: oldest,
    stale,
  };
}

/** The purchasing header chip, or null when there is nothing to chase. */
export function exceptionChipText(s: ExceptionSummary): string | null {
  if (s.open === 0) return null;
  const bits = [`${s.open} open dock issue${s.open !== 1 ? 's' : ''}`];
  if (s.oldestDays > 0) bits.push(`oldest ${s.oldestDays}d`);
  return bits.join(' · ');
}
