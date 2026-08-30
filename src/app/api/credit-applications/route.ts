import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

interface ListRow {
  id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  requested_terms: string | null;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
  prospect_id: string | null;
}

/**
 * GET /api/credit-applications — the review queue's list. Summary columns
 * ONLY: tax_id and the bank fields leave the server solely through the
 * per-id detail route, so the whole queue's EINs aren't shipped to the
 * browser on page load. Migration 237 made the table service-role-only;
 * this feature gate (finance/admin/super_admin by default) is the read
 * boundary.
 *
 * fetchAllRows because the table is written by an unauthenticated public
 * endpoint: past 1000 rows a bare select would silently drop the OLDEST
 * rows — i.e. real pending applications would vanish from the queue.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'credit_applications');
  if (auth.error) return auth.error;

  const { data, error } = await fetchAllRows<ListRow>((from, to) =>
    service
      .from('credit_applications')
      .select('id, company_name, contact_name, contact_email, requested_terms, status, submitted_at, reviewed_at, prospect_id')
      .order('submitted_at', { ascending: false })
      .order('id')
      .range(from, to) as any,
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ applications: data });
}
