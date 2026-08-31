import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createInvoiceFromSO, fulfillSalesOrder, getSalesOrderFulfillmentState } from '@/lib/netsuite';
import { decideFulfillment } from '@/lib/so-fulfillment';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/vehicle-tracking/invoice — admin-only (field ask, 2026-08-21:
 * "the vehicle completion process should let you turn the sales order or
 * estimate into a NetSuite invoice").
 *
 * Fulfills the FULL sales order and then bills it, in one step (field ask,
 * 2026-08-28: invoicing straight from the SO produced an invoice holding
 * only labor and freight). This account runs Advanced Shipping, so
 * NetSuite's SO→invoice transform carries only the lines that need no
 * fulfillment — every part has to pass through an Item Fulfillment first.
 * Fulfilling relieves inventory and posts COGS, so it happens at most once
 * per sales order, ever: NetSuite's own fulfillment records are the source
 * of truth and the UNIQUE claim in netsuite_so_fulfillments (migration 244)
 * closes the race between two clicks.
 *
 * Bills the FULL sales order via NetSuite's SO→invoice transform (memo and
 * location inherited from the SO, so the vehicle context the SO carries
 * survives onto the invoice), then stamps the check-in's invoice fields —
 * the same ones the archived view shows and the unpaid-invoices tile reads.
 * The estimate path is driven client-side: an un-converted estimate goes
 * through /api/estimates/convert-to-so first (with its approval gate), then
 * lands here with the fresh SO id.
 *
 * Body: { checkinId, salesOrderId } — the SO must be linked to the check-in
 * (join table or legacy column). One invoice per check-in: an already-
 * stamped invoice_number returns 409 with the existing number.
 */
const Schema = z.object({
  checkinId: z.string().uuid(),
  salesOrderId: z.string().regex(/^\d{1,15}$/),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { checkinId, salesOrderId } = parsed.data;

  try {
    const { data: checkin, error: cErr } = await supabase
      .from('fleet_checkins')
      .select('id, vin, customer_name, invoice_number, netsuite_sales_order_id')
      .eq('id', checkinId)
      .maybeSingle();
    if (cErr || !checkin) {
      return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
    }

    if (checkin.invoice_number) {
      return NextResponse.json({
        error: `This vehicle already has invoice #${checkin.invoice_number}. Clear the invoice field on the card first if it needs re-invoicing.`,
        invoiceNumber: checkin.invoice_number,
      }, { status: 409 });
    }

    // The SO must actually belong to this check-in — join table or the
    // legacy primary column (older rows predate the join table).
    const { data: link } = await supabase
      .from('fleet_checkin_sales_orders')
      .select('id')
      .eq('checkin_id', checkinId)
      .eq('netsuite_sales_order_id', salesOrderId)
      .maybeSingle();
    if (!link && String(checkin.netsuite_sales_order_id || '') !== salesOrderId) {
      return NextResponse.json({ error: 'That sales order is not linked to this vehicle.' }, { status: 400 });
    }

    // ── Fulfill first (or establish that we must not) ──
    const state = await getSalesOrderFulfillmentState(salesOrderId);
    if (!state.success) {
      return NextResponse.json({ error: state.error || 'Could not read the sales order in NetSuite' }, { status: 502 });
    }

    const decision = decideFulfillment({
      soStatus: state.status || '',
      soStatusLabel: state.statusLabel,
      existingFulfillments: state.fulfillments.length,
      shippedFulfillments: state.fulfillments.filter(f => f.status === 'C').length,
    });
    if (decision.action === 'block') {
      return NextResponse.json({ error: decision.error, step: 'fulfillment' }, { status: 400 });
    }

    let fulfillment: { id: string | null; tranid: string | null; shipped: boolean } | null =
      state.fulfillments.length > 0
        ? { id: state.fulfillments[0].id, tranid: state.fulfillments[0].tranid, shipped: state.fulfillments[0].status === 'C' }
        : null;

    if (decision.action === 'fulfill') {
      // The claim is what makes this safe under a double-click: UNIQUE on
      // netsuite_so_id, so the second caller gets 23505 and never reaches
      // NetSuite. Only a claim that provably created nothing is released.
      const { error: claimErr } = await supabase
        .from('netsuite_so_fulfillments')
        .insert({ netsuite_so_id: String(salesOrderId), claimed_by: auth.user?.id || null });

      if (claimErr) {
        if (claimErr.code === '23505') {
          const { data: held } = await supabase
            .from('netsuite_so_fulfillments')
            .select('netsuite_fulfillment_id, tranid, shipped')
            .eq('netsuite_so_id', String(salesOrderId))
            .maybeSingle();
          return NextResponse.json({
            error: held?.netsuite_fulfillment_id
              ? `This sales order was already fulfilled (item fulfillment ${held.tranid || held.netsuite_fulfillment_id}). Reload the vehicle — it may just need invoicing.`
              : 'Another fulfillment for this sales order is already running. Give it a moment, then reload.',
            step: 'fulfillment',
          }, { status: 409 });
        }
        return NextResponse.json({ error: `Could not claim the fulfillment: ${claimErr.message}` }, { status: 500 });
      }

      const filled = await fulfillSalesOrder(salesOrderId);

      if (!filled.success) {
        // Release the claim ONLY when NetSuite confirms nothing was created;
        // an unknown outcome keeps the claim, so the worst case is a stuck
        // sales order a human resolves — never a second fulfillment.
        const after = await getSalesOrderFulfillmentState(salesOrderId);
        if (after.success && after.fulfillments.length === 0) {
          await supabase.from('netsuite_so_fulfillments').delete().eq('netsuite_so_id', String(salesOrderId));
        } else {
          await supabase.from('netsuite_so_fulfillments')
            .update({ last_error: filled.error || 'unknown', ...(after.fulfillments[0] ? {
              netsuite_fulfillment_id: after.fulfillments[0].id,
              tranid: after.fulfillments[0].tranid,
              shipped: after.fulfillments[0].status === 'C',
            } : {}) })
            .eq('netsuite_so_id', String(salesOrderId));
        }
        // No invoice on a failed fulfillment: billing anyway is exactly the
        // labor-and-freight-only invoice this change exists to stop.
        return NextResponse.json({ error: filled.error || 'NetSuite item fulfillment failed', step: 'fulfillment' }, { status: 502 });
      }

      await supabase.from('netsuite_so_fulfillments')
        .update({
          netsuite_fulfillment_id: filled.fulfillmentId || null,
          tranid: filled.tranid || null,
          shipped: filled.shipped,
          completed_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('netsuite_so_id', String(salesOrderId));

      if (!filled.shipped) {
        // Created but not Shipped: inventory has NOT moved, so the invoice
        // would still come up short. Stop here — the claim stays, so a retry
        // re-uses this fulfillment instead of creating another.
        return NextResponse.json({
          error: `Item fulfillment ${filled.tranid || filled.fulfillmentId} was created but NetSuite left it un-shipped, so the parts are not billable yet. Set it to Shipped in NetSuite, then invoice again.`,
          step: 'fulfillment',
          fulfillmentId: filled.fulfillmentId,
        }, { status: 502 });
      }

      fulfillment = { id: filled.fulfillmentId || null, tranid: filled.tranid || null, shipped: true };
    }

    // Full-SO transform: no line overrides, no memo/location overrides —
    // everything the SO carries (vehicle memo, VIN custom field, location)
    // inherits onto the invoice.
    const result = await createInvoiceFromSO({ salesOrderId });
    if (!result.success) {
      return NextResponse.json({ error: result.error || 'NetSuite invoice create failed' }, { status: 502 });
    }

    // Stamp the check-in's invoice fields (migration 070) — best-effort;
    // the invoice exists in NetSuite either way.
    const { error: stampErr } = await supabase
      .from('fleet_checkins')
      .update({
        invoice_number: result.invoiceNumber || result.invoiceId || null,
        date_invoiced: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      })
      .eq('id', checkinId);
    if (stampErr) console.error('checkin invoice stamp failed:', stampErr.message);

    return NextResponse.json({
      success: true,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber || result.invoiceId,
      fulfillmentId: fulfillment?.id || null,
      fulfillmentNumber: fulfillment?.tranid || null,
      fulfilled: decision.action === 'fulfill',
      fulfillmentNote: decision.action === 'skip' ? decision.reason : null,
    });
  } catch (err: any) {
    console.error('vehicle invoice error:', err);
    return NextResponse.json({ error: err?.message || 'Failed to create invoice' }, { status: 500 });
  }
}
