/**
 * Server half of FleetSuite's own sales order and invoice PDFs
 * (src/lib/sales-pdf.ts): reads the record live from NetSuite and the
 * letterhead from Settings → Company, and returns the bytes. Callers that
 * email stop with the error: no PDF, no send.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getInvoiceRecord, getSalesOrderRecord } from './netsuite';
import { readLetterhead } from './statement-pdf-server';
import { buildTransactionPdf, transactionPdfFilename } from './transaction-pdf';
import { salesPdfDataFromRecord, type SalesKind } from './sales-pdf';

export type SalesPdfResult =
  | { ok: true; buffer: Buffer; filename: string; number: string; base64: string }
  | { ok: false; error: string };

export async function makeSalesPdf(
  supabase: SupabaseClient,
  kind: SalesKind,
  netsuiteId: string | number,
): Promise<SalesPdfResult> {
  const [rec, letterhead] = await Promise.all([
    kind === 'invoice' ? getInvoiceRecord(netsuiteId) : getSalesOrderRecord(netsuiteId),
    readLetterhead(supabase).catch(() => null),
  ]);
  if (!rec.success) return { ok: false, error: rec.error };
  try {
    const data = salesPdfDataFromRecord(kind, rec.record, letterhead);
    const buffer = Buffer.from(buildTransactionPdf(data).output('arraybuffer'));
    return { ok: true, buffer, base64: buffer.toString('base64'), filename: transactionPdfFilename(kind, data.number), number: data.number };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'the PDF could not be drawn' };
  }
}

/**
 * FleetSuite's invoice PDF in getNetSuitePdf's answer shape, so every invoice
 * email (single, several, statements, the customer portal) swaps one call.
 */
export async function getFleetSuiteInvoicePdf(
  supabase: SupabaseClient,
  invoiceId: string | number,
): Promise<{ success: boolean; pdfBase64?: string; filename?: string; error?: string }> {
  const r = await makeSalesPdf(supabase, 'invoice', invoiceId);
  return r.ok ? { success: true, pdfBase64: r.base64, filename: r.filename } : { success: false, error: r.error };
}
