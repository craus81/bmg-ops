import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTotals, normalizeDiscount } from '@/lib/estimate-totals';
import { resolveLineTaxability } from '@/lib/line-taxability';
import { FALLBACK_SALES_TAX_RATE } from '@/lib/sales-tax';
import { FALLBACK_LABOR_RATE } from '@/lib/labor-rate';
import { findItems } from '@/lib/netsuite';
import { WRAP_VINYL_ITEM, WRAP_LABOR_ITEM } from '@/lib/graphics-invoice';
import { diffWrapEstimateLines, plannedWrapEstimateLines, type WrapLineEdit } from '@/lib/wrap-quote-estimate-lines';
import { linkQuoteJobsToEstimate } from '@/lib/graphics-links';
import { getSalesTaxRate } from '@/lib/sales-tax';
import { readPricingOverrides } from '@/lib/wrap-quote-price-override';
import { getDefaultLaborRate } from '@/lib/labor-rate';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';
import { snapshotReviewedContent, clearReviewIfContentChanged } from '@/lib/estimate-review-content';
import { TEMPLATE_COLUMNS, estimateVehicleFields, type PlatformLite, type VehicleTemplate } from '@/lib/vehicle-templates';

export interface WrapQuoteAttach {
  diagram?: boolean;
  attachments?: boolean;
  films?: boolean;
}

function result(body: any, init?: { status?: number }) {
  return { status: init?.status ?? 200, body };
}

// The estimate columns a worksheet's vehicle template writes, worked out the
// same way the estimate's own picker does (src/lib/vehicle-templates.ts).
async function templateVehicleFields(supabase: SupabaseClient, templateId: string | null | undefined) {
  if (!templateId) return null;
  const [{ data: tpl }, { data: platforms }] = await Promise.all([
    supabase.from('vehicle_templates').select(TEMPLATE_COLUMNS).eq('id', templateId).maybeSingle(),
    supabase.from('vehicle_platforms').select('id, key, config').eq('active', true),
  ]);
  if (!tpl) return null;
  return estimateVehicleFields(tpl as unknown as VehicleTemplate, {}, (platforms || []) as PlatformLite[]);
}

/**
 * Keep an estimate's vehicle the same as its worksheet's (Craig
 * 2026-10-19, "Same picker + sync"): every builder save writes the
 * worksheet's template onto the estimate. Left alone when the estimate is
 * locked (approved / on a sales order), when the worksheet draws on photos
 * (no template), when the estimate already has this template (so qualifiers
 * a rep fixed by hand survive), and when another worksheet on the estimate
 * draws a different vehicle — one estimate can't hold two.
 */
export async function syncEstimateVehicleFromQuote(
  supabase: SupabaseClient,
  estimateId: string,
  wrapQuoteId: string,
  templateId: string | null | undefined,
): Promise<boolean> {
  if (!templateId) return false;
  const [{ data: est }, { data: others }] = await Promise.all([
    supabase.from('estimates').select('id, vehicle_template_id, customer_approved, status, netsuite_so_id').eq('id', estimateId).maybeSingle(),
    supabase.from('wrap_quotes').select('id, template_id').eq('estimate_id', estimateId).neq('id', wrapQuoteId),
  ]);
  if (!est) return false;
  if (est.netsuite_so_id || est.customer_approved || est.status === 'accepted') return false;
  if (est.vehicle_template_id === templateId) return false;
  if ((others || []).some((o: { template_id: string | null }) => o.template_id && o.template_id !== templateId)) return false;
  const fields = await templateVehicleFields(supabase, templateId);
  if (!fields) return false;
  const { error } = await supabase.from('estimates').update(fields).eq('id', estimateId);
  return !error;
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
  /** A fleet sibling (src/lib/estimate-fleet.ts): refresh its lines only.
   *  The worksheet stays pinned to the estimate it was built on, and its
   *  graphics job keeps that link. */
  sibling = false,
): Promise<{ status: number; body: any }> {
  const [{ data: estimate }, { data: quote }] = await Promise.all([
    supabase.from('estimates').select('id, tax_rate, tax_exempt, labor_rate, labor_hours_override, customer_approved, status, netsuite_so_id, vehicle_count, discount_type, discount_value').eq('id', estimateId).maybeSingle(),
    supabase.from('wrap_quotes').select('id, quote_number, vehicle_description, materials_total, labor_total, package_qty, pricing_overrides').eq('id', wrapQuoteId).maybeSingle(),
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

  const planned = plannedWrapEstimateLines(quote);
  if (planned.length === 0) {
    return result({ error: 'The wrap quote has no material or labor amounts yet — price it first.' }, { status: 400 });
  }
  const materials = parseFloat(quote.materials_total) || 0;
  const labor = parseFloat(quote.labor_total) || 0;

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

  // A re-priced worksheet changes what an approved review looked at.
  const reviewedBefore = await snapshotReviewedContent(supabase, estimateId);

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

  // Materials on the vinyl item (kit-split), labor on the install item, and
  // the rep's own lines from the builder as plain custom lines. Labor is
  // priced, not houred: wrap labor is billed at graphics rates inside the
  // quote total — hours here would double-count at the estimate's shop
  // labor rate.
  const lineRows = planned.map(p => {
    const nsId = p.item_number === WRAP_VINYL_ITEM ? vinylId : p.item_number === WRAP_LABOR_ITEM ? laborId : null;
    return {
      estimate_id: estimateId,
      sort_order: sort++,
      wrap_quote_id: wrapQuoteId,
      netsuite_item_id: nsId,
      item_number: p.item_number,
      description: p.description,
      quantity: p.quantity,
      unit_price: p.unit_price,
      line_total: Math.round(p.quantity * p.unit_price * 100) / 100,
      labor_hours: 0,
      is_custom: p.is_custom || !nsId,
    };
  });
  // Stamp each new line's sales-tax answer (migration 336) so the totals
  // below and the NetSuite push agree with what the builder would quote.
  const stampedRows = await resolveLineTaxability(supabase, lineRows);
  const { error: insertErr } = await supabase.from('estimate_line_items').insert(stampedRows);
  if (insertErr) return result({ error: insertErr.message }, { status: 500 });

  // Record the linkage (+ what the quote contributes to the estimate's
  // customer PDF, when the estimator sent its checkboxes) and refresh the
  // estimate's stored totals.
  if (!sibling) {
    await supabase.from('wrap_quotes').update({
      estimate_id: estimateId,
      ...(attach ? { estimate_attach: attach } : {}),
      updated_at: new Date().toISOString(),
    }).eq('id', wrapQuoteId);
  }

  // The builder's Tax exempt switch decides the estimate's (a worksheet
  // saved before the switch existed leaves the estimate's checkbox alone).
  await refreshEstimateTotals(supabase, estimate, worksheetTaxExempt(quote) ?? !!estimate.tax_exempt);

  // A graphics job already made from this quote now belongs to this
  // estimate too, so invoicing and the estimate approval reach it (a job
  // only ever had the link it was created from).
  if (!sibling) await linkQuoteJobsToEstimate(supabase, wrapQuoteId, estimateId);

  const reviewCleared = await clearReviewIfContentChanged(supabase, estimateId, reviewedBefore, null);

  return result({
    success: true,
    reviewCleared,
    linesAdded: lineRows.length,
    matched: !!(vinylId || materials <= 0) && !!(laborId || labor <= 0),
  });
}

/** The worksheet's Tax exempt switch, or null when it was never set. */
function worksheetTaxExempt(quote: { pricing_overrides?: unknown }): boolean | null {
  return readPricingOverrides(quote.pricing_overrides)?.tax_exempt ?? null;
}

/**
 * Recompute an estimate's stored totals from its lines, saving `taxExempt`
 * on it at the same time so the checkbox and the tax line always agree.
 */
async function refreshEstimateTotals(supabase: SupabaseClient, estimate: any, taxExempt: boolean): Promise<void> {
  const estimateId = estimate.id;
  const { data: allLines } = await supabase
    .from('estimate_line_items')
    .select('quantity, unit_price, labor_hours, taxable, discount_type, discount_value')
    .eq('estimate_id', estimateId);
  const totals = computeTotals(
    allLines || [],
    // Keep the estimate's own quoted rate; the company setting only fills
    // in for a row saved before tax_rate existed.
    parseFloat(String(estimate.tax_rate ?? FALLBACK_SALES_TAX_RATE)),
    taxExempt,
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
    tax_exempt: taxExempt,
    tax_amount: totals.tax_amount,
    grand_total: totals.grand_total,
    updated_at: new Date().toISOString(),
  }).eq('id', estimateId);
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
  keepEstimateLines = false,
): Promise<{ status: number; body: any }> {
  const { data: quote } = await supabase
    .from('wrap_quotes')
    .select('id, quote_number, vehicle_description, customer_id, customer, project_type, project_notes, estimate_id, estimate_attach, template_id, materials_total, labor_total, package_qty, pricing_overrides')
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
      const priced = plannedWrapEstimateLines(quote).length > 0;
      // An unpriced quote still opens its estimate — the lines land once
      // it has amounts. A locked estimate (accepted / converted) is
      // reported, not silently skipped.
      let fleet: FleetSync | null = null;
      if (priced && !keepEstimateLines) {
        const r = await addWrapQuoteToEstimate(supabase, est.id, wrapQuoteId, attach);
        if (r.status === 409) return r;
        fleet = await syncFleetSiblings(supabase, est.id, wrapQuoteId);
      } else if (priced && attach) {
        // "Keep the estimate's numbers": the lines stay as they were edited
        // on the estimate; only the picture/files choices follow the save.
        await supabase.from('wrap_quotes').update({ estimate_attach: attach, updated_at: new Date().toISOString() }).eq('id', wrapQuoteId);
      }
      if (priced && keepEstimateLines) {
        // The lines stay, but the Tax exempt switch still follows the save.
        const exempt = worksheetTaxExempt(quote);
        if (exempt != null) {
          const { data: full } = await supabase.from('estimates').select('id, tax_rate, tax_exempt, labor_rate, labor_hours_override, customer_approved, status, netsuite_so_id, vehicle_count, discount_type, discount_value').eq('id', est.id).maybeSingle();
          if (full && exempt !== !!full.tax_exempt && !full.netsuite_so_id && !full.customer_approved && full.status !== 'accepted') {
            await refreshEstimateTotals(supabase, full, exempt);
          }
        }
      } else if (!quote.estimate_id) {
        // Unpriced but arriving from an estimate: link now, lines later.
        await supabase.from('wrap_quotes').update({
          estimate_id: est.id,
          ...(attach ? { estimate_attach: attach } : {}),
          updated_at: new Date().toISOString(),
        }).eq('id', wrapQuoteId);
        await linkQuoteJobsToEstimate(supabase, wrapQuoteId, est.id);
      }
      await syncEstimateVehicleFromQuote(supabase, est.id, wrapQuoteId, quote.template_id);
      return result({ success: true, estimateId: est.id, estimateNumber: est.estimate_number, netsuiteEstimateNumber: est.netsuite_estimate_number, created: false, ...(fleet ? { fleet } : {}) });
    }
    // The estimate it pointed at is gone — fall through and make a new one.
  }

  // No estimate yet: create a draft for the quote's customer + vehicle.
  let customerNsId: string | null = null;
  let customerName: string = String(quote.customer?.name || '').trim();
  let customerTaxExempt = false;
  if (quote.customer_id) {
    const { data: cust } = await supabase
      .from('customers')
      .select('company_name, netsuite_id, tax_exempt')
      .eq('id', quote.customer_id)
      .maybeSingle();
    if (cust) {
      customerTaxExempt = !!cust.tax_exempt;
      customerNsId = cust.netsuite_id || null;
      customerName = customerName || cust.company_name || '';
    }
  }
  if (!customerName) {
    return result({ error: 'Pick a customer on the Price & Estimate tab first — the estimate needs one.' }, { status: 400 });
  }

  // Vehicle: the worksheet's template fills the estimate's picker (make,
  // model, year, and the parts-catalog platform behind it). A photo
  // worksheet has only its typed description, which goes in vehicle_other.
  const vehicle = String(quote.vehicle_description || '').trim();
  let vehicleFields: Record<string, string | null> | null = await templateVehicleFields(supabase, quote.template_id);
  if (!vehicleFields) {
    const m = vehicle.match(/\b(19|20)\d{2}\b/);
    vehicleFields = {
      vehicle_year: m ? m[0] : null,
      vehicle_other: vehicle ? vehicle.replace(/^\s*(19|20)\d{2}\s*/, '').trim().slice(0, 120) || null : null,
    };
  }

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
      // The worksheet's switch; an older worksheet without one follows the
      // customer's Tax exempt default, as a new estimate does.
      tax_exempt: worksheetTaxExempt(quote) ?? customerTaxExempt,
      labor_rate: laborRate,
      labor_hours: 0,
      subtotal: 0,
      labor_total: 0,
      tax_amount: 0,
      grand_total: 0,
      ...vehicleFields,
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

  const priced = plannedWrapEstimateLines(quote).length > 0;
  if (priced) {
    const r = await addWrapQuoteToEstimate(supabase, estimate.id, wrapQuoteId, attach);
    if (r.status >= 400) return r;
  }
  return result({ success: true, estimateId: estimate.id, estimateNumber: estimate.estimate_number, netsuiteEstimateNumber: null, created: true });
}

export interface FleetSync {
  /** Estimate numbers whose graphics lines were rewritten to match. */
  updated: string[];
  /** Estimate numbers left alone because they're approved or on a sales order. */
  locked: string[];
}

/**
 * A Graphics Builder save rewrote this worksheet's lines on its estimate;
 * do the same on the other estimates of its fleet order (migration 410),
 * so the vehicles in one order can't drift apart (Craig, 2026-10-19).
 *
 * Only siblings that still carry this worksheet's lines are touched: a
 * fleet copy keeps wrap_quote_id on its lines, and a sibling whose
 * graphics someone deliberately took off stays that way. Approved or
 * converted siblings are skipped and reported, never rewritten.
 */
export async function syncFleetSiblings(
  supabase: SupabaseClient,
  estimateId: string,
  wrapQuoteId: string,
): Promise<FleetSync | null> {
  const { data: est } = await supabase.from('estimates').select('fleet_group_id').eq('id', estimateId).maybeSingle();
  if (!est?.fleet_group_id) return null;
  const { data: siblings } = await supabase
    .from('estimates')
    .select('id, estimate_number, customer_approved, status, netsuite_so_id')
    .eq('fleet_group_id', est.fleet_group_id)
    .neq('id', estimateId);
  if (!siblings || siblings.length === 0) return null;
  const { data: carrying } = await supabase
    .from('estimate_line_items')
    .select('estimate_id')
    .eq('wrap_quote_id', wrapQuoteId)
    .in('estimate_id', siblings.map(s => s.id));
  const withLines = new Set((carrying || []).map(l => l.estimate_id));

  const out: FleetSync = { updated: [], locked: [] };
  for (const sib of siblings) {
    if (!withLines.has(sib.id)) continue;
    if (sib.netsuite_so_id || sib.customer_approved || sib.status === 'accepted') {
      out.locked.push(sib.estimate_number);
      continue;
    }
    const r = await addWrapQuoteToEstimate(supabase, sib.id, wrapQuoteId, undefined, true);
    if (r.status < 400) out.updated.push(sib.estimate_number);
  }
  return out.updated.length || out.locked.length ? out : null;
}

/**
 * Has anyone changed this worksheet's lines on the estimate since the
 * builder last wrote them? Called BEFORE the builder saves, while the quote
 * row still holds the numbers that last save put on the estimate. A locked
 * estimate answers no edits — the save reports the lock itself.
 */
export async function wrapQuoteEstimateEdits(
  supabase: SupabaseClient,
  wrapQuoteId: string,
  estimateId: string,
): Promise<WrapLineEdit[]> {
  const [{ data: quote }, { data: estimate }, { data: lines }] = await Promise.all([
    supabase.from('wrap_quotes').select('quote_number, vehicle_description, materials_total, labor_total, package_qty, pricing_overrides, estimate_id').eq('id', wrapQuoteId).maybeSingle(),
    supabase.from('estimates').select('id, customer_approved, status, netsuite_so_id').eq('id', estimateId).maybeSingle(),
    supabase.from('estimate_line_items').select('item_number, description, quantity, unit_price, sort_order').eq('estimate_id', estimateId).eq('wrap_quote_id', wrapQuoteId),
  ]);
  if (!quote || !estimate) return [];
  if (estimate.netsuite_so_id || estimate.customer_approved || estimate.status === 'accepted') return [];
  // Never on this estimate yet (first save from ?forEstimate): nothing to lose.
  if (quote.estimate_id !== estimateId && (lines || []).length === 0) return [];
  return diffWrapEstimateLines(plannedWrapEstimateLines(quote), lines || []);
}
