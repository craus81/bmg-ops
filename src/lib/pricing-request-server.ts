import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { pricingRequestStage, type PriceSheetSummary, type PricingRequest } from '@/lib/pricing-request';

/**
 * Server helpers for /api/pricing-requests (migration 352). Service-role
 * client only: the tables have RLS on and no policies.
 */

export const PRICING_REQUEST_SELECT =
  'id, request_number, customer_name, customer_netsuite_id, company_name, contact_name, contact_email, received_date, description, vehicle, status, part_number, install_part_number, part_id, install_part_id, part_price, install_price, po_id, linked_at, created_by, created_at, updated_at';

const SHEET_SELECT =
  'id, pricing_request_id, estimate_number, status, customer_approved, customer_rejected_at, customer_rejection_reason, grand_total, created_at';

/**
 * Each request's price sheet: the newest estimate marked with its id. With
 * `withLines`, the sheet's lines come along (the detail view and the PO
 * link read the quoted prices off them).
 */
export async function loadPriceSheets(
  service: SupabaseClient,
  requestIds: string[],
  { withLines = false } = {},
): Promise<Map<string, PriceSheetSummary>> {
  const out = new Map<string, PriceSheetSummary>();
  if (requestIds.length === 0) return out;
  const rows: any[] = [];
  // Chunked: a long id list would overflow the PostgREST URL.
  for (let i = 0; i < requestIds.length; i += 150) {
    const chunk = requestIds.slice(i, i + 150);
    const { data, error } = await fetchAllRows<any>((from, to) =>
      service.from('estimates').select(SHEET_SELECT)
        .in('pricing_request_id', chunk)
        .order('created_at', { ascending: false }).order('id')
        .range(from, to));
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
  }
  const newest = new Map<string, any>();
  for (const r of rows) {
    const cur = newest.get(r.pricing_request_id);
    if (!cur || String(r.created_at) > String(cur.created_at)) newest.set(r.pricing_request_id, r);
  }
  const linesBySheet = new Map<string, PriceSheetSummary['lines']>();
  if (withLines && newest.size > 0) {
    const sheetIds = Array.from(newest.values()).map(r => r.id);
    const { data: lineRows, error } = await service.from('estimate_line_items')
      .select('estimate_id, item_number, description, quantity, unit_price, sort_order')
      .in('estimate_id', sheetIds)
      .order('sort_order').order('id');
    if (error) throw new Error(error.message);
    for (const l of lineRows || []) {
      const list = linesBySheet.get(l.estimate_id) || [];
      list.push({ item_number: l.item_number, description: l.description, quantity: Number(l.quantity) || 0, unit_price: Number(l.unit_price) || 0 });
      linesBySheet.set(l.estimate_id, list);
    }
  }
  newest.forEach((r, requestId) => {
    out.set(requestId, {
      id: r.id,
      estimate_number: r.estimate_number,
      status: r.status,
      customer_approved: r.customer_approved,
      customer_rejected_at: r.customer_rejected_at,
      customer_rejection_reason: r.customer_rejection_reason,
      grand_total: r.grand_total == null ? null : Number(r.grand_total),
      lines: linesBySheet.get(r.id) || [],
    });
  });
  return out;
}

/** PO numbers for the requests already on a PO. */
export async function loadPoNumbers(service: SupabaseClient, poIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(poIds.filter(Boolean)));
  if (ids.length === 0) return out;
  const { data } = await service.from('purchase_orders').select('id, po_number').in('id', ids);
  for (const p of data || []) out.set(p.id, p.po_number);
  return out;
}

/** A request as the API returns it: the row plus its stage, price sheet and PO number. */
export function withStage(
  row: PricingRequest,
  sheet: PriceSheetSummary | null,
  poNumber: string | null,
) {
  return { ...row, stage: pricingRequestStage(row, sheet), sheet, po_number: poNumber };
}

/** The local customers row for a NetSuite customer: its id (the estimate
 *  builder's contact picker keys on it) and its tax-exempt default, which a
 *  new price sheet starts with, as a new estimate in the builder does. */
export async function customerForNetsuiteId(
  service: SupabaseClient,
  netsuiteId: string | null,
): Promise<{ id: string; tax_exempt: boolean } | null> {
  if (!netsuiteId) return null;
  const { data } = await service.from('customers').select('id, tax_exempt').eq('netsuite_id', netsuiteId).limit(1);
  const row = data?.[0];
  return row ? { id: row.id, tax_exempt: !!row.tax_exempt } : null;
}
