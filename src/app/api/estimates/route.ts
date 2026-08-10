import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { computeTotals } from '@/lib/estimate-totals';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';

export const dynamic = 'force-dynamic';

const LineItemSchema = z.object({
  part_id: z.string().uuid().optional().nullable(),
  netsuite_item_id: z.string().max(40).optional().nullable(),
  item_number: z.string().max(120).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  quantity: z.union([z.number(), z.string()]).optional(),
  unit_price: z.union([z.number(), z.string()]).optional(),
  labor_hours: z.union([z.number(), z.string()]).optional(),
  is_custom: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
});

const UpsertEstimateSchema = z.object({
  id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional().nullable(),
  customer_name: z.string().max(200).optional().nullable(),
  customer_netsuite_id: z.string().max(40).optional().nullable(),
  title: z.string().max(300).optional().nullable(),
  notes: z.string().max(10_000).optional().nullable(),
  status: z.string().max(40).optional(),
  tax_rate: z.union([z.number(), z.string()]).optional(),
  tax_exempt: z.boolean().optional(),
  labor_rate: z.union([z.number(), z.string()]).optional(),
  labor_hours_override: z.union([z.number(), z.string()]).optional().nullable(),
  line_items: z.array(LineItemSchema).max(500).optional(),
  created_by: z.string().uuid().optional().nullable(),
  install_instructions: z.string().max(5000).optional().nullable(),
  on_site_contact_name: z.string().max(120).optional().nullable(),
  on_site_contact_phone: z.string().max(40).optional().nullable(),
  delivery_preferences: z.string().max(2000).optional().nullable(),
  internal_notes: z.string().max(5000).optional().nullable(),
  // K5: header VIN (full 17 or a partial, matching the scanner's tolerance)
  // and the customer's fleet unit number.
  vin: z.string().max(32).optional().nullable(),
  unit_number: z.string().max(60).optional().nullable(),
});

const DeleteSchema = z.object({ id: z.string().uuid() });

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}


// GET — list estimates
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const supabase = getSupabase();
    const status = req.nextUrl.searchParams.get('status');
    // Single-estimate fetch: the deep-link fallback for records outside the
    // list response (PostgREST caps un-limited reads at 1000 rows, newest
    // first, so old estimates fall out of the list).
    const id = req.nextUrl.searchParams.get('id');
    if (id) {
      const { data, error } = await supabase.from('estimates').select('*').eq('id', id).maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ estimates: data ? [data] : [] });
    }

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
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpsertEstimateSchema);
  if (parsed.error) return parsed.error;
  const {
    id, // if present, update existing
    customer_id, customer_name, customer_netsuite_id,
    title, notes, status,
    tax_rate, tax_exempt,
    labor_rate, labor_hours_override,
    line_items, // array of line item objects
    created_by,
    // T1.6 install context
    install_instructions, on_site_contact_name, on_site_contact_phone,
    delivery_preferences, internal_notes,
    vin, unit_number,
  } = parsed.data;

  try {
    const supabase = getSupabase();
    // VINs are case-insensitive; store them the way the scanner does so
    // vin-match suffix comparisons work across estimates and scan_logs.
    const normalizedVin = vin?.trim().toUpperCase() || null;
    const normalizedUnit = unit_number?.trim() || null;

    const lines = line_items || [];
    const effectiveTaxRate = parseFloat(String(tax_rate ?? 0.0795));
    const effectiveLaborRate = parseFloat(String(labor_rate ?? 85));
    const override = labor_hours_override !== undefined && labor_hours_override !== null
      ? parseFloat(String(labor_hours_override))
      : null;

    const totals = computeTotals(lines, effectiveTaxRate, !!tax_exempt, effectiveLaborRate, override);

    if (id) {
      // ── UPDATE existing estimate ──
      // A builder Save/Sync only ever submits 'draft' or 'pushed'. The sales
      // stages ('sent'/'accepted'/'rejected') are owned by the send-for-approval
      // and customer-approval flows — letting a Save write 'draft' over them
      // silently erased approvals and dropped sent estimates out of the
      // follow-up queue. Preserve the sales stage unless the caller is
      // explicitly moving to one (Send for Approval pre-saves with 'sent').
      const SALES_STAGES = ['sent', 'accepted', 'rejected'];
      const requestedStatus = status || 'draft';
      let effectiveStatus: string | undefined = requestedStatus;
      if (requestedStatus === 'draft' || requestedStatus === 'pushed') {
        const { data: existing, error: statusReadErr } = await supabase
          .from('estimates')
          .select('status')
          .eq('id', id)
          .maybeSingle();
        if (statusReadErr) {
          // Fail closed: if we can't see the current stage, leave status
          // untouched rather than risk writing 'draft' over an approval.
          effectiveStatus = undefined;
        } else if (existing && SALES_STAGES.includes(existing.status)) {
          effectiveStatus = existing.status;
        }
      }

      const { error: updateErr } = await supabase
        .from('estimates')
        .update({
          customer_id: customer_id || null,
          customer_name: customer_name || null,
          customer_netsuite_id: customer_netsuite_id || null,
          title: title || null,
          notes: notes || null,
          ...(effectiveStatus !== undefined ? { status: effectiveStatus } : {}),
          tax_rate: effectiveTaxRate,
          tax_exempt: !!tax_exempt,
          labor_rate: effectiveLaborRate,
          labor_hours: totals.labor_hours,
          labor_hours_override: override,
          subtotal: totals.subtotal,
          labor_total: totals.labor_total,
          tax_amount: totals.tax_amount,
          grand_total: totals.grand_total,
          install_instructions: install_instructions || null,
          on_site_contact_name: on_site_contact_name || null,
          on_site_contact_phone: on_site_contact_phone || null,
          delivery_preferences: delivery_preferences || null,
          internal_notes: internal_notes || null,
          vin: normalizedVin,
          unit_number: normalizedUnit,
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
          notes: l.notes || null,
        }));
        await supabase.from('estimate_line_items').insert(lineRows);
      }

      return NextResponse.json({ success: true, id });
    } else {
      // ── CREATE new estimate ──
      // The number has a UNIQUE constraint and a 4-char random suffix — two
      // creates in the same month can collide, so retry with a fresh number
      // on 23505 instead of failing the save (wrap-quote does the same).
      let data: any = null;
      let insertErr: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const estimate_number = await nextJobNumber(supabase, 'EST', legacyJobNumber.est);
        const res = await supabase
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
          install_instructions: install_instructions || null,
          on_site_contact_name: on_site_contact_name || null,
          on_site_contact_phone: on_site_contact_phone || null,
          delivery_preferences: delivery_preferences || null,
          internal_notes: internal_notes || null,
          vin: normalizedVin,
          unit_number: normalizedUnit,
          created_by: created_by || null,
        })
        .select()
        .single();
        data = res.data;
        insertErr = res.error;
        if (!insertErr || insertErr.code !== '23505') break;
      }

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
          notes: l.notes || null,
        }));
        await supabase.from('estimate_line_items').insert(lineRows);
      }

      return NextResponse.json({ success: true, id: data.id, estimate_number: data.estimate_number });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE — delete an estimate (also deletes from NetSuite if pushed)
export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DeleteSchema);
  if (parsed.error) return parsed.error;
  const { id } = parsed.data;

  try {
    const supabase = getSupabase();

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
