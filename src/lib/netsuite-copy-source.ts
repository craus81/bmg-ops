import type { SupabaseClient } from '@supabase/supabase-js';
import {
  NETSUITE_COPY_LABEL, invoiceLineAmount, sourceLineFromRow, type NetsuiteCopyType, type NetsuiteSourceDoc,
} from '@/lib/netsuite-estimate-copy';

/**
 * Server only: an old NetSuite invoice, sales order or estimate as the copy
 * screens read it. Used by Copy to new estimate (/api/estimates/draft-from-
 * netsuite) and the new sales order's Copy from (/api/sales-orders/new/copy).
 */

export interface LoadedCopyDoc {
  doc: NetsuiteSourceDoc;
  customerNetsuiteId: string | null;
}

/**
 * The old document from FleetSuite's own copy of it: sales orders and
 * estimates from their NetSuite copies (migrations 196, 372), invoices from
 * the ledger mirror (migration 314). No live NetSuite call.
 */
export async function loadNetsuiteCopyDoc(service: SupabaseClient, type: NetsuiteCopyType, nsId: string): Promise<LoadedCopyDoc | null> {
  const label = NETSUITE_COPY_LABEL[type];
  if (type === 'invoice') {
    const { data: head } = await service
      .from('ledger_invoices')
      .select('id, doc_number, doc_date, customer_netsuite_id')
      .eq('source', 'netsuite').eq('doc_type', 'invoice').eq('external_ref', nsId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!head) return null;
    const { data: lines } = await service
      .from('ledger_invoice_lines')
      // The mirror stores amounts unsigned; NetSuite's own signed amount in
      // `raw` is what tells a discount line apart. NetSuite signs invoice
      // lines as credits (a sold part is negative, a discount positive), so
      // it's flipped here the way every invoice report does (-tl.netamount).
      .select('item_external_id, item_name, item_number, description, quantity, unit_price, amount, line_kind, line_no, ns_amount:raw->>netamount')
      .eq('document_id', head.id)
      .eq('line_kind', 'item')
      .order('line_no', { ascending: true, nullsFirst: false });
    return {
      doc: { number: head.doc_number || nsId, typeLabel: label, date: head.doc_date || '', lines: (lines || []).map((l: any) => sourceLineFromRow({ ...l, amount: invoiceLineAmount(l.ns_amount, l.amount) })) },
      customerNetsuiteId: head.customer_netsuite_id || null,
    };
  }

  const [headTable, lineTable, fk] = type === 'salesOrder'
    ? ['netsuite_sales_orders', 'netsuite_sales_order_lines', 'so_id']
    : ['netsuite_estimates', 'netsuite_estimate_lines', 'ns_estimate_id'];
  const { data: head } = await service
    .from(headTable)
    .select('id, tranid, trandate, customer_netsuite_id')
    .eq('netsuite_id', nsId)
    .maybeSingle();
  if (!head) return null;
  // line_id is NetSuite's transactionline id, which runs in line order.
  const { data: lines } = await service
    .from(lineTable)
    .select('line_id, item_netsuite_id, item_number, description, quantity, rate, amount')
    .eq(fk, head.id);
  const ordered = (lines || []).sort((a: any, b: any) => Number(a.line_id) - Number(b.line_id));
  return {
    doc: { number: head.tranid || nsId, typeLabel: label, date: head.trandate || '', lines: ordered.map(sourceLineFromRow) },
    customerNetsuiteId: head.customer_netsuite_id || null,
  };
}
