import { NextRequest, NextResponse } from 'next/server';
import { requireMoney } from '@/lib/api-auth';
import { fetchOpenArInvoices, computeArAging } from '@/lib/financials-data';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/ar-summary — what customers owe us, in three numbers, for
 * the Financial Dashboard focus (owner decision 2026-10-24: Harold's
 * Dashboard "very simple and focused"). Same open-invoice read and aging
 * buckets as the Past Due page and the Financials A/R card, so the three
 * never disagree. Billing figures only, so the money gate.
 */
export async function GET(req: NextRequest) {
  const auth = await requireMoney(req);
  if (auth.error) return auth.error;

  try {
    const { invoices } = await fetchOpenArInvoices();
    const aging = computeArAging(invoices);
    return NextResponse.json({
      outstanding: aging.total,
      pastDue: aging.pastDue,
      over60: aging.buckets.d61_90 + aging.buckets.d90plus,
      openCount: aging.openCount,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not read A/R from NetSuite' }, { status: 502 });
  }
}
