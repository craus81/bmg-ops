import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { evaluateSystemHealth, recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

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

  // The Email delivery section: every outbound email (email_log, written by
  // the send layer), newest first. 100 rows covers days at current volume;
  // the page filters problems client-side.
  const { data: emails } = await service
    .from('email_log')
    .select('id, kind, recipients, subject, sent_by, context_url, delivery_status, delivery_detail, delivery_updated_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  return NextResponse.json({
    checks,
    writeProbe,
    emails: emails || [],
    cronSecretConfigured: !!process.env.CRON_SECRET,
    externalPingConfigured: !!process.env.HEALTH_PING_URL,
    generatedAt: new Date().toISOString(),
  });
}
