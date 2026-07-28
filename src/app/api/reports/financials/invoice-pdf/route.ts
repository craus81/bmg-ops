import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { getNetSuitePdf } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/financials/invoice-pdf?id=<NetSuite internal id>
 *
 * Invoice PDF for the financials drill-down. Mirrors /api/netsuite/pdf but
 * gated by requireFinancials instead of requireStaff — the `executive` role
 * can see the Financials tab yet is not internal staff, so it would 403 on
 * the staff route and couldn't print invoices from the A/R drill-down.
 *
 * Response matches /api/netsuite/pdf: { success, pdfBase64?, filename?, error? }.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const id = req.nextUrl.searchParams.get('id') || '';
  if (!/^\d{1,15}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Invalid invoice id' }, { status: 400 });
  }

  try {
    const result = await getNetSuitePdf('invoice', id);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || 'PDF fetch failed' }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'PDF fetch failed' }, { status: 500 });
  }
}
