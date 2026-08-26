import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { syncArInvoicePayments } from '@/lib/ar-payment-sync';

export const dynamic = 'force-dynamic';
// SuiteQL round-trips over the unpaid backlog take a while.
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/reports/ar-sync-paid
 *
 * On-demand run of the customer-invoice payment sweep (the same one the
 * netsuite-sync cron runs every 2 hours): flips fleet_checkins/scan_logs
 * is_paid to true for any recorded invoice NetSuite shows Paid In Full.
 * The manual "invoiced, awaiting payment" checkboxes stay a valid override.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const result = await syncArInvoicePayments(service);
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'NetSuite payment check failed' }, { status: 502 });
  }
}
