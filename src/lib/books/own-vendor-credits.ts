import type { SupabaseClient } from '@supabase/supabase-js';
import { VENDOR_CREDIT_RULE, type VendorCreditDraft, type WorkedVendorCredit } from '@/lib/vendor-credit';
import { signedAmount } from './own-invoices';

/**
 * Books' own copy of each vendor credit FleetSuite makes (migration 467,
 * docs/books.md "Vendor credits made in FleetSuite").
 *
 * When FleetSuite makes a vendor credit in NetSuite (src/lib/vendor-credit.ts,
 * /api/purchasing/vendor-credit), it keeps its own copy, worked out by its
 * own rules rather than read back from NetSuite: each line's account or part,
 * the part's quantity and rate, the amount (vendor_credit@1), and the bills
 * it was applied to. Checking the copies against NetSuite's vendor credits,
 * and posting them, comes after.
 *
 * Saving never stops a vendor credit: it already exists in NetSuite when the
 * copy is made, so a copy that can't be saved is logged and left.
 */

export interface MadeVendorCredit {
  netsuiteId: string | null | undefined;
  draft: VendorCreditDraft;
  worked: WorkedVendorCredit;
  vendorName: string | null;
  /** The press of Make vendor credit (typed_vendor_credits.id). */
  madeFromId: string;
  madeBy: string | null;
}

/** The copy as gl_own_vendor_credit_save takes it. Pure. */
export function ownVendorCreditPayload(made: MadeVendorCredit & { netsuiteId: string }) {
  const { draft, worked } = made;
  return {
    netsuite_id: made.netsuiteId,
    company: worked.company?.code ?? draft.company,
    made_from_id: made.madeFromId,
    vendor_netsuite_id: draft.vendorId,
    vendor_name: made.vendorName,
    credit_number: draft.number.trim(),
    credit_date: draft.date,
    location_netsuite_id: draft.locationId,
    reason: draft.reason.trim(),
    rule: VENDOR_CREDIT_RULE,
    total: signedAmount(worked.totalCents),
    applied: signedAmount(worked.appliedCents),
    applied_to: worked.applied.map((a) => ({ bill_netsuite_id: a.billId, bill_number: a.billNumber, amount: signedAmount(a.cents) })),
    made_by: made.madeBy,
    lines: worked.lines.map((l) => ({
      line_no: l.lineNo,
      kind: l.kind,
      account_netsuite_id: l.accountId,
      item_netsuite_id: l.itemId,
      item_number: l.itemNumber,
      description: l.description ?? l.memo,
      quantity: l.quantity,
      rate: l.rate,
      amount: signedAmount(l.cents),
    })),
  };
}

/**
 * Saves Books' own copy of a vendor credit FleetSuite just made. Never throws: the vendor credit exists in NetSuite
 * whatever happens here.
 */
export async function saveOwnVendorCredit(service: SupabaseClient, made: MadeVendorCredit): Promise<{ saved: boolean; reason?: string }> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which vendor credit it made" };
  try {
    const { data, error } = await service.rpc('gl_own_vendor_credit_save', { p: ownVendorCreditPayload({ ...made, netsuiteId }) });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite vendor credit ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
