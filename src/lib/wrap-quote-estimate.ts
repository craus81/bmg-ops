import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTotals, normalizeDiscount } from '@/lib/estimate-totals';
import { resolveLineTaxability } from '@/lib/line-taxability';
import { FALLBACK_SALES_TAX_RATE } from '@/lib/sales-tax';
import { FALLBACK_LABOR_RATE } from '@/lib/labor-rate';
import { findItems } from '@/lib/netsuite';
import { WRAP_VINYL_ITEM, WRAP_LABOR_ITEM, kitLineSplit } from '@/lib/graphics-invoice';
import { linkQuoteJobsToEstimate } from '@/lib/graphics-links';

export interface WrapQuoteAttach {
  diagram?: boolean;
  attachments?: boolean;
  films?: boolean;
}

function result(body: any, init?: { status?: number }) {
  return { status: init?.status ?? 200, body };
}

/**
 * Fold a saved wrap quote into an estimate as line items (the "Add
 * Graphics" round trip). Shared by POST /api/estimates/[id]/add-wrap-quote
 * and by /api/graphics/create-estimate, which folds in the wrap quote a
 * graphics job came from.
 *
 * Lines mirror the wrap quote's own NetSuite mapping exactly — materials
 * on WRAP_VINYL_ITEM (kit-split like the NS push), labor on
 * WRAP_LABOR_ITEM — resolved to real NS item ids up front, so the
 * estimate stays pushable with no manual matching. Replace semantics:
 * existing lines from this quote are deleted first, so edit-quote →
 * re-add updates in place instead of duplicating. Estimate totals are
 * recomputed server-side.
 *
 * Returns the HTTP status and JSON body the route answers with.
 */
export async function addWrapQuoteToEstimate(
  supabase: SupabaseClient,
  estimateId: string,
  wrapQuoteId: string,
  attach?: WrapQuoteAttach,
): Promise<{ status: number; body: any }> {
  const [{ data: estimate }, { data: quote }] = await Promise.all([
    supabase.from('estimates').select('id, tax_rate, tax_exempt, labor_rate, labor_hours_override, customer_approved, status, netsuite_so_id, vehicle_count, discount_type, discount_value').eq('id', estimateId).maybeSingle(),
    supabase.from('wrap_quotes').select('id, quote_number, vehicle_description, materials_total, labor_total, package_qty').eq('id', wrapQuoteId).maybeSingle(),
  ]);
  if (!estimate) return result({ error: 'Estimate not found' }, { status: 404 });
  if (!quote) return result({ error: 'Wrap quote not found' }, { status: 404 });

  // The same wall add-lines has (its :58-63) — this route deletes and
  // rewrites lines AND totals, and had no lock at all: anyone could click
  // "Add Graphics" on a signed or even CONVERTED estimate and move its
  // grand total under the frozen snapshot (Round 3 finding).
  if (estimate.netsuite_so_id) {
    return result({ error: 'This estimate was already converted to a Sales Order — start a new estimate instead.' }, { status: 409 });
  }
  if (estimate.customer_approved || estimate.status === 'accepted') {
    return result({ error: 'This estimate was accepted by the customer — its contents are locked. Start a new estimate instead.' }, { status: 409 });
  }

  const materials = parseFloat(quote.materials_total) || 0;
  const labor = parseFloat(quote.labor_total) || 0;
  if (materials <= 0 && labor <= 0) {
    return result({ error: 'The wrap quote has no material or labor amounts yet — price it first.' }, { status: 400 });
  }

  // Resolve the two standing NS items. Best-effort: if NetSuite is
  // unreachable the lines land unmatched and the builder's existing
  // "Match NetSuite item" flow covers them before push.
  let vinylId: string | null = null;
  let laborId: string | null = null;
  try {
    const items = await findItems([WRAP_VINYL_ITEM, WRAP_LABOR_ITEM]);
    vinylId = items[WRAP_VINYL_ITEM.toUpperCase()]?.id || null;
    laborId = items[WRAP_LABOR_ITEM.toUpperCase()]?.id || null;
  } catch { /* NS down — lines still land, unmatched */ }

  const kitQty = Math.max(1, parseInt(quote.package_qty, 10) || 1);
  const vinylSplit = kitLineSplit(materials, kitQty);
  const vehicle = quote.vehicle_description || null;

  // Replace any lines this quote already put on the estimate.
  await supabase.from('estimate_line_items').delete().eq('estimate_id', estimateId).eq('wrap_quote_id', wrapQuoteId);

  const { data: maxRow } = await supabase
    .from('estimate_line_items')
    .select('sort_order')
    .eq('estimate_id', estimateId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  let sort = (maxRow?.sort_order ?? -1) + 1;

  const lineRows = [
    ...(materials > 0 ? [{
      estimate_id: estimateId,
      sort_order: sort++,
      wrap_quote_id: wrapQuoteId,
      netsuite_item_id: vinylId,
      item_number: WRAP_VINYL_ITEM,
      description: `Vehicle graphics${vehicle ? ` — ${vehicle}` : ''}${kitQty > 1 ? ` (${kitQty} kits)` : ''} — ${quote.quote_number}`,
      quantity: vinylSplit.quantity,
      unit_price: vinylSplit.rate,
      line_total: Math.round(vinylSplit.quantity * vinylSplit.rate * 100) / 100,
      labor_hours: 0,
      is_custom: !vinylId,
    }] : []),
    ...(labor > 0 ? [{
      estimate_id: estimateId,
      sort_order: sort++,
      wrap_quote_id: wrapQuoteId,
      netsuite_item_id: laborId,
      item_number: WRAP_LABOR_ITEM,
      description: `Graphics install${vehicle ? ` — ${vehicle}` : ''} — ${quote.quote_number}`,
      quantity: 1,
      unit_price: Math.round(labor * 100) / 100,
      line_total: Math.round(labor * 100) / 100,
      // Priced, not houred: wrap labor is billed at graphics rates inside
      // the quote total — hours here would double-count at the estimate's
      // shop labor rate.
      labor_hours: 0,
      is_custom: !laborId,
    }] : []),
  ];
  // Stamp each new line's sales-tax answer (migration 336) so the totals
  // below and the NetSuite push agree with what the builder would quote.
  const stampedRows = await resolveLineTaxability(supabase, lineRows);
  const { error: insertErr } = await supabase.from('estimate_line_items').insert(stampedRows);
  if (insertErr) return result({ error: insertErr.message }, { status: 500 });

  // Record the linkage (+ what the quote contributes to the estimate's
  // customer PDF, when the estimator sent its checkboxes) and refresh the
  // estimate's stored totals.
  await supabase.from('wrap_quotes').update({
    estimate_id: estimateId,
    ...(attach ? { estimate_attach: attach } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', wrapQuoteId);

  const { data: allLines } = await supabase
    .from('estimate_line_items')
    .select('quantity, unit_price, labor_hours, taxable')
    .eq('estimate_id', estimateId);
  const totals = computeTotals(
    allLines || [],
    // Keep the estimate's own quoted rate; the company setting only fills
    // in for a row saved before tax_rate existed.
    parseFloat(String(estimate.tax_rate ?? FALLBACK_SALES_TAX_RATE)),
    !!estimate.tax_exempt,
    parseFloat(String(estimate.labor_rate ?? FALLBACK_LABOR_RATE)),
    estimate.labor_hours_override !== null && estimate.labor_hours_override !== undefined
      ? parseFloat(String(estimate.labor_hours_override))
      : null,
    // Without the count, adding a line to a 12-vehicle estimate would
    // recompute its totals at one vehicle and quietly divide it by 12.
    (estimate as any).vehicle_count,
    // A percent discount grows with the new lines; a dollar one stays put.
    normalizeDiscount((estimate as any).discount_type, (estimate as any).discount_value),
  );
  await supabase.from('estimates').update({
    labor_hours: totals.labor_hours,
    subtotal: totals.subtotal,
    labor_total: totals.labor_total,
    discount_amount: totals.discount_amount,
    tax_amount: totals.tax_amount,
    grand_total: totals.grand_total,
    updated_at: new Date().toISOString(),
  }).eq('id', estimateId);

  // A graphics job already made from this quote now belongs to this
  // estimate too, so invoicing and the estimate approval reach it (a job
  // only ever had the link it was created from).
  await linkQuoteJobsToEstimate(supabase, wrapQuoteId, estimateId);

  return result({
    success: true,
    linesAdded: lineRows.length,
    matched: !!(vinylId || materials <= 0) && !!(laborId || labor <= 0),
  });
}
