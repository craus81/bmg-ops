import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Shop crew capacity (R5-16): crew size × shift hours = the week planner's
 * daily denominator, on the quote_settings singleton like the labor rate;
 * plus per-day hour overrides (holiday, short crew) in
 * shop_capacity_overrides. Reading is admin (the planner itself reads
 * capacity through /api/shop-week, staff-wide); writing is super-admin,
 * matching the labor-rate precedent — it recolors every load bar.
 */

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data } = await getSupabase()
    .from('quote_settings')
    .select('shop_crew_size, shop_shift_hours')
    .eq('id', 1)
    .maybeSingle();
  return NextResponse.json({
    crewSize: data?.shop_crew_size != null ? Number(data.shop_crew_size) : null,
    shiftHours: data?.shop_shift_hours != null ? Number(data.shop_shift_hours) : null,
  });
}

const UpdateSchema = z.union([
  z.object({
    /** Both null clears the setting (planner shows demand without judging). */
    crewSize: z.number().int().min(0).max(200).nullable(),
    shiftHours: z.number().min(0).max(24).nullable(),
  }),
  z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Hours for that day; null removes the override (back to base). */
    hours: z.number().min(0).max(2000).nullable(),
    note: z.string().max(200).optional(),
  }),
]);

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;
  const supabase = getSupabase();

  if ('day' in parsed.data) {
    const { day, hours, note } = parsed.data;
    if (hours == null) {
      const { error } = await supabase.from('shop_capacity_overrides').delete().eq('day', day);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      const { error } = await supabase.from('shop_capacity_overrides').upsert({
        day,
        hours,
        note: note || null,
        updated_by: auth.user.id,
        updated_at: new Date().toISOString(),
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'shop_capacity_overrides',
      recordId: day,
      action: hours == null ? 'capacity_override_cleared' : 'capacity_override_set',
      detail: { day, hours, note: note || null },
    });
    return NextResponse.json({ ok: true });
  }

  const { crewSize, shiftHours } = parsed.data;
  const { data: before } = await supabase
    .from('quote_settings')
    .select('shop_crew_size, shop_shift_hours')
    .eq('id', 1)
    .maybeSingle();
  const { error } = await supabase.from('quote_settings').upsert({
    id: 1,
    shop_crew_size: crewSize,
    shop_shift_hours: shiftHours,
    updated_at: new Date().toISOString(),
    updated_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'quote_settings',
    recordId: '1',
    action: 'shop_capacity_changed',
    detail: {
      from: { crewSize: before?.shop_crew_size ?? null, shiftHours: before?.shop_shift_hours != null ? Number(before.shop_shift_hours) : null },
      to: { crewSize, shiftHours },
    },
  });
  return NextResponse.json({ crewSize, shiftHours });
}
