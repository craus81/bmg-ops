import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { loadQuoteFacts, summarizeQuoteFacts, type QuoteFact } from '@/lib/sales-facts';
import { loadLeadFunnel, loadOutcomeRows, loadLostReasons, summarizeOutcomes } from '@/lib/sales-outcomes';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
    // (the R3-1 MAJOR sweep) rides inside it. The R5-9 sections (funnel /
    // outcomes / lost reasons) gather alongside and fail independently:
    // a broken new tab must never take down the original report.
    const [factsRes, funnelRes, outcomeRes, lostRes] = await Promise.allSettled([
      loadQuoteFacts(service, start, endNext),
      loadLeadFunnel(service, start, endNext),
      loadOutcomeRows(service, start, endNext),
      loadLostReasons(service, start, endNext),
    ]);
    if (factsRes.status === 'rejected') throw factsRes.reason;
    const facts: QuoteFact[] = factsRes.value;
    const sectionErr = (r: PromiseSettledResult<unknown>) =>
      r.status === 'rejected' ? { error: String((r.reason as any)?.message || r.reason).slice(0, 300) } : null;

    // Per-rep rollup.
    const byRep = new Map<string, QuoteFact[]>();
    for (const f of facts) {
      const key = f.repId || 'unassigned';
      const arr = byRep.get(key) || [];
      arr.push(f);
      byRep.set(key, arr);
    }
    const funnel = funnelRes.status === 'fulfilled' ? funnelRes.value : null;
    const repIds = [...new Set([
      ...[...byRep.keys()],
      ...(funnel?.byRep.map(r => r.repId) || []),
    ])].filter(k => k !== 'unassigned');
    const names = new Map<string, string>();
    if (repIds.length > 0) {
      const { data: reps } = await service.from('profiles').select('id, full_name').in('id', repIds);
      for (const r of reps || []) names.set(r.id, r.full_name);
    }
    const repName = (id: string) => id === 'unassigned' ? 'Unassigned' : names.get(id) || 'Unknown';

    const summarize = summarizeQuoteFacts;

    const perRep = [...byRep.entries()]
      .map(([repId, rows]) => ({
        repId,
        repName: repName(repId),
        ...summarize(rows),
      }))
      .sort((a, b) => b.sentValue - a.sentValue);

    const outcomes = outcomeRes.status === 'fulfilled'
      ? {
        estimates: summarizeOutcomes(outcomeRes.value.estimates),
        proofs: summarizeOutcomes(outcomeRes.value.proofs),
      }
      : sectionErr(outcomeRes);

    return NextResponse.json({
      range: { start, end },
      totals: summarize(facts),
      perRep,
      quotes: facts.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || '')),
      funnel: funnel
        ? { ...funnel, byRep: funnel.byRep.map(r => ({ ...r, repName: repName(r.repId) })) }
        : sectionErr(funnelRes),
      outcomes,
      lostReasons: lostRes.status === 'fulfilled' ? lostRes.value : sectionErr(lostRes),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Report failed' }, { status: 500 });
  }
}
