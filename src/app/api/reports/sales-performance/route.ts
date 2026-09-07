import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { loadQuoteFacts, summarizeQuoteFacts, type QuoteFact } from '@/lib/sales-facts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);


const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sales performance from timestamps the quote flows already capture:
 * quotes sent in the range, what they turned into, how fast, per rep.
 * Won = accepted (or pushed to NetSuite, which only happens on real
 * orders); lost = rejected; open = still sitting at sent.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const startParam = req.nextUrl.searchParams.get('start') || '';
  const endParam = req.nextUrl.searchParams.get('end') || '';
  const end = DATE_RE.test(endParam) ? endParam : new Date().toISOString().slice(0, 10);
  const start = DATE_RE.test(startParam) ? startParam
    : new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  // End-exclusive next day so timestamps late on the end date count.
  const endNext = new Date(new Date(end + 'T00:00:00Z').getTime() + 86_400_000).toISOString().slice(0, 10);

  try {
    // Fact building lives in src/lib/sales-facts.ts (R4-4) — shared with
    // the CEO view's Sales band so the two can never disagree. Pagination
    // (the R3-1 MAJOR sweep) rides inside it.
    const facts: QuoteFact[] = await loadQuoteFacts(service, start, endNext);

    // Per-rep rollup.
    const byRep = new Map<string, QuoteFact[]>();
    for (const f of facts) {
      const key = f.repId || 'unassigned';
      const arr = byRep.get(key) || [];
      arr.push(f);
      byRep.set(key, arr);
    }
    const repIds = [...byRep.keys()].filter(k => k !== 'unassigned');
    const names = new Map<string, string>();
    if (repIds.length > 0) {
      const { data: reps } = await service.from('profiles').select('id, full_name').in('id', repIds);
      for (const r of reps || []) names.set(r.id, r.full_name);
    }

    const summarize = summarizeQuoteFacts;

    const perRep = [...byRep.entries()]
      .map(([repId, rows]) => ({
        repId,
        repName: repId === 'unassigned' ? 'Unassigned' : names.get(repId) || 'Unknown',
        ...summarize(rows),
      }))
      .sort((a, b) => b.sentValue - a.sentValue);

    return NextResponse.json({
      range: { start, end },
      totals: summarize(facts),
      perRep,
      quotes: facts.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || '')),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Report failed' }, { status: 500 });
  }
}
