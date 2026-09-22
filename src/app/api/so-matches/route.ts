import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Orphan sales-order match review queue (R6-13, audit line 424).
 *
 * GET  — open suggestions, best first, with the order and estimate they
 *        join and the signals behind the score.
 * POST — accept or reject one. ACCEPTING is what actually links the order
 *        to the estimate; the nightly pass only ever suggests. Both
 *        decisions are audited, because a link written from a heuristic
 *        needs a name against it.
 */

const MAX_ROWS = 200;

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { data: suggestions, error } = await service
    .from('so_match_suggestions')
    .select('id, so_id, estimate_id, score, confidence, rationale, signals, text_compared, text_verdict, created_at')
    .eq('status', 'open')
    .order('score', { ascending: false })
    .limit(MAX_ROWS);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = suggestions || [];
  if (rows.length === 0) return NextResponse.json({ suggestions: [] });

  const [{ data: sos }, { data: ests }] = await Promise.all([
    service
      .from('netsuite_sales_orders')
      .select('id, tranid, customer_name, trandate, total, estimate_id')
      .in('id', [...new Set(rows.map(r => r.so_id))]),
    service
      .from('estimates')
      .select('id, estimate_number, netsuite_estimate_number, title, status, grand_total, created_at, netsuite_so_id')
      .in('id', [...new Set(rows.map(r => r.estimate_id))]),
  ]);

  const soById = new Map((sos || []).map(s => [s.id, s]));
  const estById = new Map((ests || []).map(e => [e.id, e]));

  return NextResponse.json({
    suggestions: rows.map(r => {
      const so = soById.get(r.so_id);
      const est = estById.get(r.estimate_id);
      return {
        ...r,
        so: so ? { tranid: so.tranid, customer: so.customer_name, date: so.trandate, total: so.total } : null,
        estimate: est
          ? {
              number: est.netsuite_estimate_number || est.estimate_number,
              title: est.title, status: est.status, total: est.grand_total, createdAt: est.created_at,
            }
          : null,
        // A suggestion whose order or estimate got linked elsewhere since
        // the run is shown as no longer applicable rather than accepted or
        // hidden — the reviewer sees why it left the queue.
        alreadyLinked: !!(so?.estimate_id || est?.netsuite_so_id),
      };
    }),
  });
}

const DecideSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(['accept', 'reject']),
  note: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DecideSchema);
  if (parsed.error) return parsed.error;
  const { id, decision, note } = parsed.data;

  const { data: sug } = await service
    .from('so_match_suggestions')
    .select('id, so_id, estimate_id, status, score, confidence')
    .eq('id', id)
    .maybeSingle();
  if (!sug) return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
  if (sug.status !== 'open') {
    return NextResponse.json({ error: `Already ${sug.status}` }, { status: 409 });
  }

  const now = new Date().toISOString();

  if (decision === 'accept') {
    // Re-check both sides at decision time. The nightly pass read them
    // hours ago and the sync may have linked either since; overwriting a
    // link the sync made from an EXACT signal with one from a heuristic
    // would be a straight downgrade.
    const [{ data: so }, { data: est }] = await Promise.all([
      service.from('netsuite_sales_orders').select('id, netsuite_id, tranid, estimate_id').eq('id', sug.so_id).maybeSingle(),
      service.from('estimates').select('id, netsuite_so_id, netsuite_estimate_number').eq('id', sug.estimate_id).maybeSingle(),
    ]);
    if (!so || !est) return NextResponse.json({ error: 'The order or estimate no longer exists' }, { status: 409 });
    if (so.estimate_id) return NextResponse.json({ error: 'That order is already linked to an estimate' }, { status: 409 });
    if (est.netsuite_so_id) return NextResponse.json({ error: 'That estimate is already linked to a sales order' }, { status: 409 });

    const { error: soErr } = await service
      .from('netsuite_sales_orders')
      // 'suggested' — a person agreed with a score. Not 'memo', which would
      // claim one of the sync's own exact signals fired.
      .update({ estimate_id: sug.estimate_id, match_source: 'suggested' })
      .eq('id', sug.so_id)
      .is('estimate_id', null);
    if (soErr) return NextResponse.json({ error: soErr.message }, { status: 500 });

    // The estimate side, written exactly as the sync writes it: the
    // internal id in netsuite_so_id, the tranid in netsuite_so_number, and
    // status 'accepted' — an order exists for this estimate, so the deal is
    // won, and leaving it in 'sent' is the bug the sync's own backfill
    // exists to avoid. If this half fails the mismatch is REPORTED rather
    // than swallowed; the SO side is the link the reports read.
    const { error: estErr } = await service
      .from('estimates')
      .update({
        netsuite_so_id: String(so.netsuite_id),
        netsuite_so_number: so.tranid || null,
        status: 'accepted',
      })
      .eq('id', sug.estimate_id)
      .is('netsuite_so_id', null);

    // Everything else this order was suggested against is now moot.
    await service
      .from('so_match_suggestions')
      .update({ status: 'superseded', updated_at: now })
      .eq('so_id', sug.so_id)
      .eq('status', 'open')
      .neq('id', id);

    await service
      .from('so_match_suggestions')
      .update({ status: 'accepted', decided_by: auth.user.id, decided_at: now, decision_note: note || null, updated_at: now })
      .eq('id', id);

    await logAudit(service, {
      actorId: auth.user.id,
      table: 'netsuite_sales_orders',
      recordId: sug.so_id,
      action: 'link_estimate',
      detail: {
        source: 'so_matchmaker_suggestion',
        estimateId: sug.estimate_id,
        score: sug.score,
        confidence: sug.confidence,
        note: note || null,
        estimateSideWritten: !estErr,
      },
    });

    return NextResponse.json({
      ok: true,
      linked: true,
      estimateSideWritten: !estErr,
      warning: estErr ? `The order was linked, but the estimate's own sales-order number was not written: ${estErr.message}` : undefined,
    });
  }

  await service
    .from('so_match_suggestions')
    .update({ status: 'rejected', decided_by: auth.user.id, decided_at: now, decision_note: note || null, updated_at: now })
    .eq('id', id);

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'so_match_suggestions',
    recordId: id,
    action: 'reject',
    detail: { soId: sug.so_id, estimateId: sug.estimate_id, score: sug.score, note: note || null },
  });

  return NextResponse.json({ ok: true, linked: false });
}
