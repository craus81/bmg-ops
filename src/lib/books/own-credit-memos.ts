import type { SupabaseClient } from '@supabase/supabase-js';
import { CREDIT_TAX_RULE, type InvoiceView, type WorkedCreditMemo } from '@/lib/credit-memo';
import { chicagoDate, OWN_COMPANY, signedAmount } from './own-invoices';

/**
 * Books' own copy of each credit memo FleetSuite makes (migration 466,
 * docs/books.md "Credit memos made in FleetSuite").
 *
 * When FleetSuite makes a credit memo in NetSuite against an invoice
 * (src/lib/credit-memo.ts, /api/invoices/credit-memo), it keeps its own copy,
 * worked out by its own rules rather than read back from NetSuite: the lines
 * the person picked, each at its quantity and price or amount, taxed as the
 * invoice taxed it at the invoice's rate (credit_tax@1), with whether the
 * part came back on the shelf or the money went on the credit item. Checking
 * the copies against NetSuite's credit memos, and posting them, comes after.
 *
 * Saving never stops a credit memo: it already exists in NetSuite when the
 * copy is made, so a copy that can't be saved is logged and left.
 */

export interface MadeCreditMemo {
  netsuiteId: string | null | undefined;
  netsuiteNumber?: string | null;
  invoice: InvoiceView;
  worked: WorkedCreditMemo;
  reason: string;
  /** The press of Make credit memo (invoice_credit_memos.id). */
  madeFromId: string;
  madeBy: string | null;
}

/** The copy as gl_own_credit_memo_save takes it. Pure. */
export function ownCreditMemoPayload(made: MadeCreditMemo & { netsuiteId: string }, opts: { customerId: string | null; creditDate: string }) {
  const { invoice, worked } = made;
  const taxed = worked.lines.some((l) => l.taxable);
  return {
    netsuite_id: made.netsuiteId,
    netsuite_number: made.netsuiteNumber ?? null,
    company: OWN_COMPANY,
    invoice_netsuite_id: invoice.id,
    invoice_number: invoice.number || null,
    made_from_id: made.madeFromId,
    customer_netsuite_id: invoice.customerId,
    customer_id: opts.customerId,
    credit_date: opts.creditDate,
    location_netsuite_id: invoice.locationId,
    reason: made.reason.trim(),
    tax_rule: CREDIT_TAX_RULE,
    // Nothing taxed, nothing at any rate: the rate is the invoice's only when tax was given back.
    tax_rate: (taxed ? invoice.taxRate ?? 0 : 0).toFixed(6),
    tax_rate_from: taxed ? invoice.taxRateFrom ?? 'worked_out' : 'untaxed',
    subtotal: signedAmount(worked.subtotalCents),
    tax: signedAmount(worked.taxCents),
    total: signedAmount(worked.totalCents),
    made_by: made.madeBy,
    lines: worked.lines.map((l, i) => ({
      line_no: i + 1,
      invoice_line: l.invoiceLine,
      item_netsuite_id: l.itemId,
      item_number: l.itemNumber,
      description: l.description || null,
      quantity: l.quantity,
      rate: l.price,
      amount: signedAmount(l.cents),
      taxable: l.taxable,
      tax: signedAmount(l.taxCents),
      back_to_stock: l.backToStock,
      on_credit_item: l.onCreditItem,
    })),
  };
}

/**
 * Saves Books' own copy of a credit memo FleetSuite just made. Never throws: the credit memo exists in NetSuite
 * whatever happens here.
 */
export async function saveOwnCreditMemo(
  service: SupabaseClient,
  made: MadeCreditMemo,
  at: Date = new Date(),
): Promise<{ saved: boolean; reason?: string }> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which credit memo it made" };
  try {
    let customerId: string | null = null;
    if (made.invoice.customerId) {
      const { data, error } = await service.from('customers').select('id').eq('netsuite_id', made.invoice.customerId);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ id: string }>;
      customerId = rows.length === 1 ? rows[0].id : null;
    }
    const payload = ownCreditMemoPayload({ ...made, netsuiteId }, { customerId, creditDate: chicagoDate(at) });
    const { data, error } = await service.rpc('gl_own_credit_memo_save', { p: payload });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite credit memo ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
