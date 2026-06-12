import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { rolesOf } from '@/lib/cni-access';
import { loadShift, canManageShift } from '@/lib/shifts';

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

  const isAdmin = rolesOf(auth.profile).includes('admin');
  if (!(await canManageShift(service, auth.user.id, shift, isAdmin))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!shift.ended_at) {
    const { error } = await service
      .from('work_shifts')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', shift.id);
    if (error) return NextResponse.json({ error: 'Failed to end shift: ' + error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
