import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { fromDateString } from '@/lib/payroll';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Field credits in [start, endExclusive) — the biweekly payroll window. */
async function periodCredits(start: string, endExclusive: string) {
  const { data } = await service
    .from('install_credits')
    .select('id, profile_id, vin, part_number, rate_per_vehicle, share_weight, crew_size, amount, payout_id, created_at')
    .eq('source', 'field')
    .is('voided_at', null)
    .gte('created_at', fromDateString(start).toISOString())
    .lt('created_at', fromDateString(endExclusive).toISOString())
    .order('created_at');
  return data || [];
}

const GetSchema = z.object({ start: dateStr, endExclusive: dateStr });

/**
 * Payroll report for one period: every field credit with the earner's name,
 * plus per-person totals. Field workers are W-2 payroll — these are never
 * NetSuite-billed; the report (CSV on the client) goes to payroll.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;

  const credits = await periodCredits(q.data.start, q.data.endExclusive);
  const profileIds = [...new Set(credits.map(c => c.profile_id))];
  const { data: profiles } = profileIds.length
    ? await service.from('profiles').select('id, full_name').in('id', profileIds)
    : { data: [] as { id: string; full_name: string }[] };
  const names = new Map((profiles || []).map(p => [p.id, p.full_name]));

  return NextResponse.json({
    credits: credits.map(c => ({
      ...c,
      amount: c.amount != null ? Number(c.amount) : null,
      profile_name: names.get(c.profile_id) || 'Unknown',
    })),
  });
}

const PostSchema = z.object({
  action: z.literal('mark_paid'),
  start: dateStr,
  endExclusive: dateStr,
});

/**
 * Mark a period paid: one payroll_period payout per person covering their
 * unlocked credits in the window, which locks those credits against
 * recompute. Refuses while unpriced credits remain (price them first at
 * /admin/pay-rates) so nobody gets shorted silently.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { start, endExclusive } = parsed.data;

  const credits = await periodCredits(start, endExclusive);
  const open = credits.filter(c => !c.payout_id);
  if (open.length === 0) {
    return NextResponse.json({ error: 'Nothing to pay — all credits in this period are already on a payout' }, { status: 400 });
  }
  const unpriced = open.filter(c => c.amount == null);
  if (unpriced.length > 0) {
    const parts = [...new Set(unpriced.map(c => c.part_number || '(no part)'))].join(', ');
    return NextResponse.json({
      error: `${unpriced.length} credit${unpriced.length === 1 ? ' is' : 's are'} unpriced (${parts}) — set rates at /admin/pay-rates first`,
    }, { status: 400 });
  }

  const byPerson = new Map<string, typeof open>();
  for (const c of open) {
    const arr = byPerson.get(c.profile_id) || [];
    arr.push(c);
    byPerson.set(c.profile_id, arr);
  }

  const inclusiveEnd = new Date(fromDateString(endExclusive));
  inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
  const periodEnd = inclusiveEnd.toISOString().slice(0, 10);

  let payoutCount = 0;
  for (const [profileId, rows] of byPerson) {
    const total = rows.reduce((s, c) => s + Number(c.amount), 0);
    const { data: payout, error } = await service
      .from('payouts')
      .insert({
        profile_id: profileId,
        kind: 'payroll_period',
        period_start: start,
        period_end: periodEnd,
        total_amount: Math.round(total * 100) / 100,
        status: 'paid',
        approved_by: auth.user.id,
        approved_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error || !payout) {
      return NextResponse.json({ error: 'Failed to create payout: ' + (error?.message || 'unknown'), payoutsCreated: payoutCount }, { status: 500 });
    }
    const { error: linkErr } = await service
      .from('install_credits')
      .update({ payout_id: payout.id })
      .in('id', rows.map(c => c.id));
    if (linkErr) {
      return NextResponse.json({ error: 'Failed to link credits: ' + linkErr.message, payoutsCreated: payoutCount }, { status: 500 });
    }
    payoutCount++;
  }

  return NextResponse.json({ success: true, payoutsCreated: payoutCount, creditsPaid: open.length });
}
