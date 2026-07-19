import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface PoRef {
  tranid: string | null;
  vendor_name: string | null;
  trandate: string | null;
  status_label: string | null;
  eta_date: string | null;
  remaining: number;
}

interface PartRow {
  item_number: string;
  description: string | null;
  needed: number;
  on_hand: number;
  on_order: number;
  short: number;
  pos: PoRef[];
}

/**
 * GET /api/upfit-projects/parts-readiness?id=<projectId>
 *
 * The part-level math the shop actually needs: for the project's sales
 * order, per part — how many we need, how many are on hand (live from
 * NetSuite), and how many are on order across ALL open vendor POs (synced
 * netsuite_vendor_pos, matched purely on part number — vendor POs are
 * created separately from the SO, so document links don't exist).
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const projectId = req.nextUrl.searchParams.get('id');
  if (!projectId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data: project } = await service
    .from('upfit_projects')
    .select('id, netsuite_so_id, netsuite_so_number')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (!project.netsuite_so_id || !/^\d+$/.test(project.netsuite_so_id)) {
    return NextResponse.json({ available: false, reason: 'no_sales_order' });
  }

  // ── What the sales order needs (live) ──
  let soLines: any[];
  try {
    soLines = await suiteqlQueryAll(`
      SELECT tl.item, i.itemid AS item_number, tl.memo AS description, tl.quantity
      FROM transactionline tl
      LEFT JOIN item i ON tl.item = i.id
      WHERE tl.transaction = ${project.netsuite_so_id}
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND tl.item IS NOT NULL
    `);
  } catch (e: any) {
    return NextResponse.json({ available: false, reason: 'netsuite_error', error: String(e?.message || e).slice(0, 200) });
  }

  const parts = new Map<string, PartRow & { itemIds: Set<string> }>();
  for (const line of soLines) {
    const key = normalizeItemNumber(line.item_number);
    if (!key) continue;
    const row = parts.get(key) || {
      item_number: key, description: null, needed: 0, on_hand: 0, on_order: 0, short: 0,
      pos: [], itemIds: new Set<string>(),
    };
    row.needed += Math.abs(parseFloat(line.quantity || '0')) || 0;
    if (!row.description && line.description) row.description = line.description;
    if (line.item) row.itemIds.add(String(line.item));
    parts.set(key, row);
  }

  if (parts.size === 0) {
    return NextResponse.json({ available: true, soNumber: project.netsuite_so_number, parts: [], summary: { covered: 0, onOrder: 0, short: 0 } });
  }

  // ── On hand (live — netsuite_parts sync can lag). Prefer "available"
  //    (on hand minus committed) — the honest schedulable number — with a
  //    fallback when the account doesn't expose it. ──
  const allItemIds = [...new Set([...parts.values()].flatMap(p => [...p.itemIds]))];
  try {
    let invRows: any[];
    try {
      invRows = await suiteqlQueryAll(`
        SELECT i.id, i.itemid AS item_number, i.totalquantityonhand AS qty, i.totalquantityavailable AS avail
        FROM item i
        WHERE i.id IN (${allItemIds.join(', ')})
      `);
    } catch {
      invRows = await suiteqlQueryAll(`
        SELECT i.id, i.itemid AS item_number, i.totalquantityonhand AS qty
        FROM item i
        WHERE i.id IN (${allItemIds.join(', ')})
      `);
    }
    for (const inv of invRows) {
      const row = parts.get(normalizeItemNumber(inv.item_number));
      if (!row) continue;
      const onHand = Math.max(0, parseFloat(inv.qty || '0') || 0);
      const avail = inv.avail != null ? Math.max(0, parseFloat(inv.avail || '0') || 0) : onHand;
      row.on_hand = avail;
    }
  } catch { /* non-inventory items have no on-hand — leave 0 */ }

  // ── On order across all open vendor POs (synced, matched on part number) ──
  const { data: poLines } = await service
    .from('netsuite_vendor_po_lines')
    .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(tranid, vendor_name, trandate, status, status_label, eta_date)')
    .in('item_number', [...parts.keys()]);

  for (const l of poLines || []) {
    const po = (l as any).netsuite_vendor_pos;
    if (!isOpenPoStatus(po?.status)) continue;
    const remaining = Math.max(0, (l.quantity || 0) - (l.quantity_received || 0));
    if (remaining <= 0) continue;
    const row = parts.get(l.item_number);
    if (!row) continue;
    row.on_order += remaining;
    row.pos.push({
      tranid: po?.tranid || null,
      vendor_name: po?.vendor_name || null,
      trandate: po?.trandate || null,
      status_label: po?.status_label || po?.status || null,
      eta_date: po?.eta_date || null,
      remaining,
    });
  }

  const rows: PartRow[] = [...parts.values()].map(({ itemIds: _ids, ...row }) => ({
    ...row,
    short: Math.max(0, row.needed - row.on_hand - row.on_order),
  }));
  // Shortages first, then parts still riding on a PO, then covered.
  rows.sort((a, b) => (b.short - a.short) || (b.on_order - a.on_order) || a.item_number.localeCompare(b.item_number));

  const summary = {
    covered: rows.filter(r => r.short === 0 && r.needed <= r.on_hand).length,
    onOrder: rows.filter(r => r.short === 0 && r.needed > r.on_hand).length,
    short: rows.filter(r => r.short > 0).length,
    // ready: every part in stock now · waiting: covered once POs land ·
    // short: something isn't even on order yet
    verdict: rows.some(r => r.short > 0) ? 'short' : rows.some(r => r.needed > r.on_hand) ? 'waiting' : 'ready',
    // Latest ETA across the POs still owed parts — the earliest realistic
    // schedule date when waiting.
    lastEta: rows.filter(r => r.needed > r.on_hand).flatMap(r => r.pos.map(p => p.eta_date)).filter(Boolean).sort().pop() || null,
  };

  return NextResponse.json({ available: true, soNumber: project.netsuite_so_number, parts: rows, summary });
}
