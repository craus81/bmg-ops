import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';
import { getCustomerPaymentsFromRestlet } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/customer-payments?customerId=<NetSuite internal id>
 *
 * Payments received + credit memos for one customer, newest first — sourced
 * from the financials RESTlet because the SuiteQL integration role cannot
 * see CustPymt records. Amounts are returned as magnitudes; dates as ISO.
 *
 * Response: { success, transactions: [{ id, tranid, date, type: 'payment' |
 * 'credit', amount, memo }] } or { success: false, error } (200 — the UI
 * shows the RESTlet-redeploy hint instead of a hard failure).
 */

function toIso(d: string): string | null {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const customerId = safeIntId(req.nextUrl.searchParams.get('customerId'), 'customerId');
    const result = await getCustomerPaymentsFromRestlet(customerId, 50);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || 'Payments unavailable' });
    }
    const transactions = (result.transactions || []).map(t => ({
      id: t.id,
      tranid: t.tranid,
      date: toIso(t.date),
      type: t.type === 'CustCred' ? 'credit' : 'payment',
      amount: Math.abs(t.amount),
      memo: t.memo,
    }));
    return NextResponse.json({ success: true, transactions });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message || 'Failed to fetch payments' }, { status: 500 });
  }
}
