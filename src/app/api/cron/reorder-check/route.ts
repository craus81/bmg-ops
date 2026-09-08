import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { loadReorderCandidates, computeReorderSuggestion, weeklyVelocity } from '@/lib/reorder';
import { findLowStock, summarizeStock, type StockPolicy, type StockRoll } from '@/lib/roll-stock';
import { buildCostHistory, computeDrift, staleCostWorklist, type Buy } from '@/lib/part-cost-book';

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
 *
 * R6-2 folds shop MATERIALS into the same sweep, as the audit's batching
 * note asked: film, premask and ink with a reorder point set raise the
 * same kind of request into the same queue, tagged 'material_low_stock'.
 * Materials with stock tracked but no point are watched, never ordered.
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

    // ── Materials (R6-2): rolls of film/premask, cartridges of ink ──────
    const materialCreated: { id: string; itemNumber: string; qty: number }[] = [];
    let materialBumped = 0;
    try {
      const [{ data: rollRows }, { data: policyRows }] = await Promise.all([
        service.from('material_rolls')
          .select('id, substrate_id, material_name, kind, unit, width_in, remaining_qty, received_at, status')
          .eq('status', 'open'),
        service.from('material_stock_settings')
          .select('kind, material_key, material_name, unit, reorder_at, order_up_to, vendor_name, item_number'),
      ]);
      const rolls: StockRoll[] = (rollRows || []).map((r: any) => ({
        id: r.id, substrateId: r.substrate_id, materialName: r.material_name, kind: r.kind,
        unit: r.unit, widthIn: r.width_in != null ? Number(r.width_in) : null,
        remainingQty: Number(r.remaining_qty), receivedAt: r.received_at, status: r.status,
      }));
      const policies: StockPolicy[] = (policyRows || []).map((p: any) => ({
        key: `${p.kind}:${p.material_key}`, kind: p.kind, materialName: p.material_name, unit: p.unit,
        reorderAt: p.reorder_at != null ? Number(p.reorder_at) : null,
        orderUpTo: p.order_up_to != null ? Number(p.order_up_to) : null,
        vendorName: p.vendor_name, itemNumber: p.item_number,
      }));

      for (const hit of findLowStock(summarizeStock(rolls), policies)) {
        // One standing row per material, same non-spam rule as parts: top
        // up the open request rather than stacking a second one.
        const requestItem = hit.itemNumber || hit.materialName;
        const note = `Auto: ${hit.onHand} ${hit.unit} on hand, reorder at ${hit.reorderAt}.`;
        const { data: pending } = await service
          .from('purchase_requests')
          .select('id, quantity')
          .eq('item_number', requestItem)
          .eq('source', 'material_low_stock')
          .eq('status', 'pending')
          .maybeSingle();
        if (pending) {
          await service.from('purchase_requests')
            .update({ quantity: hit.suggestedQty, note, updated_at: new Date().toISOString() })
            .eq('id', pending.id).eq('status', 'pending');
          materialBumped++;
          continue;
        }
        const { data: row } = await service.from('purchase_requests').insert({
          item_number: requestItem,
          description: `${hit.materialName} (${hit.kind}) — ${hit.suggestedQty} ${hit.unit}`,
          vendor_name: hit.vendorName,
          quantity: hit.suggestedQty,
          note,
          source: 'material_low_stock',
          requested_by: null,
        }).select('id').single();
        if (row) materialCreated.push({ id: row.id, itemNumber: hit.materialName, qty: hit.suggestedQty });
      }
    } catch (e: any) {
      // Materials are a bolt-on to this sweep: a failure here must not cost
      // the parts replenishment that already ran.
      console.error('material low-stock pass failed:', e?.message || e);
    }
    created.push(...materialCreated);
    bumped += materialBumped;

    // ── Price drift (R6-7) ──────────────────────────────────────────────
    // Catalog purchase_price ages silently while real costs move. Counted
    // every night so system-health shows the number, but only ANNOUNCED on
    // Mondays: a nightly "prices drifted" ping about a list that barely
    // changes is exactly the notification people learn to ignore.
    let driftMaterial = 0;
    let driftMinor = 0;
    try {
      const [{ data: lines }, { data: parts }] = await Promise.all([
        service.from('netsuite_vendor_po_lines')
          .select('item_number, quantity, rate, po:netsuite_vendor_pos(vendor_name, trandate)')
          .not('rate', 'is', null).gt('rate', 0),
        service.from('netsuite_parts').select('item_number, purchase_price').eq('is_active', true),
      ]);
      const byItem = new Map<string, Buy[]>();
      for (const l of lines || []) {
        const key = String((l as any).item_number || '').trim().toUpperCase();
        if (!key) continue;
        const arr = byItem.get(key) || [];
        arr.push({
          itemNumber: key,
          poTranid: null,
          vendorName: (l as any).po?.vendor_name || null,
          trandate: (l as any).po?.trandate || null,
          quantity: Number((l as any).quantity) || 0,
          rate: Number((l as any).rate) || 0,
        });
        byItem.set(key, arr);
      }
      const drifts = (parts || [])
        .map((p: any) => {
          const key = String(p.item_number || '').trim().toUpperCase();
          const buys = byItem.get(key);
          if (!buys) return null;
          return computeDrift(buildCostHistory(key, buys), p.purchase_price != null ? Number(p.purchase_price) : null);
        })
        .filter(Boolean) as ReturnType<typeof computeDrift>[];
      const worklist = staleCostWorklist(drifts);
      driftMaterial = worklist.filter(d => d.severity === 'material').length;
      driftMinor = worklist.filter(d => d.severity === 'minor').length;
    } catch (e: any) {
      console.error('price drift pass failed:', e?.message || e);
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

    // Monday-only drift ping (see the counting note above).
    if (driftMaterial > 0 && new Date().getUTCDay() === 1) {
      const { data: staff } = await service
        .from('profiles').select('id, role, roles, status, deactivated').eq('status', 'approved');
      const adminIds = (staff || [])
        .filter((p: any) => !p.deactivated && (p.roles?.length ? p.roles : [p.role]).some((r: string) => r === 'admin' || r === 'super_admin'))
        .map((p: any) => p.id);
      if (adminIds.length > 0) {
        await notifyMany(adminIds, {
          type: 'price_drift',
          title: `💸 ${driftMaterial} catalog price${driftMaterial !== 1 ? 's' : ''} out of date`,
          body: `What we actually pay has moved 15%+ from the catalog on ${driftMaterial} part${driftMaterial !== 1 ? 's' : ''}${driftMinor > 0 ? ` (plus ${driftMinor} smaller)` : ''}. Every margin built on those numbers is off.`,
          url: '/admin/purchasing',
          channels: ['in_app'],
        });
      }
    }

    const syncStateWrite = await recordHeartbeat(service, 'reorder_check', {
      status: 'ok',
      managed: candidates.length,
      triggered,
      created: created.length,
      bumped,
      skipped_dismissed: skippedDismissed,
      material_created: materialCreated.length,
      material_bumped: materialBumped,
      price_drift_material: driftMaterial,
      price_drift_minor: driftMinor,
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
