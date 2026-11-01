import type { SupabaseClient } from '@supabase/supabase-js';
import type { BooksCompany } from './journal';
import { signedAmount } from './own-invoices';

/**
 * Books' own copy of each bill payment FleetSuite makes (migration 488,
 * docs/books.md "Vendors paid in FleetSuite").
 *
 * When FleetSuite makes one of an approved payment run's payments in NetSuite
 * (src/lib/pay-vendors.ts, /api/pay-vendors), it keeps its own copy, as it was
 * sent rather than read back from NetSuite: the company, the vendor, the bank
 * account it was paid from, the day, check or ACH, the memo, the bills it paid
 * with what it paid on each, the total, and who asked for the run and who
 * approved it. Checking the copies against NetSuite's bill payments, and
 * posting them, comes after.
 *
 * Saving never stops a payment: it already exists in NetSuite when the copy
 * is made, so a copy that can't be saved is logged and left.
 */

/** A bill it paid, as the run kept it. */
export interface MadeBillPaymentBill {
  netsuiteId: string;
  number: string | null;
  cents: number;
}

export interface MadeBillPayment {
  netsuiteId: string | null | undefined;
  netsuiteNumber?: string | null;
  company: BooksCompany;
  vendorNetsuiteId: string;
  vendorName: string | null;
  bankAccountNetsuiteId: string;
  /** 'YYYY-MM-DD', the day it's paid. */
  date: string;
  method: 'check' | 'ach';
  /** The memo NetSuite was sent. */
  memo: string | null;
  bills: readonly MadeBillPaymentBill[];
  totalCents: number;
  /** The run and its payment (vendor_payment_runs.id, vendor_payment_run_payments.id). */
  madeFromRun: string;
  madeFromPayment: string;
  askedBy: string | null;
  approvedBy: string | null;
}

/** The copy as gl_own_bill_payment_save takes it. Pure. */
export function ownBillPaymentPayload(made: MadeBillPayment & { netsuiteId: string }) {
  return {
    netsuite_id: made.netsuiteId,
    netsuite_number: made.netsuiteNumber ?? null,
    company: made.company,
    made_from_run: made.madeFromRun,
    made_from_payment: made.madeFromPayment,
    vendor_netsuite_id: made.vendorNetsuiteId,
    vendor_name: made.vendorName,
    bank_account_netsuite_id: made.bankAccountNetsuiteId,
    payment_date: made.date,
    method: made.method,
    memo: made.memo,
    bills: made.bills.map((b) => ({ netsuite_id: b.netsuiteId, number: b.number, amount: signedAmount(b.cents) })),
    amount: signedAmount(made.totalCents),
    asked_by: made.askedBy,
    approved_by: made.approvedBy,
  };
}

/** Saves Books' own copy of a bill payment FleetSuite just made. Never throws: the payment exists in NetSuite whatever happens here. */
export async function saveOwnBillPayment(service: SupabaseClient, made: MadeBillPayment): Promise<{ saved: boolean; reason?: string }> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which bill payment it made" };
  try {
    const { data, error } = await service.rpc('gl_own_bill_payment_save', { p: ownBillPaymentPayload({ ...made, netsuiteId }) });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite bill payment ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
