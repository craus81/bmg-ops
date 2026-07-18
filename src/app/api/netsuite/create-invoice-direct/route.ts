import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createDirectInvoice } from '@/lib/netsuite';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const NumericId = z.union([z.string().regex(/^\d{1,15}$/), z.number().int().nonnegative()]);

const LineItemSchema = z.object({
  itemId: NumericId,
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  description: z.string().max(2000).optional(),
});

const Schema = z.object({
  customerId: NumericId,
  locationId: NumericId.optional().nullable(),
  memo: z.string().max(5000).optional().nullable(),
  lineItems: z.array(LineItemSchema).min(1).max(500),
  graphicsJobId: z.string().uuid().optional().nullable(),
});

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
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { customerId, locationId, memo, lineItems, graphicsJobId } = parsed.data;

  const result = await createDirectInvoice({
    customerId,
    locationId: locationId ?? undefined,
    memo: memo ?? undefined,
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
