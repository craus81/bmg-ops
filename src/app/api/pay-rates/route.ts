import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { priceUnpricedCredits } from '@/lib/pay-credits';
import { logAudit } from '@/lib/audit';
import { canonicalizePartNumber, partNumberPattern } from '@/lib/part-number';
import { fetchAllRows } from '@/lib/fetch-all';

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

  // Paginated: unpriced credits accumulate unboundedly, and rows past the
  // 1000-row cap would vanish from the needs-pricing queue unseen.
  const { data: unpriced } = await fetchAllRows<{
    part_number: string | null; source: string; vin: string | null; cni_job_vin_id: string | null;
  }>((from, to) => service
    .from('install_credits')
    .select('part_number, source, vin, cni_job_vin_id')
    .is('amount', null)
    .is('voided_at', null)
    .order('id')
    .range(from, to));

  // Field credits price from install_pay_rates — that's this screen's queue.
  // CNI credits price from their job's pay_per_vehicle, and credits with no
  // part number can't match a rate at all; both used to vanish from this
  // response entirely and accumulate unseen.
  const counts = new Map<string, number>();
  const noPart: { vin: string | null; source: string }[] = [];
  const cniVinIds: string[] = [];
  let cniCount = 0;
  for (const c of unpriced || []) {
    if (c.source === 'cni') {
      cniCount++;
      if (c.cni_job_vin_id) cniVinIds.push(c.cni_job_vin_id);
      continue;
    }
    if (!c.part_number) {
      noPart.push({ vin: c.vin || null, source: c.source });
      continue;
    }
    counts.set(c.part_number, (counts.get(c.part_number) || 0) + 1);
  }

  // Which CNI jobs are the unpriced credits sitting on? (Fixed by setting
  // pay-per-vehicle on the job, not by a rate here.)
  const cniJobs = new Map<string, string>();
  if (cniVinIds.length > 0) {
    for (let i = 0; i < cniVinIds.length; i += 200) {
      const { data: vins } = await service
        .from('cni_job_vins')
        .select('id, job:cni_jobs(id, job_number, title)')
        .in('id', cniVinIds.slice(i, i + 200));
      for (const v of vins || []) {
        const job = Array.isArray(v.job) ? v.job[0] : v.job;
        if (job) cniJobs.set(job.id, job.title || job.job_number || job.id.slice(0, 8));
      }
    }
  }

  return NextResponse.json({
    rates: rates || [],
    needsPricing: [...counts.entries()].map(([part_number, credits]) => ({ part_number, credits })),
    noPartCredits: { count: noPart.length, vins: noPart.slice(0, 20).map(n => n.vin).filter(Boolean) },
    cniUnpriced: { count: cniCount, jobs: [...cniJobs.entries()].map(([id, label]) => ({ id, label })) },
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
  const { ratePerVehicle } = parsed.data;
  // Case never matters for part numbers: store the catalog's casing, and
  // match any existing rate row case-insensitively so "06u166" updates the
  // "06U166" rate instead of creating a duplicate.
  const partNumber = (await canonicalizePartNumber(service, parsed.data.partNumber))!;

  // Read the current rate first: the audit log records the change, and an
  // update must not clobber the original created_by.
  const { data: existingRows } = await service
    .from('install_pay_rates')
    .select('id, rate_per_vehicle, active')
    .ilike('part_number', partNumberPattern(partNumber))
    .limit(1);
  const existing = existingRows?.[0] || null;

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
