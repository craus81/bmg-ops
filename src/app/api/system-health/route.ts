import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { evaluateSystemHealth } from '@/lib/system-health';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** Current health of every background job, for the admin System Health page. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const checks = await evaluateSystemHealth(service);
  return NextResponse.json({
    checks,
    cronSecretConfigured: !!process.env.CRON_SECRET,
    generatedAt: new Date().toISOString(),
  });
}
