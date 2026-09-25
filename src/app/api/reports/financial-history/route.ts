import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFinancials } from '@/lib/api-auth';
import { loadFinancialHistory } from '@/lib/financial-history';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/financial-history
 *
 * Monthly P&L across both systems: QuickBooks before the cutover, NetSuite
 * from it (src/lib/financial-history.ts). Same wall as the Financials P&L it
 * extends backwards (super_admin / executive).
 *
 * NetSuite months not cached yet are fetched one at a time inside a 40 s
 * budget; `netsuitePending` > 0 tells the page to ask again for the rest.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  try {
    return NextResponse.json(await loadFinancialHistory(createServiceClient(), { budgetMs: 40_000 }));
  } catch (err: any) {
    console.error('financial-history report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
