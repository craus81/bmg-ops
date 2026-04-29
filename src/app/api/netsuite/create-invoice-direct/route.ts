import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createDirectInvoice } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

/**
 * POST /api/netsuite/create-invoice-direct
 *
 * Body: {
 *   customerId: string | number,
 *   locationId?: string | number,
 *   memo?: string,
 *   lineItems: { itemId: string | number, quantity: number, rate: number, description?: string }[],
 *   graphicsJobId?: string,
 * }
 *
 * Creates a standalone NetSuite invoice (no SO/PO required). When
 * graphicsJobId is provided, stores the resulting invoice id/number on
 * graphics_jobs so the UI can suppress duplicate "create invoice?"
 * prompts.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { customerId, locationId, memo, lineItems, graphicsJobId } = body || {};

  if (!customerId) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 });
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return NextResponse.json({ error: 'At least one line item is required' }, { status: 400 });
  }

  for (const li of lineItems) {
    if (!li.itemId) {
      return NextResponse.json({ error: 'Every line item needs an itemId' }, { status: 400 });
    }
    if (typeof li.quantity !== 'number' || li.quantity <= 0) {
      return NextResponse.json({ error: 'Every line item needs a positive quantity' }, { status: 400 });
    }
    if (typeof li.rate !== 'number' || li.rate < 0) {
      return NextResponse.json({ error: 'Every line item needs a non-negative rate' }, { status: 400 });
    }
  }

  const result = await createDirectInvoice({
    customerId,
    locationId,
    memo,
    lineItems,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Invoice creation failed' }, { status: 502 });
  }

  if (graphicsJobId && result.invoiceId) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    await supabase
      .from('graphics_jobs')
      .update({
        netsuite_invoice_id: result.invoiceId,
        netsuite_invoice_number: result.invoiceNumber || null,
        invoiced_at: new Date().toISOString(),
      })
      .eq('id', graphicsJobId);
  }

  return NextResponse.json({
    success: true,
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber,
  });
}
