import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { syncVendorBillPayments, syncPayoutBillPayments } from '@/lib/vendor-bill-sync';

export const dynamic = 'force-dynamic';
// SuiteQL round-trips for a large billed backlog take a while.
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/vendor-invoices/sync-paid
 *
 * On-demand run of the NetSuite vendor-bill payment sweep (the same one the
 * netsuite-sync cron runs every 2 hours): flips billed invoices whose bill
 * NetSuite shows Paid In Full to 'paid' and sends the paid notifications.
 * Powers the "Check NetSuite" button on the AP queue's Awaiting Payment tab.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['finance']);
  if (auth.error) return auth.error;

  try {
    const result = await syncVendorBillPayments(service);
    // Installer payouts share the sweep (R5-13a) — the button checks both.
    const payouts = await syncPayoutBillPayments(service);
    return NextResponse.json({
      success: true,
      ...result,
      checked: result.checked + payouts.checked,
      paid: result.paid + payouts.paid,
      errors: [...result.errors, ...payouts.errors],
      payouts,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'NetSuite payment check failed' }, { status: 502 });
  }
}
