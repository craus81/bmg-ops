import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().uuid().optional().nullable(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}


/**
 * POST /api/graphics/create-estimate
 * Creates an estimate from a graphics job, pre-populated with the job's
 * part numbers and customer. The estimate then travels with the job
 * through the production process all the way to invoicing.
 *
 * Body: { jobId: string, userId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, userId } = parsed.data;

  try {
    const supabase = getSupabase();

    // Load the graphics job
    const { data: job, error: jobErr } = await supabase
      .from('graphics_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    // Check if the job already has an estimate
    if (job.estimate_id) {
      const { data: existingEst } = await supabase
        .from('estimates')
        .select('id, estimate_number, status, grand_total')
        .eq('id', job.estimate_id)
        .maybeSingle();

      if (existingEst) {
        return NextResponse.json({
          error: `This job already has an estimate: ${existingEst.estimate_number}`,
          status: 'already_exists',
          estimate_id: existingEst.id,
          estimate_number: existingEst.estimate_number,
        }, { status: 400 });
      }
    }

    // Look up customer info
    let customerId: string | null = null;
    let customerName = job.customer || null;
    let customerNsId: string | null = job.customer_netsuite_id || null;

    if (customerName && !customerNsId) {
      const { data: customer } = await supabase
        .from('customers')
        .select('id, netsuite_id, company_name')
        .ilike('company_name', customerName)
        .eq('active', true)
        .limit(1)
        .maybeSingle();

      if (customer) {
        customerId = customer.id;
        customerName = customer.company_name;
        customerNsId = customer.netsuite_id;
      }
    }

    // Build line items from part numbers
    const partNumbers = (job.part_number || '')
      .split(',')
      .map((p: string) => p.trim())
      .filter(Boolean);

    const lineItems: any[] = [];

    for (const pn of partNumbers) {
      // Look up from netsuite_parts catalog
      const { data: part } = await supabase
        .from('netsuite_parts')
        .select('id, netsuite_id, item_number, display_name, description, sales_price, labor_hours')
        .eq('item_number', pn)
        .eq('is_active', true)
        .maybeSingle();

      if (part) {
        lineItems.push({
          part_id: part.id,
          netsuite_item_id: part.netsuite_id,
          item_number: part.item_number,
          description: part.display_name || part.description || part.item_number,
          quantity: job.quantity || 1,
          unit_price: part.sales_price || 0,
          labor_hours: part.labor_hours || 0,
          is_custom: false,
        });
      } else {
        // Add as custom line with zero price (user can fill in)
        lineItems.push({
          part_id: null,
          netsuite_item_id: null,
          item_number: pn,
          description: `${pn} (from graphics job)`,
          quantity: job.quantity || 1,
          unit_price: 0,
          labor_hours: 0,
          is_custom: true,
        });
      }
    }

    // Compute totals
    const subtotal = lineItems.reduce((sum: number, l: any) => sum + (l.quantity * l.unit_price), 0);
    const autoLaborHours = lineItems.reduce((sum: number, l: any) => sum + l.labor_hours, 0);
    const laborRate = 120; // default
    const laborTotal = autoLaborHours * laborRate;
    const taxRate = 0.0795;
    const taxAmount = subtotal * taxRate;
    const grandTotal = subtotal + laborTotal + taxAmount;

    // Create the estimate
    const estimateNumber = await nextJobNumber(supabase, 'EST', legacyJobNumber.est);
    const titleParts = [`Graphics Job #${job.job_number || job.id.slice(0, 8)}`];
    if (job.title) titleParts.push(job.title);
    const title = titleParts.join(' — ');

    const { data: estimate, error: estErr } = await supabase
      .from('estimates')
      .insert({
        estimate_number: estimateNumber,
        customer_id: customerId,
        customer_name: customerName,
        customer_netsuite_id: customerNsId,
        title,
        notes: [
          job.po_number ? `PO #${job.po_number}` : null,
          job.notes,
        ].filter(Boolean).join('\n') || null,
        status: 'draft',
        tax_rate: taxRate,
        tax_exempt: false,
        labor_rate: laborRate,
        labor_hours: autoLaborHours,
        subtotal: Math.round(subtotal * 100) / 100,
        labor_total: Math.round(laborTotal * 100) / 100,
        tax_amount: Math.round(taxAmount * 100) / 100,
        grand_total: Math.round(grandTotal * 100) / 100,
        created_by: userId || auth.user.id,
      })
      .select()
      .single();

    if (estErr || !estimate) {
      return NextResponse.json({ error: estErr?.message || 'Failed to create estimate' }, { status: 500 });
    }

    // Insert line items
    if (lineItems.length > 0) {
      const rows = lineItems.map((l: any, idx: number) => ({
        estimate_id: estimate.id,
        sort_order: idx,
        part_id: l.part_id,
        netsuite_item_id: l.netsuite_item_id,
        item_number: l.item_number,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price,
        line_total: l.quantity * l.unit_price,
        labor_hours: l.labor_hours,
        is_custom: l.is_custom,
      }));
      await supabase.from('estimate_line_items').insert(rows);
    }

    // Link the estimate to the graphics job
    await supabase
      .from('graphics_jobs')
      .update({
        estimate_id: estimate.id,
        customer_netsuite_id: customerNsId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Log in status history
    await supabase.from('graphics_status_history').insert({
      job_id: jobId,
      from_status: job.status,
      to_status: job.status,
      changed_by: userId || auth.user.id,
      note: `Estimate created: ${estimateNumber}${lineItems.length > 0 ? ` (${lineItems.length} line item${lineItems.length !== 1 ? 's' : ''})` : ''}`,
    });

    return NextResponse.json({
      success: true,
      estimate_id: estimate.id,
      estimate_number: estimateNumber,
      line_item_count: lineItems.length,
      grand_total: Math.round(grandTotal * 100) / 100,
    });
  } catch (err: any) {
    console.error('Graphics create-estimate error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create estimate' }, { status: 500 });
  }
}
