import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notify, notifyMany, getSuperAdminIds } from '@/lib/notify';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { deepLinks } from '@/lib/deep-links';
import { chicagoDay } from '@/lib/exec-metrics';
import { loadOpenDeals, classifyCloseBucket, daysPast, type ForecastDeal } from '@/lib/deal-forecast';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const LOST_REASON_LABELS: Record<string, string> = {
  price: 'price', timing: 'timing', competitor: 'competitor',
  no_response: 'no response', other: 'other',
};

/**
 * Weekly deal-forecast sweep (R5-8, Friday morning). Two jobs:
 *
 * 1. Slippage nudges — every open deal whose expected_close_date has passed
 *    nudges its owner (created_by): close it, move the date, or mark it
 *    lost with the structured reason. Repeating weekly is the design — the
 *    nudge loop is what keeps close dates honest instead of letting
 *    forecast dollars roll forward silently.
 *
 * 2. Pipeline-movement digest to super admins — new deals, stage moves,
 *    close dates pushed later, won/lost with reasons, from the R5-4
 *    audit trigger's row_update entries (migration 274). A week with no
 *    movement and nothing overdue sends nothing (heartbeat only).
 *
 * Buckets come from the same deal-forecast lib as the dashboard strip, so
 * the nudge and the strip can never disagree about "overdue".
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const today = chicagoDay();
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    const deals = await loadOpenDeals(service);
    const overdue = deals
      .filter(d => classifyCloseBucket(d.expectedClose, today) === 'overdue')
      .sort((a, b) => (a.expectedClose || '').localeCompare(b.expectedClose || ''));

    // ── 1. Nudge each owner about their overdue deals ──
    const byOwner = new Map<string, ForecastDeal[]>();
    for (const deal of overdue) {
      if (!deal.createdBy) continue; // ownerless deals surface via the digest count
      if (!byOwner.has(deal.createdBy)) byOwner.set(deal.createdBy, []);
      byOwner.get(deal.createdBy)!.push(deal);
    }
    let nudged = 0;
    if (byOwner.size > 0) {
      // Only approved accounts — a deal whose creator was deactivated
      // shouldn't dead-letter a notification row.
      const { data: owners } = await service
        .from('profiles').select('id').in('id', [...byOwner.keys()]).eq('status', 'approved');
      const active = new Set((owners || []).map(o => o.id));
      for (const [ownerId, ownerDeals] of byOwner) {
        if (!active.has(ownerId)) continue;
        const first = ownerDeals[0];
        const daysLate = first.expectedClose ? daysPast(first.expectedClose, today) : 0;
        if (ownerDeals.length === 1) {
          await notify({
            userId: ownerId,
            type: 'deal_overdue',
            title: 'Deal past its expected close date',
            body: `"${first.title}" for ${first.customer} was expected to close ${first.expectedClose} (${daysLate} day${daysLate !== 1 ? 's' : ''} ago). Close it, move the date, or mark it lost with a reason.`,
            url: deepLinks.opportunity(first.prospectId, first.id),
            channels: ['in_app', 'push', 'email'],
          });
        } else {
          const top = ownerDeals.slice(0, 3).map(d => `${d.title} (${d.customer}, was ${d.expectedClose})`).join(' · ');
          await notify({
            userId: ownerId,
            type: 'deal_overdue',
            // Digest of several deals → the CRM list (deep-links digest
            // carve-out); a single deal above links to the exact record.
            title: `${ownerDeals.length} of your deals are past their close dates`,
            body: `${top}${ownerDeals.length > 3 ? ` and ${ownerDeals.length - 3} more` : ''}. Close them, move the dates, or mark them lost.`,
            url: '/admin/prospects',
            channels: ['in_app', 'push', 'email'],
          });
        }
        nudged++;
      }
    }

    // ── 2. Pipeline-movement digest from the audit trail (R5-4) ──
    const [auditRes, newDealsRes] = await Promise.all([
      fetchAllRows<{ record_id: string | null; action: string; detail: any }>((from, to) => service
        .from('audit_log')
        .select('id, record_id, action, detail')
        .eq('table_name', 'prospect_opportunities')
        .in('action', ['row_update', 'row_delete'])
        .gte('created_at', since)
        .order('created_at').order('id')
        .range(from, to)),
      service
        .from('prospect_opportunities')
        .select('id, value')
        .gte('created_at', since),
    ]);
    if (auditRes.error) throw new Error(auditRes.error.message);
    const audits = auditRes.data || [];
    const newDeals = newDealsRes.data || [];
    const newValue = newDeals.reduce((s, d) => s + (Number(d.value) || 0), 0);

    const stageMoves = audits.filter(a => a.action === 'row_update' && a.detail?.changed?.stage);
    const wonIds = stageMoves.filter(a => a.detail.changed.stage?.to === 'won').map(a => a.record_id).filter(Boolean) as string[];
    const lostIds = stageMoves.filter(a => a.detail.changed.stage?.to === 'lost').map(a => a.record_id).filter(Boolean) as string[];
    const slips = audits.filter(a => {
      const c = a.detail?.changed?.expected_close_date;
      return c && typeof c.from === 'string' && typeof c.to === 'string' && c.to > c.from;
    });
    const deleted = audits.filter(a => a.action === 'row_delete').length;

    // Won value + lost reasons come from the rows as they stand now.
    let wonValue = 0;
    const lostReasons = new Map<string, number>();
    const closedIds = [...new Set([...wonIds, ...lostIds])];
    for (let i = 0; i < closedIds.length; i += 200) {
      const { data: rows } = await service
        .from('prospect_opportunities')
        .select('id, value, stage, lost_reason')
        .in('id', closedIds.slice(i, i + 200));
      for (const r of rows || []) {
        if (r.stage === 'won' && wonIds.includes(r.id)) wonValue += Number(r.value) || 0;
        if (r.stage === 'lost' && lostIds.includes(r.id)) {
          const label = LOST_REASON_LABELS[r.lost_reason] || 'no reason recorded';
          lostReasons.set(label, (lostReasons.get(label) || 0) + 1);
        }
      }
    }
    const topLostReason = [...lostReasons.entries()].sort((a, b) => b[1] - a[1])[0];

    const fmtK = (n: number) => n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
    const lines: string[] = [];
    if (newDeals.length > 0) lines.push(`${newDeals.length} new deal${newDeals.length !== 1 ? 's' : ''} (${fmtK(newValue)})`);
    if (wonIds.length > 0) lines.push(`${wonIds.length} won (${fmtK(wonValue)})`);
    if (lostIds.length > 0) lines.push(`${lostIds.length} lost${topLostReason ? ` (top reason: ${topLostReason[0]})` : ''}`);
    const otherMoves = stageMoves.length - wonIds.length - lostIds.length;
    if (otherMoves > 0) lines.push(`${otherMoves} stage move${otherMoves !== 1 ? 's' : ''}`);
    if (slips.length > 0) lines.push(`${slips.length} close date${slips.length !== 1 ? 's' : ''} pushed later`);
    if (deleted > 0) lines.push(`${deleted} deal${deleted !== 1 ? 's' : ''} deleted`);
    if (overdue.length > 0) {
      const overdueValue = overdue.reduce((s, d) => s + d.value, 0);
      lines.push(`${overdue.length} overdue now (${fmtK(overdueValue)})`);
    }

    let digested = 0;
    if (lines.length > 0) {
      const superAdminIds = await getSuperAdminIds();
      if (superAdminIds.length > 0) {
        await notifyMany(superAdminIds, {
          type: 'pipeline_movement',
          title: 'Pipeline this week',
          body: lines.join(' · ').slice(0, 900),
          // Digest of the whole pipeline → the CRM list.
          url: '/admin/prospects',
          channels: ['in_app', 'push', 'email'],
        });
        digested = superAdminIds.length;
      }
    }

    const syncStateWrite = await recordHeartbeat(service, 'deal_forecast_check', {
      status: 'ok', openDeals: deals.length, overdue: overdue.length, nudged,
      movement: lines, digested,
    });
    return NextResponse.json({
      status: 'ok', openDeals: deals.length, overdue: overdue.length, nudged,
      movement: lines, digested, syncStateWrite,
    });
  } catch (e: any) {
    console.error('deal-forecast-check failed:', e);
    await recordHeartbeat(service, 'deal_forecast_check', { error: e.message || 'deal forecast check failed' }).catch(() => {});
    return NextResponse.json({ error: e.message || 'deal forecast check failed' }, { status: 500 });
  }
}
