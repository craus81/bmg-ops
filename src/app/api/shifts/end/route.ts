import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { rolesOf } from '@/lib/cni-access';
import { loadShift, canManageShift } from '@/lib/shifts';
import { maybeNotifyLaborBurn, laborBurnAdminIds } from '@/lib/labor-burn';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({ shiftId: z.string().uuid() });

/** End a shift. Idempotent — ending an already-ended shift is a no-op. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const shift = await loadShift(service, parsed.data.shiftId);
  if (!shift) return NextResponse.json({ error: 'Shift not found' }, { status: 404 });

  const isAdmin = isAdminRole(rolesOf(auth.profile));
  if (!(await canManageShift(service, auth.user.id, shift, isAdmin))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!shift.ended_at) {
    const { error } = await service
      .from('work_shifts')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', shift.id);
    if (error) return NextResponse.json({ error: 'Failed to end shift: ' + error.message }, { status: 500 });

    // Labor burn meter (R6-12): stopping the timer is the moment the hours
    // become real, so it is the moment to check them against the hours
    // sold. Fires once per visit and never throws — a notification problem
    // must not fail the tech's Stop button.
    if (shift.context === 'shop' && shift.fleet_checkin_id) {
      await maybeNotifyLaborBurn(service, shift.fleet_checkin_id, {
        notifyMany,
        adminIds: () => laborBurnAdminIds(service),
        pickListUrl: (vin, checkinId) => deepLinks.pickList(vin, checkinId),
      });
    }
  }
  return NextResponse.json({ success: true });
}
