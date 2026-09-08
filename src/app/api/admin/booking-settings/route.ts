import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { loadBookingSettings, saveBookingSettings, sanitizeBookingSettings } from '@/lib/booking';

export const dynamic = 'force-dynamic';

/**
 * Booking settings (R5-17): business days/hours, slot length, per-day cap,
 * lead time, and blocked dates for the customer pickup/drop-off pages.
 * Admin read AND write — this is day-to-day ops config (blocking a holiday
 * shouldn't need the owner), unlike the financial settings next door.
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
  return NextResponse.json(await loadBookingSettings(getSupabase()));
}

const UpdateSchema = z.object({
  enabled: z.boolean(),
  businessDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  slotMinutes: z.number().int(),
  maxPerDay: z.number().int().min(1).max(50),
  leadDays: z.number().int().min(0).max(30),
  horizonDays: z.number().int().min(7).max(60),
  blockedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100),
});

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;

  const supabase = getSupabase();
  const settings = sanitizeBookingSettings(parsed.data);
  try {
    await saveBookingSettings(supabase, settings);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Save failed' }, { status: 500 });
  }
  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'app_settings',
    recordId: 'booking_settings',
    action: 'booking_settings_changed',
    detail: settings as any,
  });
  return NextResponse.json(settings);
}
