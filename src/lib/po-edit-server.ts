/**
 * The server half of Edit PO (src/lib/po-edit.ts has the rules): read the
 * PO live, refuse if NetSuite's copy changed since the window opened, make
 * the new PO for moved lines, save the changes in NetSuite, then bring
 * FleetSuite's copy, the purchase requests and Craig's alert along.
 *
 * NetSuite goes first. If it refuses, nothing changes in FleetSuite.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createPurchaseOrder,
  getPurchaseOrderRecord,
  patchPurchaseOrder,
  poItemLinesFromRecord,
  type PoItemLine,
} from '@/lib/netsuite';
import {
  canEditPo,
  parsePoHeader,
  planPoEdit,
  planPoHeader,
  splitRequestsForQty,
  type PoEditHeader,
  type PoLineEdit,
  type PoNewLine,
} from '@/lib/po-edit';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';
import { centralDate } from '@/lib/central-day';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PoEditLineView extends PoItemLine {
  itemNumber: string;
  /** The jobs this line is for: their requests, oldest first. */
  jobs: { requestId: string; quantity: number; label: string }[];
}

export interface PoEditView {
  po: { id: string; netsuiteId: string; tranid: string | null; vendorName: string | null; status: string | null; statusLabel: string | null };
  header: PoEditHeader;
  lastModified: string | null;
  lines: PoEditLineView[];
}

type Loaded = { ok: true; view: PoEditView; record: any; mirror: any } | { ok: false; status: number; error: string };

/** The PO as the window shows it: NetSuite's lines and header, named and tied to their jobs. */
export async function loadPoForEdit(service: SupabaseClient, poId: string): Promise<Loaded> {
  const { data: po } = await service.from('netsuite_vendor_pos')
    .select('id, netsuite_id, tranid, vendor_netsuite_id, vendor_name, status, status_label, memo, total, eta_date, trandate')
    .eq('id', poId).maybeSingle();
  if (!po?.netsuite_id) return { ok: false, status: 404, error: 'That PO isn’t in FleetSuite. Refresh the page.' };
  const label = po.tranid || `#${po.netsuite_id}`;
  if (!canEditPo(po.status)) {
    return { ok: false, status: 409, error: `PO ${label} is ${String(po.status_label || 'received or closed').toLowerCase()}, so it can't be edited here.` };
  }
  const live = await getPurchaseOrderRecord(po.netsuite_id);
  if (!live.success) return { ok: false, status: 502, error: `Couldn’t read PO ${label} from NetSuite: ${live.error}` };
  const { header, lastModified } = parsePoHeader(live.record);
  // NetSuite's own Receive By wins; else the date the vendor gave (parts email).
  if (!header.dueDate && po.eta_date) header.dueDate = String(po.eta_date).slice(0, 10);
  const lines = poItemLinesFromRecord(live.record);
  const labels = await itemLabels(service, po.id, lines.map(l => l.itemId));

  const { data: reqRows } = await service.from('purchase_requests')
    .select('id, netsuite_item_id, quantity, created_at, upfit_projects(project_name, netsuite_so_number), estimates(estimate_number, customer_name)')
    .eq('ordered_po_id', po.id).eq('status', 'ordered')
    .order('created_at').order('id');
  const jobsByItem = new Map<string, PoEditLineView['jobs']>();
  for (const r of (reqRows || []) as any[]) {
    const p = r.upfit_projects; const e = r.estimates;
    const jobLabel = p ? [p.netsuite_so_number ? `SO ${p.netsuite_so_number}` : null, p.project_name].filter(Boolean).join(' · ')
      : e ? [`Estimate ${e.estimate_number || ''}`.trim(), e.customer_name].filter(Boolean).join(' · ')
      : 'stock';
    const key = String(r.netsuite_item_id);
    jobsByItem.set(key, [...(jobsByItem.get(key) || []), { requestId: r.id, quantity: Number(r.quantity) || 0, label: jobLabel }]);
  }
  // A part normally sits on one line; its requests go with the first open one.
  const claimed = new Set<string>();
  const out: PoEditLineView[] = lines.map(l => {
    const jobs = !l.isClosed && !claimed.has(l.itemId) ? jobsByItem.get(l.itemId) || [] : [];
    if (jobs.length) claimed.add(l.itemId);
    return { ...l, itemNumber: labels.get(l.itemId) || `Item ${l.itemId}`, jobs };
  });

  return {
    ok: true,
    record: live.record,
    mirror: po,
    view: {
      po: { id: po.id, netsuiteId: String(po.netsuite_id), tranid: po.tranid || null, vendorName: po.vendor_name || null, status: po.status || null, statusLabel: po.status_label || null },
      header,
      lastModified,
      lines: out,
    },
  };
}

/** NetSuite item id → part number: the PO's own copy first, then the parts catalog. */
async function itemLabels(service: SupabaseClient, poId: string, itemIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data: mLines } = await service.from('netsuite_vendor_po_lines').select('item_netsuite_id, item_number').eq('po_id', poId);
  for (const m of (mLines || []) as any[]) if (m.item_netsuite_id && m.item_number) out.set(String(m.item_netsuite_id), m.item_number);
  const missing = [...new Set(itemIds.filter(id => !out.has(id)))];
  if (missing.length) {
    const { data: parts } = await service.from('netsuite_parts').select('netsuite_id, item_number').in('netsuite_id', missing);
    for (const p of (parts || []) as any[]) if (p.netsuite_id && p.item_number) out.set(String(p.netsuite_id), p.item_number);
  }
  return out;
}

export interface PoEditInput {
  lastModified: string | null;
  header?: Partial<PoEditHeader>;
  lines?: PoLineEdit[];
  adds?: PoNewLine[];
  /** Where moved lines go: a new PO with this vendor. */
  moveTo?: { vendorNetsuiteId: string; vendorName: string | null } | null;
}

export type PoEditResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      poNumber: string | null;
      vendorName: string | null;
      changes: string[];
      /** The jobs whose parts went back to the parts queue. */
      requeued: string[];
      movedTo: { id: string | null; number: string | null; vendorName: string | null } | null;
      /** Set when the new PO was made but this PO couldn't be changed. */
      warning?: string;
    };

export async function savePoEdit(
  service: SupabaseClient,
  poId: string,
  input: PoEditInput,
  actor: { id: string; name: string },
): Promise<PoEditResult> {
  const loaded = await loadPoForEdit(service, poId);
  if (!loaded.ok) return loaded;
  const { view, record, mirror } = loaded;
  const label = view.po.tranid || `#${view.po.netsuiteId}`;

  if (input.lastModified && view.lastModified && input.lastModified !== view.lastModified) {
    return { ok: false, status: 409, error: `Someone changed PO ${label} in NetSuite after you opened it. Nothing was saved. Close the window and open it again to see their changes.` };
  }

  const labels = new Map(view.lines.map(l => [l.itemId, l.itemNumber]));
  for (const a of input.adds || []) labels.set(a.itemId, a.itemNumber);
  const plan = planPoEdit(view.lines, input.lines || [], input.adds || [], labels);
  if (!plan.ok) return { ok: false, status: 400, error: plan.error };
  const head = planPoHeader(view.header, input.header || {});
  if (plan.moved.length && !input.moveTo?.vendorNetsuiteId) {
    return { ok: false, status: 400, error: 'Pick the vendor the moved parts go to.' };
  }
  if (plan.moved.length && input.moveTo && mirror.vendor_netsuite_id && String(mirror.vendor_netsuite_id) === input.moveTo.vendorNetsuiteId) {
    return { ok: false, status: 400, error: `The moved parts are already with ${view.po.vendorName || 'this vendor'}. Pick a different vendor.` };
  }
  const changes = [...head.changes, ...plan.changes];
  if (changes.length === 0) return { ok: false, status: 400, error: 'Nothing changed.' };

  // ── The new PO for moved lines, first: if NetSuite refuses it, this PO stays as it was. ──
  let movedTo: { netsuiteId: string; number: string | null; mirrorId: string | null } | null = null;
  const today = centralDate();
  if (plan.moved.length && input.moveTo) {
    const soNames = [...new Set(view.lines.filter(l => plan.moved.some(m => m.line === l.line)).flatMap(l => l.jobs.map(j => j.label.match(/^SO \S+/)?.[0]).filter(Boolean)))] as string[];
    const memo = `FleetSuite purchase requests — moved from PO ${label}${soNames.length ? ` · for ${soNames.join(', ')}` : ''}`.slice(0, 999);
    const made = await createPurchaseOrder({
      vendorId: input.moveTo.vendorNetsuiteId,
      locationId: record?.location?.id || undefined,
      tranDate: today,
      memo,
      lineItems: plan.moved.map(l => ({ itemId: l.itemId, quantity: l.quantity, rate: l.rate, description: l.description })),
    });
    if (!made.success || !made.purchaseOrderId) {
      return { ok: false, status: 502, error: `NetSuite didn’t make the new PO with ${input.moveTo.vendorName || 'that vendor'}: ${made.error || 'no reason given'}. Nothing was changed.` };
    }
    movedTo = { netsuiteId: made.purchaseOrderId, number: made.purchaseOrderNumber || null, mirrorId: null };
    try {
      const total = plan.moved.every(l => l.rate != null) ? round2(plan.moved.reduce((s, l) => s + (l.rate || 0) * l.quantity, 0)) : null;
      const { data: header } = await service.from('netsuite_vendor_pos').upsert({
        netsuite_id: made.purchaseOrderId,
        tranid: made.purchaseOrderNumber || null,
        vendor_netsuite_id: input.moveTo.vendorNetsuiteId,
        vendor_name: input.moveTo.vendorName,
        trandate: today,
        status: 'B',
        status_label: 'Pending Receipt',
        memo,
        total,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'netsuite_id' }).select('id').single();
      if (header) {
        movedTo.mirrorId = header.id;
        await service.from('netsuite_vendor_po_lines').insert(plan.moved.map((l, i) => ({
          po_id: header.id,
          line_id: `prov-${i + 1}`,
          item_netsuite_id: l.itemId,
          item_number: normalizeItemNumber(labels.get(l.itemId) || ''),
          description: l.description,
          quantity: l.quantity,
          quantity_received: 0,
          quantity_billed: 0,
          rate: l.rate,
          amount: l.rate != null ? round2(l.rate * l.quantity) : null,
        })));
      }
    } catch (err) {
      console.error('po-edit: new PO copy failed (sync will catch up):', err);
    }
  }

  // ── This PO in NetSuite. ──
  const body: Record<string, unknown> = { ...head.body };
  if (plan.items.length) body.item = { items: plan.items };
  const res = await patchPurchaseOrder(view.po.netsuiteId, body, { replace: plan.replace });
  if (!res.success) {
    if (movedTo) {
      return {
        ok: true,
        poNumber: view.po.tranid,
        vendorName: view.po.vendorName,
        changes: [],
        requeued: [],
        movedTo: { id: movedTo.mirrorId, number: movedTo.number, vendorName: input.moveTo?.vendorName || null },
        warning: `New PO ${movedTo.number || ''} was made, but NetSuite didn’t change PO ${label}: ${res.error}. Those parts are on both POs now. Take them off PO ${label} in NetSuite.`,
      };
    }
    return { ok: false, status: 502, error: `NetSuite didn’t save PO ${label}: ${res.error}. Nothing was changed.` };
  }

  // ── From here NetSuite has the changes. The rest is best effort, and the
  // 2-hour sync rewrites the copy from NetSuite anyway. ──
  const now = new Date().toISOString();
  await updateCopy(service, mirror, plan, labels, new Map(view.lines.map(l => [l.line, l.itemId])), head.body, input.header, now);
  const requeued = await moveRequests(service, mirror, view, plan, movedTo, input.moveTo || null, now);

  if (head.body.dueDate !== undefined) {
    try {
      await service.from('netsuite_vendor_pos').update({ eta_date: head.body.dueDate || null, eta_source: 'manual' }).eq('id', mirror.id);
      if (head.body.dueDate) {
        // Every ETA writer adds its row (migration 273).
        await service.from('po_eta_events').insert({
          po_id: mirror.id,
          po_tranid: mirror.tranid || null,
          vendor_name: mirror.vendor_name || null,
          eta_date: head.body.dueDate,
          previous_eta: mirror.eta_date || null,
          source: 'manual',
          detail: `Edit PO · ${actor.name}`.slice(0, 200),
        });
      }
    } catch (err) {
      console.warn('po-edit: expected date copy failed:', err);
    }
  }

  return {
    ok: true,
    poNumber: view.po.tranid,
    vendorName: view.po.vendorName,
    changes: movedTo
      ? changes.map(c => c.replace(/to a new PO$/, `to PO ${movedTo!.number || 'new'}${input.moveTo?.vendorName ? ` (${input.moveTo.vendorName})` : ''}`))
      : changes,
    requeued,
    movedTo: movedTo ? { id: movedTo.mirrorId, number: movedTo.number, vendorName: input.moveTo?.vendorName || null } : null,
  };
}

/** FleetSuite's copy of the PO, so lists and readiness agree now. */
async function updateCopy(
  service: SupabaseClient,
  mirror: any,
  plan: Extract<ReturnType<typeof planPoEdit>, { ok: true }>,
  labels: Map<string, string>,
  lineItems: Map<number, string>,
  headBody: Record<string, unknown>,
  header: Partial<PoEditHeader> | undefined,
  now: string,
): Promise<void> {
  try {
    const { data: mLines } = await service.from('netsuite_vendor_po_lines')
      .select('id, item_netsuite_id, quantity, quantity_received, rate').eq('po_id', mirror.id).order('quantity', { ascending: false });
    const copy = ((mLines || []) as any[]).map(m => ({ ...m }));
    const take = (itemId: string) => {
      const i = copy.findIndex(m => String(m.item_netsuite_id) === itemId);
      return i < 0 ? null : copy.splice(i, 1)[0];
    };
    for (const l of [...plan.removed, ...plan.moved]) {
      const m = take(l.itemId);
      if (m) await service.from('netsuite_vendor_po_lines').delete().eq('id', m.id);
    }
    const edited = new Map<number, Record<string, unknown>>();
    for (const it of plan.items) if (typeof it.line === 'number' && ('quantity' in it || 'rate' in it)) edited.set(it.line, it);
    for (const [line, it] of edited) {
      const itemId = lineItems.get(line) || null;
      const m = itemId ? take(itemId) : null;
      if (!m) continue;
      const qty = 'quantity' in it ? Number(it.quantity) : Number(m.quantity);
      const rate = 'rate' in it ? (it.rate == null ? null : Number(it.rate)) : (m.rate == null ? null : Number(m.rate));
      await service.from('netsuite_vendor_po_lines').update({
        quantity: qty, rate, amount: rate != null ? round2(rate * qty) : null,
      }).eq('id', m.id);
    }
    for (const [i, a] of plan.added.entries()) {
      await service.from('netsuite_vendor_po_lines').insert({
        po_id: mirror.id,
        line_id: `prov-edit-${Date.now()}-${i}-${a.itemId}`,
        item_netsuite_id: a.itemId,
        item_number: normalizeItemNumber(a.itemNumber || labels.get(a.itemId) || ''),
        description: a.description,
        quantity: a.quantity,
        quantity_received: 0,
        quantity_billed: 0,
        rate: a.rate,
        amount: a.rate != null ? round2(a.rate * a.quantity) : null,
      });
    }
    const { data: after } = await service.from('netsuite_vendor_po_lines').select('amount').eq('po_id', mirror.id);
    const amounts = ((after || []) as any[]).map(r => r.amount);
    await service.from('netsuite_vendor_pos').update({
      ...(headBody.memo !== undefined ? { memo: header?.memo?.trim() || null } : {}),
      total: amounts.length && amounts.every(a => a != null) ? round2(amounts.reduce((s, a) => s + Number(a), 0)) : mirror.total,
      last_synced_at: now,
    }).eq('id', mirror.id);
  } catch (err) {
    console.error('po-edit: copy update failed (sync will catch up):', err);
  }
}

/**
 * The purchase requests follow the parts: a removed line's requests and the
 * part of a lowered line no longer on order go back to the queue (never
 * matched to this PO again), and a moved line's requests go with it to the
 * new PO. Returns the jobs whose parts went back.
 */
async function moveRequests(
  service: SupabaseClient,
  mirror: any,
  view: PoEditView,
  plan: Extract<ReturnType<typeof planPoEdit>, { ok: true }>,
  movedTo: { netsuiteId: string; number: string | null; mirrorId: string | null } | null,
  moveTo: { vendorNetsuiteId: string; vendorName: string | null } | null,
  now: string,
): Promise<string[]> {
  const requeuedJobs = new Set<string>();
  const jobsOf = (line: number) => view.lines.find(l => l.line === line)?.jobs || [];
  try {
    const ids = [...plan.removed, ...plan.moved].flatMap(l => jobsOf(l.line).map(j => j.requestId))
      .concat(plan.qtyChanges.flatMap(c => jobsOf(c.line).map(j => j.requestId)));
    if (ids.length === 0) return [];
    const { data: rows } = await service.from('purchase_requests').select('*').in('id', [...new Set(ids)]);
    const byId = new Map(((rows || []) as any[]).map(r => [r.id as string, r]));
    const blocked = (r: any) => [...new Set([...(r.auto_match_blocked_po_ids || []), mirror.id])];
    const backToQueue = async (r: any, clearVendor: boolean) => {
      const { error } = await service.from('purchase_requests').update({
        status: 'pending',
        ordered_po_id: null, ordered_po_number: null, ordered_at: null, ordered_by: null, ordered_match: null,
        ...(clearVendor ? { vendor_netsuite_id: null } : {}),
        auto_match_blocked_po_ids: blocked(r),
        updated_at: now,
      }).eq('id', r.id).eq('status', 'ordered');
      if (error) console.error('po-edit: request back to queue failed:', error);
    };

    for (const l of plan.removed) {
      for (const j of jobsOf(l.line)) {
        const r = byId.get(j.requestId); if (!r) continue;
        await backToQueue(r, true);
        requeuedJobs.add(j.label);
      }
    }
    for (const c of plan.qtyChanges) {
      if (c.to >= c.from) continue;
      const jobs = jobsOf(c.line);
      const held = jobs.map(j => ({ id: j.requestId, quantity: j.quantity }));
      const split = splitRequestsForQty(held, c.to);
      for (const b of split.back) {
        const r = byId.get(b.id); if (!r) continue;
        await backToQueue(r, false);
        requeuedJobs.add(jobs.find(j => j.requestId === b.id)!.label);
      }
      if (split.split) {
        const r = byId.get(split.split.id);
        if (r) {
          await service.from('purchase_requests').update({ quantity: split.split.quantity, updated_at: now }).eq('id', r.id);
          const { error } = await service.from('purchase_requests').insert({
            item_number: r.item_number,
            netsuite_item_id: r.netsuite_item_id,
            description: r.description,
            vendor_name: r.vendor_name,
            vendor_netsuite_id: r.vendor_netsuite_id,
            source_project_id: r.source_project_id,
            source_estimate_id: r.source_estimate_id ?? null,
            needed_by: r.needed_by,
            note: r.note,
            requested_by: r.requested_by,
            source: r.source,
            created_at: r.created_at,
            split_from_id: r.split_from_id || r.id,
            auto_match_blocked_po_ids: blocked(r),
            quantity: split.split.back,
            status: 'pending',
            updated_at: now,
          });
          if (error) console.error('po-edit: leftover split failed:', error);
          requeuedJobs.add(jobs.find(j => j.requestId === r.id)!.label);
        }
      }
    }
    if (movedTo && moveTo) {
      const movedIds = plan.moved.flatMap(l => jobsOf(l.line).map(j => j.requestId));
      if (movedIds.length) {
        await service.from('purchase_requests').update({
          ordered_po_id: movedTo.mirrorId,
          ordered_po_number: movedTo.number,
          ordered_match: null,
          vendor_netsuite_id: moveTo.vendorNetsuiteId,
          ...(moveTo.vendorName ? { vendor_name: moveTo.vendorName } : {}),
          auto_match_blocked_po_ids: [mirror.id],
          updated_at: now,
        }).in('id', movedIds);
        const projectIds = [...new Set(movedIds.map(id => byId.get(id)?.source_project_id).filter(Boolean))] as string[];
        if (movedTo.mirrorId && projectIds.length) {
          await service.from('upfit_project_pos').upsert(
            projectIds.map(p => ({ project_id: p, po_id: movedTo.mirrorId, po_number: movedTo.number, source: 'request_queue' })),
            { onConflict: 'project_id,po_id', ignoreDuplicates: true },
          );
        }
      }
    }

    // A job with nothing left on this PO loses its link to it (as Undo does).
    const touchedProjects = [...new Set([...byId.values()].map(r => r.source_project_id).filter(Boolean))] as string[];
    const movedProjects = new Set(plan.moved.flatMap(l => jobsOf(l.line).map(j => byId.get(j.requestId)?.source_project_id)).filter(Boolean));
    for (const projectId of touchedProjects) {
      const { count } = await service.from('purchase_requests')
        .select('id', { count: 'exact', head: true })
        .eq('source_project_id', projectId).eq('ordered_po_id', mirror.id).eq('status', 'ordered');
      if ((count || 0) > 0) continue;
      await service.from('upfit_project_pos').delete().eq('project_id', projectId).eq('po_id', mirror.id).eq('source', 'request_queue');
      await service.from('upfit_projects')
        .update({
          netsuite_vendor_po_id: movedTo && movedProjects.has(projectId) ? movedTo.netsuiteId : null,
          netsuite_vendor_po_number: movedTo && movedProjects.has(projectId) ? movedTo.number : null,
        })
        .eq('id', projectId).eq('netsuite_vendor_po_id', mirror.netsuite_id);
    }
  } catch (err) {
    console.error('po-edit: request update failed:', err);
  }
  return [...requeuedJobs].filter(j => j !== 'stock');
}
