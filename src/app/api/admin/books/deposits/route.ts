import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { copyNetSuiteDeposits } from '@/lib/books/netsuite-deposits';

export const dynamic = 'force-dynamic';
// "Copy now" runs the same job as the cron, with the same budget.
export const maxDuration = 300;

const COPY_BUDGET_MS = 240_000;

/**
 * POST /api/admin/books/deposits — copy NetSuite's customer deposits and
 * deposit applications now rather than wait for the two-hourly run
 * (/api/cron/books-netsuite-deposits). Same job, same record of how it
 * went; the response says only how the run went, and the invoices page's
 * Deposits switch reloads the rest.
 *
 * Super admins and the bookkeeper; the CPA only reads (docs/books.md "Who can
 * open the books").
 */
export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;

  const result = await copyNetSuiteDeposits(createServiceClient(), { deadline: Date.now() + COPY_BUDGET_MS });
  return NextResponse.json({ copy: result.error ? 'failed' : result.partial ? 'partial' : 'ok' });
}
