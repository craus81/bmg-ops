import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { computePartsReadinessBoard } from '@/lib/parts-readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/upfit-projects/readiness-board — parts-readiness verdicts for a
 * board's worth of projects at once (R3-12), from synced data only. The
 * per-project GET (parts-readiness) stays the live/authoritative view for
 * the detail panel; this feeds the card chips.
 */
const Schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const service = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const readiness = await computePartsReadinessBoard(service, parsed.data.ids);
    return NextResponse.json({ readiness });
  } catch (err: any) {
    console.error('readiness-board failed:', err);
    return NextResponse.json({ error: err?.message || 'Failed to compute readiness' }, { status: 500 });
  }
}
