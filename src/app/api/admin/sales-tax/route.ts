import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { getSalesTaxRatePct } from '@/lib/sales-tax';

export const dynamic = 'force-dynamic';

/**
 * The company sales tax rate (Settings -> Sales Tax).
 *
 * Reading is staff-wide -- the estimate and wrap builders show the rate.
 * Writing is super-admin only, both here and in the database (migration 245
 * guards the column with a trigger), because the rate drives what every
 * customer is billed and it used to be a free-text box on every estimate.
 * Every change is written to audit_log with the old and new value.
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

  const pct = await getSalesTaxRatePct(getSupabase());
  return NextResponse.json({ sales_tax_rate_pct: pct });
}

const UpdateSchema = z.object({
  // Percent, matching what the settings form shows (7.95 = 7.95%).
  sales_tax_rate_pct: z.union([z.number(), z.string()]),
});

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;

  const pct = Number(parsed.data.sales_tax_rate_pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return NextResponse.json({ error: 'Sales tax rate must be between 0 and 100 percent.' }, { status: 400 });
  }
  // Two decimals is what the documents render; storing more would make the
  // saved rate and the printed rate disagree.
  const rounded = Math.round(pct * 100) / 100;

  const supabase = getSupabase();
  const previous = await getSalesTaxRatePct(supabase);

  const { error } = await supabase.from('quote_settings').upsert({
    id: 1,
    sales_tax_rate_pct: rounded,
    updated_at: new Date().toISOString(),
    updated_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'quote_settings',
    recordId: '1',
    action: 'sales_tax_rate_changed',
    detail: { from_pct: previous, to_pct: rounded },
  });

  return NextResponse.json({ sales_tax_rate_pct: rounded });
}
