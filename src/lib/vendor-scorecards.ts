import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Vendor scorecards (R5-11): buyers picked vendors and believed promised
 * dates on memory. This rolls up what the system already watches — POs and
 * spend (netsuite_vendor_pos), arrivals (po_receipts, since m241 ~Aug
 * 2026), and promises (po_eta_events, R5-2's append-only capture) — into
 * per-vendor reality: actual lead time, promised-vs-actual, slip
 * frequency/magnitude, and short-ship rate.
 *
 * History honesty: receipts and ETA events accrue only from their capture
 * ship dates, so early numbers are thin — the loader reports each stream's
 * earliest record and the UI must label it. NULL beats a lying zero.
 */

export interface VendorPoFacts {
  poId: string;
  vendor: string;
  tranid: string | null;
  trandate: string | null; // YYYY-MM-DD
  total: number;
}

export interface VendorStats {
  vendor: string;
  poCount: number;
  spend: number;
  /** PO date → FIRST receipt, whole days, median over received POs. */
  medianLeadDays: number | null;
  leadSamples: number;
  /** First promised ETA vs FINAL receipt day, avg (positive = late). */
  avgPromiseMissDays: number | null;
  promiseSamples: number;
  /** ETA-change events that moved the date LATER. */
  slipCount: number;
  etaEvents: number;
  avgSlipDays: number | null;
  /** Received lines delivered short (received < ordered) vs lines received. */
  shortShipLines: number;
  receivedLines: number;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const dayDiff = (fromDay: string, toDay: string): number =>
  Math.round((Date.parse(toDay.slice(0, 10) + 'T00:00:00Z') - Date.parse(fromDay.slice(0, 10) + 'T00:00:00Z')) / 86_400_000);

export function summarizeVendors(
  pos: VendorPoFacts[],
  receipts: { poId: string; receivedAt: string }[],
  etaEvents: { poId: string; etaDate: string; previousEta: string | null; createdAt: string }[],
  lines: { poId: string; quantity: number; quantityReceived: number }[],
): VendorStats[] {
  const firstReceipt = new Map<string, string>();
  const lastReceipt = new Map<string, string>();
  for (const r of receipts) {
    const day = r.receivedAt.slice(0, 10);
    const first = firstReceipt.get(r.poId);
    if (!first || day < first) firstReceipt.set(r.poId, day);
    const last = lastReceipt.get(r.poId);
    if (!last || day > last) lastReceipt.set(r.poId, day);
  }

  // First promised ETA per PO = the earliest event's eta_date (events are
  // append-only; previous_eta NULL marks the PO's first promise).
  const firstEta = new Map<string, { at: string; eta: string }>();
  const slipsByPo = new Map<string, number[]>();
  const etaCountByPo = new Map<string, number>();
  for (const e of etaEvents) {
    const existing = firstEta.get(e.poId);
    if (!existing || e.createdAt < existing.at) firstEta.set(e.poId, { at: e.createdAt, eta: e.etaDate });
    etaCountByPo.set(e.poId, (etaCountByPo.get(e.poId) || 0) + 1);
    if (e.previousEta && e.etaDate > e.previousEta) {
      const arr = slipsByPo.get(e.poId) || [];
      arr.push(dayDiff(e.previousEta, e.etaDate));
      slipsByPo.set(e.poId, arr);
    }
  }

  const shortByPo = new Map<string, { short: number; received: number }>();
  for (const l of lines) {
    if (!(l.quantityReceived > 0)) continue;
    const entry = shortByPo.get(l.poId) || { short: 0, received: 0 };
    entry.received++;
    if (l.quantityReceived < l.quantity) entry.short++;
    shortByPo.set(l.poId, entry);
  }

  const byVendor = new Map<string, VendorPoFacts[]>();
  for (const po of pos) {
    const key = (po.vendor || '').trim() || '(no vendor)';
    const arr = byVendor.get(key) || [];
    arr.push(po);
    byVendor.set(key, arr);
  }

  const out: VendorStats[] = [];
  for (const [vendor, vendorPos] of byVendor) {
    const leads: number[] = [];
    const promiseMisses: number[] = [];
    let slipCount = 0, etaCount = 0, shortShip = 0, receivedLines = 0;
    const slipDays: number[] = [];
    for (const po of vendorPos) {
      const first = firstReceipt.get(po.poId);
      if (po.trandate && first) {
        const d = dayDiff(po.trandate, first);
        if (d >= 0 && d <= 365) leads.push(d);
      }
      const promised = firstEta.get(po.poId);
      const final = lastReceipt.get(po.poId);
      if (promised && final) promiseMisses.push(dayDiff(promised.eta, final));
      const slips = slipsByPo.get(po.poId) || [];
      slipCount += slips.length;
      slipDays.push(...slips);
      etaCount += etaCountByPo.get(po.poId) || 0;
      const short = shortByPo.get(po.poId);
      if (short) { shortShip += short.short; receivedLines += short.received; }
    }
    out.push({
      vendor,
      poCount: vendorPos.length,
      spend: Math.round(vendorPos.reduce((s, p) => s + p.total, 0) * 100) / 100,
      medianLeadDays: median(leads),
      leadSamples: leads.length,
      avgPromiseMissDays: promiseMisses.length > 0
        ? Math.round((promiseMisses.reduce((a, b) => a + b, 0) / promiseMisses.length) * 10) / 10
        : null,
      promiseSamples: promiseMisses.length,
      slipCount,
      etaEvents: etaCount,
      avgSlipDays: slipDays.length > 0
        ? Math.round((slipDays.reduce((a, b) => a + b, 0) / slipDays.length) * 10) / 10
        : null,
      shortShipLines: shortShip,
      receivedLines,
    });
  }
  return out.sort((a, b) => b.spend - a.spend);
}

export interface VendorScorecards {
  since: string;
  vendors: VendorStats[];
  /** Earliest captured record per stream — the thin-history labels. */
  receiptsSince: string | null;
  etaSince: string | null;
}

export async function loadVendorScorecards(service: SupabaseClient, sinceDays = 180): Promise<VendorScorecards> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);

  const { data: poRows, error: poErr } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_vendor_pos')
    .select('id, tranid, vendor_name, trandate, total')
    .gte('trandate', since)
    .order('trandate').order('id')
    .range(from, to));
  if (poErr) throw new Error('vendor POs: ' + poErr.message);
  const pos: VendorPoFacts[] = (poRows || []).map((p: any) => ({
    poId: p.id, vendor: p.vendor_name || '', tranid: p.tranid,
    trandate: p.trandate, total: Number(p.total) || 0,
  }));
  const poIds = pos.map(p => p.poId);
  const idSet = new Set(poIds);

  // Receipts and ETA events are young tables (m241 / m273) — read whole and
  // filter to the window's POs; also capture each stream's earliest record
  // for the honesty labels.
  const [receiptRes, etaRes] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from('po_receipts')
      .select('po_id, received_at')
      .order('received_at').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('po_eta_events')
      .select('po_id, eta_date, previous_eta, created_at')
      .order('created_at').order('id')
      .range(from, to)),
  ]);
  if (receiptRes.error) throw new Error('receipts: ' + receiptRes.error.message);
  if (etaRes.error) throw new Error('eta events: ' + etaRes.error.message);
  const allReceipts = receiptRes.data || [];
  const allEtas = etaRes.data || [];

  const receipts = allReceipts
    .filter((r: any) => idSet.has(r.po_id))
    .map((r: any) => ({ poId: r.po_id, receivedAt: r.received_at }));
  const etaEvents = allEtas
    .filter((e: any) => idSet.has(e.po_id))
    .map((e: any) => ({ poId: e.po_id, etaDate: e.eta_date, previousEta: e.previous_eta, createdAt: e.created_at }));

  const lines: { poId: string; quantity: number; quantityReceived: number }[] = [];
  for (let i = 0; i < poIds.length; i += 100) {
    const { data, error } = await fetchAllRows<any>((from, to) => service
      .from('netsuite_vendor_po_lines')
      .select('po_id, quantity, quantity_received')
      .in('po_id', poIds.slice(i, i + 100))
      .order('id')
      .range(from, to));
    if (error) throw new Error('po lines: ' + error.message);
    for (const l of data || []) {
      lines.push({ poId: l.po_id, quantity: Number(l.quantity) || 0, quantityReceived: Number(l.quantity_received) || 0 });
    }
  }

  return {
    since,
    vendors: summarizeVendors(pos, receipts, etaEvents, lines),
    receiptsSince: allReceipts[0]?.received_at?.slice(0, 10) || null,
    etaSince: allEtas[0]?.created_at?.slice(0, 10) || null,
  };
}

/** One-line buying-flow chip per vendor ("avg 8d late · 2 slips · 3 short lines"). */
export function vendorChipText(s: VendorStats): string | null {
  const parts: string[] = [];
  if (s.avgPromiseMissDays != null) {
    parts.push(s.avgPromiseMissDays > 0.5 ? `avg ${s.avgPromiseMissDays}d late vs promise`
      : s.avgPromiseMissDays < -0.5 ? `avg ${Math.abs(s.avgPromiseMissDays)}d early` : 'on promise');
  } else if (s.medianLeadDays != null) {
    parts.push(`~${s.medianLeadDays}d lead`);
  }
  if (s.slipCount > 0) parts.push(`${s.slipCount} ETA slip${s.slipCount !== 1 ? 's' : ''}`);
  if (s.shortShipLines > 0) parts.push(`${s.shortShipLines} short line${s.shortShipLines !== 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
