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

const Schema = z.object({
  shiftId: z.string().uuid(),
  partNumber: z.string().trim().max(120).optional().nullable(),
  partDescription: z.string().trim().max(300).optional().nullable(),
  billableCustomer: z.string().trim().max(200).optional().nullable(),
});

/**
 * Switch the part the crew is scanning under, mid-shift (CNI field-shift model,
 * docs/cni-redesign.md §1.2 / §1.3). The part is held on the open work_shift;
 * vehicles completed after the change bill under the new part — already-logged
 * scans keep the part they were logged with. Pass a null partNumber to clear it
 * (vehicles then land "needs part" in the Scan Log instead of vanishing).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const shift = await loadShift(service, parsed.data.shiftId);
  if (!shift) return NextResponse.json({ error: 'Shift not found' }, { status: 404 });
  if (shift.context !== 'cni') {
    return NextResponse.json({ error: 'Only CNI shifts pick a part this way' }, { status: 400 });
  }
  if (shift.ended_at) {
    return NextResponse.json({ error: 'This shift has ended' }, { status: 409 });
  }

  const isAdmin = rolesOf(auth.profile).includes('admin');
  if (!(await canManageShift(service, auth.user.id, shift, isAdmin))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { error } = await service
    .from('work_shifts')
    .update({
      part_number: parsed.data.partNumber || null,
      part_description: parsed.data.partDescription || null,
      billable_customer: parsed.data.billableCustomer || null,
    })
    .eq('id', shift.id);
  if (error) return NextResponse.json({ error: 'Failed to set the part: ' + error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
