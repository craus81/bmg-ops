/**
 * Server half of FleetSuite's own PO PDF (src/lib/po-pdf.ts): reads the PO
 * live from NetSuite and the letterhead from Settings → Company, and returns
 * the bytes. No PDF, no send: callers stop with the error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getPurchaseOrderRecord } from './netsuite';
import { readLetterhead } from './statement-pdf-server';
import { buildTransactionPdf } from './transaction-pdf';
import { poPdfDataFromRecord } from './po-pdf';

export async function makePurchaseOrderPdf(
  supabase: SupabaseClient,
  purchaseOrderId: string | number,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  const [rec, letterhead] = await Promise.all([
    getPurchaseOrderRecord(purchaseOrderId),
    readLetterhead(supabase).catch(() => null),
  ]);
  if (!rec.success) return { ok: false, error: rec.error };
  try {
    const doc = buildTransactionPdf(poPdfDataFromRecord(rec.record, letterhead));
    return { ok: true, buffer: Buffer.from(doc.output('arraybuffer')) };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'the PDF could not be drawn' };
  }
}
