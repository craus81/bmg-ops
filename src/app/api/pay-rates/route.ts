import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { priceUnpricedCredits } from '@/lib/pay-credits';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET: rate list plus the needs-pricing queue (parts that have unpriced
 * credits because vehicles were scanned before a rate existed).
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { data: rates } = await service
    .from('install_pay_rates')
    .select('id, part_number, rate_per_vehicle, active, updated_at')
    .order('part_number');

  const { data: unpriced } = await service
    .from('install_credits')
    .select('part_number')
    .is('amount', null)
    .is('voided_at', null);
  const counts = new Map<string, number>();
  for (const c of unpriced || []) {
    if (!c.part_number) continue;
    counts.set(c.part_number, (counts.get(c.part_number) || 0) + 1);
  }

  return NextResponse.json({
    rates: rates || [],
    needsPricing: [...counts.entries()].map(([part_number, credits]) => ({ part_number, credits })),
  });
}

const PostSchema = z.object({
  partNumber: z.string().trim().min(1).max(120),
  ratePerVehicle: z.number().nonnegative().max(100000),
  active: z.boolean().optional(),
});

/**
 * Upsert a rate (admin). Setting a rate also fills in any unpriced credits
 * for that part — crew tracking never blocked on pricing, money catches up.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { partNumber, ratePerVehicle } = parsed.data;

  // Read the current rate first: the audit log records the change, and an
  // update must not clobber the original created_by.
  const { data: existing } = await service
    .from('install_pay_rates')
    .select('id, rate_per_vehicle, active')
    .eq('part_number', partNumber)
    .maybeSingle();

  const { error } = existing
    ? await service
        .from('install_pay_rates')
        .update({
          rate_per_vehicle: ratePerVehicle,
          active: parsed.data.active ?? true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
    : await service
        .from('install_pay_rates')
        .insert({
          part_number: partNumber,
          rate_per_vehicle: ratePerVehicle,
          active: parsed.data.active ?? true,
          created_by: auth.user.id,
          updated_at: new Date().toISOString(),
        });
  if (error) return NextResponse.json({ error: 'Failed to save rate: ' + error.message }, { status: 500 });

  const priced = await priceUnpricedCredits(service, partNumber, ratePerVehicle);

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'install_pay_rates',
    recordId: partNumber,
    action: existing ? 'rate_change' : 'rate_create',
    detail: {
      before: existing ? { rate_per_vehicle: Number(existing.rate_per_vehicle), active: existing.active } : null,
      after: { rate_per_vehicle: ratePerVehicle, active: parsed.data.active ?? true },
      pricedCredits: priced.ok ? priced.priced : 0,
    },
  });

  if (!priced.ok) {
    return NextResponse.json({ error: priced.error, pricedCredits: priced.priced }, { status: 500 });
  }
  return NextResponse.json({ success: true, pricedCredits: priced.priced });
}
