/**
 * ONE number for staff to look for.
 *
 * An estimate carries two: FleetSuite's own `estimate_number` (EST-2608-041,
 * minted by next_job_number) and, once pushed, NetSuite's `tranId`
 * (`netsuite_estimate_number`). Staff were hunting both — the field ask was
 * "rename the FleetSuite estimate to whatever NetSuite called it."
 *
 * We change the LABEL, not the stored number. `estimate_number` is
 * NOT NULL UNIQUE and is the join key sales-order-sync matches SO memos
 * against (`sales-order-sync.ts` ilike on estimate_number, memos written by
 * estimate-document.ts), and it is baked into delivered PDFs, sent emails,
 * the signed acceptance snapshot and the audit log. Renaming the row would
 * orphan all of that — and the NetSuite number can go away again (the push
 * DELETE clears it). So once a NetSuite number exists it becomes the
 * headline everywhere staff READ a number, with the FleetSuite one shown
 * beside it; both stay searchable.
 *
 * Customer-facing output (the estimate PDF, the approval document, quote
 * emails) is deliberately NOT routed through here — those artifacts have
 * already gone out under the FleetSuite number.
 */

export interface EstimateNumbered {
  estimate_number?: string | null;
  netsuite_estimate_number?: string | null;
}

const clean = (v: string | null | undefined): string => (v || '').trim();

/** The number to show first: NetSuite's once it exists, else FleetSuite's. */
export function estimateHeadlineNumber(est: EstimateNumbered | null | undefined): string {
  return clean(est?.netsuite_estimate_number) || clean(est?.estimate_number);
}

/**
 * The other number, or null when there is only one. Render it beside the
 * headline (a dim `EST-2608-041` tag) so the FleetSuite number a rep may
 * still have written down remains visible.
 */
export function estimateAltNumber(est: EstimateNumbered | null | undefined): string | null {
  const ns = clean(est?.netsuite_estimate_number);
  const fs = clean(est?.estimate_number);
  return ns && fs && ns !== fs ? fs : null;
}

/** True when the query matches EITHER number — searching never regresses. */
export function estimateNumberMatches(est: EstimateNumbered | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return clean(est?.estimate_number).toLowerCase().includes(q)
    || clean(est?.netsuite_estimate_number).toLowerCase().includes(q);
}
