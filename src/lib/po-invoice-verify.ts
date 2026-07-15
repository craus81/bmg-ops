import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';

export interface PoInvoiceLineCheck {
  part_number: string;
  ordered: number;
  invoiced: number;
  status: 'ok' | 'over' | 'under' | 'extra';
}

export interface PoInvoiceVerifyResult {
  posChecked: number;
  flagged: number;
  cleared: number;
  flaggedPos: { poId: string; poNumber: string; problems: string[] }[];
}

// NetSuite sub-item ids come back as "PARENT : CHILD"; PO lines carry just the
// item number, so compare on the last segment.
function normPart(s: string): string {
  const segs = String(s || '').split(':');
  return segs[segs.length - 1].trim().toUpperCase();
}

/**
 * Verify that each PO's linked invoices bill the quantities the PO ordered,
 * and flag POs that don't add up as needing attention.
 *
 * For every PO with at least one po_invoices row, the invoices' line
 * quantities are pulled from NetSuite (transactionline) and summed per item,
 * then compared against the PO's line quantities:
 *   - over  — a part billed for MORE than the PO ordered: always flagged.
 *   - extra — an invoice bills a part that isn't on the PO at all: flagged.
 *   - under — a part billed for less than ordered: flagged only once the PO
 *             is fulfilled (status 'complete') — an in-progress PO is
 *             expected to be partially invoiced.
 * The verdict lands on purchase_orders.invoice_check_status ('ok' /
 * 'attention') with per-line detail in invoice_check, so the PO page can
 * badge flagged POs. Safe to run repeatedly; a PO fixed since the last run
 * flips back to 'ok'.
 */
export async function verifyPoInvoiceQuantities(service: SupabaseClient): Promise<PoInvoiceVerifyResult> {
  const { data: pos, error: posErr } = await service
    .from('purchase_orders')
    .select('id, po_number, status, invoice_check_status, po_line_items(part_number, quantity), po_invoices(netsuite_invoice_id)')
    .neq('status', 'cancelled');
  if (posErr) {
    throw new Error('Failed to load POs: ' + posErr.message);
  }

  const withInvoices = (pos || []).filter(po => (po.po_invoices || []).length > 0);

  // One SuiteQL sweep for every linked invoice's per-item quantities.
  // Invoice ids are NetSuite internal ids (numeric) — drop anything else
  // rather than inlining it into the query.
  const invoiceIds = [...new Set(
    withInvoices
      .flatMap(po => (po.po_invoices || []).map((inv: any) => String(inv.netsuite_invoice_id || '').trim()))
      .filter(id => /^\d+$/.test(id)),
  )];

  // invoice id -> item name -> billed quantity. Invoice item lines carry
  // negative quantities in SuiteQL, hence the sign flip on read.
  const invoiceItemQty = new Map<string, Map<string, number>>();
  for (let i = 0; i < invoiceIds.length; i += 100) {
    const chunk = invoiceIds.slice(i, i + 100);
    const rows = await suiteqlQueryAll(`
      SELECT tl.transaction AS invoice_id, i.itemid AS item_name, SUM(tl.quantity) AS qty
      FROM transactionline tl
      LEFT JOIN item i ON i.id = tl.item
      WHERE tl.transaction IN (${chunk.join(', ')})
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND tl.item IS NOT NULL
      GROUP BY tl.transaction, i.itemid
    `);
    for (const row of rows) {
      const invId = String(row.invoice_id ?? '');
      const item = normPart(row.item_name);
      const qty = Math.abs(parseFloat(row.qty || '0')) || 0;
      if (!invId || !item || qty === 0) continue;
      const byItem = invoiceItemQty.get(invId) || new Map<string, number>();
      byItem.set(item, (byItem.get(item) || 0) + qty);
      invoiceItemQty.set(invId, byItem);
    }
  }

  let flagged = 0;
  let cleared = 0;
  const flaggedPos: PoInvoiceVerifyResult['flaggedPos'] = [];

  for (const po of withInvoices) {
    // Ordered quantity per part (a part can appear on several lines).
    const ordered = new Map<string, { part: string; qty: number }>();
    for (const line of (po.po_line_items || []) as { part_number: string; quantity: number }[]) {
      const key = normPart(line.part_number);
      if (!key) continue;
      const cur = ordered.get(key) || { part: line.part_number, qty: 0 };
      cur.qty += line.quantity || 0;
      ordered.set(key, cur);
    }

    // Invoiced quantity per part across all of this PO's invoices. Invoices
    // whose lines we couldn't fetch are left out of the math rather than
    // counted as zero-billed.
    const invoiced = new Map<string, number>();
    let invoicesCounted = 0;
    for (const inv of (po.po_invoices || []) as { netsuite_invoice_id: string }[]) {
      const byItem = invoiceItemQty.get(String(inv.netsuite_invoice_id || '').trim());
      if (!byItem) continue;
      invoicesCounted++;
      for (const [item, qty] of byItem) {
        invoiced.set(item, (invoiced.get(item) || 0) + qty);
      }
    }
    if (invoicesCounted === 0) continue;

    const lines: PoInvoiceLineCheck[] = [];
    const problems: string[] = [];
    for (const [key, ord] of ordered) {
      const inv = invoiced.get(key) || 0;
      const status: PoInvoiceLineCheck['status'] =
        inv > ord.qty ? 'over' : inv < ord.qty ? 'under' : 'ok';
      lines.push({ part_number: ord.part, ordered: ord.qty, invoiced: inv, status });
      if (status === 'over') {
        problems.push(`${ord.part}: invoiced ${inv} of ${ord.qty} ordered — over-billed`);
      } else if (status === 'under' && po.status === 'complete') {
        problems.push(`${ord.part}: invoiced ${inv} of ${ord.qty} ordered — fulfilled but under-billed`);
      }
    }
    for (const [key, qty] of invoiced) {
      if (ordered.has(key)) continue;
      lines.push({ part_number: key, ordered: 0, invoiced: qty, status: 'extra' });
      problems.push(`${key}: invoiced ${qty} but not a line on this PO`);
    }

    const status = problems.length > 0 ? 'attention' : 'ok';
    await service.from('purchase_orders').update({
      invoice_check_status: status,
      invoice_check: {
        checked_at: new Date().toISOString(),
        invoice_count: invoicesCounted,
        problems,
        lines,
      },
    }).eq('id', po.id);

    if (status === 'attention') {
      flagged++;
      flaggedPos.push({ poId: po.id, poNumber: po.po_number, problems });
    } else if (po.invoice_check_status === 'attention') {
      cleared++;
    }
  }

  return { posChecked: withInvoices.length, flagged, cleared, flaggedPos };
}
