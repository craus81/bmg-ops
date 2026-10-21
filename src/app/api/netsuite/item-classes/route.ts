import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/netsuite/item-classes — NetSuite's active classes (id + name,
 * "Parent : Child" for sub-classes), for the Create Part form's required
 * Class dropdown (Craig 2026-10-21). Read from the copy the books keep of
 * NetSuite's lists (gl_netsuite_lists, refreshed every two hours), so the
 * form doesn't wait on SuiteQL. That table is service-role only, hence this
 * route rather than a browser read.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('gl_netsuite_lists')
    .select('netsuite_id, name, details')
    .eq('kind', 'class')
    .eq('active', true)
    .is('gone_at', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const classes = (data || [])
    .map((r: { netsuite_id: string; name: string; details: { full_name?: string } | null }) => ({
      id: String(r.netsuite_id),
      name: r.details?.full_name || r.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ classes });
}
