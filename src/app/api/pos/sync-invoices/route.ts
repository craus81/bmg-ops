import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/pos/sync-invoices — link every NetSuite invoice that carries a
 * PO number to that PO, regardless of where the invoice was created.
 *
 * FleetSuite-created invoices are recorded in po_invoices at creation time,
 * but invoices entered directly in NetSuite never were. Both stamp the PO
 * number into the invoice's Reference No. (otherrefnum), so a SuiteQL sweep
 * by that field finds them all; anything not already linked gets a
 * po_invoices row. Safe to run repeatedly.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const { data: pos, error: posErr } = await service
      .from('purchase_orders')
      .select('id, po_number');
    if (posErr) {
      return NextResponse.json({ error: 'Failed to load POs: ' + posErr.message }, { status: 500 });
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
    const linked = new Set((existing || []).map(r => `${r.purchase_order_id}|${r.netsuite_invoice_id}`));

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
          if (linked.has(key)) continue;
          const { error } = await service.from('po_invoices').insert({
            purchase_order_id: poId,
            netsuite_invoice_id: String(inv.id),
            netsuite_invoice_number: inv.tranid || null,
            memo: `Synced from NetSuite${inv.trandate ? ` — invoiced ${String(inv.trandate).slice(0, 10)}` : ''}`,
          });
          if (!error) {
            linked.add(key);
            added++;
          }
        }
      }
    }

    return NextResponse.json({ success: true, posScanned: numbers.length, invoicesFound: found, linked: added });
  } catch (err: any) {
    console.error('Sync invoices error:', err);
    return NextResponse.json({ error: err.message || 'Failed to sync invoices' }, { status: 500 });
  }
}
