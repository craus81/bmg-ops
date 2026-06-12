import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { rolesOf } from '@/lib/cni-access';
import { loadShift, canManageShift, eligibleMemberIds, memberViews } from '@/lib/shifts';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  shiftId: z.string().uuid(),
  add: z.array(z.object({
    profileId: z.string().uuid(),
    weight: z.number().positive().max(99).optional(),
  })).max(50).default([]),
  remove: z.array(z.string().uuid()).max(50).default([]),
  setWeight: z.array(z.object({
    profileId: z.string().uuid(),
    weight: z.number().positive().max(99),
  })).max(50).default([]),
});

/**
 * Tag/untag crew or change weights mid-shift. Anyone currently on the shift
 * (or its starter, or an admin) can do this. Changes only affect vehicles
 * completed AFTER the change — already-snapshotted credits are untouched
 * (admin corrections go through the credit editor instead).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { shiftId, add, remove, setWeight } = parsed.data;

  const shift = await loadShift(service, shiftId);
  if (!shift) return NextResponse.json({ error: 'Shift not found' }, { status: 404 });
  if (shift.ended_at) return NextResponse.json({ error: 'Shift has ended' }, { status: 400 });

  const isAdmin = rolesOf(auth.profile).includes('admin');
  if (!(await canManageShift(service, auth.user.id, shift, isAdmin))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const current = await memberViews(service, shiftId);
  const currentIds = new Set(current.map(m => m.profile_id));

  if (add.length > 0) {
    const eligible = await eligibleMemberIds(service, shift);
    const toAdd = add.filter(m => !currentIds.has(m.profileId));
    for (const m of toAdd) {
      if (!eligible.has(m.profileId)) {
        return NextResponse.json({ error: 'One or more crew members are not eligible for this shift' }, { status: 400 });
      }
    }
    if (toAdd.length > 0) {
      const { error } = await service.from('work_shift_members').insert(
        toAdd.map(m => ({
          shift_id: shiftId,
          profile_id: m.profileId,
          share_weight: m.weight ?? 1,
          added_by: auth.user.id,
        })),
      );
      if (error) return NextResponse.json({ error: 'Failed to add crew: ' + error.message }, { status: 500 });
      for (const m of toAdd) currentIds.add(m.profileId);
    }
  }

  if (remove.length > 0) {
    const removeSet = new Set(remove);
    const remaining = [...currentIds].filter(id => !removeSet.has(id));
    if (remaining.length === 0) {
      return NextResponse.json({ error: 'A shift needs at least one member — end the shift instead' }, { status: 400 });
    }
    const { error } = await service
      .from('work_shift_members')
      .update({ removed_at: new Date().toISOString() })
      .eq('shift_id', shiftId)
      .in('profile_id', remove)
      .is('removed_at', null);
    if (error) return NextResponse.json({ error: 'Failed to remove crew: ' + error.message }, { status: 500 });
  }

  for (const w of setWeight) {
    const { error } = await service
      .from('work_shift_members')
      .update({ share_weight: w.weight })
      .eq('shift_id', shiftId)
      .eq('profile_id', w.profileId)
      .is('removed_at', null);
    if (error) return NextResponse.json({ error: 'Failed to update weight: ' + error.message }, { status: 500 });
  }

  return NextResponse.json({ members: await memberViews(service, shiftId) });
}
