import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { z } from '@/lib/validate';
import { loadFrozenQuotes, summarizeQuotedMargins } from '@/lib/quoted-margin-report';
import { getMarginFloorPct } from '@/lib/quoted-margin';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Query = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * GET /api/reports/quoted-margin?start=&end= (R5-10): frozen-at-send margin
 * ledger — by rep, by customer, by month, distribution vs each row's own
 * frozen floor, and the below-floor sends with who/when/why. Reads only
 * migration 275's snapshot columns, so the report shows exactly what was
 * offered, not what today's costs would say. Same audience as the other
 * margin reports (admin|sales).
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const parsed = Query.safeParse({ start: searchParams.get('start'), end: searchParams.get('end') });
  if (!parsed.success) {
    return NextResponse.json({ error: 'start and end are required as YYYY-MM-DD' }, { status: 400 });
  }
  const { start, end } = parsed.data;
  const endNext = new Date(new Date(end + 'T00:00:00Z').getTime() + 86_400_000).toISOString().slice(0, 10);

  try {
    const [rows, currentFloor] = await Promise.all([
      loadFrozenQuotes(service, start, endNext),
      getMarginFloorPct(service),
    ]);
    const summary = summarizeQuotedMargins(rows);

    // Names for the by-rep rollup and the below-floor who/when list.
    const senderIds = [...new Set([
      ...summary.byRep.map(r => r.senderId),
      ...summary.belowFloorList.map(r => r.senderId || ''),
    ])].filter(id => id && id !== 'unknown');
    const names = new Map<string, string>();
    if (senderIds.length > 0) {
      const { data: profiles } = await service.from('profiles').select('id, full_name').in('id', senderIds);
      for (const p of profiles || []) names.set(p.id, p.full_name || 'Unknown');
    }

    return NextResponse.json({
      range: { start, end },
      currentFloor,
      totals: summary.totals,
      byRep: summary.byRep.map(r => ({
        ...r,
        repName: r.senderId === 'unknown' ? 'Unknown' : names.get(r.senderId) || 'Unknown',
      })),
      byCustomer: summary.byCustomer,
      byMonth: summary.byMonth,
      distribution: summary.distribution,
      belowFloor: summary.belowFloorList.map(r => ({
        ...r,
        senderName: (r.senderId && names.get(r.senderId)) || 'Unknown',
      })),
    });
  } catch (e: any) {
    console.error('quoted-margin report failed:', e);
    return NextResponse.json({ error: e.message || 'Report failed' }, { status: 500 });
  }
}
