/**
 * The estimate-approval VIEW payload — the exact estimate/lines/graphics
 * shape the customer's approval page renders.
 *
 * Two callers build it and they must not drift: the public magic-link route
 * (/api/approve/estimate/[token]) loads it by token for the customer, and
 * the staff preview (/api/estimates/[id]/approval-preview) loads it by id so
 * staff can see what was sent WITHOUT holding the approval token. The token
 * is deliberately never given to a client — a staff holder could open the
 * customer's page and forge an acceptance (see stripApprovalSecrets in
 * src/app/api/estimates/route.ts) — so the preview keys off the estimate id
 * and its own staff guard instead.
 *
 * Server-only: callers pass a service-role Supabase client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadEstimateGraphics } from './estimate-graphics';
import { enrichLinesWithPartAssets } from './estimate-line-parts';

/** The estimate fields the customer-facing document is allowed to show. */
export function publicEstimate(est: any) {
  return {
    id: est.id,
    estimate_number: est.estimate_number,
    title: est.title,
    customer_name: est.customer_name,
    // Vehicle identity — the email/PDF/snapshot all show it; the approval
    // page must identify the same vehicle the customer is approving.
    vin: est.vin,
    unit_number: est.unit_number,
    vehicle_year: est.vehicle_year,
    vehicle_other: est.vehicle_other,
    vehicle_wheelbase: est.vehicle_wheelbase,
    vehicle_roof: est.vehicle_roof,
    po_number: est.po_number,
    expiration_date: est.expiration_date,
    tax_rate: est.tax_rate,
    tax_exempt: est.tax_exempt,
    tax_amount: est.tax_amount,
    labor_rate: est.labor_rate,
    labor_hours: est.labor_hours,
    labor_hours_override: est.labor_hours_override,
    labor_total: est.labor_total,
    subtotal: est.subtotal,
    grand_total: est.grand_total,
    notes: est.notes,
    install_instructions: est.install_instructions,
    on_site_contact_name: est.on_site_contact_name,
    on_site_contact_phone: est.on_site_contact_phone,
    delivery_preferences: est.delivery_preferences,
    customer_approved_at: est.customer_approved_at,
    customer_rejected_at: est.customer_rejected_at,
  };
}

/** Line fields the document renders, incl. the enriched part assets. */
export function publicLines(lines: any[]) {
  return (lines || []).map((l: any) => ({
    id: l.id,
    item_number: l.item_number,
    description: l.description,
    quantity: l.quantity,
    unit_price: l.unit_price,
    line_total: l.line_total,
    notes: l.notes,
    image_url: l.part_image_url || null,
    product_url: l.part_product_url || null,
  }));
}

/** Lines with their catalog photo + product link, in document order. */
export async function loadApprovalLines(service: SupabaseClient, estimateId: string) {
  const { data: lines } = await service
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', estimateId)
    .order('sort_order');
  return enrichLinesWithPartAssets(service, lines || []);
}

/**
 * The whole view payload for one estimate id — what the staff preview
 * renders, and the same three pieces the token route returns.
 */
export async function loadEstimateApprovalView(service: SupabaseClient, estimateId: string) {
  const { data: estimate } = await service
    .from('estimates')
    .select('*, vehicle_platforms(label)')
    .eq('id', estimateId)
    .maybeSingle();
  if (!estimate) return null;
  (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;

  const lines = await loadApprovalLines(service, estimate.id);
  const { summaries: graphics } = await loadEstimateGraphics(service, estimate.id);

  return {
    estimate: publicEstimate(estimate),
    lines: publicLines(lines),
    graphics,
    /** Terminal state, so the preview can say the link is already spent. */
    decided: estimate.customer_approved
      ? ('approved' as const)
      : estimate.customer_rejected_at
        ? ('rejected' as const)
        : null,
    sentAt: estimate.sent_for_approval_at || null,
  };
}
