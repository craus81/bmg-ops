import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { computeTotals } from '@/lib/estimate-totals';
import { FALLBACK_SALES_TAX_RATE } from '@/lib/sales-tax';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Same line shape the estimates upsert accepts (api/estimates/route.ts) —
// route files can only export handlers, so the schema is restated here.
const LineItemSchema = z.object({
  part_id: z.string().uuid().optional().nullable(),
  netsuite_item_id: z.string().max(40).optional().nullable(),
  item_number: z.string().max(120).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  quantity: z.union([z.number(), z.string()]).optional(),
  unit_price: z.union([z.number(), z.string()]).optional(),
  labor_hours: z.union([z.number(), z.string()]).optional().nullable(),
  is_custom: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
});

const Schema = z.object({ line_items: z.array(LineItemSchema).min(1).max(100) });

/**
 * POST /api/estimates/[id]/add-lines — append line items to an existing
 * estimate (the catalog browser's "Add to estimate" flow, where there is no
 * builder holding the rest of the estimate's state). Unlike the estimates
 * upsert, this touches ONLY the line list: lines land after the current
 * ones and the header fields stay untouched, so it's safe to call against
 * an estimate nobody has open. Totals are recomputed server-side, same as
 * add-wrap-quote.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { line_items } = parsed.data;

  try {
    const { data: estimate } = await supabase
      .from('estimates')
      .select('id, estimate_number, status, netsuite_so_id, tax_rate, tax_exempt, labor_rate, labor_hours_override')
      .eq('id', params.id)
      .maybeSingle();
    if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

    // Guard the states where silent appends would lie downstream: a
    // converted estimate already drove a NetSuite Sales Order, and an
    // accepted one has a customer-signed snapshot that must not drift.
    if (estimate.netsuite_so_id) {
      return NextResponse.json({ error: 'This estimate was already converted to a Sales Order — start a new estimate instead.' }, { status: 409 });
    }
    if (estimate.status === 'accepted') {
      return NextResponse.json({ error: 'This estimate was accepted by the customer — its contents are locked. Start a new estimate instead.' }, { status: 409 });
    }

    const { data: maxRow } = await supabase
      .from('estimate_line_items')
      .select('sort_order')
      .eq('estimate_id', params.id)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    let sort = (maxRow?.sort_order ?? -1) + 1;

    const lineRows = line_items.map((l) => {
      const quantity = parseFloat(String(l.quantity ?? 1)) || 1;
      const unitPrice = parseFloat(String(l.unit_price ?? 0)) || 0;
      return {
        estimate_id: params.id,
        sort_order: sort++,
        part_id: l.part_id || null,
        netsuite_item_id: l.netsuite_item_id || null,
        item_number: l.item_number || null,
        description: l.description || null,
        quantity,
        unit_price: unitPrice,
        line_total: Math.round(quantity * unitPrice * 100) / 100,
        // NULL = labor not set on the part (migration 258); 0 is a real value.
        labor_hours: l.labor_hours == null || l.labor_hours === '' ? null : (parseFloat(String(l.labor_hours)) || 0),
        is_custom: !!l.is_custom,
        notes: l.notes || null,
      };
    });
    const { error: insertErr } = await supabase.from('estimate_line_items').insert(lineRows);
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

    const { data: allLines } = await supabase
      .from('estimate_line_items')
      .select('quantity, unit_price, labor_hours')
      .eq('estimate_id', params.id);
    const totals = computeTotals(
      allLines || [],
      // Keep the estimate's own quoted rate; the company setting only fills
      // in for a row saved before tax_rate existed.
      parseFloat(String(estimate.tax_rate ?? FALLBACK_SALES_TAX_RATE)),
      !!estimate.tax_exempt,
      parseFloat(String(estimate.labor_rate ?? 120)),
      estimate.labor_hours_override !== null && estimate.labor_hours_override !== undefined
        ? parseFloat(String(estimate.labor_hours_override))
        : null,
    );
    await supabase.from('estimates').update({
      labor_hours: totals.labor_hours,
      subtotal: totals.subtotal,
      labor_total: totals.labor_total,
      tax_amount: totals.tax_amount,
      grand_total: totals.grand_total,
      updated_at: new Date().toISOString(),
    }).eq('id', params.id);

    return NextResponse.json({
      success: true,
      added: lineRows.length,
      estimate_number: estimate.estimate_number,
      grand_total: totals.grand_total,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
