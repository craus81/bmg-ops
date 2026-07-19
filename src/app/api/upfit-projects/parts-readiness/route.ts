import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { computePartsReadiness } from '@/lib/parts-readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/upfit-projects/parts-readiness?id=<projectId>
 * Per-part needed / reserved / free / on-order math for the project's
 * sales order — see src/lib/parts-readiness.ts.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const projectId = req.nextUrl.searchParams.get('id');
  if (!projectId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const readiness = await computePartsReadiness(service, projectId);
  if (!readiness.available && readiness.reason === 'not_found') {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  return NextResponse.json(readiness);
}
