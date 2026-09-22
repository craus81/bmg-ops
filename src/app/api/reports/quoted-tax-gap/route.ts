import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { summarizeTaxGap, type TaxGapEstimate, type TaxGapLine } from '@/lib/quoted-tax-gap';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ESTIMATE_COLUMNS =
  'id, estimate_number, customer_name, status, tax_rate, tax_exempt, tax_amount, vehicle_count, ' +
  'labor_rate, labor_hours_override, customer_approved, customer_approved_at, sent_for_approval_at, ' +
  'netsuite_estimate_number, created_at, updated_at';

/**
 * GET /api/reports/quoted-tax-gap — estimates whose saved tax is below what
 * today's math gives, the cleanup list for PR #984. All the reasoning lives
 * in src/lib/quoted-tax-gap.ts; this reads the two tables and calls it.
 *
 * Read-only: it recomputes in memory and writes nothing back. Fixing a row is
 * a human act — re-save an unsent quote, talk to the customer about a signed
 * one — so there is deliberately no repair-all here.
 *
 * Both reads paginate. estimate_line_items is well past PostgREST's 1000-row
 * cap, and a silently truncated read would under-report the exposure while
 * looking complete, so a failed page fails the whole report.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data: estimates, error: estError } = await fetchAllRows<TaxGapEstimate>((from, to) =>
    supabase
      .from('estimates')
      .select(ESTIMATE_COLUMNS)
      .order('id')
      .range(from, to) as unknown as PromiseLike<{ data: TaxGapEstimate[] | null; error: { message: string } | null }>,
  );
  if (estError) {
    return NextResponse.json({ error: `Could not read estimates: ${estError.message}` }, { status: 502 });
  }

  const { data: lines, error: lineError } = await fetchAllRows<TaxGapLine>((from, to) =>
    supabase
      .from('estimate_line_items')
      .select('estimate_id, quantity, unit_price')
      .order('id')
      .range(from, to) as unknown as PromiseLike<{ data: TaxGapLine[] | null; error: { message: string } | null }>,
  );
  if (lineError) {
    return NextResponse.json({ error: `Could not read estimate lines: ${lineError.message}` }, { status: 502 });
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    ...summarizeTaxGap(estimates, lines),
  });
}
