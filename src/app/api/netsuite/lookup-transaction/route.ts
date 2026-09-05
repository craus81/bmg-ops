import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { safeStringLiteral, SqlSafeError } from '@/lib/sql-safe';

/**
 * GET /api/netsuite/lookup-transaction?tranid=SO123&type=salesOrder
 * Looks up a sales order, estimate, or invoice by its tranid (the
 * human-readable number).
 * type: 'salesOrder' | 'estimate' | 'invoice' | 'any' (default 'any' searches
 * sales orders and estimates — the upfit-project link flow; 'invoice' is
 * explicit, used to open a stamped invoice number's PDF).
 * Returns id, tranid, type, customer, total — enough to link to an upfit project.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const tranid = req.nextUrl.searchParams.get('tranid')?.trim();
  const type = (req.nextUrl.searchParams.get('type') || 'any').toLowerCase();

  if (!tranid) {
    return NextResponse.json({ error: 'tranid required' }, { status: 400 });
  }

  const typeFilter =
    type === 'salesorder' ? `t.type = 'SalesOrd'` :
    type === 'estimate' ? `t.type = 'Estimate'` :
    type === 'invoice' ? `t.type = 'CustInvc'` :
    `t.type IN ('SalesOrd', 'Estimate')`;

  let safeTranid: string;
  try {
    safeTranid = safeStringLiteral(tranid, 60);
  } catch (err: any) {
    if (err instanceof SqlSafeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const query = `
    SELECT
      t.id,
      t.tranid,
      t.type,
      t.entity AS customer_id,
      c.companyname AS customer_name,
      c.entityid AS customer_entityid,
      t.total,
      t.status,
      t.trandate
    FROM transaction t
    LEFT JOIN customer c ON t.entity = c.id
    WHERE ${typeFilter}
    AND UPPER(t.tranid) = UPPER('${safeTranid}')
    ORDER BY t.trandate DESC
  `;

  try {
    const result = await suiteqlQuery(query);
    const items = result?.items || [];

    if (items.length === 0) {
      return NextResponse.json({
        found: false,
        error: `No ${type === 'invoice' ? 'invoice' : 'sales order or estimate'} found with number "${tranid}"`,
      }, { status: 404 });
    }

    const row = items[0];
    const matchType = row.type === 'Estimate' ? 'estimate' : row.type === 'CustInvc' ? 'invoice' : 'salesOrder';

    return NextResponse.json({
      found: true,
      match: {
        id: row.id,
        tranid: row.tranid,
        type: matchType,
        typeLabel: matchType === 'estimate' ? 'Estimate' : matchType === 'invoice' ? 'Invoice' : 'Sales Order',
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        customer_entityid: row.customer_entityid,
        total: parseFloat(row.total) || 0,
        status: row.status,
        trandate: row.trandate,
      },
    });
  } catch (err: any) {
    console.error('NetSuite lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}
