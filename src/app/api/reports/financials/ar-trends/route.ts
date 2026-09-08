import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFinancials } from '@/lib/api-auth';
import { loadArTrends } from '@/lib/ar-trends';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/financials/ar-trends (R5-6): DSO now (live A/R ÷ daily
 * trailing-12 revenue), the nightly aging-snapshot series (accrues from the
 * R5-1 capture ship date), slowest payers by median days-to-pay (sweep-
 * noticed dates, labeled), and payments posted this week (RESTlet
 * collections mode — carries the redeploy hint until deployed). Sections
 * fail independently.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  try {
    const trends = await loadArTrends(service);
    return NextResponse.json(trends);
  } catch (e: any) {
    console.error('ar-trends failed:', e);
    return NextResponse.json({ error: e?.message || 'A/R trends failed' }, { status: 500 });
  }
}
