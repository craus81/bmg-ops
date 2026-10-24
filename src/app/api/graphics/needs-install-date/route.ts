import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { INSTALLED_DELIVERY_METHODS, isInstallScheduler, needsInstallDate } from '@/lib/install-scheduling';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * GET /api/graphics/needs-install-date — Home's "Needs install date" list
 * for whoever books installs (notification_preferences.schedules_installs,
 * migration 430: Jessie). Approved jobs we install, onsite or at our shop,
 * with no install date yet; a job drops off as soon as its date is set.
 * Anyone without the tick gets an empty list, so Home renders nothing.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!(await isInstallScheduler(service, auth.user.id))) {
    return NextResponse.json({ scheduler: false, jobs: [], total: 0 });
  }
  const { data, error } = await service.from('graphics_jobs')
    .select('id, job_number, title, customer, status, delivery_method, scheduled_install_date, customer_approved, customer_approved_at')
    .eq('customer_approved', true)
    .in('delivery_method', [...INSTALLED_DELIVERY_METHODS])
    .is('scheduled_install_date', null)
    .order('customer_approved_at', { ascending: true, nullsFirst: false }).order('id')
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data || []).filter(needsInstallDate);
  return NextResponse.json({
    scheduler: true,
    jobs: rows.slice(0, 15).map(j => ({
      id: j.id,
      label: j.title || j.job_number || 'Graphics job',
      customer: j.customer,
      onSite: j.delivery_method === 'onsite_install',
      approvedAt: j.customer_approved_at,
    })),
    total: rows.length,
  });
}
