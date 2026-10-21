import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { copyEstimate } from '@/lib/estimate-copy';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

/**
 * POST /api/estimates/[id]/duplicate — copy an estimate (header + lines)
 * into a fresh draft (Round 3 roadmap R3-17).
 *
 * Plain copy or revision is decided server-side from the source's state —
 * no body needed. The copy rules live in src/lib/estimate-copy.ts, shared
 * with the fleet "Copy for more vehicles" route.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  try {
    const { status, body } = await copyEstimate(supabase, params.id, auth.user.id);
    return NextResponse.json(body, { status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
