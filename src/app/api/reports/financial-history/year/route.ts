import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFinancials } from '@/lib/api-auth';
import { loadYearDetail } from '@/lib/financial-history-detail';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reports/financial-history/year?year=YYYY
 *
 * One Financial History year taken apart for cross-checking: each system's
 * monthly revenue side by side, invoices per month, QuickBooks' own yearly
 * P&L, and the year by account (src/lib/financial-history-detail.ts). Reads
 * stored data only. Same wall as the report itself (super_admin / executive).
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const year = Number(req.nextUrl.searchParams.get('year'));
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    return NextResponse.json({ error: 'year (YYYY) required' }, { status: 400 });
  }
  try {
    return NextResponse.json(await loadYearDetail(createServiceClient(), year));
  } catch (err: any) {
    console.error('financial-history year detail failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
