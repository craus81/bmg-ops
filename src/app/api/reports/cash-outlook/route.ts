import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFinancials } from '@/lib/api-auth';
import { loadCashOutlook } from '@/lib/cash-outlook';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/cash-outlook (R6-12)
 *
 * Four weeks forward: expected collections placed at the date each customer
 * actually pays, minus vendor bills at their due dates, approved payouts,
 * and a payroll run-rate, over a balance that starts at the real bank
 * total. Bank balances and the whole payables side make this
 * financials-only, same wall as the Financials tab.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  try {
    return NextResponse.json(await loadCashOutlook(supabase));
  } catch (err: any) {
    console.error('cash-outlook report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
