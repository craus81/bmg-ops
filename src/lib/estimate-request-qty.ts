/**
 * The quantity a line starts at in the estimate Request parts window, which
 * lists every part on the estimate (Craig, 2026-10-26, option A). Lines that
 * need ordering start at `to_request` (see `toRequestQty` in
 * estimate-readiness). Lines already covered by stock or a PO start at the
 * full estimate quantity less anything already requested, or the full
 * quantity when that is all requested already, so one tick adds the whole
 * line (Craig: "full").
 *
 * Kept out of estimate-readiness.ts because that file pulls in NetSuite and
 * this one is used by the client-side modal.
 */
export interface RequestQtyInput {
  needed: number;
  requested: number;
  to_request: number;
}

export function startingRequestQty(r: RequestQtyInput): number {
  if (r.to_request > 0) return r.to_request;
  const left = r.needed - r.requested;
  return left > 0 ? left : r.needed;
}
