import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface QuoteFact {
  type: 'estimate' | 'wrap';
  repId: string | null;
  customer: string;
  number: string;
  total: number;
  sentAt: string | null;
  outcome: 'won' | 'lost' | 'open';
  decidedAt: string | null;
}

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
    const [estRes, wrapRes] = await Promise.all([
      service
        .from('estimates')
        .select('id, estimate_number, customer_name, grand_total, created_by, status, sent_for_approval_at, customer_approved_at, customer_rejected_at, updated_at, created_at')
        .neq('status', 'draft')
        .or(`and(created_at.gte.${start},created_at.lt.${endNext}),and(sent_for_approval_at.gte.${start},sent_for_approval_at.lt.${endNext})`)
        .limit(2000),
      service
        .from('wrap_quotes')
        .select('id, quote_number, customer, total, created_by, status, sent_at, accepted_at, rejected_at, created_at')
        .neq('status', 'draft')
        .gte('sent_at', start)
        .lt('sent_at', endNext)
        .limit(2000),
    ]);
    if (estRes.error) return NextResponse.json({ error: estRes.error.message }, { status: 500 });
    if (wrapRes.error) return NextResponse.json({ error: wrapRes.error.message }, { status: 500 });

    const inRange = (iso: string | null) => !!iso && iso >= start && iso < endNext;
    const facts: QuoteFact[] = [];

    for (const e of estRes.data || []) {
      const sentAt = e.sent_for_approval_at || e.updated_at;
      if (!inRange(sentAt)) continue;
      const outcome = e.status === 'accepted' || e.status === 'pushed' ? 'won'
        : e.status === 'rejected' ? 'lost' : 'open';
      facts.push({
        type: 'estimate',
        repId: e.created_by,
        customer: e.customer_name || '—',
        number: e.estimate_number,
        total: Number(e.grand_total) || 0,
        sentAt,
        outcome,
        decidedAt: outcome === 'won' ? (e.customer_approved_at || e.updated_at)
          : outcome === 'lost' ? (e.customer_rejected_at || e.updated_at) : null,
      });
    }
    for (const w of wrapRes.data || []) {
      const outcome = w.status === 'accepted' ? 'won' : w.status === 'rejected' ? 'lost' : 'open';
      facts.push({
        type: 'wrap',
        repId: w.created_by,
        customer: (w.customer as any)?.name || '—',
        number: w.quote_number,
        total: Number(w.total) || 0,
        sentAt: w.sent_at,
        outcome,
        decidedAt: outcome === 'won' ? w.accepted_at : outcome === 'lost' ? w.rejected_at : null,
      });
    }

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

    const summarize = (rows: QuoteFact[]) => {
      const sentCount = rows.length;
      const sentValue = rows.reduce((s, f) => s + f.total, 0);
      const won = rows.filter(f => f.outcome === 'won');
      const lost = rows.filter(f => f.outcome === 'lost');
      const open = rows.filter(f => f.outcome === 'open');
      const decided = won.length + lost.length;
      const closeDays = won
        .map(f => f.sentAt && f.decidedAt ? (new Date(f.decidedAt).getTime() - new Date(f.sentAt).getTime()) / 86_400_000 : null)
        .filter((d): d is number => d != null && d >= 0);
      return {
        sentCount,
        sentValue,
        wonCount: won.length,
        wonValue: won.reduce((s, f) => s + f.total, 0),
        lostCount: lost.length,
        lostValue: lost.reduce((s, f) => s + f.total, 0),
        openCount: open.length,
        openValue: open.reduce((s, f) => s + f.total, 0),
        winRate: decided > 0 ? won.length / decided : null,
        avgDaysToClose: closeDays.length > 0 ? closeDays.reduce((a, b) => a + b, 0) / closeDays.length : null,
      };
    };

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
