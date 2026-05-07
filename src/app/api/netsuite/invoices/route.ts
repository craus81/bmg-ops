import { NextRequest, NextResponse } from 'next/server';
import { suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';
import { safeIntId, safeLikeTerm, SqlSafeError } from '@/lib/sql-safe';
import { validateSearchParams, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  customerId: z.string().regex(/^\d{1,18}$/, 'customerId must be a positive integer'),
  q: z.string().trim().max(80, 'q too long').optional(),
});

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, QuerySchema);
  if (parsed.error) return parsed.error;
  const { customerId: customerIdRaw, q: rawSearch } = parsed.data;

  try {
    const customerId = safeIntId(customerIdRaw, 'customerId');

    let searchFilter = '';
    if (rawSearch) {
      const term = safeLikeTerm(rawSearch);
      searchFilter = `AND (
        UPPER(t.tranid) LIKE UPPER('%${term}%') ESCAPE '\\'
        OR UPPER(t.memo) LIKE UPPER('%${term}%') ESCAPE '\\'
      )`;
    }

    const query = `
      SELECT
        t.id,
        t.tranid AS invoice_number,
        t.trandate AS invoice_date,
        t.status,
        t.memo
      FROM transaction t
      WHERE t.type = 'CustInvc'
        AND t.entity = ${customerId}
        ${searchFilter}
      ORDER BY t.trandate DESC
      FETCH FIRST 50 ROWS ONLY
    `;

    const statusMap: Record<string, string> = {
      'A': 'Open',
      'B': 'Paid In Full',
    };

    const result = await suiteqlQuery(query);
    const invoices = (result?.items || []).map((row: any) => ({
      id: row.id,
      invoiceNumber: row.invoice_number || '',
      date: row.invoice_date || '',
      status: statusMap[row.status] || row.status || '',
      memo: row.memo || '',
    }));

    return NextResponse.json({ invoices, count: invoices.length });
  } catch (err: any) {
    if (err instanceof SqlSafeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('Invoice search error:', err);
    return NextResponse.json({ error: err.message || 'Failed to fetch invoices' }, { status: 500 });
  }
}
