import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { getDefaultLaborRate } from '@/lib/labor-rate';

export const dynamic = 'force-dynamic';

/**
 * The company default labor rate (Settings -> Default Labor Rate): the
 * $/hour new estimates sell labor at (migration 330).
 *
 * Reading is staff-wide -- the quote builders start from it. Writing is
 * super-admin only, here and in the database trigger, matching the sales
 * tax rate. Every change is written to audit_log with the old and new value.
 */

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const rate = await getDefaultLaborRate(getSupabase());
  return NextResponse.json({ rate });
}

const UpdateSchema = z.object({
  /** $/hour. */
  rate: z.number().min(0).max(1000),
});

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;

  // Cents, matching the numeric(10,2) column and what the documents print.
  const rate = Math.round(parsed.data.rate * 100) / 100;

  const supabase = getSupabase();
  const previous = await getDefaultLaborRate(supabase);

  const { error } = await supabase.from('quote_settings').upsert({
    id: 1,
    default_labor_rate: rate,
    updated_at: new Date().toISOString(),
    updated_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'quote_settings',
    recordId: '1',
    action: 'default_labor_rate_changed',
    detail: { from: previous, to: rate },
  });

  return NextResponse.json({ rate });
}
