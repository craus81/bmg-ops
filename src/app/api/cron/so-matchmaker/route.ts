import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { recordHeartbeat } from '@/lib/system-health';
import { callAnthropicWithRetry } from '@/lib/anthropic';
import {
  rankCandidates, normalizeItems, buildTiebreakPrompt, parseTiebreak,
  TIEBREAK_SYSTEM_PROMPT, DATE_WINDOW_DAYS,
  type MatchSo, type MatchEstimate, type PairScore,
} from '@/lib/so-matchmaker';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Nightly orphan sales-order matchmaker (R6-13, audit line 424).
 *
 * Mirrored SOs with no estimate_id are scored against the open estimates
 * for the SAME NetSuite customer; anything over the floor is written to
 * so_match_suggestions for a person to accept or reject. When the numbers
 * can't separate the top two, Claude compares the free-text line
 * descriptions as a tie-break — and a tie-break that doesn't run is
 * recorded as not-run (text_compared stays false), never implied.
 *
 * This job SUGGESTS. It never writes netsuite_sales_orders.estimate_id or
 * estimates.netsuite_so_id: a wrong automatic link misattributes revenue
 * and nothing downstream would ever surface it.
 */

/** Orders older than this are past the point of anyone reconciling them. */
const LOOKBACK_DAYS = 180;
/** Per-run cap, so one backlog can't blow the function's time budget. */
const MAX_ORDERS = 200;
/** Suggestions kept per order — a person picking from twenty is not helped. */
const MAX_PER_ORDER = 3;
const TIEBREAK_MODEL = 'claude-sonnet-4-6';
/** Tie-breaks per run. Each is an API call; the score stands without one. */
const MAX_TIEBREAKS = 25;
const CHUNK = 200;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const startedAt = Date.now();
  const since = new Date(startedAt - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);

  try {
    // ── Orphan orders ─────────────────────────────────────────────────
    const { data: orphans } = await fetchAllRows<any>((from, to) =>
      service
        .from('netsuite_sales_orders')
        .select('id, tranid, customer_netsuite_id, trandate, total')
        .is('estimate_id', null)
        .gte('trandate', since)
        .order('trandate', { ascending: false })
        .order('id')
        .range(from, to));

    const orders = (orphans || []).filter(o => o.customer_netsuite_id).slice(0, MAX_ORDERS);
    if (orders.length === 0) {
      await recordHeartbeat(service, 'so_matchmaker', { orders: 0, suggestions: 0 }, { startedAt, records: 0 });
      return NextResponse.json({ ok: true, orders: 0, suggestions: 0 });
    }

    const customerIds = [...new Set(orders.map(o => String(o.customer_netsuite_id)))];

    // ── Candidate estimates: same customers, not already converted ────
    // 'draft' is excluded on purpose — an order cannot have come from an
    // estimate that was never sent to anyone.
    const estimates: any[] = [];
    for (let i = 0; i < customerIds.length; i += CHUNK) {
      const { data } = await fetchAllRows<any>((from, to) =>
        service
          .from('estimates')
          .select('id, estimate_number, netsuite_estimate_number, customer_netsuite_id, grand_total, created_at')
          .in('customer_netsuite_id', customerIds.slice(i, i + CHUNK))
          .in('status', ['sent', 'accepted', 'pushed'])
          .is('netsuite_so_id', null)
          .gte('created_at', new Date(startedAt - (LOOKBACK_DAYS + DATE_WINDOW_DAYS) * 86_400_000).toISOString())
          .order('id')
          .range(from, to));
      estimates.push(...(data || []));
    }

    if (estimates.length === 0) {
      await recordHeartbeat(service, 'so_matchmaker', { orders: orders.length, candidates: 0, suggestions: 0 }, { startedAt, records: 0 });
      return NextResponse.json({ ok: true, orders: orders.length, candidates: 0, suggestions: 0 });
    }

    // ── Lines for both sides ──────────────────────────────────────────
    const soLines = new Map<string, { items: string[]; descriptions: string[] }>();
    const estLines = new Map<string, { items: string[]; descriptions: string[] }>();

    const orderIds = orders.map(o => o.id);
    for (let i = 0; i < orderIds.length; i += CHUNK) {
      const { data } = await fetchAllRows<any>((from, to) =>
        service
          .from('netsuite_sales_order_lines')
          .select('so_id, item_number, description')
          .in('so_id', orderIds.slice(i, i + CHUNK))
          .order('id')
          .range(from, to));
      for (const l of data || []) {
        const cur = soLines.get(l.so_id) || { items: [], descriptions: [] };
        if (l.item_number) cur.items.push(l.item_number);
        if (l.description) cur.descriptions.push(String(l.description).slice(0, 200));
        soLines.set(l.so_id, cur);
      }
    }

    const estIds = estimates.map(e => e.id);
    for (let i = 0; i < estIds.length; i += CHUNK) {
      const { data } = await fetchAllRows<any>((from, to) =>
        service
          .from('estimate_line_items')
          .select('estimate_id, item_number, description')
          .in('estimate_id', estIds.slice(i, i + CHUNK))
          .order('id')
          .range(from, to));
      for (const l of data || []) {
        const cur = estLines.get(l.estimate_id) || { items: [], descriptions: [] };
        if (l.item_number) cur.items.push(l.item_number);
        if (l.description) cur.descriptions.push(String(l.description).slice(0, 200));
        estLines.set(l.estimate_id, cur);
      }
    }

    const byCustomer = new Map<string, MatchEstimate[]>();
    for (const e of estimates) {
      const key = String(e.customer_netsuite_id);
      const lines = estLines.get(e.id) || { items: [], descriptions: [] };
      const row: MatchEstimate = {
        id: e.id,
        number: e.netsuite_estimate_number || e.estimate_number || e.id.slice(0, 8),
        customerNetsuiteId: key,
        createdAt: e.created_at,
        total: e.grand_total == null ? null : Number(e.grand_total),
        itemNumbers: normalizeItems(lines.items),
      };
      if (!byCustomer.has(key)) byCustomer.set(key, []);
      byCustomer.get(key)!.push(row);
    }

    // ── Score, tie-break, write ───────────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let tiebreaks = 0;
    let tiebreakSkipped = 0;
    const rows: any[] = [];
    const seenPairs = new Set<string>();
    let ambiguousOrders = 0;

    for (const o of orders) {
      const lines = soLines.get(o.id) || { items: [], descriptions: [] };
      const soRow: MatchSo = {
        id: o.id,
        tranid: o.tranid,
        customerNetsuiteId: String(o.customer_netsuite_id),
        trandate: o.trandate,
        total: o.total == null ? null : Number(o.total),
        itemNumbers: normalizeItems(lines.items),
      };
      const candidates = byCustomer.get(soRow.customerNetsuiteId || '') || [];
      const ranked: PairScore[] = rankCandidates(soRow, candidates).slice(0, MAX_PER_ORDER);
      if (ranked.length === 0) continue;

      // Tie-break only where the numbers actually failed to choose.
      let textCompared = false;
      let verdict: { pick: string | null; why: string } | null = null;
      if (ranked[0].ambiguous) {
        ambiguousOrders++;
        if (apiKey && tiebreaks < MAX_TIEBREAKS) {
          tiebreaks++;
          const numbers = ranked.map(r => candidates.find(c => c.id === r.estimateId)?.number || '');
          try {
            const res = await callAnthropicWithRetry({
              model: TIEBREAK_MODEL,
              max_tokens: 300,
              system: TIEBREAK_SYSTEM_PROMPT,
              messages: [{
                role: 'user',
                content: buildTiebreakPrompt(
                  lines.descriptions,
                  ranked.map(r => {
                    const c = candidates.find(x => x.id === r.estimateId)!;
                    return { number: c.number, descriptions: (estLines.get(c.id)?.descriptions) || [] };
                  }),
                ),
              }],
            }, apiKey, { maxRetries: 1 });
            if (res.ok) {
              const body = await res.json();
              const text = (body?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
              verdict = parseTiebreak(text, numbers.filter(Boolean));
              // Only a real reply counts as "compared". An unparseable one
              // leaves the flag false so nothing claims a comparison ran.
              textCompared = verdict != null;
            }
          } catch {
            // Same: the scores stand, the flag stays false.
          }
        } else {
          tiebreakSkipped++;
        }
      }

      for (const p of ranked) {
        const key = `${p.soId}:${p.estimateId}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const number = candidates.find(c => c.id === p.estimateId)?.number || '';
        const picked = textCompared && verdict?.pick === number;
        rows.push({
          so_id: p.soId,
          estimate_id: p.estimateId,
          score: p.score,
          confidence: p.confidence,
          rationale: p.ambiguous
            ? `${p.rationale} Numbers alone could not separate this from another candidate.`
            : p.rationale,
          signals: { ...p.signals, ambiguous: p.ambiguous, so: soRow.tranid },
          text_compared: p.ambiguous ? textCompared : null,
          text_verdict: p.ambiguous && textCompared
            ? (picked ? `Line descriptions match: ${verdict!.why}` : `Line descriptions did not single this out: ${verdict!.why}`)
            : null,
          updated_at: new Date().toISOString(),
        });
      }
    }

    // Upsert on (so_id, estimate_id): re-running refreshes a suggestion's
    // score rather than piling up duplicates. A row a person already
    // decided is left exactly as they left it — re-suggesting something
    // they rejected last night would make the queue impossible to clear.
    let written = 0;
    if (rows.length > 0) {
      const pairs = rows.map(r => `${r.so_id}:${r.estimate_id}`);
      const decided = new Set<string>();
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { data } = await service
          .from('so_match_suggestions')
          .select('so_id, estimate_id, status')
          .in('so_id', [...new Set(slice.map(r => r.so_id))])
          .neq('status', 'open');
        for (const d of data || []) decided.add(`${d.so_id}:${d.estimate_id}`);
      }
      const fresh = rows.filter((_, i) => !decided.has(pairs[i]));
      for (let i = 0; i < fresh.length; i += CHUNK) {
        const { error } = await service
          .from('so_match_suggestions')
          .upsert(fresh.slice(i, i + CHUNK), { onConflict: 'so_id,estimate_id' });
        if (error) throw error;
        written += fresh.slice(i, i + CHUNK).length;
      }
    }

    await recordHeartbeat(service, 'so_matchmaker', {
      orders: orders.length, candidates: estimates.length, suggestions: written,
      ambiguousOrders, tiebreaks, tiebreaksSkipped: tiebreakSkipped,
    }, { startedAt, records: written });
    return NextResponse.json({
      ok: true,
      orders: orders.length,
      candidates: estimates.length,
      suggestions: written,
      ambiguousOrders,
      tiebreaks,
      // Named rather than hidden: an ambiguous order whose tie-break never
      // ran is still ambiguous, and the queue should say so.
      tiebreaksSkipped: tiebreakSkipped,
      tiebreaksConfigured: !!apiKey,
    });
  } catch (e: any) {
    await recordHeartbeat(service, 'so_matchmaker', { error: e?.message || 'unknown' }, { startedAt });
    return NextResponse.json({ error: e?.message || 'Matchmaker failed' }, { status: 500 });
  }
}
