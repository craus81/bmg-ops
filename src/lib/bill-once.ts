import type { SupabaseClient } from '@supabase/supabase-js';
import { findVendorBill } from '@/lib/netsuite';

/**
 * One NetSuite bill per approved vendor invoice or installer payout
 * (migration 435; owner decision 2026-10-24, thread "Replacing NetSuite with
 * FleetSuite", "Fix it first").
 *
 * Create Bill in NetSuite on a vendor invoice (/api/vendor-invoices/workflow)
 * or an installer payout (/api/admin/payouts) used to check the row was
 * approved, make the bill, then stamp the row billed. Two screens tapping at
 * once both passed the check, and a try again after "Bill created in NetSuite
 * but failed to update" found the row still approved, so either could enter
 * the same bill twice. Now a try:
 *   1. takes an atomic claim on the row, the shape Parts Mail's bills have had
 *      since migration 251: only a try that finds the row approved and
 *      unclaimed (or claimed by a try that died, STALE_CLAIM_MS ago) goes on;
 *   2. asks NetSuite for a bill it already has from the vendor under the
 *      Reference No. this one would carry, and stops if there is one. That
 *      covers a stamp that failed after NetSuite made the bill, even once the
 *      claim it left has gone stale;
 *   3. makes the bill, letting the claim go if NetSuite refuses it.
 * The caller stamps the row billed, clearing bill_claimed_at in the same
 * write when claimedAt is set. When that stamp fails the claim stays, so
 * nobody bills the row again while it reads approved.
 *
 * Send to NetSuite on Snap a bill (migration 436) bills its snapped bill the
 * same way, while the bill is a draft.
 */

/** The rows a bill button bills. */
export type BillOnceTable = 'vendor_invoices' | 'payouts' | 'gl_snapped_bills';

/** The status a row has while it can be billed. */
const READY: Record<BillOnceTable, string> = { vendor_invoices: 'approved', payouts: 'approved', gl_snapped_bills: 'draft' };

/** A claim this old is taken over: the try that held it died without letting it go. */
export const STALE_CLAIM_MS = 15 * 60_000;

type Made = { success: boolean; billId?: string; billNumber?: string; error?: string };
type Found = { billId: string; billNumber: string } | null;

export type BillOnce =
  | { ok: true; billId: string; billNumber: string; claimedAt: string | null }
  | { ok: false; status: number; error: string };

export async function makeBillOnce(
  service: SupabaseClient,
  table: BillOnceTable,
  id: string,
  bill: { vendorId: string; vendorName: string; referenceNo: string; create: () => Promise<Made> },
  find: (vendorId: string, referenceNo: string) => Promise<Found> = findVendorBill,
  now: Date = new Date(),
): Promise<BillOnce> {
  const claimedAt = now.toISOString();
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const { data: won, error: claimErr } = await service
    .from(table)
    .update({ bill_claimed_at: claimedAt })
    .eq('id', id)
    .eq('status', READY[table])
    .or(`bill_claimed_at.is.null,bill_claimed_at.lt.${staleCutoff}`)
    .select('id');
  let claimed: string | null = claimedAt;
  if (claimErr) {
    // Right after the migration deploys, PostgREST's schema cache may not
    // have the column yet (#741): bill unclaimed, as before it existed.
    if ((claimErr as { code?: string }).code === 'PGRST204' || /bill_claimed_at/i.test(claimErr.message || '')) {
      console.warn(`bill-once: ${table}.bill_claimed_at not in the schema cache yet, billing unclaimed`);
      claimed = null;
    } else {
      return { ok: false, status: 503, error: 'Could not hold this for billing, so nothing was billed. Try again.' };
    }
  } else if (!won || won.length === 0) {
    return { ok: false, status: 409, error: 'A bill for this is already being made, or was just made. Wait a moment and refresh.' };
  }

  // Only our own claim is let go: one taken over after it went stale belongs to another try.
  const letGo = async () => {
    if (!claimed) return;
    try {
      await service.from(table).update({ bill_claimed_at: null }).eq('id', id).eq('bill_claimed_at', claimed);
    } catch { /* the stale takeover covers a claim that wasn't let go */ }
  };

  let found: Found;
  try {
    found = await find(bill.vendorId, bill.referenceNo);
  } catch (e) {
    await letGo();
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, error: `Couldn't ask NetSuite whether it already has bill ${bill.referenceNo}, so nothing was billed. Try again. (${why})` };
  }
  if (found) {
    await letGo();
    const number = found.billNumber || found.billId;
    // The vendor invoice and payout pages can record a bill made in NetSuite; Snap a bill has nothing to record.
    const record = table === 'gl_snapped_bills' ? '' : ` If that's this one's bill, use Record Bill with ${number}.`;
    return {
      ok: false,
      status: 409,
      error: `NetSuite already has bill ${number} from ${bill.vendorName}, so FleetSuite didn't make another.${record}`,
    };
  }

  let made: Made;
  try {
    made = await bill.create();
  } catch (e) {
    made = { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!made.success) {
    await letGo();
    return { ok: false, status: 502, error: made.error || 'Failed to create vendor bill' };
  }
  return { ok: true, billId: made.billId || '', billNumber: made.billNumber || '', claimedAt: claimed };
}

/**
 * A create for makeBillOnce that doesn't take NetSuite's silence for a no (Snap a bill's Send). NetSuite can keep a
 * bill without saying which (the connection drops after it's saved, or no id comes back). makeBillOnce asked for one
 * from the vendor under the Reference No. just before the create, so one NetSuite has now is the one just made; when
 * it has none, the create's own answer stands.
 */
export async function madeOrFound(create: () => Promise<Made>, find: () => Promise<Found>): Promise<Made> {
  let made: Made;
  try {
    made = await create();
  } catch (e) {
    made = { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (made.success && /^\d+$/.test(made.billId ?? '')) return made;
  const found = await find().catch(() => null);
  return found ? { success: true, billId: found.billId, billNumber: found.billNumber } : made;
}
