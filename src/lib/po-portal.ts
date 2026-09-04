/**
 * Customer PO-status portal — the customer-safe projection of a customer's
 * purchase orders (migration 260).
 *
 * ONE builder for everything a customer may see about their POs, so the
 * shared-link page (and any future logged-in surface) can never leak an
 * internal field by accident: every value below is chosen, named and
 * worded for the customer. Internal jargon (flagged jobs, invoice checks,
 * location overrides, notes) never leaves this file.
 *
 * Status is derived, not stored: a PO's own status is nearly binary
 * (open/complete), while the motion the customer cares about lives in the
 * child graphics jobs and the per-line install scans. The PO stage is the
 * SLOWEST of its parts — "Shipped" with one of two jobs still printing
 * would be a lie.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { r2PresignGet } from './r2';
import { carrierTrackingUrl } from './deep-links';

export type PortalStageKey =
  | 'received' | 'in_design' | 'in_production' | 'ready' | 'shipped'
  | 'in_progress' | 'fulfilled' | 'closed' | 'cancelled';

export interface PortalStage { key: PortalStageKey; label: string; color: string; detail?: string }

export const PORTAL_STAGES: Record<PortalStageKey, { label: string; color: string; rank: number }> = {
  received:      { label: 'Received',       color: '#64748b', rank: 0 },
  in_design:     { label: 'In design',      color: '#8b5cf6', rank: 1 },
  in_production: { label: 'In production',  color: '#3b82f6', rank: 2 },
  ready:         { label: 'Ready',          color: '#0ea5e9', rank: 3 },
  shipped:       { label: 'Shipped',        color: '#2563eb', rank: 4 },
  in_progress:   { label: 'Installing',     color: '#f59e0b', rank: 5 },
  fulfilled:     { label: 'Fulfilled',      color: '#16a34a', rank: 6 },
  closed:        { label: 'Closed',         color: '#475569', rank: 7 },
  cancelled:     { label: 'Cancelled',      color: '#9ca3af', rank: 8 },
};

/** Plain-language collapse of the 14 internal graphics statuses. Flagged
 *  jobs are admin-only (nobody has confirmed them yet) and are excluded
 *  before this map is consulted. */
const JOB_STAGE: Record<string, PortalStageKey> = {
  received: 'received',
  designing: 'in_design', revision: 'in_design',
  printing: 'in_production', outgassing: 'in_production', cutting: 'in_production', packing: 'in_production',
  ready: 'ready', ready_to_pickup: 'ready',
  shipped: 'shipped',
  picked_up: 'shipped',
  installed: 'fulfilled',
};
const JOB_LABEL: Record<string, string> = {
  received: 'Received', designing: 'In design', revision: 'In design',
  printing: 'In production', outgassing: 'In production', cutting: 'In production', packing: 'In production',
  ready: 'Ready', ready_to_pickup: 'Ready for pickup', shipped: 'Shipped', picked_up: 'Picked up', installed: 'Installed',
};
const JOB_TERMINAL = new Set(['installed', 'picked_up']);

export interface PortalVehicle { vin: string; label: string; installedAt: string | null; location: string | null }
export interface PortalLine {
  id: string;
  partNumber: string;
  description: string | null;
  quantity: number;
  installed: number;
  vehicles: PortalVehicle[];
}
export interface PortalJob {
  id: string;
  jobNumber: string | null;
  title: string;
  status: string;
  statusLabel: string;
  dueDate: string | null;
  scheduledInstallDate: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  updatedAt: string | null;
}
export interface PortalInvoice { number: string | null; date: string | null; status: 'open' | 'paid' | null; dueDate: string | null }
export interface PortalFile { name: string; url: string }
export interface PortalPo {
  id: string;
  poNumber: string;
  status: string;
  stage: PortalStage;
  receivedAt: string | null;
  orderedDate: string | null;
  requestedDeliveryDate: string | null;
  shipTo: string | null;
  buyerName: string | null;
  ordered: number;
  installed: number;
  lines: PortalLine[];
  jobs: PortalJob[];
  invoices: PortalInvoice[];
  files: PortalFile[];
  /** Older fulfilled/closed POs are listed as a summary only. */
  detail: boolean;
}
export interface PortalData {
  company: { name: string };
  generatedAt: string;
  summary: { open: number; inProduction: number; installing: number; fulfilled90d: number; total: number };
  pos: PortalPo[];
}

const DETAIL_WINDOW_DAYS = 90;
const OLDER_CAP = 300;

const num = (v: unknown) => parseFloat(String(v ?? 0)) || 0;

function shipToLabel(s: any): string | null {
  if (!s || typeof s !== 'object') return null;
  const parts = [s.name, s.address, [s.city, s.state].filter(Boolean).join(', '), s.zip].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function vehicleLabel(s: any): string {
  const desc = [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ');
  return desc || `VIN …${String(s.vin || '').slice(-8)}`;
}

/** Derive the customer-facing stage of one PO from its parts. */
export function derivePoStage(po: { status: string }, lines: { quantity: number; installed: number }[], jobs: { status: string }[]): PortalStage {
  const mk = (key: PortalStageKey, detail?: string): PortalStage => ({ key, label: PORTAL_STAGES[key].label, color: PORTAL_STAGES[key].color, detail });
  if (po.status === 'cancelled') return mk('cancelled');
  if (po.status === 'closed') return mk('closed');
  if (po.status === 'complete') return mk('fulfilled');
  const ordered = lines.reduce((s, l) => s + num(l.quantity), 0);
  const installed = lines.reduce((s, l) => s + Math.min(num(l.installed), num(l.quantity)), 0);
  const active = jobs.filter(j => !JOB_TERMINAL.has(j.status));
  if (active.length > 0) {
    // The slowest job sets the PO's stage.
    const slowest = active
      .map(j => JOB_STAGE[j.status] || 'received')
      .sort((a, b) => PORTAL_STAGES[a].rank - PORTAL_STAGES[b].rank)[0];
    if (installed > 0 && PORTAL_STAGES[slowest].rank >= PORTAL_STAGES.shipped.rank) {
      return mk('in_progress', `${installed} of ${ordered} installed`);
    }
    return mk(slowest, active.length > 1 ? `${active.length} jobs` : undefined);
  }
  if (installed > 0) return mk('in_progress', `${installed} of ${ordered} installed`);
  return mk('received');
}

/**
 * Everything the portal shows for one customer. `netsuiteId` is the
 * scoping key: purchase_orders.customer_netsuite_id is a real id (unlike
 * the name-matched vehicle portal), so nothing from another customer can
 * slip in through a similar company name.
 */
export async function buildPoPortalData(
  service: SupabaseClient,
  customer: { netsuite_id: string; company_name: string | null },
): Promise<PortalData> {
  const { data: pos } = await fetchAllRows<any>((from, to) =>
    service
      .from('purchase_orders')
      .select('id, po_number, status, ordered_date, requested_delivery_date, ship_to, buyer_name, created_at')
      .eq('customer_netsuite_id', customer.netsuite_id)
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to),
  );

  const cutoff = new Date(Date.now() - DETAIL_WINDOW_DAYS * 86_400_000).toISOString();
  const detailPos = pos.filter(p => p.status === 'open' || (p.created_at || '') >= cutoff);
  const olderPos = pos.filter(p => !detailPos.includes(p)).slice(0, OLDER_CAP);
  const detailIds = detailPos.map(p => p.id);

  const chunk = <T,>(arr: T[], n: number) => { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const loadByPo = async <T,>(table: string, select: string, poCol: string, ids: string[], order: string): Promise<T[]> => {
    const all: T[] = [];
    for (const ids200 of chunk(ids, 200)) {
      const { data } = await fetchAllRows<T>((from, to) =>
        // A dynamic select string types as an error row; the caller names T.
        service.from(table).select(select).in(poCol, ids200).order(order).order('id').range(from, to) as unknown as
          PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
      );
      all.push(...data);
    }
    return all;
  };

  const [lines, jobs, scans, invoices, files] = await Promise.all([
    loadByPo<any>('po_line_items', 'id, po_id, part_number, description, quantity, installed', 'po_id', detailIds, 'part_number'),
    loadByPo<any>('graphics_jobs', 'id, po_id, job_number, title, status, due_date, scheduled_install_date, carrier, tracking_number, updated_at', 'po_id', detailIds, 'created_at'),
    loadByPo<any>('scan_logs', 'id, po_id, po_line_item_id, vin, vehicle_year, vehicle_make, vehicle_model, location_name, scanned_at', 'po_id', detailIds, 'scanned_at'),
    loadByPo<any>('po_invoices', 'id, purchase_order_id, netsuite_invoice_number, ns_status, due_date, created_at', 'purchase_order_id', detailIds, 'created_at'),
    loadByPo<any>('po_files', 'id, po_id, file_name, file_type, storage_path, uploaded_at', 'po_id', detailIds, 'uploaded_at'),
  ]);

  const by = <T extends { [k: string]: any }>(rows: T[], key: string) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = String(r[key]); const arr = m.get(k) || []; arr.push(r); m.set(k, arr); }
    return m;
  };
  const linesBy = by(lines, 'po_id');
  const jobsBy = by(jobs.filter(j => j.status !== 'flagged' && j.status !== 'cancelled'), 'po_id');
  const scansBy = by(scans, 'po_line_item_id');
  const invoicesBy = by(invoices, 'purchase_order_id');
  const filesBy = by(files.filter(f => (f.file_type || '').includes('pdf') || /\.pdf$/i.test(f.file_name || '')), 'po_id');

  const buildPo = async (p: any, detail: boolean): Promise<PortalPo> => {
    const poLines = detail ? (linesBy.get(p.id) || []) : [];
    const poJobs = detail ? (jobsBy.get(p.id) || []) : [];
    const stage = derivePoStage(p, poLines, poJobs);
    const lineViews: PortalLine[] = poLines.map(l => ({
      id: l.id,
      partNumber: l.part_number,
      description: l.description,
      quantity: num(l.quantity),
      installed: num(l.installed),
      vehicles: (scansBy.get(l.id) || []).map(s => ({
        vin: s.vin,
        label: vehicleLabel(s),
        installedAt: s.scanned_at,
        location: s.location_name || null,
      })),
    }));
    const fileViews: PortalFile[] = await Promise.all((filesBy.get(p.id) || []).slice(0, 5).map(async f => ({
      name: f.file_name,
      // Presigned, one hour — the token gates the page, the file must not
      // sit on a permanent public URL (the proof-approval lesson).
      url: await r2PresignGet('graphics-proofs', f.storage_path, { disposition: 'inline', expiresIn: 3600 }),
    })));
    return {
      id: p.id,
      poNumber: p.po_number,
      status: p.status,
      stage,
      receivedAt: p.created_at || null,
      orderedDate: p.ordered_date || null,
      requestedDeliveryDate: p.requested_delivery_date || null,
      shipTo: shipToLabel(p.ship_to),
      buyerName: p.buyer_name || null,
      ordered: lineViews.reduce((s, l) => s + l.quantity, 0),
      installed: lineViews.reduce((s, l) => s + Math.min(l.installed, l.quantity), 0),
      lines: lineViews,
      jobs: poJobs.map(j => ({
        id: j.id,
        jobNumber: j.job_number || null,
        title: j.title || `Job ${j.job_number || ''}`.trim(),
        status: j.status,
        statusLabel: JOB_LABEL[j.status] || 'In progress',
        dueDate: j.due_date || null,
        scheduledInstallDate: j.scheduled_install_date || null,
        carrier: j.carrier || null,
        trackingNumber: j.tracking_number || null,
        trackingUrl: j.tracking_number ? carrierTrackingUrl(j.carrier, j.tracking_number) : null,
        updatedAt: j.updated_at || null,
      })),
      invoices: (invoicesBy.get(p.id) || []).map(i => ({
        number: i.netsuite_invoice_number || null,
        date: i.created_at || null,
        status: i.ns_status === 'paid' ? 'paid' : i.ns_status === 'open' ? 'open' : null,
        dueDate: i.due_date || null,
      })),
      files: fileViews,
      detail,
    };
  };

  const detailViews = await Promise.all(detailPos.map(p => buildPo(p, true)));
  const olderViews = await Promise.all(olderPos.map(p => buildPo(p, false)));
  const all = [...detailViews, ...olderViews];

  const fulfilled90 = detailViews.filter(p => p.stage.key === 'fulfilled' || p.stage.key === 'closed').length;
  return {
    company: { name: customer.company_name || 'Your company' },
    generatedAt: new Date().toISOString(),
    summary: {
      open: all.filter(p => p.status === 'open').length,
      inProduction: all.filter(p => ['in_design', 'in_production', 'ready', 'shipped'].includes(p.stage.key)).length,
      installing: all.filter(p => p.stage.key === 'in_progress').length,
      fulfilled90d: fulfilled90,
      total: pos.length,
    },
    pos: all,
  };
}
