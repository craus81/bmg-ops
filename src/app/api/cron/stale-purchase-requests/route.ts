import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const STALE_DAYS = 5;
const REALERT_DAYS = 3;

/**
 * Daily aging-requests sweep (R3-12): a purchase request still pending after
 * 5+ days gets the purchasing admins a nag — the queue page shows age, but
 * only to someone who already opened it, so an unworked request could sit
 * quietly forever. One digest per run (per-request dedupe in this cron's
 * sync_state row, re-alerting every 3 days), linking to the queue — or to
 * the request itself when exactly one is stale.
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
    const now = Date.now();
    const cutoff = new Date(now - STALE_DAYS * 86_400_000).toISOString();
    const { data: pending } = await service
      .from('purchase_requests')
      .select('id, item_number, quantity, vendor_name, created_at, upfit_projects(project_name)')
      .eq('status', 'pending')
      .lte('created_at', cutoff)
      .order('created_at')
      .limit(500);
    const stale = pending || [];

    // Per-request re-alert dedupe lives in this cron's own sync_state row.
    const { data: state } = await service
      .from('sync_state').select('last_result').eq('sync_type', 'stale_purchase_request_check').maybeSingle();
    const lastAlerts: Record<string, string> = ((state?.last_result as any)?.alerts as Record<string, string>) || {};

    const due = stale.filter(r => {
      const last = lastAlerts[r.id];
      return !last || now - new Date(last).getTime() >= REALERT_DAYS * 86_400_000;
    });

    let alerted = 0;
    if (due.length > 0) {
      const { data: admins } = await service
        .from('profiles').select('id')
        .or('role.eq.admin,roles.cs.{admin},role.eq.super_admin,roles.cs.{super_admin}')
        .eq('status', 'approved');
      const adminIds = (admins || []).map(a => a.id);
      if (adminIds.length > 0) {
        const days = (iso: string) => Math.floor((now - new Date(iso).getTime()) / 86_400_000);
        const lines = due.slice(0, 3).map(r => {
          const proj = (r as any).upfit_projects?.project_name;
          return `${r.item_number} ×${r.quantity}${r.vendor_name ? ` (${r.vendor_name})` : ''}${proj ? ` — ${proj}` : ''} · ${days(r.created_at)}d`;
        });
        const more = due.length - lines.length;
        await notifyMany(adminIds, {
          type: 'purchase_request_stale',
          title: `🛒 ${due.length} parts request${due.length !== 1 ? 's' : ''} waiting ${STALE_DAYS}+ days`,
          body: `${lines.join('\n')}${more > 0 ? `\n…and ${more} more` : ''}\nNobody has ordered these yet.`.slice(0, 900),
          url: deepLinks.purchaseRequests(due.length === 1 ? due[0].id : undefined),
          channels: ['in_app', 'push'],
        });
        const stamp = new Date().toISOString();
        for (const r of due) lastAlerts[r.id] = stamp;
        alerted = due.length;
      }
    }

    // Drop dedupe entries for requests no longer pending-and-stale so a
    // cancelled/ordered request stops occupying the map (and a re-raised
    // one alerts on its own clock).
    const activeIds = new Set(stale.map(r => r.id));
    for (const id of Object.keys(lastAlerts)) {
      if (!activeIds.has(id)) delete lastAlerts[id];
    }

    const syncStateWrite = await recordHeartbeat(
      service, 'stale_purchase_request_check', { status: 'ok', stale: stale.length, alerted, alerts: lastAlerts },
    );

    return NextResponse.json({ status: 'ok', stale: stale.length, alerted, syncStateWrite });
  } catch (e: any) {
    console.error('stale-purchase-requests failed:', e);
    await recordHeartbeat(service, 'stale_purchase_request_check', { error: e.message || 'stale purchase request check failed' });
    return NextResponse.json({ error: e.message || 'stale purchase request check failed' }, { status: 500 });
  }
}
