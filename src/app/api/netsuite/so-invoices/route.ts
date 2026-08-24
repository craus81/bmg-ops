import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/so-invoices?soId=12345
 *
 * The customer invoices billed FROM a sales order (transaction.createdfrom),
 * straight from NetSuite — so it sees invoices created in NetSuite AND ones
 * FleetSuite raised via the SO→invoice transform, with no sync lag. Drives
 * the In-Shop record's "invoice replaces the sales order once billed"
 * behavior: an invoiced SO is basically dead paper, the invoice is what
 * staff need to open.
 *
 * Returns { invoices: [{ id, tranid, trandate, total, status }] } — empty
 * array when nothing has been billed yet.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const soIdRaw = req.nextUrl.searchParams.get('soId')?.trim() || '';
  if (!/^\d{1,15}$/.test(soIdRaw)) {
    return NextResponse.json({ error: 'soId must be a NetSuite internal id' }, { status: 400 });
  }

  const query = `
    SELECT
      t.id,
      t.tranid,
      t.trandate,
      t.foreigntotal AS total,
      BUILTIN.DF(t.status) AS status_label
    FROM transaction t
    WHERE t.type = 'CustInvc'
    AND t.createdfrom = ${soIdRaw}
    ORDER BY t.trandate DESC, t.id DESC
  `;

  try {
    const result = await suiteqlQuery(query);
    const invoices = (result?.items || []).map((r: any) => ({
      id: r.id?.toString(),
      tranid: r.tranid || r.id?.toString(),
      trandate: r.trandate || null,
      total: parseFloat(r.total) || 0,
      status: r.status_label || null,
    }));
    return NextResponse.json({ invoices });
  } catch (err: any) {
    console.error('SO invoice lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}
