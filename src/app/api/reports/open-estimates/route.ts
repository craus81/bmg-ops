import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { shopWorkMs } from '@/lib/shop-hours';
import { summarizeOpenEstimates, type OpenEstimateSource } from '@/lib/open-estimates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createServiceClient();

const ESTIMATE_COLUMNS =
  'id, estimate_number, netsuite_estimate_number, title, customer_name, grand_total, status, created_by, ' +
  'created_at, updated_at, sent_for_approval_at, last_followup_at, customer_approved, customer_approved_at, ' +
  'netsuite_so_id, internal_review_status, internal_reviewer_id, internal_review_requested_by, ' +
  'internal_review_requested_at, internal_review_decided_at, internal_review_note';

/**
 * GET /api/reports/open-estimates — every estimate still waiting on someone,
 * bucketed by where it is stuck (src/lib/open-estimates.ts). Read-only.
 *
 * Finished estimates (sales order, lost) are filtered in the query so the
 * read stays small; it still paginates, since a truncated read would hide
 * exactly the old, forgotten rows this report exists to surface.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data: estimates, error } = await fetchAllRows<OpenEstimateSource>((from, to) =>
    supabase
      .from('estimates')
      .select(ESTIMATE_COLUMNS)
      .is('netsuite_so_id', null)
      .neq('status', 'rejected')
      .order('id')
      .range(from, to) as unknown as PromiseLike<{ data: OpenEstimateSource[] | null; error: { message: string } | null }>,
  );
  if (error) {
    return NextResponse.json({ error: `Could not read estimates: ${error.message}` }, { status: 502 });
  }

  const report = summarizeOpenEstimates(estimates, Date.now(), shopWorkMs);

  const ids = [...new Set(report.rows.flatMap(r => [r.repId, r.reviewerId]).filter((x): x is string => !!x))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data: people } = await supabase.from('profiles').select('id, full_name, email').in('id', ids);
    for (const p of people || []) names[p.id] = p.full_name || p.email || 'Unknown';
  }

  return NextResponse.json({ generatedAt: new Date().toISOString(), ...report, names });
}
