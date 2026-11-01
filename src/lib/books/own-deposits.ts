import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentMethod } from '@/lib/receive-payment';
import type { BooksCompany } from './journal';
import { signedAmount } from './own-invoices';

/**
 * Books' own copy of each customer deposit FleetSuite makes (migration 486,
 * docs/books.md "Deposits taken in FleetSuite").
 *
 * When FleetSuite makes a customer deposit in NetSuite (src/lib/take-deposit.ts,
 * /api/sales-orders/deposit), it keeps its own copy, as it was taken and sent
 * rather than read back from NetSuite: the company whose sales order it's on,
 * the order, the day, check or ACH with its number or reference, the memo
 * NetSuite got, the amount, and that it went to Undeposited Funds. Checking
 * the copies against NetSuite's deposits, and posting them, comes after.
 *
 * Saving never stops a deposit: it already exists in NetSuite when the copy
 * is made, so a copy that can't be saved is logged and left.
 */

export interface MadeDeposit {
  netsuiteId: string | null | undefined;
  netsuiteNumber?: string | null;
  company: BooksCompany;
  customerNetsuiteId: string;
  salesOrderNetsuiteId: string;
  salesOrderNumber: string | null;
  /** 'YYYY-MM-DD', the day it was received. */
  date: string;
  method: PaymentMethod;
  reference: string | null;
  /** As NetSuite got it. */
  memo: string;
  amountCents: number;
  /** The press of Take deposit (received_deposits.id). */
  madeFromId: string;
  madeBy: string | null;
}

/** The copy as gl_own_deposit_save takes it. Pure. */
export function ownDepositPayload(made: MadeDeposit & { netsuiteId: string }, opts: { customerId: string | null }) {
  return {
    netsuite_id: made.netsuiteId,
    netsuite_number: made.netsuiteNumber ?? null,
    company: made.company,
    made_from_id: made.madeFromId,
    customer_netsuite_id: made.customerNetsuiteId,
    customer_id: opts.customerId,
    sales_order_netsuite_id: made.salesOrderNetsuiteId,
    sales_order_number: made.salesOrderNumber || null,
    deposit_date: made.date,
    method: made.method,
    reference: made.reference,
    memo: made.memo,
    deposited_to: 'undeposited_funds',
    amount: signedAmount(made.amountCents),
    made_by: made.madeBy,
  };
}

/** Saves Books' own copy of a deposit FleetSuite just made. Never throws: the deposit exists in NetSuite whatever happens here. */
export async function saveOwnDeposit(service: SupabaseClient, made: MadeDeposit): Promise<{ saved: boolean; reason?: string }> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which deposit it made" };
  try {
    const { data: customers, error: customerError } = await service.from('customers').select('id').eq('netsuite_id', made.customerNetsuiteId);
    if (customerError) throw new Error(customerError.message);
    const rows = (customers ?? []) as Array<{ id: string }>;
    const payload = ownDepositPayload({ ...made, netsuiteId }, { customerId: rows.length === 1 ? rows[0].id : null });
    const { data, error } = await service.rpc('gl_own_deposit_save', { p: payload });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite deposit ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
