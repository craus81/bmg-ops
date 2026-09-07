import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const WINDOW_DAYS = 180;
const MIN_CUSTOMER_SAMPLES = 3;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * GET /api/vehicle-tracking/turnaround-suggest?customer= (R4-6)
 *
 * A realistic promised-back suggestion for the check-in wizard: median
 * received→complete days over the last 180 days — this customer's own
 * jobs when there are at least 3, the whole shop otherwise. Advisory
 * only; the wizard shows it under the date field, never auto-fills.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const customer = (new URL(req.url).searchParams.get('customer') || '').trim().toLowerCase();

    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const { data: completions, error } = await supabase
      .from('vehicle_status_history')
      .select('vehicle_id, created_at')
      .eq('to_status', 'complete')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) throw new Error(error.message);

    // Ascending scan → earliest completion per vehicle.
    const completedAt = new Map<string, number>();
    for (const c of completions || []) {
      if (!completedAt.has(c.vehicle_id)) completedAt.set(c.vehicle_id, new Date(c.created_at).getTime());
    }

    const ids = [...completedAt.keys()];
    const shopDurations: number[] = [];
    const customerDurations: number[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data: checkins, error: cErr } = await supabase
        .from('fleet_checkins')
        .select('id, created_at, customer_name')
        .in('id', ids.slice(i, i + 200));
      if (cErr) throw new Error(cErr.message);
      for (const c of checkins || []) {
        const days = (completedAt.get(c.id)! - new Date(c.created_at).getTime()) / 86_400_000;
        // Same-day flips and months-long stragglers would skew a "typical" number.
        if (days < 0.25 || days > 60) continue;
        shopDurations.push(days);
        if (customer && (c.customer_name || '').trim().toLowerCase() === customer) {
          customerDurations.push(days);
        }
      }
    }

    if (shopDurations.length === 0) {
      return NextResponse.json({ suggestDays: null, basis: null, samples: 0 });
    }
    const useCustomer = customerDurations.length >= MIN_CUSTOMER_SAMPLES;
    const src = useCustomer ? customerDurations : shopDurations;
    return NextResponse.json({
      suggestDays: Math.max(1, Math.ceil(median(src))),
      basis: useCustomer ? 'customer' : 'shop',
      samples: src.length,
    });
  } catch (err: any) {
    console.error('turnaround-suggest failed:', err);
    return NextResponse.json({ error: err?.message || 'Suggestion failed' }, { status: 500 });
  }
}
