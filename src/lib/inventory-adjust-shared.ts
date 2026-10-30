/** Pure parts of the Inventory Adjust button, shared by the pop-up and the route (src/lib/inventory-adjust.ts). */

export const ADJUST_REASONS = ['Count correction', 'Damaged', 'Used in shop', 'Found', 'Other'] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];
export type AdjustMode = 'delta' | 'count';

/** The signed change an entry makes, or an error to show in red. */
export function adjustmentChange(
  mode: AdjustMode,
  qty: number,
  onHand: number,
): { change: number; after: number } | { error: string } {
  if (!Number.isFinite(qty) || !Number.isInteger(qty)) return { error: 'Enter a whole number.' };
  if (mode === 'count' && qty < 0) return { error: "A shelf count can't be below 0." };
  const change = mode === 'delta' ? qty : qty - onHand;
  if (change === 0) {
    return { error: mode === 'count' ? `NetSuite already shows ${onHand} on hand. Nothing to adjust.` : 'Enter a change other than 0.' };
  }
  const after = onHand + change;
  if (after < 0) return { error: `That would leave ${after} on hand. NetSuite can't go below 0. Check the count.` };
  return { change, after };
}

/** The memo NetSuite shows on the adjustment. */
export function adjustmentMemo(reason: string, note: string | null | undefined, by: string | null | undefined): string {
  const parts = [`FleetSuite: ${reason}`];
  const n = (note || '').trim();
  if (n) parts.push(n);
  if (by) parts.push(`by ${by}`);
  return parts.join(' · ');
}
