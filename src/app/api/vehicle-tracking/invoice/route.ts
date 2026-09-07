import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createInvoiceFromSO, fulfillSalesOrder } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAIM_STALE_MS = 15 * 60 * 1000;

type SoInvoiceRow = {
  id: string;
  netsuite_sales_order_id: string;
  invoice_number: string | null;
  netsuite_invoice_id: string | null;
  fulfillment_number: string | null;
  invoiced_at: string | null;
};

async function loadSoInvoices(checkinId: string): Promise<SoInvoiceRow[] | null> {
  const { data, error } = await supabase
    .from('fleet_checkin_invoices')
    .select('id, netsuite_sales_order_id, invoice_number, netsuite_invoice_id, fulfillment_number, invoiced_at')
    .eq('fleet_checkin_id', checkinId)
    .order('created_at');
  // Table not deployed yet (schema-cache / deploy-order) → callers degrade
  // to the legacy scalar behavior instead of failing.
  if (error) {
    console.warn('fleet_checkin_invoices unavailable:', error.message);
    return null;
  }
  return (data || []) as SoInvoiceRow[];
}

/**
 * GET /api/vehicle-tracking/invoice?checkinId= — the per-SO invoice ledger
 * for one check-in, so the completion modal can show each sales order's own
 * state instead of one number for the whole vehicle.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const checkinId = new URL(req.url).searchParams.get('checkinId') || '';
  if (!z.string().uuid().safeParse(checkinId).success) {
    return NextResponse.json({ error: 'Invalid checkinId' }, { status: 400 });
  }
  const rows = await loadSoInvoices(checkinId);
  return NextResponse.json({ soInvoices: rows ?? [], ledgerAvailable: rows !== null });
}

/**
 * POST /api/vehicle-tracking/invoice — admin-only (field ask, 2026-08-21:
 * "the vehicle completion process should let you turn the sales order or
 * estimate into a NetSuite invoice").
 *
 * Fulfils the sales order first — one Item Fulfillment for every open line
 * (owner rule, 2026-09-05: an invoiced SO must be fulfilled; billing straight
 * off it left orders at Pending Fulfillment with inventory never relieved) —
 * then bills the FULL sales order via NetSuite's SO→invoice transform.
 *
 * One invoice PER SALES ORDER (§7.4 item 2, migration 261): the modal has
 * offered a button per linked SO since the print work, but the check-in's
 * single invoice_number 409'd every second attempt — a three-SO vehicle
 * could bill exactly one of them. The `fleet_checkin_invoices` row IS the
 * claim: its UNIQUE (check-in, SO) pair turns a concurrent second click
 * away before the money call, a NetSuite failure deletes the unstamped row,
 * and success stamps the invoice onto it. The legacy scalar
 * fleet_checkins.invoice_number still receives the FIRST invoice (the
 * archived card, unpaid tile, and AR payment sync read it).
 *
 * Legacy guard: a check-in invoiced before this ledger existed carries a
 * scalar number with no per-SO rows — there is no record of WHICH SO that
 * invoice covered, so billing another SO needs an explicit
 * `allowAdditional: true` after a human has checked NetSuite (the
 * create-invoice tranche-flag precedent, #761).
 *
 * Body: { checkinId, salesOrderId, allowAdditional? } — the SO must be
 * linked to the check-in (join table or legacy column).
 */
const Schema = z.object({
  checkinId: z.string().uuid(),
  salesOrderId: z.string().regex(/^\d{1,15}$/),
  allowAdditional: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { checkinId, salesOrderId, allowAdditional } = parsed.data;

  // Assigned once the claim row exists, so the catch below can release it.
  let releaseOnError: (() => Promise<void>) | null = null;

  try {
    const { data: checkin, error: cErr } = await supabase
      .from('fleet_checkins')
      .select('id, vin, customer_name, invoice_number, netsuite_sales_order_id')
      .eq('id', checkinId)
      .maybeSingle();
    if (cErr || !checkin) {
      return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
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

    const ledger = await loadSoInvoices(checkinId);

    // Ledger unavailable (migration 261 not applied yet): degrade to the
    // old one-invoice-per-vehicle behavior rather than billing unguarded.
    if (ledger === null) {
      if (checkin.invoice_number) {
        return NextResponse.json({
          error: `This vehicle already has invoice #${checkin.invoice_number}. Clear the invoice field on the card first if it needs re-invoicing.`,
          invoiceNumber: checkin.invoice_number,
        }, { status: 409 });
      }
    } else {
      const existing = ledger.find(r => r.netsuite_sales_order_id === salesOrderId);
      if (existing?.invoice_number) {
        return NextResponse.json({
          error: `Sales order ${salesOrderId} is already billed as invoice #${existing.invoice_number}.`,
          invoiceNumber: existing.invoice_number,
          soInvoices: ledger,
        }, { status: 409 });
      }
      // Legacy scalar with NO per-SO rows: an invoice of unknown coverage
      // exists. Require the explicit flag rather than guessing.
      if (checkin.invoice_number && ledger.length === 0 && !allowAdditional) {
        return NextResponse.json({
          error: `This vehicle was invoiced (#${checkin.invoice_number}) before per-sales-order tracking existed, so there is no record of which SO that invoice covered. Check NetSuite first, then confirm to bill SO ${salesOrderId} anyway.`,
          invoiceNumber: checkin.invoice_number,
          legacyInvoice: true,
          canAdditional: true,
        }, { status: 409 });
      }
    }

    // Claim the (check-in, SO) pair by inserting its ledger row BEFORE the
    // money call — the UNIQUE pair turns a concurrent second click away.
    const claimStamp = new Date().toISOString();
    let claimRowId: string | null = null;
    if (ledger !== null) {
      const { data: claimRow, error: claimErr } = await supabase
        .from('fleet_checkin_invoices')
        .insert({
          fleet_checkin_id: checkinId,
          netsuite_sales_order_id: salesOrderId,
          claimed_at: claimStamp,
          invoiced_by: auth.user.id,
        })
        .select('id')
        .single();
      if (claimErr) {
        if ((claimErr as any).code === '23505') {
          // Row exists: invoiced (caught above unless racing), in-flight,
          // or a stale claim from a crash — take over only when stale.
          const staleCutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
          const { data: takeover } = await supabase
            .from('fleet_checkin_invoices')
            .update({ claimed_at: claimStamp, invoiced_by: auth.user.id })
            .eq('fleet_checkin_id', checkinId)
            .eq('netsuite_sales_order_id', salesOrderId)
            .is('invoice_number', null)
            .lt('claimed_at', staleCutoff)
            .select('id');
          if (!takeover || takeover.length === 0) {
            return NextResponse.json({
              error: 'An invoice for this sales order is already being created — wait a moment and refresh.',
            }, { status: 409 });
          }
          claimRowId = takeover[0].id;
        } else {
          console.warn('invoice claim insert failed, proceeding unclaimed:', claimErr.message);
        }
      } else {
        claimRowId = claimRow?.id || null;
      }
    }
    const releaseClaim = async () => {
      if (!claimRowId) return;
      try {
        await supabase
          .from('fleet_checkin_invoices')
          .delete()
          .eq('id', claimRowId)
          .is('invoice_number', null)
          .eq('claimed_at', claimStamp);
      } catch { /* stale claims are reclaimable on their own */ }
    };
    releaseOnError = releaseClaim;

    // Fulfil every line first. Fail closed: an invoice without its
    // fulfillment is the exact state this step exists to prevent.
    const fulfil = await fulfillSalesOrder(salesOrderId);
    if (!fulfil.success) {
      await releaseClaim();
      return NextResponse.json({
        error: `Could not fulfil the sales order, so it was not invoiced: ${fulfil.error || 'NetSuite item fulfillment failed'}`,
        step: 'fulfillment',
      }, { status: 502 });
    }

    // Full-SO transform: no line overrides, no memo/location overrides —
    // everything the SO carries (vehicle memo, VIN custom field, location)
    // inherits onto the invoice.
    const result = await createInvoiceFromSO({ salesOrderId });
    if (!result.success) {
      await releaseClaim();
      // The fulfillment already posted — say so, so nobody fulfils it twice by hand.
      return NextResponse.json({
        error: `${result.error || 'NetSuite invoice create failed'}${fulfil.fulfillmentNumber ? ` (the sales order WAS fulfilled: ${fulfil.fulfillmentNumber} — only the invoice is missing)` : ''}`,
        step: 'invoice',
        fulfillmentNumber: fulfil.fulfillmentNumber || null,
      }, { status: 502 });
    }

    // The invoice exists in NetSuite either way, so every stamp must be
    // truthy — a null would re-arm the guards above and invite a duplicate.
    // An internal-id fallback is fine: the AR payment sync resolves
    // internal ids to tranids (Round 3 §7.2.8).
    const stampNumber = result.invoiceNumber
      || (result.invoiceId ? String(result.invoiceId) : 'created-id-unknown');
    let warning: string | undefined;

    // Retire the claim: stamp the ledger row. A failed stamp keeps the row
    // claimed (blocks a re-bill for 15 minutes) and says so loudly.
    if (claimRowId) {
      const { error: rowStampErr } = await supabase
        .from('fleet_checkin_invoices')
        .update({
          invoice_number: stampNumber,
          netsuite_invoice_id: result.invoiceId ? String(result.invoiceId) : null,
          fulfillment_number: fulfil.fulfillmentNumber || null,
          invoiced_at: new Date().toISOString(),
          claimed_at: null,
        })
        .eq('id', claimRowId);
      if (rowStampErr) {
        console.error('fleet_checkin_invoices stamp failed (invoice exists):', rowStampErr.message);
        warning = `Invoice #${stampNumber} was created, but recording it here failed — this sales order stays locked for 15 minutes; refresh before billing anything else on this vehicle.`;
      }
    }

    // Legacy scalar: the FIRST invoice still lands on the check-in (the
    // archived card, unpaid tile, and AR payment sync read it); later
    // per-SO invoices leave it alone.
    if (!checkin.invoice_number) {
      const { error: stampErr } = await supabase
        .from('fleet_checkins')
        .update({
          invoice_number: stampNumber,
          date_invoiced: new Date().toISOString().slice(0, 10),
          updated_at: new Date().toISOString(),
        })
        .eq('id', checkinId)
        .is('invoice_number', null);
      if (stampErr) console.error('checkin invoice stamp failed:', stampErr.message);
    }

    const finalLedger = ledger !== null ? await loadSoInvoices(checkinId) : null;

    return NextResponse.json({
      success: true,
      warning,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber || result.invoiceId,
      fulfillmentId: fulfil.fulfillmentId || null,
      fulfillmentNumber: fulfil.fulfillmentNumber || null,
      // 'already_fulfilled' = the SO was past fulfillment before this call.
      fulfillmentSkipped: fulfil.skipped || null,
      soInvoices: finalLedger ?? undefined,
    });
  } catch (err: any) {
    console.error('vehicle invoice error:', err);
    if (releaseOnError) await releaseOnError();
    return NextResponse.json({ error: err?.message || 'Failed to create invoice' }, { status: 500 });
  }
}
