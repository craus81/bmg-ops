/**
 * Purchase requests → NetSuite POs (migration 331). A request only left the
 * Purchasing queue when someone pressed "Create PO in NetSuite" on it; a PO
 * keyed straight into NetSuite left it pending forever. This pass runs after
 * every vendor PO sync and Parts Mail scan and marks pending requests ordered
 * on the PO that bought them, so the queue matches what was actually ordered
 * and the PO's ETA/tracking (written by the Parts Mail scan) shows against
 * the request.
 *
 * The rule (Craig, 2026-09-29):
 * - same part number (normalized like the PO mirror) AND same vendor — a
 *   request with no vendor never auto-matches;
 * - the PO is dated on or after the day the request was raised (shop
 *   calendar), and isn't Rejected or Closed;
 * - oldest request first; each PO line is used only up to its quantity,
 *   counting what earlier requests (auto or Create PO) already hold;
 * - a request the line only partly covers is split: the ordered part is
 *   marked ordered, the rest stays pending as its own row;
 * - automatic, with an admin Undo (unmatchPurchaseRequest) that also stops
 *   the request re-matching to that same PO.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

/** PO statuses that are no evidence of an order: Rejected (C), Closed (H). */
const NON_ORDER_PO_STATUSES = ['C', 'H'];

export interface MatchRequest {
  id: string;
  item_number: string;
  quantity: number;
  vendor_name: string | null;
  vendor_netsuite_id: string | null;
  created_at: string;
  auto_match_blocked_po_ids?: string[] | null;
}

export interface MatchPo {
  id: string;
  netsuite_id?: string | null;
  tranid: string | null;
  vendor_name: string | null;
  vendor_netsuite_id: string | null;
  trandate: string | null;
  status: string | null;
}

export interface MatchLine {
  po_id: string;
  item_number: string | null;
  quantity: number;
}

export interface RequestPlan {
  requestId: string;
  /** In order: the first one stays on the request's own row. */
  allocations: { poId: string; quantity: number }[];
  /** Quantity left pending (0 = fully ordered). */
  remainder: number;
}

/** "Ranger Design, Inc." ↔ "RANGER DESIGN" — lowercase, alphanumerics only,
 *  trailing company suffixes dropped. */
export function normalizeVendorName(name: string | null | undefined): string {
  const words = String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && ['inc', 'llc', 'co', 'corp', 'corporation', 'company', 'ltd', 'lp'].includes(words[words.length - 1])) {
    words.pop();
  }
  return words.join('');
}

/** The request's vendor is the PO's vendor. NetSuite ids decide when both
 *  sides have one; otherwise the names must agree. */
export function sameVendor(req: Pick<MatchRequest, 'vendor_name' | 'vendor_netsuite_id'>, po: Pick<MatchPo, 'vendor_name' | 'vendor_netsuite_id'>): boolean {
  if (req.vendor_netsuite_id && po.vendor_netsuite_id) return String(req.vendor_netsuite_id) === String(po.vendor_netsuite_id);
  const a = normalizeVendorName(req.vendor_name);
  return !!a && a === normalizeVendorName(po.vendor_name);
}

/** YYYY-MM-DD on the shop calendar (America/Chicago). */
export function shopDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(iso));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure planner: which pending requests land on which PO lines. `claimed` is
 * quantity already held per `${po_id}|${ITEM}` by ordered requests; it is
 * consumed as the plan allocates, so one call never over-books a line.
 */
export function planRequestMatches(
  requests: MatchRequest[],
  pos: MatchPo[],
  lines: MatchLine[],
  claimed: Map<string, number>,
): RequestPlan[] {
  const poById = new Map(pos.map(p => [p.id, p]));

  // Remaining capacity per PO line item (lines of the same item on one PO pool).
  const capacity = new Map<string, number>();
  for (const l of lines) {
    const item = normalizeItemNumber(l.item_number);
    if (!item || !poById.has(l.po_id)) continue;
    const key = `${l.po_id}|${item}`;
    capacity.set(key, (capacity.get(key) || 0) + (Number(l.quantity) || 0));
  }
  for (const [key, held] of claimed) {
    if (capacity.has(key)) capacity.set(key, round2(capacity.get(key)! - held));
  }

  // Candidate PO ids per item, earliest PO first.
  const posByItem = new Map<string, MatchPo[]>();
  for (const key of capacity.keys()) {
    const [poId, item] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    posByItem.set(item, [...(posByItem.get(item) || []), poById.get(poId)!]);
  }
  for (const list of posByItem.values()) {
    list.sort((a, b) => String(a.trandate || '').localeCompare(String(b.trandate || ''))
      || String(a.tranid || '').localeCompare(String(b.tranid || '')));
  }

  const plans: RequestPlan[] = [];
  const oldestFirst = [...requests].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const req of oldestFirst) {
    if (!req.vendor_name && !req.vendor_netsuite_id) continue;
    const item = normalizeItemNumber(req.item_number);
    const candidates = posByItem.get(item);
    if (!candidates) continue;
    const raised = shopDate(req.created_at);
    const blocked = new Set(req.auto_match_blocked_po_ids || []);
    let need = Number(req.quantity) || 0;
    const allocations: RequestPlan['allocations'] = [];
    for (const po of candidates) {
      if (need <= 0) break;
      if (blocked.has(po.id)) continue;
      if (NON_ORDER_PO_STATUSES.includes(String(po.status || '').toUpperCase())) continue;
      if (!po.trandate || po.trandate.slice(0, 10) < raised) continue;
      if (!sameVendor(req, po)) continue;
      const key = `${po.id}|${item}`;
      const left = capacity.get(key) || 0;
      if (left <= 0) continue;
      const take = round2(Math.min(left, need));
      allocations.push({ poId: po.id, quantity: take });
      capacity.set(key, round2(left - take));
      need = round2(need - take);
    }
    if (allocations.length > 0) plans.push({ requestId: req.id, allocations, remainder: Math.max(0, need) });
  }
  return plans;
}

export interface AutoMatchResult {
  pending: number;
  matched: number;
  split: number;
  errors: number;
  error?: string;
}

const chunk = <T,>(xs: T[], n = 200): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * Load pending requests + candidate PO lines, plan, and write the matches.
 * Never throws — callers run it as a tail step of a sync.
 */
export async function autoMatchPurchaseRequests(service: SupabaseClient): Promise<AutoMatchResult> {
  const result: AutoMatchResult = { pending: 0, matched: 0, split: 0, errors: 0 };
  // Hand-marked requests whose PO has just arrived from NetSuite link first,
  // so the lines they hold count as taken in the match below.
  await linkManualOrders(service);
  try {
    // Rows claimed by an in-flight Create PO (ordered_by set) are left alone.
    const { data: requests, error: reqErr } = await fetchAllRows<any>((from, to) =>
      service.from('purchase_requests')
        .select('*')
        .eq('status', 'pending')
        .is('ordered_by', null)
        .order('created_at')
        .order('id')
        .range(from, to),
    );
    if (reqErr) throw reqErr;
    const eligible = (requests as any[]).filter(r => r.vendor_name || r.vendor_netsuite_id);
    result.pending = requests.length;
    if (eligible.length === 0) return result;

    const minDate = eligible.map(r => shopDate(r.created_at)).sort()[0];
    const { data: pos, error: poErr } = await fetchAllRows<MatchPo>((from, to) =>
      service.from('netsuite_vendor_pos')
        .select('id, netsuite_id, tranid, vendor_name, vendor_netsuite_id, trandate, status')
        .gte('trandate', minDate)
        .order('id')
        .range(from, to),
    );
    if (poErr) throw poErr;
    if (pos.length === 0) return result;

    const items = [...new Set(eligible.map(r => normalizeItemNumber(r.item_number)))];
    const poIds = pos.map(p => p.id);
    const lines: MatchLine[] = [];
    const claimed = new Map<string, number>();
    for (const ids of chunk(poIds)) {
      for (const itemChunk of chunk(items)) {
        const { data, error } = await fetchAllRows<MatchLine>((from, to) =>
          service.from('netsuite_vendor_po_lines')
            .select('id, po_id, item_number, quantity')
            .in('po_id', ids)
            .in('item_number', itemChunk)
            .order('id')
            .range(from, to),
        );
        if (error) throw error;
        lines.push(...data);
      }
      const { data: held, error: heldErr } = await fetchAllRows<any>((from, to) =>
        service.from('purchase_requests')
          .select('id, ordered_po_id, item_number, quantity')
          .eq('status', 'ordered')
          .in('ordered_po_id', ids)
          .order('id')
          .range(from, to),
      );
      if (heldErr) throw heldErr;
      for (const h of held) {
        const key = `${h.ordered_po_id}|${normalizeItemNumber(h.item_number)}`;
        claimed.set(key, round2((claimed.get(key) || 0) + (Number(h.quantity) || 0)));
      }
    }
    if (lines.length === 0) return result;

    const plans = planRequestMatches(eligible, pos, lines, claimed);
    const reqById = new Map(eligible.map(r => [r.id as string, r]));
    const poById = new Map(pos.map(p => [p.id, p]));
    const nowIso = new Date().toISOString();

    // Everyone who asked hears once per PO.
    type Heard = { userId: string; poId: string; rows: { id: string; label: string }[] };
    const heard = new Map<string, Heard>();

    for (const plan of plans) {
      const req = reqById.get(plan.requestId)!;
      const orderedAt = (poId: string) => {
        const d = poById.get(poId)?.trandate;
        const at = d ? `${d.slice(0, 10)}T17:00:00.000Z` : nowIso;
        return at > req.created_at ? at : req.created_at;
      };
      const [first, ...rest] = plan.allocations;

      // Guarded on the row still being the pending, unclaimed, same-quantity
      // row we planned from — a Create PO or a qty edit in between wins.
      const { data: stamped, error: stampErr } = await service.from('purchase_requests')
        .update({
          status: 'ordered',
          quantity: first.quantity,
          ordered_po_id: first.poId,
          ordered_at: orderedAt(first.poId),
          ordered_match: 'auto',
          updated_at: nowIso,
        })
        .eq('id', req.id)
        .eq('status', 'pending')
        .is('ordered_by', null)
        .eq('quantity', req.quantity)
        .select('id');
      if (stampErr) { result.errors++; console.error('auto-match: stamp failed:', stampErr); continue; }
      if (!stamped || stamped.length === 0) continue;
      result.matched++;

      const copy = {
        item_number: req.item_number,
        netsuite_item_id: req.netsuite_item_id,
        description: req.description,
        vendor_name: req.vendor_name,
        vendor_netsuite_id: req.vendor_netsuite_id,
        source_project_id: req.source_project_id,
        source_estimate_id: req.source_estimate_id ?? null,
        needed_by: req.needed_by,
        note: req.note,
        requested_by: req.requested_by,
        source: req.source,
        created_at: req.created_at,
        split_from_id: req.split_from_id || req.id,
        auto_match_blocked_po_ids: req.auto_match_blocked_po_ids || [],
      };
      const extraRows = [
        ...rest.map(a => ({
          ...copy, quantity: a.quantity, status: 'ordered', ordered_po_id: a.poId,
          ordered_at: orderedAt(a.poId), ordered_match: 'auto', updated_at: nowIso,
        })),
        ...(plan.remainder > 0 ? [{ ...copy, quantity: plan.remainder, status: 'pending', updated_at: nowIso }] : []),
      ];
      let inserted: { id: string; ordered_po_id: string | null }[] = [];
      if (extraRows.length > 0) {
        const { data, error } = await service.from('purchase_requests').insert(extraRows).select('id, ordered_po_id');
        if (error) {
          // The original row now says only part of what was asked — put it
          // back rather than lose the rest of the request.
          result.errors++;
          console.error('auto-match: split insert failed, reverting:', error);
          await service.from('purchase_requests').update({
            status: 'pending', quantity: req.quantity, ordered_po_id: null, ordered_at: null, ordered_match: null, updated_at: nowIso,
          }).eq('id', req.id);
          result.matched--;
          continue;
        }
        inserted = (data || []) as any[];
        if (plan.remainder > 0) result.split++;
      }

      const orderedRows = [{ id: req.id, ordered_po_id: first.poId }, ...inserted.filter(r => r.ordered_po_id)];
      for (const row of orderedRows) {
        const poId = row.ordered_po_id!;
        const qty = plan.allocations.find(a => a.poId === poId)?.quantity ?? 0;
        if (req.requested_by) {
          const key = `${req.requested_by}|${poId}`;
          const entry: Heard = heard.get(key) || { userId: req.requested_by, poId, rows: [] };
          entry.rows.push({ id: row.id, label: `${qty}× ${req.item_number}` });
          heard.set(key, entry);
        }
        if (req.source_project_id) await linkProjectToPo(service, req.source_project_id, poById.get(poId)!);
      }
    }

    for (const { userId, poId, rows } of heard.values()) {
      const po = poById.get(poId);
      try {
        await notifyMany([userId], {
          type: 'purchase_request_ordered',
          title: `📦 Ordered — PO ${po?.tranid || ''}${po?.vendor_name ? ` (${po.vendor_name})` : ''}`.trim(),
          body: rows.map(r => r.label).join(' · ').slice(0, 900),
          url: deepLinks.purchaseRequests(rows.length === 1 ? rows[0].id : null),
          channels: ['in_app', 'push'] as ('in_app' | 'push')[],
        });
      } catch (err) {
        console.error('auto-match: notify failed:', err);
      }
    }
  } catch (err: any) {
    result.error = String(err?.message || err).slice(0, 300);
    console.error('auto-match: failed:', err);
  }
  return result;
}

/** Same bookkeeping as Create PO: the project's PO join row, and the
 *  first-PO scalar stamp that Parts Mail matches ETA emails against. */
async function linkProjectToPo(service: SupabaseClient, projectId: string, po: MatchPo): Promise<void> {
  try {
    await service.from('upfit_project_pos').upsert(
      { project_id: projectId, po_id: po.id, po_number: po.tranid, source: 'request_queue' },
      { onConflict: 'project_id,po_id', ignoreDuplicates: true },
    );
    if (po.netsuite_id) {
      await service.from('upfit_projects').update({
        netsuite_vendor_po_id: po.netsuite_id,
        netsuite_vendor_po_number: po.tranid,
      }).eq('id', projectId).is('netsuite_vendor_po_id', null);
      await service.from('upfit_projects')
        .update({ parts_ordered_date: po.trandate?.slice(0, 10) || null })
        .eq('id', projectId)
        .is('parts_ordered_date', null);
    }
  } catch (err) {
    console.error('auto-match: project PO link failed:', err);
  }
}

/**
 * Undo an automatic match: the row goes back to pending, any pending
 * remainder split off the same request folds back into it, and this PO is
 * remembered so the next sync doesn't re-match it straight back.
 */
export async function unmatchPurchaseRequest(service: SupabaseClient, id: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data: row, error } = await service.from('purchase_requests').select('*').eq('id', id).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!row) return { ok: false, status: 404, error: 'That request no longer exists.' };
  if (row.status === 'ordered' && row.ordered_match === 'manual') {
    // A hand mark has no split and no PO to block: it just goes back.
    const { error: upErr } = await service.from('purchase_requests').update({
      status: 'pending',
      ordered_po_id: null,
      ordered_po_number: null,
      ordered_at: null,
      ordered_by: null,
      ordered_match: null,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id).eq('status', 'ordered');
    if (upErr) return { ok: false, status: 500, error: upErr.message };
    return { ok: true };
  }
  if (row.status !== 'ordered' || row.ordered_match !== 'auto') {
    return { ok: false, status: 409, error: 'Only requests matched automatically or marked ordered by hand can be undone here.' };
  }

  const root = row.split_from_id || row.id;
  const { data: siblings } = await service.from('purchase_requests')
    .select('id, quantity')
    .eq('status', 'pending')
    .or(`id.eq.${root},split_from_id.eq.${root}`)
    .neq('id', row.id);
  const pendingSiblings = (siblings || []) as { id: string; quantity: number }[];
  const quantity = round2(Number(row.quantity) + pendingSiblings.reduce((s, r) => s + (Number(r.quantity) || 0), 0));
  const blocked = [...new Set([...(row.auto_match_blocked_po_ids || []), row.ordered_po_id].filter(Boolean))];

  const { error: upErr } = await service.from('purchase_requests').update({
    status: 'pending',
    quantity,
    ordered_po_id: null,
    ordered_at: null,
    ordered_match: null,
    auto_match_blocked_po_ids: blocked,
    updated_at: new Date().toISOString(),
  }).eq('id', row.id).eq('status', 'ordered');
  if (upErr) return { ok: false, status: 500, error: upErr.message };

  if (pendingSiblings.length > 0) {
    await service.from('purchase_requests').delete().in('id', pendingSiblings.map(r => r.id));
  }
  return { ok: true };
}

// ── Mark ordered by hand (migration 347) ──────────────────────────────────

/** "po 1234", "#PO1234" and "PO1234" are all the same PO number. */
export function normalizePoNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s#]/g, '');
}

/** tranids the typed number could be: as typed, and with or without the
 *  PO prefix, so "1234" finds PO1234 and "PO1234" finds a bare 1234. */
export function poNumberCandidates(raw: string): string[] {
  const n = normalizePoNumber(raw);
  if (!n) return [];
  const bare = n.startsWith('PO') ? n.slice(2) : n;
  return [...new Set([n, bare, `PO${bare}`].filter(Boolean))];
}

/** The mirrored NetSuite PO a typed number names, newest first if several. */
export async function findVendorPoByNumber(service: SupabaseClient, raw: string): Promise<MatchPo | null> {
  const candidates = poNumberCandidates(raw);
  if (candidates.length === 0) return null;
  const { data, error } = await service.from('netsuite_vendor_pos')
    .select('id, netsuite_id, tranid, vendor_name, vendor_netsuite_id, trandate, status')
    .in('tranid', candidates)
    .order('trandate', { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) throw error;
  return ((data || []) as MatchPo[])[0] || null;
}

export interface MarkOrderedResult {
  marked: number;
  /** The mirrored PO the requests now point at; null = not synced yet. */
  po: MatchPo | null;
  /** Parts that aren't lines on the linked PO — worth a second look. */
  notOnPo: string[];
}

/**
 * An admin marks pending requests ordered on a PO they placed outside the
 * queue. The PO number is required; when the PO is already mirrored the
 * requests link to it (and take its vendor), otherwise linkManualOrders
 * links them once the sync brings it in.
 */
export async function markRequestsOrdered(
  service: SupabaseClient,
  opts: { ids: string[]; poNumber: string; userId: string },
): Promise<{ ok: true; result: MarkOrderedResult } | { ok: false; status: number; error: string }> {
  const poNumber = normalizePoNumber(opts.poNumber);
  if (!poNumber) return { ok: false, status: 400, error: 'Enter the PO number the parts were ordered on.' };

  const { data: rows, error } = await service.from('purchase_requests').select('*').in('id', opts.ids);
  if (error) return { ok: false, status: 500, error: error.message };
  if (!rows || rows.length !== opts.ids.length) {
    return { ok: false, status: 404, error: 'Some requests no longer exist — refresh the queue.' };
  }
  const notPending = (rows as any[]).filter(r => r.status !== 'pending' || r.ordered_by);
  if (notPending.length > 0) {
    return { ok: false, status: 409, error: `Already ${notPending[0].status === 'pending' ? 'being ordered' : notPending[0].status}: ${notPending.map(r => r.item_number).join(', ')} — refresh the queue.` };
  }

  let po: MatchPo | null;
  try {
    po = await findVendorPoByNumber(service, poNumber);
  } catch (err: any) {
    return { ok: false, status: 500, error: String(err?.message || err) };
  }

  const nowIso = new Date().toISOString();
  const { data: stamped, error: upErr } = await service.from('purchase_requests')
    .update({
      status: 'ordered',
      ordered_match: 'manual',
      ordered_po_number: po?.tranid || poNumber,
      ordered_po_id: po?.id || null,
      ordered_at: nowIso,
      ordered_by: opts.userId,
      ...(po?.vendor_name ? { vendor_name: po.vendor_name } : {}),
      ...(po?.vendor_netsuite_id ? { vendor_netsuite_id: po.vendor_netsuite_id } : {}),
      updated_at: nowIso,
    })
    .in('id', opts.ids)
    .eq('status', 'pending')
    .is('ordered_by', null)
    .select('id');
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  const stampedIds = new Set(((stamped || []) as any[]).map(r => r.id as string));
  const marked = (rows as any[]).filter(r => stampedIds.has(r.id));

  let notOnPo: string[] = [];
  if (po) {
    const { data: lines } = await service.from('netsuite_vendor_po_lines').select('item_number').eq('po_id', po.id);
    const onPo = new Set(((lines || []) as any[]).map(l => normalizeItemNumber(l.item_number)));
    notOnPo = [...new Set(marked.filter(r => !onPo.has(normalizeItemNumber(r.item_number))).map(r => r.item_number as string))];
    for (const pid of new Set(marked.map(r => r.source_project_id).filter(Boolean))) {
      await linkProjectToPo(service, pid as string, po);
    }
  }

  await notifyOrdered(marked, po?.tranid || poNumber, po?.vendor_name || null, opts.userId);
  return { ok: true, result: { marked: marked.length, po, notOnPo } };
}

/**
 * Hand-marked requests whose PO wasn't mirrored yet: link each to its PO
 * once the sync has brought it in. Never throws — it runs ahead of the
 * auto-match on every sync.
 */
export async function linkManualOrders(service: SupabaseClient): Promise<number> {
  let linked = 0;
  try {
    const { data: rows, error } = await service.from('purchase_requests')
      .select('id, ordered_po_number, source_project_id')
      .eq('status', 'ordered')
      .eq('ordered_match', 'manual')
      .is('ordered_po_id', null)
      .not('ordered_po_number', 'is', null)
      .limit(500);
    if (error) throw error;
    const byNumber = new Map<string, any[]>();
    for (const r of (rows || []) as any[]) {
      byNumber.set(r.ordered_po_number, [...(byNumber.get(r.ordered_po_number) || []), r]);
    }
    for (const [number, group] of byNumber) {
      const po = await findVendorPoByNumber(service, number);
      if (!po) continue;
      const { error: upErr } = await service.from('purchase_requests')
        .update({
          ordered_po_id: po.id,
          ordered_po_number: po.tranid || number,
          ...(po.vendor_name ? { vendor_name: po.vendor_name } : {}),
          ...(po.vendor_netsuite_id ? { vendor_netsuite_id: po.vendor_netsuite_id } : {}),
          updated_at: new Date().toISOString(),
        })
        .in('id', group.map(r => r.id))
        .is('ordered_po_id', null);
      if (upErr) { console.error('link-manual-orders: update failed:', upErr); continue; }
      linked += group.length;
      for (const pid of new Set(group.map(r => r.source_project_id).filter(Boolean))) {
        await linkProjectToPo(service, pid as string, po);
      }
    }
  } catch (err) {
    console.error('link-manual-orders: failed:', err);
  }
  return linked;
}

/** Requesters hear their parts were ordered — one note each, linking the
 *  exact request when it's their only one (a digest links the queue). */
async function notifyOrdered(rows: any[], poLabel: string, vendorName: string | null, actorId: string): Promise<void> {
  const byRequester = new Map<string, any[]>();
  for (const r of rows) {
    if (!r.requested_by || r.requested_by === actorId) continue;
    byRequester.set(r.requested_by, [...(byRequester.get(r.requested_by) || []), r]);
  }
  for (const [uid, theirs] of byRequester) {
    try {
      await notifyMany([uid], {
        type: 'purchase_request_ordered',
        title: `📦 Ordered — PO ${poLabel}${vendorName ? ` (${vendorName})` : ''}`.trim(),
        body: theirs.map(r => `${r.quantity}× ${r.item_number}`).join(' · ').slice(0, 900),
        url: deepLinks.purchaseRequests(theirs.length === 1 ? theirs[0].id : null),
        channels: ['in_app', 'push'] as ('in_app' | 'push')[],
      });
    } catch (err) {
      console.error('mark-ordered: notify failed:', err);
    }
  }
}
