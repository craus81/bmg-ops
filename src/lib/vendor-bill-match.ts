/**
 * Pure matching logic for the NetSuite vendor-bill payment sync — kept free
 * of side-effectful imports (supabase/notify clients) so it's unit-testable.
 *
 * netsuite_bill_id holds whatever the bill was recorded with: the internal
 * id (numeric) from the one-click create, or a hand-pasted bill number
 * (tranid) from "Record Bill" — the lookup matches on either.
 */

export interface NsBill { id: unknown; tranid: unknown; status: unknown }

/** The NetSuite bill (if any) a stored bill reference points at — matches
 *  the internal id exactly first (so a tranid that happens to look like
 *  another bill's id can never cross-match), then the tranid
 *  case-insensitively. */
export function findBillForRef(ref: string, bills: NsBill[]): NsBill | null {
  const r = ref.trim();
  if (!r) return null;
  const upper = r.toUpperCase();
  return bills.find(b => String(b.id) === r) ||
    bills.find(b => String(b.tranid || '').toUpperCase() === upper) ||
    null;
}
