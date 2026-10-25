import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { loadStaffCalendar } from '@/lib/shop-staff';

export const dynamic = 'force-dynamic';

/**
 * Staff calendar (migration 442): the roster of people who do the work and
 * the days they'll be out. Admin read and write — the page at
 * /admin/staff-calendar is the only client; Shop Week reads the same
 * tables server-side for capacity.
 *
 * GET ?start=YYYY-MM-DD&end=YYYY-MM-DD (end exclusive, at most ~3 months)
 * POST { action: 'save_staff' | 'remove_staff' | 'set_off' | 'clear_off', … }
 */

const service = createServiceClient();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const p = req.nextUrl.searchParams;
  const start = p.get('start') || '';
  const end = p.get('end') || '';
  if (!DAY.test(start) || !DAY.test(end) || end <= start) {
    return NextResponse.json({ error: 'start and end (YYYY-MM-DD) are required' }, { status: 400 });
  }
  if (Date.parse(end) - Date.parse(start) > 100 * 86_400_000) {
    return NextResponse.json({ error: 'Range too long' }, { status: 400 });
  }
  try {
    return NextResponse.json(await loadStaffCalendar(service, start, end));
  } catch (e: any) {
    console.error('staff calendar load failed:', e);
    return NextResponse.json({ error: 'Failed to load the staff calendar' }, { status: 500 });
  }
}

const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save_staff'),
    id: z.string().uuid().optional(), // omitted = new person
    name: z.string().trim().min(1).max(80),
    department: z.enum(['upfit', 'graphics_install']),
    hoursPerDay: z.number().min(0).max(24),
    workDays: z.array(z.number().int().min(1).max(7)).max(7),
    active: z.boolean().optional(),
  }),
  z.object({ action: z.literal('remove_staff'), id: z.string().uuid() }),
  z.object({
    action: z.literal('set_off'),
    staffId: z.string().uuid(),
    day: z.string().regex(DAY),
    /** null = the whole day. */
    hours: z.number().gt(0).max(24).nullable(),
    note: z.string().max(200).optional(),
  }),
  z.object({ action: z.literal('clear_off'), staffId: z.string().uuid(), day: z.string().regex(DAY) }),
]);

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const stamp = new Date().toISOString();

  if (body.action === 'save_staff') {
    const row = {
      name: body.name,
      department: body.department,
      hours_per_day: body.hoursPerDay,
      work_days: [...new Set(body.workDays)].sort(),
      active: body.active ?? true,
      updated_at: stamp,
    };
    const { data, error } = body.id
      ? await service.from('shop_staff').update(row).eq('id', body.id).select('id').maybeSingle()
      : await service.from('shop_staff').insert(row).select('id').single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
    await logAudit(service, {
      actorId: auth.user.id, table: 'shop_staff', recordId: data.id,
      action: body.id ? 'shop_staff_updated' : 'shop_staff_added', detail: row,
    });
    return NextResponse.json({ ok: true, id: data.id });
  }

  if (body.action === 'remove_staff') {
    // Hard delete: the roster is a planning list, not a payroll record, and
    // the cascade takes their time-off rows with them.
    const { error } = await service.from('shop_staff').delete().eq('id', body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logAudit(service, { actorId: auth.user.id, table: 'shop_staff', recordId: body.id, action: 'shop_staff_removed' });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'set_off') {
    const { error } = await service.from('staff_time_off').upsert({
      staff_id: body.staffId,
      day: body.day,
      hours: body.hours,
      note: body.note?.trim() || null,
      created_by: auth.user.id,
    }, { onConflict: 'staff_id,day' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logAudit(service, {
      actorId: auth.user.id, table: 'staff_time_off', recordId: `${body.staffId}:${body.day}`,
      action: 'staff_time_off_set', detail: { hours: body.hours, note: body.note || null },
    });
    return NextResponse.json({ ok: true });
  }

  const { error } = await service.from('staff_time_off').delete().eq('staff_id', body.staffId).eq('day', body.day);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logAudit(service, {
    actorId: auth.user.id, table: 'staff_time_off', recordId: `${body.staffId}:${body.day}`, action: 'staff_time_off_cleared',
  });
  return NextResponse.json({ ok: true });
}
