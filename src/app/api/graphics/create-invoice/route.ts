import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { createDirectInvoice, findItems, suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * POST /api/graphics/create-invoice
 * Creates a direct invoice in NetSuite from a graphics job.
 * Skips the Sales Order step — goes straight from PO/job to Invoice.
 *
 * Body: { jobId: string, userId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const supabase = getSupabase();
    const { jobId, userId } = await req.json();

    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    // Load the graphics job
    const { data: job, error: jobErr } = await supabase
      .from('graphics_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    // Check if already invoiced
    if (job.netsuite_invoice_id) {
      return NextResponse.json({
        error: `This job already has an invoice: ${job.netsuite_invoice_number || job.netsuite_invoice_id}`,
        status: 'already_invoiced',
        netsuite_invoice_id: job.netsuite_invoice_id,
        netsuite_invoice_number: job.netsuite_invoice_number,
      }, { status: 400 });
    }

    // We need a NetSuite customer ID to create the invoice
    let customerNsId = job.customer_netsuite_id;

    // If no NS customer ID on the job, try to look it up from the customer name
    if (!customerNsId && job.customer) {
      const { data: customer } = await supabase
        .from('customers')
        .select('netsuite_id')
        .ilike('company_name', job.customer)
        .eq('active', true)
        .limit(1)
        .maybeSingle();

      if (customer?.netsuite_id) {
        customerNsId = customer.netsuite_id;
      }
    }

    // If still no customer, try the linked PO
    if (!customerNsId && job.po_id) {
      const { data: po } = await supabase
        .from('purchase_orders')
        .select('customer')
        .eq('id', job.po_id)
        .maybeSingle();

      if (po?.customer) {
        const { data: customer } = await supabase
          .from('customers')
          .select('netsuite_id')
          .ilike('company_name', po.customer)
          .eq('active', true)
          .limit(1)
          .maybeSingle();

        if (customer?.netsuite_id) {
          customerNsId = customer.netsuite_id;
        }
      }
    }

    if (!customerNsId) {
      return NextResponse.json({
        error: 'No NetSuite customer found for this job. Please set the customer on the job first.',
      }, { status: 400 });
    }

    // Build line items from part numbers on the job
    const partNumbers = (job.part_number || '')
      .split(',')
      .map((p: string) => p.trim())
      .filter(Boolean);

    if (partNumbers.length === 0) {
      return NextResponse.json({
        error: 'No part numbers on this job. Add part numbers to create an invoice.',
      }, { status: 400 });
    }

    // Look up NS item IDs for the part numbers
    const nsItems = await findItems(partNumbers);

    const lineItems: { itemId: string; quantity: number; rate: number; description?: string }[] = [];
    const skippedParts: string[] = [];

    for (const pn of partNumbers) {
      const nsItem = nsItems[pn.toUpperCase()];
      if (nsItem) {
        // Try to get the price from the catalog
        const { data: catalogItem } = await supabase
          .from('netsuite_parts')
          .select('sales_price')
          .eq('item_number', pn)
          .eq('is_active', true)
          .maybeSingle();

        const rate = catalogItem?.sales_price || 0;

        lineItems.push({
          itemId: nsItem.id,
          quantity: job.quantity || 1,
          rate,
          description: job.title || nsItem.displayName || pn,
        });
      } else {
        skippedParts.push(pn);
      }
    }

    if (lineItems.length === 0) {
      return NextResponse.json({
        error: `Could not find any of these parts in NetSuite: ${partNumbers.join(', ')}. Make sure part numbers match NetSuite items.`,
        skippedParts,
      }, { status: 400 });
    }

    // Build memo
    const memoParts = [`Graphics Job #${job.job_number || job.id.slice(0, 8)}`];
    if (job.po_number) memoParts.push(`PO #${job.po_number}`);
    if (job.customer) memoParts.push(job.customer);
    const memo = memoParts.join(' — ');

    // Create the invoice directly in NetSuite (no SO required)
    const result = await createDirectInvoice({
      customerId: customerNsId,
      memo,
      lineItems,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Calculate invoice amount
    const invoiceAmount = lineItems.reduce((sum, li) => sum + (li.quantity * li.rate), 0);

    // Update the graphics job with invoice info
    await supabase
      .from('graphics_jobs')
      .update({
        netsuite_invoice_id: result.invoiceId,
        netsuite_invoice_number: result.invoiceNumber,
        invoiced_at: new Date().toISOString(),
        invoiced_by: userId || auth.user.id,
        invoice_amount: invoiceAmount,
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
      note: `Invoice created: ${result.invoiceNumber || result.invoiceId}${job.po_number ? ` (PO #${job.po_number})` : ''}`,
    });

    return NextResponse.json({
      success: true,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      invoiceAmount,
      lineItemCount: lineItems.length,
      skippedParts: skippedParts.length > 0 ? skippedParts : undefined,
    });
  } catch (err: any) {
    console.error('Graphics create-invoice error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create invoice' }, { status: 500 });
  }
}
