import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { copyNetSuiteBillPayments } from '@/lib/books/netsuite-bill-payments';

export const dynamic = 'force-dynamic';
// "Copy now" runs the same job as the cron, with the same budget.
export const maxDuration = 300;

const COPY_BUDGET_MS = 240_000;

/**
 * POST /api/admin/books/bill-payments — copy NetSuite's bill payments now
 * rather than wait for the two-hourly run
 * (/api/cron/books-netsuite-bill-payments). Same job, same record of how it
 * went; the response says only how the run went, and the invoices page's
 * Bill payments switch reloads the rest.
 *
 * Super admins and the bookkeeper; the CPA only reads (docs/books.md "Who can
 * open the books").
 */
export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;

  const result = await copyNetSuiteBillPayments(createServiceClient(), { deadline: Date.now() + COPY_BUDGET_MS });
  return NextResponse.json({ copy: result.error ? 'failed' : result.partial ? 'partial' : 'ok' });
}
