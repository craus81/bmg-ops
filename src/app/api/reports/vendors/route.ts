import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { loadVendorScorecards, vendorChipText } from '@/lib/vendor-scorecards';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/vendors (R5-11):
 *   ?days=90|180|365          — scorecard window (default 180)
 *   &chips=1                  — slim map for the purchasing queue's group
 *                               headers ("Meyer: avg 8d late · 2 slips")
 *   &vendor=<name>            — drill-in: that vendor's recent POs with
 *                               first-receipt state, the receipt history
 *                               view receiving never had, and price drift
 *                               per item from line rates.
 * Staff-guarded (the buying flow's audience, not just admins).
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const days = [90, 180, 365].includes(Number(searchParams.get('days'))) ? Number(searchParams.get('days')) : 180;
  const vendor = (searchParams.get('vendor') || '').trim();

  try {
    if (vendor) return NextResponse.json(await vendorDetail(vendor, days));

    const cards = await loadVendorScorecards(service, days);
    if (searchParams.get('chips') === '1') {
      const chips: Record<string, string> = {};
      for (const v of cards.vendors) {
        const text = vendorChipText(v);
        if (text) chips[v.vendor.toLowerCase()] = text;
      }
      return NextResponse.json({ days, chips });
    }
    return NextResponse.json({ days, ...cards });
  } catch (e: any) {
    console.error('vendors report failed:', e);
    return NextResponse.json({ error: e.message || 'Vendors report failed' }, { status: 500 });
  }
}

async function vendorDetail(vendor: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data: pos, error: poErr } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_vendor_pos')
    .select('id, tranid, trandate, status_label, total, eta_date')
    .eq('vendor_name', vendor)
    .gte('trandate', since)
    .order('trandate', { ascending: false }).order('id')
    .range(from, to));
  if (poErr) throw new Error(poErr.message);
  const poIds = (pos || []).map((p: any) => p.id);

  const firstReceipt = new Map<string, string>();
  const receipts: any[] = [];
  for (let i = 0; i < poIds.length; i += 100) {
    const { data } = await fetchAllRows<any>((from, to) => service
      .from('po_receipts')
      .select('po_id, item_number, description, quantity, received_at, note')
      .in('po_id', poIds.slice(i, i + 100))
      .order('received_at', { ascending: false }).order('id')
      .range(from, to));
    receipts.push(...(data || []));
  }
  for (const r of receipts) {
    const day = String(r.received_at).slice(0, 10);
    const existing = firstReceipt.get(r.po_id);
    if (!existing || day < existing) firstReceipt.set(r.po_id, day);
  }
  const tranidByPo = new Map<string, string>((pos || []).map((p: any) => [p.id, p.tranid || '—']));

  // Price drift per item over the window, from line rates ordered by PO date.
  const rateSightings = new Map<string, { first: { day: string; rate: number }; last: { day: string; rate: number }; buys: number }>();
  const dayByPo = new Map<string, string>((pos || []).map((p: any) => [p.id, p.trandate || '']));
  for (let i = 0; i < poIds.length; i += 100) {
    const { data } = await fetchAllRows<any>((from, to) => service
      .from('netsuite_vendor_po_lines')
      .select('po_id, item_number, rate')
      .in('po_id', poIds.slice(i, i + 100))
      .order('id')
      .range(from, to));
    for (const l of data || []) {
      const rate = l.rate != null ? Number(l.rate) : null;
      const day = dayByPo.get(l.po_id) || '';
      if (rate == null || !(rate > 0) || !l.item_number || !day) continue;
      const entry = rateSightings.get(l.item_number);
      if (!entry) {
        rateSightings.set(l.item_number, { first: { day, rate }, last: { day, rate }, buys: 1 });
      } else {
        entry.buys++;
        if (day < entry.first.day) entry.first = { day, rate };
        if (day >= entry.last.day) entry.last = { day, rate };
      }
    }
  }
  const priceDrift = [...rateSightings.entries()]
    .filter(([, s]) => s.buys >= 2 && s.first.rate !== s.last.rate)
    .map(([item, s]) => ({
      item,
      buys: s.buys,
      firstRate: s.first.rate,
      lastRate: s.last.rate,
      driftPct: Math.round(((s.last.rate - s.first.rate) / s.first.rate) * 1000) / 10,
    }))
    .sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))
    .slice(0, 20);

  return {
    vendor,
    days,
    pos: (pos || []).slice(0, 50).map((p: any) => ({
      id: p.id,
      tranid: p.tranid,
      trandate: p.trandate,
      status: p.status_label,
      total: Number(p.total) || 0,
      eta: p.eta_date,
      firstReceipt: firstReceipt.get(p.id) || null,
    })),
    receipts: receipts.slice(0, 100).map((r: any) => ({
      poTranid: tranidByPo.get(r.po_id) || '—',
      item: r.item_number,
      description: r.description,
      quantity: Number(r.quantity) || 0,
      receivedAt: r.received_at,
      note: r.note,
    })),
    priceDrift,
  };
}
