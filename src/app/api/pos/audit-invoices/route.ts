import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { fetchAllRows } from '@/lib/po-invoice-sync';
import { verifyPoInvoiceQuantities } from '@/lib/po-invoice-verify';
import { matchInvoicesToPos, type AuditInvoice } from '@/lib/po-invoice-audit';

export const dynamic = 'force-dynamic';
// One SuiteQL sweep over every customer invoice in the window plus the
// quantity verify on affected POs when applying.
export const maxDuration = 120;

const Schema = z.object({
  // How far back to sweep NetSuite invoices. A year covers the active book
  // without dragging the full history through SuiteQL every click.
  months: z.number().int().min(1).max(60).optional(),
  // false/omitted = report only; true = write the po_invoices links for the
  // unambiguous matches and re-run the quantity check on the affected POs.
  apply: z.boolean().optional(),
});

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/pos/audit-invoices — retroactive audit for invoices the regular
 * sync can't see (see po-invoice-audit). Sweeps every NetSuite customer
 * invoice in the window, matches unlinked ones to POs by normalized
 * Reference No. / scan stamps / memo mentions, and — on apply — links them
 * and re-runs the over-billing check so hidden over-billing surfaces with
 * the usual ⚠ badge and super-admin alert.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const months = parsed.data.months ?? 12;
  const apply = parsed.data.apply ?? false;

  try {
    const pos = (await fetchAllRows<{ id: string; po_number: string | null }>(
      (from, to) => service.from('purchase_orders').select('id, po_number').order('id').range(from, to),
      'POs',
    ))
      .filter(po => String(po.po_number || '').trim())
      .map(po => ({ id: po.id, poNumber: String(po.po_number).trim() }));

    const links = await fetchAllRows<{ netsuite_invoice_id: string }>(
      (from, to) => service.from('po_invoices').select('netsuite_invoice_id').order('id').range(from, to),
      'invoice links',
    );
    const linkedInvoiceIds = new Set(links.map(l => String(l.netsuite_invoice_id)));

    // Scan stamps: invoice number -> the PO numbers on its scans. Only scans
    // that carry both fields say anything about which PO an invoice billed.
    const scans = await fetchAllRows<{ invoice_number: string; po_number: string }>(
      (from, to) => service
        .from('scan_logs')
        .select('invoice_number, po_number')
        .not('invoice_number', 'is', null)
        .not('po_number', 'is', null)
        .order('id')
        .range(from, to),
      'scan stamps',
    );
    const scanPoNumbersByInvoice = new Map<string, Set<string>>();
    for (const s of scans) {
      const inv = String(s.invoice_number || '').trim();
      const po = String(s.po_number || '').trim();
      if (!inv || !po) continue;
      const set = scanPoNumbersByInvoice.get(inv) || new Set<string>();
      set.add(po);
      scanPoNumbersByInvoice.set(inv, set);
    }

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = `${cutoff.getMonth() + 1}/${cutoff.getDate()}/${cutoff.getFullYear()}`;
    const rows = await suiteqlQueryAll(`
      SELECT t.id, t.tranid, t.trandate, t.otherrefnum, t.memo, c.companyname
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.type = 'CustInvc'
        AND t.trandate >= TO_DATE('${cutoffStr}', 'MM/DD/YYYY')
    `);
    const invoices: AuditInvoice[] = rows.map((r: any) => ({
      id: String(r.id ?? ''),
      tranid: String(r.tranid ?? ''),
      trandate: r.trandate ? String(r.trandate).slice(0, 10) : null,
      otherrefnum: r.otherrefnum != null ? String(r.otherrefnum) : null,
      memo: r.memo != null ? String(r.memo) : null,
      customerName: r.companyname != null ? String(r.companyname) : null,
    }));

    const findings = matchInvoicesToPos(invoices, pos, linkedInvoiceIds, scanPoNumbersByInvoice);

    let applied = 0;
    let verify: { posChecked: number; flagged: number; flaggedPos: { poId: string; poNumber: string; problems: string[] }[] } | null = null;
    if (apply && findings.matches.length > 0) {
      for (const m of findings.matches) {
        // Upsert with DO NOTHING, same as the sync sweep — the unique index
        // absorbs a race with the cron linking the same invoice.
        const { data: inserted, error } = await service.from('po_invoices').upsert({
          purchase_order_id: m.poId,
          netsuite_invoice_id: m.invoiceId,
          netsuite_invoice_number: m.invoiceNumber || null,
          memo: `Linked by invoice audit — ${m.detail}${m.trandate ? ` (invoiced ${m.trandate})` : ''}`,
        }, { onConflict: 'purchase_order_id,netsuite_invoice_id', ignoreDuplicates: true }).select('id');
        if (!error && (inserted?.length ?? 0) > 0) applied++;
      }
      // Newly linked billing consumes open quantities and can flip POs to
      // 'attention' — which also fires the super-admin billing alert.
      const affectedPoIds = [...new Set(findings.matches.map(m => m.poId))];
      const result = await verifyPoInvoiceQuantities(service, affectedPoIds);
      verify = { posChecked: result.posChecked, flagged: result.flagged, flaggedPos: result.flaggedPos };
    }

    return NextResponse.json({
      success: true,
      months,
      invoicesInRange: invoices.length,
      alreadyLinked: findings.alreadyLinked,
      unlinkedScanned: findings.scanned,
      matches: findings.matches,
      ambiguous: findings.ambiguous,
      applied,
      verify,
    });
  } catch (err: any) {
    console.error('Invoice audit error:', err);
    return NextResponse.json({ error: err.message || 'Failed to audit invoices' }, { status: 500 });
  }
}
