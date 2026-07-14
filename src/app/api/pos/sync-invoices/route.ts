import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { syncPoInvoices } from '@/lib/po-invoice-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/pos/sync-invoices — manual trigger for the PO-invoice sweep
 * (see syncPoInvoices). The netsuite-sync cron runs the same sweep every
 * couple hours; this button exists for when someone wants it right now.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const result = await syncPoInvoices(service);
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    console.error('Sync invoices error:', err);
    return NextResponse.json({ error: err.message || 'Failed to sync invoices' }, { status: 500 });
  }
}
