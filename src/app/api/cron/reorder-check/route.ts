import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { loadReorderCandidates, computeReorderSuggestion, weeklyVelocity } from '@/lib/reorder';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Nightly auto-replenishment sweep (R4-7): for every part with a
 * reorder_point set, when free stock + open on-order falls to the point,
 * raise a purchase_request tagged 'auto_reorder' into the /admin/purchasing
 * queue — sized to fill back to order_up_to, net of everything already
 * requested. The sweep only queues; a person still turns requests into POs.
 *
 * Non-spam rules: one auto row per part (an existing pending auto_reorder
 * row is topped up, not duplicated, and top-ups don't re-notify); demand-tab
 * dismissals hold with their watermark semantics (a "not buying this" stands
 * until the suggested quantity grows past what it was when dismissed).
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
    const candidates = await loadReorderCandidates(service);

    const created: { id: string; itemNumber: string; qty: number }[] = [];
    let bumped = 0;
    let skippedDismissed = 0;
    let triggered = 0;

    for (const c of candidates) {
      const { triggered: hit, suggestedQty } = computeReorderSuggestion(c);
      if (!hit) continue;
      triggered++;
      if (suggestedQty <= 0) continue; // pending requests already cover the fill

      // Dismissal watermark: skip while the suggestion hasn't outgrown the
      // number the buyer said no to (parts-demand's exact comparison).
      if (c.dismissedWatermark != null && suggestedQty <= c.dismissedWatermark + 1e-6) {
        skippedDismissed++;
        continue;
      }

      const velocity = weeklyVelocity(c.installs90d);
      const note = `Auto-reorder: ~${velocity}/wk installed (90d) · free ${c.free} · on order ${c.onOrder} · point ${c.reorderPoint} → fill to ${Math.max(c.orderUpTo ?? 0, c.reorderPoint)}`;

      if (c.pendingAutoRequestId) {
        // Top up the standing auto row instead of stacking a second one.
        const { error: upErr } = await service
          .from('purchase_requests')
          .update({
            quantity: c.pendingAutoQty + suggestedQty,
            note,
            updated_at: new Date().toISOString(),
          })
          .eq('id', c.pendingAutoRequestId)
          .eq('status', 'pending');
        if (upErr) console.error('reorder top-up failed:', c.itemNumber, upErr.message);
        else bumped++;
        continue;
      }

      const { data: row, error: insErr } = await service
        .from('purchase_requests')
        .insert({
          item_number: c.itemNumber,
          netsuite_item_id: c.netsuiteItemId,
          description: c.description,
          vendor_name: c.vendor,
          quantity: suggestedQty,
          note,
          source: 'auto_reorder',
          requested_by: null,
        })
        .select('id')
        .single();
      if (insErr || !row) {
        console.error('reorder request insert failed:', c.itemNumber, insErr?.message);
        continue;
      }
      created.push({ id: row.id, itemNumber: c.itemNumber, qty: suggestedQty });
    }

    // One digest to purchasing (admins) about NEW auto requests — top-ups
    // stay quiet, the queue shows them.
    let notified = 0;
    if (created.length > 0) {
      const { data: staff } = await service
        .from('profiles')
        .select('id, role, roles, status, deactivated')
        .eq('status', 'approved');
      const adminIds = (staff || [])
        .filter((p: any) => {
          if (p.deactivated) return false;
          const roles = p.roles?.length ? p.roles : [p.role];
          return roles.some((r: string) => r === 'admin' || r === 'super_admin');
        })
        .map((p: any) => p.id);
      if (adminIds.length > 0) {
        const lines = created.map(r => `${r.qty}× ${r.itemNumber}`).join(' · ');
        await notifyMany(adminIds, {
          type: 'auto_reorder',
          title: `🛒 Auto-reorder: ${created.length} part${created.length !== 1 ? 's' : ''} at reorder point`,
          body: lines.slice(0, 900),
          url: deepLinks.purchaseRequests(created.length === 1 ? created[0].id : undefined),
          channels: ['in_app', 'push'],
        });
        notified = adminIds.length;
      }
    }

    const syncStateWrite = await recordHeartbeat(service, 'reorder_check', {
      status: 'ok',
      managed: candidates.length,
      triggered,
      created: created.length,
      bumped,
      skipped_dismissed: skippedDismissed,
      notified,
    });

    return NextResponse.json({
      status: 'ok', managed: candidates.length, triggered,
      created: created.length, bumped, skippedDismissed, notified, syncStateWrite,
    });
  } catch (e: any) {
    console.error('reorder-check failed:', e);
    await recordHeartbeat(service, 'reorder_check', { error: e.message || 'reorder check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'reorder check failed' }, { status: 500 });
  }
}
