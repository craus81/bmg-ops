/**
 * Ending a shift, shared by the Stop/Pause routes. Server-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ShiftRow } from './shifts';
import { maybeNotifyLaborBurn, laborBurnAdminIds } from './labor-burn';
import { notifyMany } from './notify';
import { deepLinks } from './deep-links';

/** End an open shift now. Idempotent: an ended shift is left alone. */
export async function endShiftNow(service: SupabaseClient, shift: ShiftRow): Promise<{ error?: string }> {
  if (shift.ended_at) return {};
  const { error } = await service
    .from('work_shifts')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', shift.id)
    .is('ended_at', null);
  if (error) return { error: error.message };

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
  return {};
}
