import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireSuperAdmin } from '@/lib/api-auth';
import { computeBusinessPulse } from '@/lib/business-pulse';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/** The Business Pulse card on the Dashboard — super admins only (owner, 2026-10-22). */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json(await computeBusinessPulse(service));
  } catch (e: any) {
    console.error('business pulse failed:', e);
    return NextResponse.json({ error: e?.message || 'Business pulse failed' }, { status: 500 });
  }
}
