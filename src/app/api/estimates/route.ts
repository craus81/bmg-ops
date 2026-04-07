import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function generateEstimateNumber(): string {
  const d = new Date();
  const yy = d.getFullYear().toString().slice(-2);
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `EST-${yy}${mm}-${rand}`;
}

function computeTotals(lines: any[], taxRate: number, taxExempt: boolean, laborRate: number, laborHoursOverride: number | null) {
  const subtotal = lines.reduce((sum: number, l: any) => sum + (parseFloat(l.quantity || 0) * parseFloat(l.unit_price || 0)), 0);
  const autoLaborHours = lines.reduce((sum: number, l: any) => sum + parseFloat(l.labor_hours || 0), 0);
  const effectiveLaborHours = laborHoursOverride !== null && laborHoursOverride !== undefined ? laborHoursOverride : autoLaborHours;
  const laborTotal = effectiveLaborHours * laborRate;
  const taxableAmount = subtotal; // Tax on parts/materials only, not labor
  const taxAmount = taxExempt ? 0 : taxableAmount * taxRate;
  const grandTotal = subtotal + laborTotal + taxAmount;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    labor_hours: Math.round(autoLaborHours * 100) / 100,
    labor_total: Math.round(laborTotal * 100) / 100,
    tax_amount: Math.round(taxAmount * 100) / 100,
    grand_total: Math.round(grandTotal * 100) / 100,
  };
}

// GET — list estimates
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const supabase = getSupabase();
    const status = req.nextUrl.searchParams.get('status');

    let query = supabase
      .from('estimates')
      .select('*')
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ estimates: data || [] });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST — create or update estimate
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const supabase = getSupabase();
    const body = await req.json();
    const {
      id, // if present, update existing
      customer_id, customer_name, customer_netsuite_id,
      title, notes, status,
      tax_rate, tax_exempt,
      labor_rate, labor_hours_override,
      line_items, // array of line item objects
      created_by,
    } = body;

    const lines = line_items || [];
    const effectiveTaxRate = parseFloat(tax_rate ?? 0.0795);
    const effectiveLaborRate = parseFloat(labor_rate ?? 85);
    const override = labor_hours_override !== undefined && labor_hours_override !== null
      ? parseFloat(labor_hours_override)
      : null;

    const totals = computeTotals(lines, effectiveTaxRate, !!tax_exempt, effectiveLaborRate, override);

    if (id) {
      // ── UPDATE existing estimate ──
      const { error: updateErr } = await supabase
        .from('estimates')
        .update({
          customer_id: customer_id || null,
          customer_name: customer_name || null,
          customer_netsuite_id: customer_netsuite_id || null,
          title: title || null,
          notes: notes || null,
          status: status || 'draft',
          tax_rate: effectiveTaxRate,
          tax_exempt: !!tax_exempt,
          labor_rate: effectiveLaborRate,
          labor_hours: totals.labor_hours,
          labor_hours_override: override,
          subtotal: totals.subtotal,
          labor_total: totals.labor_total,
          tax_amount: totals.tax_amount,
          grand_total: totals.grand_total,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);

      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

      // Replace line items
      await supabase.from('estimate_line_items').delete().eq('estimate_id', id);

      if (lines.length > 0) {
        const lineRows = lines.map((l: any, idx: number) => ({
          estimate_id: id,
          sort_order: idx,
          part_id: l.part_id || null,
          netsuite_item_id: l.netsuite_item_id || null,
          item_number: l.item_number || null,
          description: l.description || null,
          quantity: parseFloat(l.quantity || 1),
          unit_price: parseFloat(l.unit_price || 0),
          line_total: parseFloat(l.quantity || 1) * parseFloat(l.unit_price || 0),
          labor_hours: parseFloat(l.labor_hours || 0),
          is_custom: !!l.is_custom,
        }));
        await supabase.from('estimate_line_items').insert(lineRows);
      }

      return NextResponse.json({ success: true, id });
    } else {
      // ── CREATE new estimate ──
      const estimate_number = generateEstimateNumber();

      const { data, error: insertErr } = await supabase
        .from('estimates')
        .insert({
          estimate_number,
          customer_id: customer_id || null,
          customer_name: customer_name || null,
          customer_netsuite_id: customer_netsuite_id || null,
          title: title || null,
          notes: notes || null,
          status: status || 'draft',
          tax_rate: effectiveTaxRate,
          tax_exempt: !!tax_exempt,
          labor_rate: effectiveLaborRate,
          labor_hours: totals.labor_hours,
          labor_hours_override: override,
          subtotal: totals.subtotal,
          labor_total: totals.labor_total,
          tax_amount: totals.tax_amount,
          grand_total: totals.grand_total,
          created_by: created_by || null,
        })
        .select()
        .single();

      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

      // Insert line items
      if (lines.length > 0 && data) {
        const lineRows = lines.map((l: any, idx: number) => ({
          estimate_id: data.id,
          sort_order: idx,
          part_id: l.part_id || null,
          netsuite_item_id: l.netsuite_item_id || null,
          item_number: l.item_number || null,
          description: l.description || null,
          quantity: parseFloat(l.quantity || 1),
          unit_price: parseFloat(l.unit_price || 0),
          line_total: parseFloat(l.quantity || 1) * parseFloat(l.unit_price || 0),
          labor_hours: parseFloat(l.labor_hours || 0),
          is_custom: !!l.is_custom,
        }));
        await supabase.from('estimate_line_items').insert(lineRows);
      }

      return NextResponse.json({ success: true, id: data.id, estimate_number });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE — delete an estimate (also deletes from NetSuite if pushed)
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const supabase = getSupabase();
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: 'Missing estimate id' }, { status: 400 });

    // Check if this estimate has been pushed to NetSuite
    const { data: estimate } = await supabase
      .from('estimates')
      .select('netsuite_estimate_id')
      .eq('id', id)
      .single();

    // If pushed to NetSuite, delete from NS first
    if (estimate?.netsuite_estimate_id) {
      try {
        const res = await fetch(new URL('/api/estimates/push', req.url).toString(), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ estimateId: id }),
        });
        const nsResult = await res.json();
        if (!nsResult.success) {
          return NextResponse.json({ error: `Failed to delete from NetSuite: ${nsResult.error}` }, { status: 500 });
        }
      } catch (nsErr: any) {
        return NextResponse.json({ error: `NetSuite delete failed: ${nsErr.message}` }, { status: 500 });
      }
    }

    // Delete line items then estimate from Supabase
    await supabase.from('estimate_line_items').delete().eq('estimate_id', id);
    const { error } = await supabase.from('estimates').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
