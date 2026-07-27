import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { createEstimate, findItems } from '@/lib/netsuite';
import { WRAP_VINYL_ITEM as VINYL_ITEM, WRAP_LABOR_ITEM as LABOR_ITEM, kitLineSplit } from '@/lib/graphics-invoice';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({ quoteId: z.string().uuid() });

// The two NetSuite items every wrap quote maps onto. All vinyl/material
// pricing becomes one line on the first; all labor becomes one line on the
// second. Taxes are not sent — NetSuite's tax engine handles them. Shared
// with the graphics-invoice derivation so the estimate and invoice agree.

/**
 * POST /api/wrap-quote/netsuite
 *
 * Creates a NetSuite Estimate (quote) from a saved wrap quote:
 *   - materials_total  -> "3M Vinyl", description = the vehicle
 *     (year make model of the template the quote was measured on)
 *   - labor_total      -> "Graphics Install Labor" (design + prep +
 *     install + per-film labor, already summed at save time)
 *
 * Requires the quote's customer to have been picked from the NetSuite
 * customer search (customers.netsuite_id is the internal id the REST API
 * needs). Refuses to create a second estimate for the same quote.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { quoteId } = parsed.data;

  const { data: quote } = await supabase.from('wrap_quotes').select('*').eq('id', quoteId).single();
  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }
  // Refuse to create an estimate we can't record — otherwise the estimate
  // exists in NetSuite but the app forgets it (no badge, no PDF, no dup
  // guard). select('*') omits columns that don't exist, so a missing key
  // means migration 134 hasn't been applied.
  if (!('netsuite_estimate_id' in quote)) {
    return NextResponse.json({
      error: 'The wrap_quotes table is missing the NetSuite columns — run migration 134 (netsuite_estimate_id / netsuite_estimate_number) first.',
    }, { status: 500 });
  }
  if (quote.netsuite_estimate_id) {
    return NextResponse.json({
      error: `Already in NetSuite as estimate ${quote.netsuite_estimate_number || quote.netsuite_estimate_id}.`,
    }, { status: 409 });
  }
  if (!quote.customer_id) {
    return NextResponse.json({
      error: 'Pick the customer from the NetSuite search on the Quote tab first — a typed-in name has no NetSuite record to attach the estimate to.',
    }, { status: 400 });
  }

  const { data: customer } = await supabase
    .from('customers')
    .select('netsuite_id, company_name')
    .eq('id', quote.customer_id)
    .maybeSingle();
  if (!customer?.netsuite_id) {
    return NextResponse.json({ error: 'That customer has no NetSuite id — re-sync customers or pick a different one.' }, { status: 400 });
  }

  const materials = parseFloat(quote.materials_total) || 0;
  const labor = parseFloat(quote.labor_total) || 0;
  if (materials <= 0 && labor <= 0) {
    return NextResponse.json({ error: 'Quote has no material or labor amounts to send.' }, { status: 400 });
  }

  const items = await findItems([VINYL_ITEM, LABOR_ITEM]);
  const vinyl = items[VINYL_ITEM.toUpperCase()];
  const laborItem = items[LABOR_ITEM.toUpperCase()];
  const missing = [
    ...(!vinyl && materials > 0 ? [VINYL_ITEM] : []),
    ...(!laborItem && labor > 0 ? [LABOR_ITEM] : []),
  ];
  if (missing.length > 0) {
    return NextResponse.json({
      error: `NetSuite item(s) not found: ${missing.join(', ')}. Create them in NetSuite (active, exact item name) and retry.`,
    }, { status: 400 });
  }

  // Kit-quantity quotes: materials go over as qty × per-kit rate when the
  // cents divide exactly (12 × $980 in NetSuite mirrors the quote document);
  // otherwise one qty-1 line so the estimate total matches to the penny.
  // materials_total already has any quantity discount / shop minimum folded
  // in, so no separate adjustment line is needed — the memo says what
  // happened for whoever reads the estimate in NetSuite.
  const kitQty = Math.max(1, parseInt(quote.package_qty, 10) || 1);
  const vinylSplit = kitLineSplit(materials, kitQty);
  const vehicleDesc = quote.vehicle_description
    ? `${quote.vehicle_description}${kitQty > 1 ? ` — ${kitQty} kits` : ''}`
    : (kitQty > 1 ? `${kitQty} kits` : null);
  const lineItems = [
    ...(materials > 0 ? [{
      itemId: vinyl.id,
      quantity: vinylSplit.quantity,
      rate: vinylSplit.rate,
      // The vehicle the quote was measured on (year make model [variant])
      ...(vehicleDesc ? { description: vehicleDesc } : {}),
    }] : []),
    ...(labor > 0 ? [{
      itemId: laborItem.id,
      quantity: 1,
      rate: Math.round(labor * 100) / 100,
    }] : []),
  ];

  const adj = quote.adjustments || null;
  const memoNotes = [
    adj && (parseFloat(adj.discount_amount) || 0) > 0.005 ? `incl ${adj.discount_pct}% qty discount` : null,
    adj && (parseFloat(adj.min_bump) || 0) > 0.005 ? 'incl shop minimum' : null,
  ].filter(Boolean);

  const result = await createEstimate({
    customerId: customer.netsuite_id,
    memo: `Wrap quote ${quote.quote_number}${memoNotes.length > 0 ? ` (${memoNotes.join(', ')})` : ''}`,
    lineItems,
  });
  if (!result.success) {
    return NextResponse.json({ error: result.error || 'NetSuite estimate creation failed' }, { status: 502 });
  }

  const { error: recordErr } = await supabase.from('wrap_quotes').update({
    netsuite_estimate_id: result.estimateId || null,
    netsuite_estimate_number: result.estimateNumber || null,
    updated_at: new Date().toISOString(),
  }).eq('id', quote.id);
  if (recordErr) {
    // The estimate DOES exist in NetSuite at this point — surface that
    // loudly so nobody re-pushes and creates a duplicate.
    return NextResponse.json({
      error: `Estimate ${result.estimateNumber || result.estimateId} was created in NetSuite but could not be recorded on the quote (${recordErr.message}). Fix the database (migration 134) — do NOT push again or you'll create a duplicate.`,
    }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    estimateId: result.estimateId,
    estimateNumber: result.estimateNumber,
  });
}
