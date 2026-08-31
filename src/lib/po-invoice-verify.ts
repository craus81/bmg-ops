import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { recomputePoFulfillment } from '@/lib/scan-match';
import { notifyPoBillingAttention, type FlaggedPoAlert } from '@/lib/po-billing-notify';

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
  /** POs (open or fulfilled) with zero invoices linked. */
  noInvoices: number;
  /** The subset of noInvoices that are fulfilled — work done, nothing billed. */
  noInvoicesFulfilled: number;
  flaggedPos: { poId: string; poNumber: string; problems: string[] }[];
}

// NetSuite sub-item ids come back as "PARENT : CHILD"; PO lines carry just the
// item number, so compare on the last segment. Exported so the invoice-open
// route groups a part's lines identically when it consumes open quantity —
// the two must agree or their installed writes diverge.
export function normPart(s: string): string {
  const segs = String(s || '').split(':');
  return segs[segs.length - 1].trim().toUpperCase();
}

/**
 * Distribute a part's consumed total across its PO lines and return the lines
 * whose `installed` should change.
 *
 * A part can appear on several PO lines, but a NetSuite invoice records only
 * item + quantity, never which PO line it billed. So consumption can't be
 * attributed to a specific line — it can only take the part's total consumed
 * quantity and spread it across the part's lines. Two rules make that spread
 * safe and repeatable:
 *   - deterministic order: fill lines in id order, so the same total always
 *     lands the same way (the invoice-open route and the verify sweep both
 *     call this, and must agree);
 *   - only raise: a line's installed is never lowered, because physical scans
 *     legitimately push installed past what's been billed.
 *
 * Because it only raises and always fills in the same order, calling it with a
 * larger total later (another invoice, the cumulative sweep) is idempotent with
 * an earlier smaller call — the two never stack into a count above the total.
 */
export function distributeInstalled(
  partLines: { id: string; quantity: number; installed: number | null }[],
  consumedTotal: number,
): { id: string; installed: number }[] {
  const ordered = [...partLines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const capacity = ordered.reduce((s, l) => s + (l.quantity || 0), 0);
  let remaining = Math.min(Math.max(consumedTotal, 0), capacity);
  const updates: { id: string; installed: number }[] = [];
  for (const line of ordered) {
    const fill = Math.min(remaining, line.quantity || 0);
    remaining -= fill;
    if (fill > (line.installed || 0)) updates.push({ id: line.id, installed: fill });
  }
  return updates;
}

/**
 * Per-item billed quantities for a set of NetSuite invoices, straight from
 * transactionline: invoice id -> normPart(item) -> quantity. Invoice item
 * lines carry negative quantities in SuiteQL, hence the sign flip on read.
 * Non-numeric ids are dropped rather than inlined into the query.
 */
export async function fetchInvoiceItemQuantities(invoiceIds: string[]): Promise<Map<string, Map<string, number>>> {
  const ids = [...new Set(
    invoiceIds.map(id => String(id || '').trim()).filter(id => /^\d+$/.test(id)),
  )];

  const invoiceItemQty = new Map<string, Map<string, number>>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
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
  return invoiceItemQty;
}

/**
 * What a PO's linked invoices have already billed, per part (normPart ->
 * quantity), plus the invoice numbers for error messages. Call
 * refreshPoInvoiceLinks first when the answer must include invoices entered
 * in NetSuite since the last sweep — this only reads what's linked.
 */
export async function getPoBilledByPart(service: SupabaseClient, poId: string): Promise<{
  billedByPart: Map<string, number>;
  invoiceNumbers: string[];
}> {
  const { data: links } = await service
    .from('po_invoices')
    .select('netsuite_invoice_id, netsuite_invoice_number')
    .eq('purchase_order_id', poId);

  const byInvoice = await fetchInvoiceItemQuantities(
    (links || []).map(l => String(l.netsuite_invoice_id || '')),
  );
  const billedByPart = new Map<string, number>();
  for (const byItem of byInvoice.values()) {
    for (const [item, qty] of byItem) billedByPart.set(item, (billedByPart.get(item) || 0) + qty);
  }
  const invoiceNumbers = (links || [])
    .map(l => l.netsuite_invoice_number)
    .filter(Boolean) as string[];
  return { billedByPart, invoiceNumbers };
}

/**
 * The gate an invoice flow runs BEFORE creating an invoice: would billing
 * `toBill` on top of what's already invoiced exceed what the PO ordered?
 * Returns one problem string per offending part; empty means safe to bill.
 *
 * Mirrors the sweep's judgments exactly — anything blocked here is precisely
 * what verifyPoInvoiceQuantities would flag 'attention' right afterwards
 * ('over' for quantity beyond ordered, 'extra' for a part the PO never had).
 * Blocking up front turns the sweep's after-the-fact badge into prevention.
 */
export function computeOverbillProblems(
  poLines: { part_number: string; quantity: number }[],
  billedByPart: Map<string, number>,
  toBill: { partNumber: string; quantity: number }[],
): string[] {
  const orderedByPart = new Map<string, number>();
  for (const line of poLines) {
    const key = normPart(line.part_number);
    if (!key) continue;
    orderedByPart.set(key, (orderedByPart.get(key) || 0) + (line.quantity || 0));
  }

  const toBillByPart = new Map<string, { part: string; qty: number }>();
  for (const t of toBill) {
    const key = normPart(t.partNumber);
    if (!key) continue;
    const cur = toBillByPart.get(key) || { part: t.partNumber, qty: 0 };
    cur.qty += t.quantity || 0;
    toBillByPart.set(key, cur);
  }

  const problems: string[] = [];
  for (const [key, t] of toBillByPart) {
    if (!orderedByPart.has(key)) {
      problems.push(`${t.part}: not a line on this PO`);
      continue;
    }
    const ordered = orderedByPart.get(key) || 0;
    const billed = billedByPart.get(key) || 0;
    if (billed + t.qty > ordered) {
      problems.push(
        billed >= ordered
          ? `${t.part}: the ${ordered} ordered ${ordered === 1 ? 'is' : 'are'} already fully invoiced`
          : `${t.part}: billing ${t.qty} on top of ${billed} already invoiced exceeds the ${ordered} ordered`,
      );
    }
  }
  return problems;
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
 * POs with NO invoices linked at all get their own 'no_invoices' marker —
 * informational for open POs (billing just hasn't happened yet), a real gap
 * for fulfilled ones. Closed/cancelled POs are left alone.
 *
 * The verdict lands on purchase_orders.invoice_check_status ('ok' /
 * 'attention' / 'no_invoices') with per-line detail in invoice_check, so the
 * PO page can badge flagged POs. Safe to run repeatedly; a PO fixed since
 * the last run flips back to 'ok'.
 *
 * Billed quantities also CONSUME the PO's open quantity: each line's
 * installed count is raised to what's been invoiced (never lowered), and a
 * fully billed PO flips to 'complete'. That keeps the "Invoice Open Qty"
 * flow from re-billing units an invoice — synced or app-created — already
 * covered.
 */
export async function verifyPoInvoiceQuantities(service: SupabaseClient, poIds?: string[]): Promise<PoInvoiceVerifyResult> {
  // Paginated: the whole-book sweep is past PostgREST's 1000-row cap, and
  // POs beyond it kept a stale invoice_check_status forever (Round 3
  // CRITICAL, R3-1). The embedded line/invoice arrays are per-PO and small.
  const { data: pos, error: posErr } = await fetchAllRows<any>((from, to) => {
    let query = service
      .from('purchase_orders')
      .select('id, po_number, status, invoice_check_status, po_line_items(id, part_number, quantity, installed), po_invoices(netsuite_invoice_id)')
      .neq('status', 'cancelled');
    // Scoped mode: recheck just these POs (the per-PO "Recheck billing"
    // button) instead of sweeping the whole book.
    if (poIds && poIds.length > 0) query = query.in('id', poIds);
    return query.order('id').range(from, to);
  });
  if (posErr) {
    throw new Error('Failed to load POs: ' + posErr.message);
  }

  const withInvoices = (pos || []).filter(po => (po.po_invoices || []).length > 0);

  // One SuiteQL sweep for every linked invoice's per-item quantities.
  const invoiceItemQty = await fetchInvoiceItemQuantities(
    withInvoices.flatMap(po => (po.po_invoices || []).map((inv: any) => String(inv.netsuite_invoice_id || ''))),
  );

  let flagged = 0;
  let cleared = 0;
  const flaggedPos: PoInvoiceVerifyResult['flaggedPos'] = [];
  const newlyFlagged: FlaggedPoAlert[] = [];
  const billedPoIds: string[] = [];

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

    // Billed units consume the PO's open quantity: raise each line's
    // installed count to what's been invoiced (never lowered — scans still
    // count physical installs past billing). A part can span several lines;
    // billed units fill them in order, capped at each line's quantity. A
    // fully billed PO then flips to 'complete' via the fulfillment
    // recompute below, dropping it off the open list and hiding the
    // "Invoice Open Qty" button.
    const lineRows = (po.po_line_items || []) as { id: string; part_number: string; quantity: number; installed: number | null }[];
    let linesChanged = false;
    for (const key of ordered.keys()) {
      const partLines = lineRows.filter(l => normPart(l.part_number) === key);
      for (const u of distributeInstalled(partLines, invoiced.get(key) || 0)) {
        await service.from('po_line_items').update({ installed: u.installed }).eq('id', u.id);
        linesChanged = true;
      }
    }
    if (linesChanged) billedPoIds.push(po.id);

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
      // Only a FLIP into 'attention' alerts anyone — a PO that stays flagged
      // across repeated sweeps would otherwise ping every couple hours.
      if (po.invoice_check_status !== 'attention') {
        newlyFlagged.push({ poId: po.id, poNumber: po.po_number, problems });
      }
    } else if (po.invoice_check_status === 'attention') {
      cleared++;
    }
  }

  // Billed units may have filled a PO — flip it to 'complete' with the same
  // rule scan matching uses, so it reads as Fulfilled everywhere.
  await recomputePoFulfillment(service, billedPoIds);

  // Money-out problems shouldn't wait to be stumbled on via the PO-page
  // badge — alert the super admins the moment a PO flips to 'attention'.
  // Never throws, so a broken send can't fail the sweep or an invoice flow
  // that ran it.
  await notifyPoBillingAttention(newlyFlagged);

  // POs with zero invoices linked get their own marker. Closed POs are
  // skipped (archived — no billing expected); cancelled ones never loaded.
  // Only write rows whose marker actually changes, so the recurring cron
  // run doesn't rewrite the whole PO book every couple hours.
  let noInvoices = 0;
  let noInvoicesFulfilled = 0;
  for (const po of pos || []) {
    if ((po.po_invoices || []).length > 0) continue;
    if (po.status === 'closed') continue;
    noInvoices++;
    if (po.status === 'complete') noInvoicesFulfilled++;
    if (po.invoice_check_status !== 'no_invoices') {
      await service.from('purchase_orders').update({
        invoice_check_status: 'no_invoices',
        invoice_check: {
          checked_at: new Date().toISOString(),
          invoice_count: 0,
          problems: [],
          lines: [],
        },
      }).eq('id', po.id);
    }
  }

  return { posChecked: withInvoices.length, flagged, cleared, noInvoices, noInvoicesFulfilled, flaggedPos };
}
