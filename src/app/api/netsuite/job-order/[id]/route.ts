import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { jobOrderLinesFromRows, stripStatusPrefix, type JobOrderData } from '@/lib/job-order';
import { createServiceClient } from '@/lib/supabase-service';
import { END_USER_FIELD, normalizeEndUser } from '@/lib/end-user';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/netsuite/job-order/[id]
 *
 * Everything a Job Order (a sales order printed as a pick ticket, no
 * pricing) shows: the SO header and its lines, read live from NetSuite.
 * Never selects rate, amount or total. See src/lib/job-order.ts.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const soId = params.id;
  if (!soId || !/^\d+$/.test(soId)) {
    return NextResponse.json({ error: 'Invalid sales order id' }, { status: 400 });
  }

  try {
    const headerRes = await suiteqlQuery(`
      SELECT
        t.id, t.tranid, t.trandate, t.otherrefnum, t.memo,
        t.custbody_vin_number_ AS vin,
        BUILTIN.DF(t.status) AS status_label,
        c.companyname AS customer_name
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.id = ${soId}
        AND t.type = 'SalesOrd'
    `);
    const h = headerRes?.items?.[0];
    if (!h) {
      return NextResponse.json({ error: 'Sales order not found in NetSuite' }, { status: 404 });
    }

    // Nice-to-have header fields go in their own queries, so a field this
    // account doesn't expose costs that field, not the whole printout.
    const [extraRes, shipToRes, linesRes, endUserRes, vendorPos] = await Promise.all([
      suiteqlQuery(`
        SELECT t.shipdate, BUILTIN.DF(t.shipmethod) AS ship_method, BUILTIN.DF(t.employee) AS sales_rep
        FROM transaction t WHERE t.id = ${soId}
      `).catch(() => null),
      suiteqlQuery(`
        SELECT sa.addrtext
        FROM transaction t
        INNER JOIN transactionshippingaddress sa ON sa.nkey = t.shippingaddress
        WHERE t.id = ${soId}
      `).catch(() => null),
      suiteqlQuery(`
        SELECT
          i.itemid       AS part_number,
          i.displayname  AS display_name,
          i.itemtype     AS item_type,
          tl.memo        AS description,
          tl.quantity    AS quantity
        FROM transactionline tl
        LEFT JOIN item i ON i.id = tl.item
        WHERE tl.transaction = ${soId}
          AND tl.mainline = 'F'
          AND tl.taxline = 'F'
        ORDER BY tl.linesequencenumber
      `),
      suiteqlQuery(`SELECT t.${END_USER_FIELD} AS end_user FROM transaction t WHERE t.id = ${soId}`).catch(() => null),
      vendorPosForSo(soId).catch(() => []),
    ]);
    const extra = extraRes?.items?.[0] || {};
    const shipTo = String(shipToRes?.items?.[0]?.addrtext || '').trim() || null;

    const data: JobOrderData = {
      id: String(h.id),
      soNumber: h.tranid || String(h.id),
      orderDate: h.trandate || null,
      customer: h.customer_name || null,
      poNumber: h.otherrefnum || null,
      endUser: normalizeEndUser(endUserRes?.items?.[0]?.end_user) || null,
      vendorPos,
      vin: h.vin || null,
      memo: h.memo || null,
      status: stripStatusPrefix(h.status_label),
      salesRep: extra.sales_rep || null,
      shipDate: extra.shipdate || null,
      shipMethod: extra.ship_method || null,
      shipTo,
      lines: jobOrderLinesFromRows(linesRes?.items || []),
    };
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'NetSuite query failed' }, { status: 500 });
  }
}

/** The vendor POs linked to this order's job (upfit_project_pos), oldest first. */
async function vendorPosForSo(soId: string): Promise<{ number: string; vendor: string | null }[]> {
  const supabase = createServiceClient();
  const { data: projects } = await supabase.from('upfit_projects').select('id').eq('netsuite_so_id', soId);
  const ids = ((projects || []) as any[]).map(p => p.id);
  if (ids.length === 0) return [];
  const { data: links } = await supabase.from('upfit_project_pos')
    .select('po_number, created_at, po:netsuite_vendor_pos(tranid, vendor_name)')
    .in('project_id', ids)
    .order('created_at', { ascending: true });
  const seen = new Set<string>();
  const out: { number: string; vendor: string | null }[] = [];
  for (const l of (links || []) as any[]) {
    const number = String(l.po?.tranid || l.po_number || '').trim();
    if (!number || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, vendor: l.po?.vendor_name || null });
  }
  return out;
}
