import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTotals, normalizeDiscount } from '@/lib/estimate-totals';
import { resolveLineTaxability } from '@/lib/line-taxability';
import { FALLBACK_SALES_TAX_RATE } from '@/lib/sales-tax';
import { FALLBACK_LABOR_RATE } from '@/lib/labor-rate';
import { findItems } from '@/lib/netsuite';
import { WRAP_VINYL_ITEM, WRAP_LABOR_ITEM, kitLineSplit } from '@/lib/graphics-invoice';
import { linkQuoteJobsToEstimate } from '@/lib/graphics-links';
import { getSalesTaxRate } from '@/lib/sales-tax';
import { getDefaultLaborRate } from '@/lib/labor-rate';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';

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
    .select('quantity, unit_price, labor_hours, taxable, discount_type, discount_value')
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

/**
 * "Save & open estimate" from the Graphics Builder: the wrap quote is the
 * worksheet, the estimate is what the customer receives (Craig, 2026-10-13).
 *
 * A quote that already belongs to an estimate re-folds its lines into it
 * (same replace semantics as addWrapQuoteToEstimate, so a re-priced quote
 * updates the estimate in place). A quote with no estimate gets a draft
 * estimate created for its customer and vehicle, then the lines. Either
 * way the caller lands on the estimate.
 *
 * `attach` is only applied when the caller sends it (a quote that was never
 * on an estimate defaults to everything on: proof, files, vinyl details).
 * `targetEstimateId` is the estimate the rep arrived from (?forEstimate):
 * a quote not yet on any estimate joins that one instead of getting a new
 * draft, which is how the first save after "Add Graphics" links up.
 */
export async function openEstimateForWrapQuote(
  supabase: SupabaseClient,
  wrapQuoteId: string,
  userId: string | null,
  attach?: WrapQuoteAttach,
  targetEstimateId?: string | null,
): Promise<{ status: number; body: any }> {
  const { data: quote } = await supabase
    .from('wrap_quotes')
    .select('id, quote_number, vehicle_description, customer_id, customer, project_type, project_notes, estimate_id, estimate_attach, template_id, materials_total, labor_total')
    .eq('id', wrapQuoteId)
    .maybeSingle();
  if (!quote) return result({ error: 'Wrap quote not found' }, { status: 404 });

  // Already on an estimate (or the rep came from one): refresh its lines
  // there and go.
  const existingId = quote.estimate_id || targetEstimateId || null;
  if (existingId) {
    const { data: est } = await supabase
      .from('estimates')
      .select('id, estimate_number, netsuite_estimate_number')
      .eq('id', existingId)
      .maybeSingle();
    if (est) {
      const priced = (parseFloat(quote.materials_total) || 0) > 0 || (parseFloat(quote.labor_total) || 0) > 0;
      // An unpriced quote still opens its estimate — the lines land once
      // it has amounts. A locked estimate (accepted / converted) is
      // reported, not silently skipped.
      if (priced) {
        const r = await addWrapQuoteToEstimate(supabase, est.id, wrapQuoteId, attach);
        if (r.status === 409) return r;
      } else if (!quote.estimate_id) {
        // Unpriced but arriving from an estimate: link now, lines later.
        await supabase.from('wrap_quotes').update({
          estimate_id: est.id,
          ...(attach ? { estimate_attach: attach } : {}),
          updated_at: new Date().toISOString(),
        }).eq('id', wrapQuoteId);
        await linkQuoteJobsToEstimate(supabase, wrapQuoteId, est.id);
      }
      return result({ success: true, estimateId: est.id, estimateNumber: est.estimate_number, netsuiteEstimateNumber: est.netsuite_estimate_number, created: false });
    }
    // The estimate it pointed at is gone — fall through and make a new one.
  }

  // No estimate yet: create a draft for the quote's customer + vehicle.
  let customerNsId: string | null = null;
  let customerName: string = String(quote.customer?.name || '').trim();
  if (quote.customer_id) {
    const { data: cust } = await supabase
      .from('customers')
      .select('company_name, netsuite_id')
      .eq('id', quote.customer_id)
      .maybeSingle();
    if (cust) {
      customerNsId = cust.netsuite_id || null;
      customerName = customerName || cust.company_name || '';
    }
  }
  if (!customerName) {
    return result({ error: 'Pick a customer on the Price & Estimate tab first — the estimate needs one.' }, { status: 400 });
  }

  // Vehicle: the template's year rides in vehicle_year; the description
  // (year make model) goes in vehicle_other, which the estimate shows as the
  // vehicle until someone picks a platform.
  let vehicleYear: string | null = null;
  if (quote.template_id) {
    const { data: tpl } = await supabase.from('vehicle_templates').select('year').eq('id', quote.template_id).maybeSingle();
    if (tpl?.year) vehicleYear = String(tpl.year).trim() || null;
  }
  const vehicle = String(quote.vehicle_description || '').trim();
  if (!vehicleYear) {
    const m = vehicle.match(/\b(19|20)\d{2}\b/);
    if (m) vehicleYear = m[0];
  }
  const vehicleOther = vehicle ? vehicle.replace(/^\s*(19|20)\d{2}\s*/, '').trim().slice(0, 120) || null : null;

  const taxRate = await getSalesTaxRate(supabase);
  const laborRate = await getDefaultLaborRate(supabase);
  const estimateNumber = await nextJobNumber(supabase, 'EST', legacyJobNumber.est);
  const title = [quote.project_type || 'Vehicle graphics', vehicle || null].filter(Boolean).join(' — ');

  const { data: estimate, error: estErr } = await supabase
    .from('estimates')
    .insert({
      estimate_number: estimateNumber,
      customer_id: quote.customer_id || null,
      customer_name: customerName,
      customer_netsuite_id: customerNsId,
      title,
      notes: quote.project_notes || null,
      status: 'draft',
      tax_rate: taxRate,
      tax_exempt: false,
      labor_rate: laborRate,
      labor_hours: 0,
      subtotal: 0,
      labor_total: 0,
      tax_amount: 0,
      grand_total: 0,
      vehicle_year: vehicleYear,
      vehicle_other: vehicleOther,
      created_by: userId,
    })
    .select('id, estimate_number')
    .single();
  if (estErr || !estimate) return result({ error: estErr?.message || 'Could not create the estimate' }, { status: 500 });

  // Link first, so an unpriced quote still belongs to its estimate.
  await supabase.from('wrap_quotes').update({
    estimate_id: estimate.id,
    estimate_attach: attach || quote.estimate_attach || { diagram: true, attachments: true, films: true },
    updated_at: new Date().toISOString(),
  }).eq('id', wrapQuoteId);
  await linkQuoteJobsToEstimate(supabase, wrapQuoteId, estimate.id);

  const priced = (parseFloat(quote.materials_total) || 0) > 0 || (parseFloat(quote.labor_total) || 0) > 0;
  if (priced) {
    const r = await addWrapQuoteToEstimate(supabase, estimate.id, wrapQuoteId, attach);
    if (r.status >= 400) return r;
  }
  return result({ success: true, estimateId: estimate.id, estimateNumber: estimate.estimate_number, netsuiteEstimateNumber: null, created: true });
}
