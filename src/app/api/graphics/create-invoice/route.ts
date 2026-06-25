import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { createDirectInvoice, findItems, getItemBasePrices } from '@/lib/netsuite';
import { resolveCustomerNsId } from '@/lib/graphics-invoice';
import { resolveInvoiceLocation } from '@/lib/invoice-location';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

// A line the user verified on the review screen: explicit item, quantity and
// rate. When present these are used as-is (skipping the part→item→price
// derivation), which is how per-part quantities finally match reality.
const VerifiedLineSchema = z.object({
  itemId: z.union([z.string().min(1).max(15), z.number().int().nonnegative()]),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  description: z.string().max(2000).optional().nullable(),
  partNumber: z.string().max(120).optional().nullable(),
});

const Schema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().uuid().optional().nullable(),
  // Optional client-supplied unit prices, keyed by part number (case
  // insensitive). Used by the legacy auto path to re-submit after prompting
  // for a price on parts with no catalog/NetSuite price.
  prices: z.record(z.string(), z.number().nonnegative()).optional().nullable(),
  // Verified lines from the review screen. When provided, these win.
  lines: z.array(VerifiedLineSchema).min(1).max(500).optional().nullable(),
  // Customer override from the review screen (the user can search/swap the
  // customer there). Falls back to resolving from the job when absent.
  customerNsId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]).optional().nullable(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * POST /api/graphics/create-invoice
 * Creates a direct invoice in NetSuite from a graphics job (skips the Sales
 * Order). Preferred flow: the client sends `lines` it verified on the review
 * screen. Legacy flow (no `lines`): derive one line per part at the job
 * quantity, prompting for missing prices via `needsPricing`.
 *
 * Body: { jobId, userId?, lines?, prices? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, userId, prices, lines: verifiedLines, customerNsId: clientCustomerNsId } = parsed.data;

  // Normalize client-supplied prices to an upper-cased part-number map.
  const priceOverrides: Record<string, number> = {};
  if (prices) {
    for (const [pn, rate] of Object.entries(prices)) {
      if (typeof rate === 'number' && rate > 0) priceOverrides[pn.trim().toUpperCase()] = rate;
    }
  }

  try {
    const supabase = getSupabase();

    const { data: job, error: jobErr } = await supabase
      .from('graphics_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    if (job.netsuite_invoice_id) {
      return NextResponse.json({
        error: `This job already has an invoice: ${job.netsuite_invoice_number || job.netsuite_invoice_id}`,
        status: 'already_invoiced',
        netsuite_invoice_id: job.netsuite_invoice_id,
        netsuite_invoice_number: job.netsuite_invoice_number,
      }, { status: 400 });
    }

    const customerNsId = (clientCustomerNsId != null ? String(clientCustomerNsId) : null)
      || await resolveCustomerNsId(supabase, job);
    if (!customerNsId) {
      return NextResponse.json({
        error: 'No NetSuite customer found for this job. Please set the customer on the job first.',
      }, { status: 400 });
    }

    // Final invoice lines + the (partNumber, itemId, rate) tuples whose price
    // we may want to backfill into the catalog afterwards.
    let lineItems: { itemId: string; quantity: number; rate: number; description?: string }[];
    let persistTargets: { partNumber: string; itemId: string; rate: number }[] = [];
    let skippedParts: string[] = [];

    if (verifiedLines && verifiedLines.length > 0) {
      // ── Verified path: trust the reviewed lines as-is. ──
      lineItems = verifiedLines.map((l) => ({
        itemId: String(l.itemId),
        quantity: l.quantity,
        rate: l.rate,
        description: (l.description || job.title || '').trim() || undefined,
      }));
      persistTargets = verifiedLines
        .filter((l) => l.partNumber && l.rate > 0)
        .map((l) => ({ partNumber: l.partNumber as string, itemId: String(l.itemId), rate: l.rate }));
    } else {
      // ── Legacy path: derive one line per part at the job quantity. ──
      const partNumbers = (job.part_number || '')
        .split(',')
        .map((p: string) => p.trim())
        .filter(Boolean);

      if (partNumbers.length === 0) {
        return NextResponse.json({
          error: 'No part numbers on this job. Add part numbers to create an invoice.',
        }, { status: 400 });
      }

      const nsItems = await findItems(partNumbers);
      const matched: { partNumber: string; itemId: string; displayName: string; rate: number }[] = [];

      for (const pn of partNumbers) {
        const nsItem = nsItems[pn.toUpperCase()];
        if (!nsItem) { skippedParts.push(pn); continue; }

        let rate = priceOverrides[pn.toUpperCase()] || 0;
        if (!(rate > 0)) {
          const { data: catalogItem } = await supabase
            .from('netsuite_parts')
            .select('sales_price')
            .eq('item_number', pn)
            .eq('is_active', true)
            .maybeSingle();
          rate = catalogItem?.sales_price || 0;
        }

        matched.push({ partNumber: pn, itemId: nsItem.id, displayName: nsItem.displayName || pn, rate });
      }

      if (matched.length === 0) {
        return NextResponse.json({
          error: `Could not find any of these parts in NetSuite: ${partNumbers.join(', ')}. Make sure part numbers match NetSuite items.`,
          skippedParts,
        }, { status: 400 });
      }

      const stillUnpriced = matched.filter((m) => !(m.rate > 0));
      if (stillUnpriced.length > 0) {
        const basePrices = await getItemBasePrices(stillUnpriced.map((m) => m.itemId));
        for (const m of stillUnpriced) {
          const bp = basePrices[m.itemId];
          if (bp > 0) m.rate = bp;
        }
      }

      const needsPricing = matched.filter((m) => !(m.rate > 0));
      if (needsPricing.length > 0) {
        return NextResponse.json({
          needsPricing: true,
          parts: needsPricing.map((m) => ({
            partNumber: m.partNumber,
            itemId: m.itemId,
            displayName: m.displayName,
          })),
          skippedParts: skippedParts.length > 0 ? skippedParts : undefined,
        });
      }

      lineItems = matched.map((m) => ({
        itemId: m.itemId,
        quantity: job.quantity || 1,
        rate: m.rate,
        description: job.title || m.displayName || m.partNumber,
      }));
      persistTargets = matched
        .filter((m) => priceOverrides[m.partNumber.toUpperCase()] > 0)
        .map((m) => ({ partNumber: m.partNumber, itemId: m.itemId, rate: m.rate }));
    }

    // Build memo
    const memoParts = [`Graphics Job #${job.job_number || job.id.slice(0, 8)}`];
    if (job.po_number) memoParts.push(`PO #${job.po_number}`);
    if (job.customer) memoParts.push(job.customer);
    const memo = memoParts.join(' — ');

    // Resolve the NetSuite location from the job's PO (customer + ship-to),
    // falling back to the job's own customer/ship-to when it has no PO.
    let locCustomer: string | null = job.customer;
    let poShipTo: { city?: string; name?: string } | null = null;
    if (job.po_id) {
      const { data: po } = await supabase
        .from('purchase_orders')
        .select('customer, ship_to')
        .eq('id', job.po_id)
        .maybeSingle();
      if (po) {
        locCustomer = po.customer || job.customer;
        poShipTo = po.ship_to || null;
      }
    }
    const { id: locationId } = await resolveInvoiceLocation({
      customerName: locCustomer,
      city: poShipTo?.city,
      name: poShipTo?.name,
      locationName: job.ship_to,
    });

    const result = await createDirectInvoice({
      customerId: customerNsId,
      memo,
      lineItems,
      locationId: locationId ?? undefined,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const invoiceAmount = lineItems.reduce((sum, li) => sum + (li.quantity * li.rate), 0);

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

    await supabase.from('graphics_status_history').insert({
      job_id: jobId,
      from_status: job.status,
      to_status: job.status,
      changed_by: userId || auth.user.id,
      note: `Invoice created: ${result.invoiceNumber || result.invoiceId}${job.po_number ? ` (PO #${job.po_number})` : ''}`,
    });

    // Backfill prices into the catalog — only where a price is missing, so we
    // never clobber an existing catalog price with a one-off invoice rate.
    let savedPrices = 0;
    for (const t of persistTargets) {
      try {
        const { data: existing } = await supabase
          .from('netsuite_parts')
          .select('id, sales_price')
          .eq('netsuite_id', t.itemId)
          .maybeSingle();

        if (existing) {
          if (!(existing.sales_price > 0)) {
            await supabase
              .from('netsuite_parts')
              .update({ sales_price: t.rate, updated_at: new Date().toISOString() })
              .eq('id', existing.id);
            savedPrices++;
          }
        } else {
          await supabase
            .from('netsuite_parts')
            .insert({
              netsuite_id: t.itemId,
              item_number: t.partNumber,
              display_name: t.partNumber,
              sales_price: t.rate,
              catalog: 'graphics',
              is_active: true,
            });
          savedPrices++;
        }
      } catch (e) {
        console.error(`Failed to persist price for part ${t.partNumber}:`, e);
      }
    }

    return NextResponse.json({
      success: true,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      invoiceAmount,
      lineItemCount: lineItems.length,
      skippedParts: skippedParts.length > 0 ? skippedParts : undefined,
      savedPrices: savedPrices > 0 ? savedPrices : undefined,
    });
  } catch (err: any) {
    console.error('Graphics create-invoice error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create invoice' }, { status: 500 });
  }
}
