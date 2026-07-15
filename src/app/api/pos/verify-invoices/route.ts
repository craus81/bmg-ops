import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { verifyPoInvoiceQuantities } from '@/lib/po-invoice-verify';

export const dynamic = 'force-dynamic';
// One SuiteQL sweep per ~100 invoices plus a per-PO update — comfortably
// inside 60s today, but well past the default ceiling on big PO books.
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/pos/verify-invoices — manual trigger for the invoiced-quantity
 * check (see verifyPoInvoiceQuantities). The netsuite-sync cron runs the
 * same check after each invoice sweep; this button exists for right-now.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const result = await verifyPoInvoiceQuantities(service);
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    console.error('Verify invoices error:', err);
    return NextResponse.json({ error: err.message || 'Failed to verify invoices' }, { status: 500 });
  }
}
