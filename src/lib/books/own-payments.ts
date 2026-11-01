import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentMethod } from '@/lib/receive-payment';
import type { BooksCompany } from './journal';
import { signedAmount } from './own-invoices';

/**
 * Books' own copy of each customer payment FleetSuite makes (migration 485,
 * docs/books.md "Payments received in FleetSuite").
 *
 * When FleetSuite makes a customer payment in NetSuite (src/lib/receive-payment.ts,
 * /api/invoices/payment), it keeps its own copy, as it was received and sent
 * rather than read back from NetSuite: the company whose invoices it pays, the
 * day, check or ACH with its number or reference, the memo NetSuite got, the
 * amount, that it went to Undeposited Funds, and what it paid on each invoice.
 * Checking the copies against NetSuite's payments, and posting them, comes
 * after.
 *
 * Saving never stops a payment: it already exists in NetSuite when the copy
 * is made, so a copy that can't be saved is logged and left.
 */

export interface MadePayment {
  netsuiteId: string | null | undefined;
  netsuiteNumber?: string | null;
  company: BooksCompany;
  customerNetsuiteId: string;
  /** 'YYYY-MM-DD', the day it was received. */
  date: string;
  method: PaymentMethod;
  reference: string | null;
  /** As NetSuite got it. */
  memo: string;
  amountCents: number;
  applied: { invoiceId: string; number: string; cents: number }[];
  /** The press of Receive payment (received_payments.id). */
  madeFromId: string;
  madeBy: string | null;
}

/** The copy as gl_own_payment_save takes it. Pure. */
export function ownPaymentPayload(made: MadePayment & { netsuiteId: string }, opts: { customerId: string | null }) {
  return {
    netsuite_id: made.netsuiteId,
    netsuite_number: made.netsuiteNumber ?? null,
    company: made.company,
    made_from_id: made.madeFromId,
    customer_netsuite_id: made.customerNetsuiteId,
    customer_id: opts.customerId,
    payment_date: made.date,
    method: made.method,
    reference: made.reference,
    memo: made.memo,
    deposited_to: 'undeposited_funds',
    amount: signedAmount(made.amountCents),
    made_by: made.madeBy,
    applications: made.applied.map((a, i) => ({
      line_no: i + 1,
      invoice_netsuite_id: a.invoiceId,
      invoice_number: a.number || null,
      amount: signedAmount(a.cents),
    })),
  };
}

/** Saves Books' own copy of a payment FleetSuite just made. Never throws: the payment exists in NetSuite whatever happens here. */
export async function saveOwnPayment(service: SupabaseClient, made: MadePayment): Promise<{ saved: boolean; reason?: string }> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which payment it made" };
  try {
    const { data: customers, error: customerError } = await service.from('customers').select('id').eq('netsuite_id', made.customerNetsuiteId);
    if (customerError) throw new Error(customerError.message);
    const rows = (customers ?? []) as Array<{ id: string }>;
    const payload = ownPaymentPayload({ ...made, netsuiteId }, { customerId: rows.length === 1 ? rows[0].id : null });
    const { data, error } = await service.rpc('gl_own_payment_save', { p: payload });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite payment ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
