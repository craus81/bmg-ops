import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { createEstimate, findItems } from '@/lib/netsuite';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({ quoteId: z.string().uuid() });

// The two NetSuite items every wrap quote maps onto. All vinyl/material
// pricing becomes one line on the first; all labor becomes one line on the
// second. Taxes are not sent — NetSuite's tax engine handles them.
const VINYL_ITEM = '3M Vinyl';
const LABOR_ITEM = 'Graphics Install Labor';

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

  const lineItems = [
    ...(materials > 0 ? [{
      itemId: vinyl.id,
      quantity: 1,
      rate: Math.round(materials * 100) / 100,
      // The vehicle the quote was measured on (year make model [variant])
      ...(quote.vehicle_description ? { description: quote.vehicle_description } : {}),
    }] : []),
    ...(labor > 0 ? [{
      itemId: laborItem.id,
      quantity: 1,
      rate: Math.round(labor * 100) / 100,
    }] : []),
  ];

  const result = await createEstimate({
    customerId: customer.netsuite_id,
    memo: `Wrap quote ${quote.quote_number}`,
    lineItems,
  });
  if (!result.success) {
    return NextResponse.json({ error: result.error || 'NetSuite estimate creation failed' }, { status: 502 });
  }

  await supabase.from('wrap_quotes').update({
    netsuite_estimate_id: result.estimateId || null,
    netsuite_estimate_number: result.estimateNumber || null,
    updated_at: new Date().toISOString(),
  }).eq('id', quote.id);

  return NextResponse.json({
    success: true,
    estimateId: result.estimateId,
    estimateNumber: result.estimateNumber,
  });
}
