/**
 * Undo a part ordered with "Create PO in NetSuite" (Craig, 2026-10-20: a
 * part went on the wrong vendor's PO and there was no way back). The part
 * comes off the PO in NetSuite, and its requests go back to the Purchasing
 * queue with no vendor picked, so they can go on the right vendor's PO.
 *
 * What happens in NetSuite, read live from the PO (the mirror can be two
 * hours old):
 * - the part's line still has more on it than these requests → its
 *   quantity drops;
 * - otherwise the line is removed, and the rest of the PO is untouched;
 * - when it is the PO's only line, the line is CLOSED instead, which closes
 *   the PO but keeps the record and its number (a PO can't have no lines);
 * - anything received or billed on that part refuses: that is a vendor
 *   return, not an undo.
 * NetSuite goes first. If it refuses, nothing changes in FleetSuite.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getPurchaseOrderItemLines, updatePurchaseOrderItemLines, type PoItemLine } from '@/lib/netsuite';

export type PoUndoPlan =
  | { kind: 'refuse'; error: string }
  /** The part isn't open on the PO in NetSuite any more — only FleetSuite changes. */
  | { kind: 'gone' }
  | {
      kind: 'patch';
      replace: boolean;
      lines: Record<string, unknown>[];
      /** Every line of the PO ends up closed. */
      closesPo: boolean;
    };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What to send NetSuite to take `quantity` of `itemId` off a PO. */
export function planPoLineUndo(lines: PoItemLine[], itemId: string, quantity: number, itemLabel: string): PoUndoPlan {
  const mine = lines.filter(l => l.itemId === itemId && !l.isClosed);
  if (mine.length === 0) return { kind: 'gone' };
  if (mine.some(l => l.quantityReceived > 0 || l.quantityBilled > 0)) {
    return {
      kind: 'refuse',
      error: `${itemLabel} has already been received or billed on this PO, so it can't be undone here. Fix it in NetSuite with a vendor return.`,
    };
  }

  // Biggest line first; a part normally sits on one line.
  let left = quantity;
  const newQty = new Map<number, number>();
  for (const l of [...mine].sort((a, b) => b.quantity - a.quantity)) {
    if (left <= 0) break;
    const take = Math.min(left, l.quantity);
    newQty.set(l.line, round2(l.quantity - take));
    left = round2(left - take);
  }
  const removed = [...newQty].filter(([, q]) => q <= 0).map(([line]) => line);
  const reduced = [...newQty].filter(([, q]) => q > 0);

  if (removed.length === 0) {
    return { kind: 'patch', replace: false, lines: reduced.map(([line, q]) => ({ line, quantity: q })), closesPo: false };
  }

  const kept = lines.filter(l => !removed.includes(l.line));
  if (kept.length === 0) {
    // Nothing would be left: close instead of remove.
    return { kind: 'patch', replace: false, lines: removed.map(line => ({ line, isClosed: true })), closesPo: true };
  }
  const reducedTo = new Map(reduced);
  return {
    kind: 'patch',
    replace: true,
    lines: kept.map(l => (reducedTo.has(l.line) ? { line: l.line, quantity: reducedTo.get(l.line) } : { line: l.line })),
    closesPo: kept.every(l => l.isClosed),
  };
}

export type PoUndoResult =
  | { ok: true; poNumber: string | null; outcome: 'reduced' | 'removed' | 'closed' | 'gone'; requeued: number }
  | { ok: false; status: number; error: string };

/** The requests a FleetSuite-made PO line holds — what the Undo acts on. */
export function isCreatedPoOrder(r: { status: string; ordered_match?: string | null; ordered_po_id?: string | null }): boolean {
  return r.status === 'ordered' && !r.ordered_match && !!r.ordered_po_id;
}

export async function undoCreatedPoOrder(service: SupabaseClient, requestIds: string[]): Promise<PoUndoResult> {
  const ids = [...new Set(requestIds)];
  const { data: rows, error } = await service.from('purchase_requests').select('*').in('id', ids);
  if (error) return { ok: false, status: 500, error: error.message };
  const requests = (rows || []) as any[];
  if (requests.length !== ids.length) return { ok: false, status: 404, error: 'Some of these requests no longer exist. Refresh the page.' };
  if (!requests.every(isCreatedPoOrder)) {
    return { ok: false, status: 409, error: 'Only parts ordered with Create PO can be undone this way. Refresh the page.' };
  }
  const poId = requests[0].ordered_po_id as string;
  const itemId = requests[0].netsuite_item_id as string | null;
  if (!itemId || requests.some(r => r.ordered_po_id !== poId || r.netsuite_item_id !== itemId)) {
    return { ok: false, status: 400, error: 'Undo one part on one PO at a time.' };
  }
  const itemLabel = requests[0].item_number as string;
  const quantity = round2(requests.reduce((s, r) => s + (Number(r.quantity) || 0), 0));

  const { data: po } = await service.from('netsuite_vendor_pos').select('id, netsuite_id, tranid').eq('id', poId).maybeSingle();
  if (!po?.netsuite_id) return { ok: false, status: 404, error: 'That PO isn’t in FleetSuite. Refresh after the next NetSuite sync.' };

  // ── NetSuite first ──
  const live = await getPurchaseOrderItemLines(po.netsuite_id);
  if (!live.success) return { ok: false, status: 502, error: `Couldn’t read PO ${po.tranid || ''} from NetSuite: ${live.error}` };
  const plan = planPoLineUndo(live.lines, itemId, quantity, itemLabel);
  if (plan.kind === 'refuse') return { ok: false, status: 409, error: plan.error };
  if (plan.kind === 'patch') {
    const res = await updatePurchaseOrderItemLines(po.netsuite_id, plan.lines, { replace: plan.replace });
    if (!res.success) return { ok: false, status: 502, error: `NetSuite didn’t change PO ${po.tranid || ''}: ${res.error}. Nothing was changed in FleetSuite.` };
  }
  const outcome: 'reduced' | 'removed' | 'closed' | 'gone' = plan.kind === 'gone' ? 'gone'
    : plan.closesPo ? 'closed'
    : plan.replace ? 'removed' : 'reduced';

  // ── The mirror, so readiness and the lists agree now rather than at the
  // next sync (which rewrites these lines from NetSuite anyway). ──
  const now = new Date().toISOString();
  try {
    if (outcome === 'closed') {
      await service.from('netsuite_vendor_pos').update({ status: 'H', status_label: 'Closed', last_synced_at: now }).eq('id', po.id);
    } else if (outcome !== 'gone') {
      const { data: mLines } = await service.from('netsuite_vendor_po_lines')
        .select('id, quantity').eq('po_id', po.id).eq('item_netsuite_id', itemId).order('quantity', { ascending: false });
      let left = quantity;
      for (const ml of (mLines || []) as { id: string; quantity: number }[]) {
        if (left <= 0) break;
        const take = Math.min(left, Number(ml.quantity) || 0);
        const q = round2((Number(ml.quantity) || 0) - take);
        left = round2(left - take);
        if (q <= 0) await service.from('netsuite_vendor_po_lines').delete().eq('id', ml.id);
        else await service.from('netsuite_vendor_po_lines').update({ quantity: q }).eq('id', ml.id);
      }
    }
  } catch (err) {
    console.error('po-undo: mirror update failed (sync will catch up):', err);
  }

  // ── The requests go back to the queue, vendor cleared so the right one
  // gets picked, and never auto-match to this PO again. ──
  const { data: catalog } = await service.from('netsuite_parts').select('vendor').eq('item_number', itemLabel).maybeSingle();
  let requeued = 0;
  for (const r of requests) {
    const root = r.split_from_id || r.id;
    const { data: siblings } = await service.from('purchase_requests')
      .select('id, quantity')
      .eq('status', 'pending')
      .or(`id.eq.${root},split_from_id.eq.${root}`)
      .neq('id', r.id);
    const pending = (siblings || []) as { id: string; quantity: number }[];
    const { error: upErr } = await service.from('purchase_requests').update({
      status: 'pending',
      quantity: round2(Number(r.quantity) + pending.reduce((s, x) => s + (Number(x.quantity) || 0), 0)),
      ordered_po_id: null,
      ordered_po_number: null,
      ordered_at: null,
      ordered_by: null,
      ordered_match: null,
      vendor_netsuite_id: null,
      vendor_name: catalog?.vendor || null,
      auto_match_blocked_po_ids: [...new Set([...(r.auto_match_blocked_po_ids || []), po.id])],
      updated_at: now,
    }).eq('id', r.id).eq('status', 'ordered');
    if (upErr) {
      console.error('po-undo: request revert failed:', upErr);
      continue;
    }
    requeued++;
    if (pending.length > 0) await service.from('purchase_requests').delete().in('id', pending.map(x => x.id));
  }

  // ── A job with nothing left on this PO loses its link to it. ──
  try {
    const projectIds = [...new Set(requests.map(r => r.source_project_id).filter(Boolean))] as string[];
    for (const projectId of projectIds) {
      const { count } = await service.from('purchase_requests')
        .select('id', { count: 'exact', head: true })
        .eq('source_project_id', projectId).eq('ordered_po_id', po.id).eq('status', 'ordered');
      if ((count || 0) > 0) continue;
      await service.from('upfit_project_pos').delete().eq('project_id', projectId).eq('po_id', po.id).eq('source', 'request_queue');
      await service.from('upfit_projects')
        .update({ netsuite_vendor_po_id: null, netsuite_vendor_po_number: null })
        .eq('id', projectId).eq('netsuite_vendor_po_id', po.netsuite_id);
    }
  } catch (err) {
    console.error('po-undo: project link cleanup failed:', err);
  }

  return { ok: true, poNumber: po.tranid || null, outcome, requeued };
}
