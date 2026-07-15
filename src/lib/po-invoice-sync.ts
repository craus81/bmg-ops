import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery } from '@/lib/netsuite';

/**
 * Refresh ONE PO's invoice links against NetSuite, both directions:
 * link any invoice now referencing this PO number that isn't linked yet
 * (e.g. a corrected replacement), and unlink rows whose NetSuite invoice
 * no longer exists (deleted/voided duplicates). Powers the per-PO
 * "Recheck billing" button, where someone just fixed things in NetSuite
 * and wants the PO to reflect it now, not at the next cron sweep.
 */
export async function refreshPoInvoiceLinks(
  service: SupabaseClient,
  poId: string,
): Promise<{ linked: number; unlinked: number }> {
  const { data: po } = await service
    .from('purchase_orders')
    .select('id, po_number')
    .eq('id', poId)
    .maybeSingle();
  if (!po?.po_number) return { linked: 0, unlinked: 0 };

  const { data: existing } = await service
    .from('po_invoices')
    .select('id, netsuite_invoice_id')
    .eq('purchase_order_id', poId);
  const existingByNsId = new Map((existing || []).map(r => [String(r.netsuite_invoice_id), r.id]));

  // Everything NetSuite currently has for this PO number...
  const poNumber = String(po.po_number).replace(/'/g, '');
  const byRef = await suiteqlQuery(`
    SELECT t.id, t.tranid, t.trandate
    FROM transaction t
    WHERE t.type = 'CustInvc' AND t.otherrefnum = '${poNumber}'
  `);
  const liveByRef = new Map<string, any>(
    (byRef?.items || []).map((inv: any) => [String(inv.id), inv]),
  );

  // ...plus an existence check for already-linked ids whose reference no.
  // may have been edited away — those stay linked as long as they exist.
  const linkedIds = [...existingByNsId.keys()].filter(id => /^\d+$/.test(id) && !liveByRef.has(id));
  const stillExists = new Set<string>();
  if (linkedIds.length > 0) {
    const check = await suiteqlQuery(`
      SELECT t.id FROM transaction t
      WHERE t.type = 'CustInvc' AND t.id IN (${linkedIds.join(', ')})
    `);
    for (const row of check?.items || []) stillExists.add(String(row.id));
  }

  let linked = 0;
  for (const [nsId, inv] of liveByRef) {
    if (existingByNsId.has(nsId)) continue;
    const { error } = await service.from('po_invoices').insert({
      purchase_order_id: poId,
      netsuite_invoice_id: nsId,
      netsuite_invoice_number: inv.tranid || null,
      memo: `Synced from NetSuite${inv.trandate ? ` — invoiced ${String(inv.trandate).slice(0, 10)}` : ''}`,
    });
    if (!error) linked++;
  }

  let unlinked = 0;
  for (const [nsId, rowId] of existingByNsId) {
    if (liveByRef.has(nsId) || stillExists.has(nsId) || !/^\d+$/.test(nsId)) continue;
    const { error } = await service.from('po_invoices').delete().eq('id', rowId);
    if (!error) unlinked++;
  }

  return { linked, unlinked };
}

export interface PoInvoiceSyncResult {
  posScanned: number;
  invoicesFound: number;
  linked: number;
}

/**
 * Link every NetSuite invoice that carries a PO number to that PO,
 * regardless of where the invoice was created.
 *
 * FleetSuite-created invoices are recorded in po_invoices at creation time,
 * but invoices entered directly in NetSuite never were. Both stamp the PO
 * number into the invoice's Reference No. (otherrefnum), so a SuiteQL sweep
 * by that field finds them all; anything not already linked gets a
 * po_invoices row. Safe to run repeatedly.
 *
 * Runs from the manual "Sync Invoices" button on the PO page and from the
 * netsuite-sync cron, so invoices show up on POs without user action.
 */
export async function syncPoInvoices(service: SupabaseClient): Promise<PoInvoiceSyncResult> {
  const { data: pos, error: posErr } = await service
    .from('purchase_orders')
    .select('id, po_number');
  if (posErr) {
    throw new Error('Failed to load POs: ' + posErr.message);
  }

  // PO number -> PO ids (numbers are unique in practice; tolerate dupes)
  const poIdsByNumber = new Map<string, string[]>();
  for (const po of pos || []) {
    const num = String(po.po_number || '').trim();
    if (!num) continue;
    const list = poIdsByNumber.get(num) || [];
    list.push(po.id);
    poIdsByNumber.set(num, list);
  }

  const { data: existing } = await service
    .from('po_invoices')
    .select('purchase_order_id, netsuite_invoice_id');
  const linkedKeys = new Set((existing || []).map(r => `${r.purchase_order_id}|${r.netsuite_invoice_id}`));

  // Sweep NetSuite for invoices referencing these PO numbers, in chunks.
  // otherrefnum is a string field; PO numbers are alphanumeric, but strip
  // quotes defensively before inlining.
  const numbers = [...poIdsByNumber.keys()].map(n => n.replace(/'/g, ''));
  let found = 0;
  let added = 0;
  for (let i = 0; i < numbers.length; i += 50) {
    const chunk = numbers.slice(i, i + 50);
    const query = `
      SELECT t.id, t.tranid, t.trandate, t.otherrefnum
      FROM transaction t
      WHERE t.type = 'CustInvc'
        AND t.otherrefnum IN (${chunk.map(n => `'${n}'`).join(', ')})
    `;
    const result = await suiteqlQuery(query);
    for (const inv of result?.items || []) {
      const refNum = String(inv.otherrefnum || '').trim();
      const poIds = poIdsByNumber.get(refNum) || [];
      if (poIds.length === 0) continue;
      found++;
      for (const poId of poIds) {
        const key = `${poId}|${String(inv.id)}`;
        if (linkedKeys.has(key)) continue;
        const { error } = await service.from('po_invoices').insert({
          purchase_order_id: poId,
          netsuite_invoice_id: String(inv.id),
          netsuite_invoice_number: inv.tranid || null,
          memo: `Synced from NetSuite${inv.trandate ? ` — invoiced ${String(inv.trandate).slice(0, 10)}` : ''}`,
        });
        if (!error) {
          linkedKeys.add(key);
          added++;
        }
      }
    }
  }

  return { posScanned: numbers.length, invoicesFound: found, linked: added };
}
