import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { suiteqlQuery } from '@/lib/netsuite';
import { safeStringLiteral } from '@/lib/sql-safe';
import { fetchAllRows } from '@/lib/fetch-all';
import { z } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/vehicle-margin?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Per-VEHICLE job margin (R3-19): the whole picture for each invoiced
 * check-in — invoice revenue vs the parts bought for its project and the
 * installer's bill for its VIN. The two half-reports (installer-costs,
 * graphics-costs) each see one slice; nothing showed a vehicle end to end.
 *
 * Revenue: live NetSuite header totals for the vehicle's invoice numbers —
 * the legacy scalar plus every stamped per-SO ledger row (migration 261).
 * Parts (PO): synced vendor-PO line amounts for POs cut for the vehicle's
 * upfit project — the purchase_requests ordered_po_id join (many POs per
 * project) plus the project's first-PO column.
 * Parts (stock, est.): the project's reserved/consumed allocations priced
 * at the catalog's purchase_price (0 = unknown, skipped and counted).
 * Installer: vendor_invoice_lines matched on the VIN (full or last-8).
 * Labor: not captured yet — the column lights up when R3-21 lands.
 */
const Query = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const NETSUITE_LOOKUP_CAP = 200;
const num = (v: unknown) => parseFloat(String(v ?? 0)) || 0;
const chunk = <T,>(arr: T[], n: number) => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const parsed = Query.safeParse({ start: searchParams.get('start'), end: searchParams.get('end') });
  if (!parsed.success) {
    return NextResponse.json({ error: 'start and end are required as YYYY-MM-DD' }, { status: 400 });
  }
  const { start, end } = parsed.data;

  try {
    // ── The vehicles: invoiced in range (scalar date, or a per-SO ledger
    // stamp in range for vehicles whose scalar predates the window). ──
    const { data: byScalar } = await fetchAllRows<any>((from, to) => supabase
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, invoice_number, date_invoiced, netsuite_sales_order_id, sales_order_number')
      .gte('date_invoiced', start)
      .lte('date_invoiced', end)
      .order('id')
      .range(from, to));
    const { data: ledgerInRange } = await fetchAllRows<any>((from, to) => supabase
      .from('fleet_checkin_invoices')
      .select('fleet_checkin_id')
      .not('invoice_number', 'is', null)
      .gte('invoiced_at', `${start}T00:00:00Z`)
      .lte('invoiced_at', `${end}T23:59:59Z`)
      .order('id')
      .range(from, to));
    const checkinIds = new Set<string>(byScalar.map(c => c.id));
    const extraIds = [...new Set(ledgerInRange.map(l => l.fleet_checkin_id))].filter(id => !checkinIds.has(id));
    let extra: any[] = [];
    if (extraIds.length > 0) {
      for (const ids of chunk(extraIds, 100)) {
        const { data } = await supabase
          .from('fleet_checkins')
          .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, invoice_number, date_invoiced, netsuite_sales_order_id, sales_order_number')
          .in('id', ids);
        extra = extra.concat(data || []);
      }
    }
    const checkins = [...byScalar, ...extra];
    const allIds = checkins.map(c => c.id);

    // Per-SO ledger rows for every vehicle in the report (invoice numbers +
    // internal ids), regardless of when they were stamped.
    const ledgerByCheckin = new Map<string, { invoice_number: string; netsuite_invoice_id: string | null }[]>();
    for (const ids of chunk(allIds, 100)) {
      const { data } = await supabase
        .from('fleet_checkin_invoices')
        .select('fleet_checkin_id, invoice_number, netsuite_invoice_id')
        .in('fleet_checkin_id', ids)
        .not('invoice_number', 'is', null);
      for (const r of data || []) {
        const arr = ledgerByCheckin.get(r.fleet_checkin_id) || [];
        arr.push({ invoice_number: r.invoice_number, netsuite_invoice_id: r.netsuite_invoice_id });
        ledgerByCheckin.set(r.fleet_checkin_id, arr);
      }
    }

    // ── Revenue: NetSuite header totals per invoice tranid. ──
    const invoiceNumbersByCheckin = new Map<string, string[]>();
    const allTranids = new Set<string>();
    for (const c of checkins) {
      const nums = new Set<string>();
      if (c.invoice_number) nums.add(String(c.invoice_number));
      for (const l of ledgerByCheckin.get(c.id) || []) nums.add(String(l.invoice_number));
      invoiceNumbersByCheckin.set(c.id, [...nums]);
      for (const n of nums) allTranids.add(n);
    }
    const meta: Record<string, unknown> = {};
    const totalByTranid = new Map<string, number>();
    const tranids = [...allTranids];
    const capped = tranids.length > NETSUITE_LOOKUP_CAP;
    if (capped) meta.netsuiteCapped = { lookedUp: NETSUITE_LOOKUP_CAP, of: tranids.length };
    try {
      for (const batch of chunk(tranids.slice(0, NETSUITE_LOOKUP_CAP), 50)) {
        const literals = batch.map(t => `'${safeStringLiteral(t, 60)}'`).join(', ');
        const res = await suiteqlQuery(`
          SELECT t.tranid AS tranid, SUM(-tl.netamount) AS total
          FROM transaction t
          INNER JOIN transactionline tl ON tl.transaction = t.id
          WHERE t.type = 'CustInvc' AND UPPER(t.tranid) IN (${literals.toUpperCase()})
            AND tl.mainline = 'F' AND tl.taxline = 'F'
          GROUP BY t.tranid
        `);
        for (const row of res?.items || []) {
          totalByTranid.set(String(row.tranid).toUpperCase(), num(row.total));
        }
      }
    } catch (err: any) {
      meta.netsuiteError = String(err?.message || err).slice(0, 200);
    }

    // ── The project chain: check-in → upfit project → POs. ──
    const projByCheckin = new Map<string, { id: string; poNsIds: Set<string>; poNumbers: Set<string> }>();
    const soIds = [...new Set(checkins.map(c => c.netsuite_sales_order_id).filter(Boolean).map(String))];
    const projRows: any[] = [];
    for (const ids of chunk(allIds, 100)) {
      const { data } = await supabase
        .from('upfit_projects')
        .select('id, fleet_checkin_id, netsuite_so_id, netsuite_vendor_po_id, netsuite_vendor_po_number')
        .in('fleet_checkin_id', ids);
      projRows.push(...(data || []));
    }
    for (const ids of chunk(soIds, 100)) {
      const { data } = await supabase
        .from('upfit_projects')
        .select('id, fleet_checkin_id, netsuite_so_id, netsuite_vendor_po_id, netsuite_vendor_po_number')
        .in('netsuite_so_id', ids);
      projRows.push(...(data || []));
    }
    const soToCheckin = new Map(checkins.filter(c => c.netsuite_sales_order_id).map(c => [String(c.netsuite_sales_order_id), c.id]));
    for (const p of projRows) {
      const checkinId = (p.fleet_checkin_id && checkins.find(c => c.id === p.fleet_checkin_id)?.id)
        || (p.netsuite_so_id ? soToCheckin.get(String(p.netsuite_so_id)) : undefined);
      if (!checkinId) continue;
      const entry = projByCheckin.get(checkinId) || { id: p.id, poNsIds: new Set<string>(), poNumbers: new Set<string>() };
      if (p.netsuite_vendor_po_id) entry.poNsIds.add(String(p.netsuite_vendor_po_id));
      if (p.netsuite_vendor_po_number) entry.poNumbers.add(String(p.netsuite_vendor_po_number));
      projByCheckin.set(checkinId, entry);
    }
    const projectIds = [...new Set([...projByCheckin.values()].map(p => p.id))];

    // Many-POs-per-project: the ordered purchase requests, plus the join
    // table (migration 267) — which also carries manual links to POs cut
    // directly in NetSuite, the ones no other source can see.
    const poRowIdsByProject = new Map<string, Set<string>>();
    for (const ids of chunk(projectIds, 100)) {
      const [{ data: reqRows }, { data: linkRows }] = await Promise.all([
        supabase
          .from('purchase_requests')
          .select('source_project_id, ordered_po_id')
          .in('source_project_id', ids)
          .not('ordered_po_id', 'is', null),
        supabase
          .from('upfit_project_pos')
          .select('project_id, po_id')
          .in('project_id', ids),
      ]);
      for (const r of reqRows || []) {
        const set = poRowIdsByProject.get(r.source_project_id) || new Set<string>();
        set.add(r.ordered_po_id);
        poRowIdsByProject.set(r.source_project_id, set);
      }
      for (const r of linkRows || []) {
        const set = poRowIdsByProject.get(r.project_id) || new Set<string>();
        set.add(r.po_id);
        poRowIdsByProject.set(r.project_id, set);
      }
    }

    // Resolve the projects' first-PO columns (NetSuite internal id or
    // tranid) to mirror row ids, then price every PO by its line amounts.
    const allPoNsIds = [...new Set([...projByCheckin.values()].flatMap(p => [...p.poNsIds]))].filter(v => /^\d+$/.test(v));
    const allPoNumbers = [...new Set([...projByCheckin.values()].flatMap(p => [...p.poNumbers]))];
    const poRowIdByNsId = new Map<string, string>();
    const poRowIdByTranid = new Map<string, string>();
    for (const ids of chunk(allPoNsIds, 100)) {
      const { data } = await supabase.from('netsuite_vendor_pos').select('id, netsuite_id').in('netsuite_id', ids);
      for (const r of data || []) poRowIdByNsId.set(String(r.netsuite_id), r.id);
    }
    for (const nums of chunk(allPoNumbers, 100)) {
      const { data } = await supabase.from('netsuite_vendor_pos').select('id, tranid').in('tranid', nums);
      for (const r of data || []) if (r.tranid) poRowIdByTranid.set(String(r.tranid), r.id);
    }
    const poRowIdsByCheckin = new Map<string, Set<string>>();
    for (const [checkinId, p] of projByCheckin) {
      const set = new Set<string>();
      for (const nsId of p.poNsIds) { const row = poRowIdByNsId.get(nsId); if (row) set.add(row); }
      for (const tr of p.poNumbers) { const row = poRowIdByTranid.get(tr); if (row) set.add(row); }
      for (const row of poRowIdsByProject.get(p.id) || []) set.add(row);
      poRowIdsByCheckin.set(checkinId, set);
    }
    const allPoRowIds = [...new Set([...poRowIdsByCheckin.values()].flatMap(s => [...s]))];
    const poCostByRowId = new Map<string, number>();
    const poLabelByRowId = new Map<string, string>();
    for (const ids of chunk(allPoRowIds, 100)) {
      const [{ data: headers }, { data: lines }] = await Promise.all([
        supabase.from('netsuite_vendor_pos').select('id, tranid').in('id', ids),
        fetchAllRows<any>((from, to) => supabase
          .from('netsuite_vendor_po_lines')
          .select('po_id, amount')
          .in('po_id', ids)
          .order('id')
          .range(from, to)),
      ]);
      for (const h of headers || []) poLabelByRowId.set(h.id, h.tranid || h.id);
      for (const l of lines || []) {
        poCostByRowId.set(l.po_id, (poCostByRowId.get(l.po_id) || 0) + num(l.amount));
      }
    }

    // ── Stock parts (estimated): allocations × catalog purchase_price. ──
    const stockByProject = new Map<string, { cost: number; unpriced: number }>();
    if (projectIds.length > 0) {
      const { data: allocs } = await fetchAllRows<any>((from, to) => supabase
        .from('part_allocations')
        .select('project_id, item_number, quantity, status')
        .in('project_id', projectIds)
        .in('status', ['reserved', 'consumed'])
        .order('id')
        .range(from, to));
      const items = [...new Set((allocs || []).map(a => a.item_number))];
      const priceByItem = new Map<string, number>();
      for (const batch of chunk(items, 200)) {
        const { data } = await supabase
          .from('netsuite_parts').select('item_number, purchase_price').in('item_number', batch);
        for (const p of data || []) priceByItem.set(p.item_number, num(p.purchase_price));
      }
      for (const a of allocs || []) {
        const entry = stockByProject.get(a.project_id) || { cost: 0, unpriced: 0 };
        const price = priceByItem.get(a.item_number) || 0;
        // A synced price of 0 means "unknown", not free (the cost query can
        // fail and default the whole catalog to 0) — count, don't price.
        if (price > 0) entry.cost += price * (num(a.quantity) || 0);
        else entry.unpriced += 1;
        stockByProject.set(a.project_id, entry);
      }
    }
    const projectByCheckinId = new Map([...projByCheckin.entries()].map(([cid, p]) => [cid, p.id]));

    // ── Installer cost: vendor invoice lines matched on the VIN. ──
    const vinKey = (vin: string | null | undefined) => String(vin || '').trim().toUpperCase();
    const last8 = (vin: string) => vin.slice(-8);
    const vinToCheckin = new Map<string, string>();
    for (const c of checkins) {
      const v = vinKey(c.vin);
      if (!v) continue;
      vinToCheckin.set(v, c.id);
      if (v.length >= 8) vinToCheckin.set(last8(v), c.id);
    }
    const installerByCheckin = new Map<string, number>();
    if (vinToCheckin.size > 0) {
      const { data: vLines } = await fetchAllRows<any>((from, to) => supabase
        .from('vendor_invoice_lines')
        .select('vin, amount')
        .order('id')
        .range(from, to));
      for (const l of vLines || []) {
        const v = vinKey(l.vin);
        const checkinId = vinToCheckin.get(v) || (v.length >= 8 ? vinToCheckin.get(last8(v)) : undefined);
        if (!checkinId) continue;
        installerByCheckin.set(checkinId, (installerByCheckin.get(checkinId) || 0) + num(l.amount));
      }
    }

    // ── Assemble. ──
    const vehicles = checkins.map(c => {
      const invoiceNumbers = invoiceNumbersByCheckin.get(c.id) || [];
      const revenue = invoiceNumbers.reduce((s, n) => s + (totalByTranid.get(n.toUpperCase()) || 0), 0);
      const poRows = [...(poRowIdsByCheckin.get(c.id) || [])];
      const partsPo = poRows.reduce((s, id) => s + (poCostByRowId.get(id) || 0), 0);
      const projId = projectByCheckinId.get(c.id);
      const stock = projId ? stockByProject.get(projId) : undefined;
      const installer = installerByCheckin.get(c.id) || 0;
      const label = [c.vehicle_year, c.vehicle_make, c.vehicle_model].filter(Boolean).join(' ')
        || (c.vin ? `VIN …${String(c.vin).slice(-8)}` : 'Vehicle');
      return {
        checkinId: c.id,
        vin: c.vin || null,
        label,
        customer: c.customer_name || null,
        soNumber: c.sales_order_number || null,
        invoiceNumbers,
        dateInvoiced: c.date_invoiced || null,
        revenue: Math.round(revenue * 100) / 100,
        partsPo: Math.round(partsPo * 100) / 100,
        partsPoNumbers: poRows.map(id => poLabelByRowId.get(id) || '').filter(Boolean),
        partsStock: Math.round((stock?.cost || 0) * 100) / 100,
        partsUnpriced: stock?.unpriced || 0,
        installer: Math.round(installer * 100) / 100,
        labor: null as number | null,
        margin: Math.round((revenue - partsPo - (stock?.cost || 0) - installer) * 100) / 100,
      };
    }).sort((a, b) => (b.dateInvoiced || '').localeCompare(a.dateInvoiced || ''));

    const totals = vehicles.reduce((t, v) => ({
      vehicles: t.vehicles + 1,
      revenue: t.revenue + v.revenue,
      parts: t.parts + v.partsPo + v.partsStock,
      installer: t.installer + v.installer,
      margin: t.margin + v.margin,
    }), { vehicles: 0, revenue: 0, parts: 0, installer: 0, margin: 0 });
    for (const k of ['revenue', 'parts', 'installer', 'margin'] as const) totals[k] = Math.round(totals[k] * 100) / 100;

    return NextResponse.json({
      range: { start, end },
      vehicles,
      totals,
      meta: {
        ...meta,
        // Honest disclosure until R3-21: shop labor isn't captured per
        // vehicle yet, so margin excludes it.
        laborNote: 'Shop labor is not captured per vehicle yet (R3-21) — margin excludes it.',
      },
    });
  } catch (err: any) {
    console.error('vehicle-margin report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
