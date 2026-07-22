import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { evaluateSystemHealth, recordHeartbeat } from '@/lib/system-health';

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
  // Live write probe: if heartbeat writes are silently failing, every age on
  // this page is frozen at its last landed write and can't be trusted — say
  // so instead of letting the wall of "Stale" tell a false story. The probe
  // row isn't in HEALTH_MONITORS, so it never shows up as a job itself.
  const writeProbe = await recordHeartbeat(service, 'health_probe', { probe: true });
  return NextResponse.json({
    checks,
    writeProbe,
    cronSecretConfigured: !!process.env.CRON_SECRET,
    externalPingConfigured: !!process.env.HEALTH_PING_URL,
    generatedAt: new Date().toISOString(),
  });
}
