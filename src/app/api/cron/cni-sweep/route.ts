import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { getCompanyInstallerIds } from '@/lib/cni-access';
import { sweepCompliance } from '@/lib/cni-compliance';
import { sweepInviteSla } from '@/lib/invite-sla';
import { suggestNextCompany } from '@/lib/cni-next-company';
import { cniStaffIds } from '@/lib/cni-staff';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The ONE daily CNI sweep (R6-8).
 *
 * The audit's own note on this cluster was that the CNI items should share a
 * single cron rather than each growing its own — five separate morning jobs
 * hitting the same three tables is five things to keep alive and five
 * chances to double-notify the same installer. Passes run in order and each
 * one's failure is contained, so a broken pass never silences the others.
 *
 * Pass 1 — compliance: warn about insurance running out, one rung at a time.
 * Pass 2 — invite SLA: re-ping unanswered invites once, alert on no takers.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  if (!secret || authHeader !== `Bearer ${secret}`) {
    const admin = await requireAdmin(req);
    if (admin.error) return admin.error;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const passes: Record<string, unknown> = {};
  let failed = 0;

  try {
    passes.compliance = await sweepCompliance(supabase, {
      notify: async (userIds, payload) => {
        await notifyMany(userIds, {
          type: payload.type,
          title: payload.title,
          body: payload.body,
          url: payload.url,
          channels: ['in_app', 'push', 'email'],
          ...(payload.force ? { forceChannels: true } : {}),
        });
      },
      companyInstallers: (companyId) => getCompanyInstallerIds(supabase, companyId),
      staffIds: () => cniStaffIds(supabase),
      installerProfileUrl: deepLinks.installerProfile(),
      consoleUrl: deepLinks.cniCompliance(),
    });
  } catch (e: any) {
    failed++;
    passes.compliance = { error: String(e?.message || e).slice(0, 300) };
    console.error('cni-sweep compliance pass failed:', e);
  }

  try {
    passes.inviteSla = await sweepInviteSla(supabase, {
      notify: async (userIds, payload) => {
        await notifyMany(userIds, {
          type: payload.type,
          title: payload.title,
          body: payload.body,
          url: payload.url,
          channels: ['in_app', 'push', 'email'],
          ...(payload.force ? { forceChannels: true } : {}),
        });
      },
      companyInstallers: (companyId) => getCompanyInstallerIds(supabase, companyId),
      staffIds: () => cniStaffIds(supabase),
      installerJobUrl: (jobId) => deepLinks.installerAvailableJob(jobId),
      adminJobUrl: (jobId) => deepLinks.cniJob(jobId),
      suggestNext: (jobId, alreadyInvited) => suggestNextCompany(supabase, jobId, alreadyInvited),
    });
  } catch (e: any) {
    failed++;
    passes.inviteSla = { error: String(e?.message || e).slice(0, 300) };
    console.error('cni-sweep invite SLA pass failed:', e);
  }

  const syncStateWrite = await recordHeartbeat(supabase, 'cni_sweep', { passes, failed });
  // A partial failure is reported, not swallowed: the health check reads the
  // heartbeat meta, and a 200 with a failed pass inside would look healthy.
  return NextResponse.json({ success: failed === 0, passes, syncStateWrite }, { status: failed === 0 ? 200 : 500 });
}
