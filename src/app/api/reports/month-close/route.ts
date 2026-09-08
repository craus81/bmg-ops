import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import {
  loadMonthClose, computeFindings, resolveGate, closeVerdict,
  monthBounds, periodFor, PERIOD_RE, CLOSE_GATES, GATE_BY_KEY,
  type GateSignoff,
} from '@/lib/month-close';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const bad = (msg: string, status = 400) => NextResponse.json({ error: msg }, { status });

/**
 * GET /api/reports/month-close?period=YYYY-MM (R6-12)
 *
 * The month-end close cockpit's gates. A closed month renders from the
 * snapshot frozen at close time; an open one recomputes.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['executive']);
  if (auth.error) return auth.error;

  const period = req.nextUrl.searchParams.get('period') || periodFor();
  if (!PERIOD_RE.test(period)) return bad('period must be YYYY-MM');

  try {
    return NextResponse.json(await loadMonthClose(supabase, period));
  } catch (err: any) {
    console.error('month-close report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}

/**
 * POST /api/reports/month-close — sign off a gate, close a month, reopen
 * one, or mark a bounced money email resolved.
 *
 * `close` re-evaluates every gate SERVER-SIDE before stamping: the client's
 * idea of readiness is a rendering, not a permission. The stamp carries a
 * snapshot of what the gates said so a closed month never re-renders
 * against data that has moved on.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['executive']);
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  const actorId = auth.user?.id || null;
  const actorName = auth.profile?.full_name || auth.user?.email || null;

  if (action === 'resolve_email') {
    const id = String(body.emailLogId || '');
    if (!id) return bad('emailLogId required');
    const { error } = await supabase
      .from('email_log')
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: actorId,
        resolution_note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
      })
      .eq('id', id);
    if (error) return bad(error.message, 500);
    return NextResponse.json({ ok: true });
  }

  const period = String(body.period || '');
  if (!PERIOD_RE.test(period)) return bad('period must be YYYY-MM');

  if (action === 'sign_off') {
    const gateKey = String(body.gateKey || '');
    const def = GATE_BY_KEY.get(gateKey);
    if (!def) return bad('unknown gate');
    const kind = body.kind === 'waived' ? 'waived' : 'acknowledged';
    if (kind === 'waived' && def.kind !== 'computed') return bad('only a computed gate can be waived');
    if (kind === 'acknowledged' && def.kind !== 'manual') return bad('only a manual gate can be acknowledged');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    // A waiver without a reason is just a hidden failure.
    if (kind === 'waived' && !note) return bad('a waiver needs a written reason');

    const { error } = await supabase
      .from('month_close_gate_signoffs')
      .upsert({
        period, gate_key: gateKey, kind, note: note || null,
        signed_by: actorId, signed_by_name: actorName, signed_at: new Date().toISOString(),
      }, { onConflict: 'period,gate_key' });
    if (error) return bad(error.message, 500);
    return NextResponse.json(await loadMonthClose(supabase, period));
  }

  if (action === 'unsign') {
    const gateKey = String(body.gateKey || '');
    if (!GATE_BY_KEY.has(gateKey)) return bad('unknown gate');
    const { error } = await supabase
      .from('month_close_gate_signoffs')
      .delete()
      .eq('period', period)
      .eq('gate_key', gateKey);
    if (error) return bad(error.message, 500);
    return NextResponse.json(await loadMonthClose(supabase, period));
  }

  if (action === 'close') {
    const { data: existing } = await supabase
      .from('month_close_periods')
      .select('period, reopened_at')
      .eq('period', period)
      .maybeSingle();
    if (existing && !existing.reopened_at) return bad('that month is already closed', 409);

    // A month cannot be closed before it has ended — half a month's gates
    // passing says nothing about the month.
    if (period >= periodFor()) return bad('that month has not ended yet', 409);

    const { startIso, endIso } = monthBounds(period);
    const [findings, signoffRes] = await Promise.all([
      computeFindings(supabase, startIso, endIso),
      supabase.from('month_close_gate_signoffs')
        .select('gate_key, kind, note, signed_by_name, signed_at')
        .eq('period', period),
    ]);
    const signoffs = new Map<string, GateSignoff>();
    for (const r of signoffRes.data || []) {
      signoffs.set(r.gate_key, {
        kind: r.kind, note: r.note || null,
        signedByName: r.signed_by_name || null, signedAt: r.signed_at,
      });
    }
    const gates = CLOSE_GATES.map(def => resolveGate(def, findings.get(def.key) || null, signoffs.get(def.key) || null));
    const verdict = closeVerdict(gates);
    if (!verdict.ready) {
      return NextResponse.json({
        error: `${verdict.blocking.length} gate${verdict.blocking.length === 1 ? '' : 's'} still open`,
        blocking: verdict.blocking.map(g => ({ key: g.key, title: g.title, state: g.state, count: g.count })),
      }, { status: 409 });
    }

    const { error } = await supabase
      .from('month_close_periods')
      .upsert({
        period,
        closed_by: actorId, closed_by_name: actorName, closed_at: new Date().toISOString(),
        note: typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || null : null,
        gate_snapshot: { gates, closedWith: { waived: verdict.waived.length, passed: verdict.passed } },
        reopened_by: null, reopened_at: null,
      }, { onConflict: 'period' });
    if (error) return bad(error.message, 500);
    return NextResponse.json(await loadMonthClose(supabase, period));
  }

  if (action === 'reopen') {
    const { error } = await supabase
      .from('month_close_periods')
      .update({ reopened_by: actorId, reopened_at: new Date().toISOString() })
      .eq('period', period);
    if (error) return bad(error.message, 500);
    return NextResponse.json(await loadMonthClose(supabase, period));
  }

  return bad('unknown action');
}
