import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createBillFromPo, findVendorBill } from '@/lib/netsuite';
import { loadThreeWayMatchForPo } from '@/lib/three-way-match';
import { logAudit } from '@/lib/audit';
import { saveOwnBill } from '@/lib/books/own-bills';
import { madeOrFound, makeBillOnce, STALE_CLAIM_MS } from '@/lib/bill-once';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const Schema = z.object({
  invoiceId: z.string().uuid(),
  // R4-8: a non-green three-way match blocks the bill unless the caller
  // explicitly overrides with a recorded reason (audit-logged).
  override: z.boolean().optional(),
  overrideReason: z.string().max(500).optional(),
  // Mark billed: NetSuite's id for the bill it already has from the vendor
  // under this invoice's Reference No., which Create bill found and named.
  // NetSuite is asked again before the invoice is marked.
  recordBill: z.string().regex(/^\d{1,20}$/).optional(),
});

/**
 * The bill's Reference No.: the vendor's invoice number, or, when the scan
 * read none, one made from the invoice's id, so NetSuite can always be asked
 * whether it already has the bill (src/lib/bill-once.ts).
 */
const referenceFor = (invoice: { id: string; invoice_number: string | null }) =>
  (invoice.invoice_number?.trim() || `PM-${invoice.id.slice(0, 8)}`).slice(0, 40);

/**
 * POST /api/parts-mail/create-bill — turn a captured vendor parts invoice
 * into a NetSuite vendor bill by transforming its matched purchase order
 * (vendor, items, amounts all carry over; the vendor's invoice number
 * becomes the bill's Reference No.). Posting real financials, so it's an
 * explicit admin/finance click — never automatic. One bill per invoice
 * (src/lib/bill-once.ts): when NetSuite already has the vendor's bill under
 * that Reference No., none is made, and { recordBill } marks the invoice
 * billed with it instead.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'finance']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const { data: invoice } = await service
    .from('vendor_parts_invoices')
    .select('*, netsuite_vendor_pos:matched_po_id (id, netsuite_id, tranid, vendor_name, vendor_netsuite_id)')
    .eq('id', parsed.data.invoiceId)
    .maybeSingle();
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  if (invoice.status === 'billed') {
    return NextResponse.json({ error: `Already billed (${invoice.netsuite_bill_number || invoice.netsuite_bill_id})` }, { status: 409 });
  }
  if (invoice.status !== 'captured') {
    return NextResponse.json({ error: "This invoice was dismissed, so it isn't billed from Parts Mail." }, { status: 409 });
  }
  const po = (invoice as any).netsuite_vendor_pos;
  if (!po?.netsuite_id) {
    return NextResponse.json({ error: 'Link this invoice to a vendor PO first — the bill is created from the PO.' }, { status: 422 });
  }
  // NetSuite is asked for a bill it already has from the PO's vendor before one is made, so the vendor is needed.
  if (!/^\d+$/.test(po.vendor_netsuite_id ?? '')) {
    return NextResponse.json({
      error: `FleetSuite's copy of PO ${po.tranid} doesn't have its vendor yet, so it can't check NetSuite for a bill already made from this invoice. Nothing was billed. Tap Sync POs, then try again.`,
    }, { status: 422 });
  }
  const vendorName: string = po.vendor_name || invoice.vendor_name || 'the vendor';
  const referenceNo = referenceFor(invoice);

  if (parsed.data.recordBill) {
    // Only the bill NetSuite still has from the vendor under this Reference No. marks the invoice.
    let found: Awaited<ReturnType<typeof findVendorBill>>;
    try {
      found = await findVendorBill(po.vendor_netsuite_id, referenceNo);
    } catch (e: any) {
      return NextResponse.json({
        error: `Couldn't ask NetSuite for bill ${referenceNo}, so this invoice wasn't marked billed. Try again. (${e?.message || e})`,
      }, { status: 502 });
    }
    if (!found || found.billId !== parsed.data.recordBill) {
      return NextResponse.json({
        error: `NetSuite doesn't have that bill from ${vendorName} under ${referenceNo} now, so this invoice wasn't marked billed. Refresh and try again.`,
      }, { status: 409 });
    }
    // Left to a try that's billing it right now (src/lib/bill-once.ts); one that died long ago doesn't hold it.
    const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    const { data: marked, error: markErr } = await service.from('vendor_parts_invoices').update({
      status: 'billed',
      netsuite_bill_id: found.billId,
      netsuite_bill_number: found.billNumber || null,
      billed_by: auth.user!.id,
      billed_at: new Date().toISOString(),
      bill_claimed_at: null,
    }).eq('id', invoice.id)
      .eq('status', 'captured')
      .or(`bill_claimed_at.is.null,bill_claimed_at.lt.${staleCutoff}`)
      .select('id');
    if (markErr) {
      return NextResponse.json({ error: `Couldn't mark this invoice billed (${markErr.message}). Try again.` }, { status: 500 });
    }
    if (!marked || marked.length === 0) {
      return NextResponse.json({ error: 'A bill for this invoice is being made, or it was just marked billed. Wait a moment and refresh.' }, { status: 409 });
    }
    await logAudit(service, {
      actorId: auth.user!.id,
      table: 'vendor_parts_invoices',
      recordId: invoice.id,
      action: 'record_bill',
      detail: { po: po.tranid, invoiceNumber: invoice.invoice_number, referenceNo, netsuite_bill_id: found.billId, billNumber: found.billNumber || null },
    });
    return NextResponse.json({ billId: found.billId, billNumber: found.billNumber, po: po.tranid, recorded: true });
  }

  // R4-8 three-way match, enforced server-side on every click (the card's
  // panel is display only): invoice total vs PO, dock receipts vs ordered,
  // prior bills against the PO. Green bills as before; anything else needs
  // an explicit override with a typed reason. Fail closed — if the match
  // can't be computed, the money call doesn't happen.
  const wantsOverride = parsed.data.override === true;
  const overrideReason = (parsed.data.overrideReason || '').trim();
  let matchResult: Awaited<ReturnType<typeof loadThreeWayMatchForPo>>['match'] | null = null;
  try {
    const { match } = await loadThreeWayMatchForPo(
      service, invoice.matched_po_id, invoice.total != null ? Number(invoice.total) : null, invoice.id,
    );
    matchResult = match;
  } catch (e: any) {
    return NextResponse.json({
      error: `Could not verify this invoice against the PO (${e?.message || 'match failed'}) — nothing was billed. Try again, or check the PO mirror.`,
    }, { status: 502 });
  }
  if (matchResult.verdict !== 'green' && !(wantsOverride && overrideReason)) {
    return NextResponse.json({
      error: matchResult.verdict === 'red'
        ? 'The three-way match failed — review the variances, then bill with an override reason if this is deliberate.'
        : 'The three-way match has warnings — confirm with an override reason to bill anyway.',
      match: matchResult,
      canOverride: true,
    }, { status: 409 });
  }

  // One bill per invoice (src/lib/bill-once.ts): an atomic claim on the
  // captured invoice (migration 251), so two clicks at once can't post two
  // real vendor bills (Round 3 §7.2.4); then NetSuite is asked for a bill it
  // already has from the vendor under this Reference No., so a bill whose
  // billed stamp failed, or one entered in NetSuite by hand, isn't made
  // again. A bill NetSuite kept without saying so is found right after.
  const findThisBill = () => findVendorBill(po.vendor_netsuite_id, referenceNo);
  const once = await makeBillOnce(service, 'vendor_parts_invoices', invoice.id, {
    vendorId: po.vendor_netsuite_id,
    vendorName,
    referenceNo,
    create: () => madeOrFound(() => createBillFromPo({
      purchaseOrderId: po.netsuite_id,
      referenceNo,
      memo: `Parts invoice ${invoice.invoice_number || invoice.file_name} (via FleetSuite parts mail)`,
    }), findThisBill),
  }, findThisBill);
  if (!once.ok) {
    return NextResponse.json({ error: once.error, ...(once.found ? { found: once.found } : {}) }, { status: once.status });
  }
  const bill = { billId: once.billId, billNumber: once.billNumber };

  // Books keeps its own copy of what was billed: the PO's open lines at its
  // prices, as FleetSuite's copy of the PO has them (src/lib/books/own-bills.ts).
  // It never stops the bill.
  await saveOwnBill(service, {
    netsuiteId: bill.billId,
    netsuiteNumber: bill.billNumber,
    madeFrom: 'parts_mail',
    madeFromId: invoice.id,
    madeBy: auth.user!.id,
    vendorId: po.vendor_netsuite_id,
    vendorName: po.vendor_name || invoice.vendor_name,
    referenceNo,
    po: { copyId: po.id, netsuiteId: po.netsuite_id, number: po.tranid },
    invoiceTotal: invoice.total,
  });

  // A bill posted past a non-green match is an exception the weekly digest
  // reads (R4-5) — recorded as soon as the bill exists, whatever happens
  // to the stamp below.
  if (matchResult.verdict !== 'green') {
    await logAudit(service, {
      actorId: auth.user!.id,
      table: 'vendor_parts_invoices',
      recordId: invoice.id,
      action: 'vendor_bill_variance_override',
      detail: {
        reason: overrideReason,
        verdict: matchResult.verdict,
        variances: matchResult.variances,
        po: po.tranid,
        invoiceNumber: invoice.invoice_number,
        invoiceTotal: invoice.total,
        billNumber: bill.billNumber || bill.billId || null,
      },
    });
  }

  // The bill EXISTS from here on — never report failure, never stamp falsy
  // (R3-8): this stamp used to be unchecked, so a failed write left the
  // invoice re-billable with a real bill already posted.
  const { error: stampErr } = await service.from('vendor_parts_invoices').update({
    status: 'billed',
    netsuite_bill_id: bill.billId || 'created-id-unknown',
    netsuite_bill_number: bill.billNumber || null,
    billed_by: auth.user!.id,
    billed_at: new Date().toISOString(),
    ...(once.claimedAt ? { bill_claimed_at: null } : {}),
  }).eq('id', invoice.id);
  if (stampErr) {
    // The claim stays held, so nothing bills it while the stamp is missing.
    // Once it's gone stale, Create bill finds this bill in NetSuite and
    // offers to mark the invoice billed with it.
    console.error('create-bill: billed stamp failed after NetSuite create:', stampErr.message);
    const number = bill.billNumber || bill.billId || referenceNo;
    return NextResponse.json({
      billId: bill.billId,
      billNumber: bill.billNumber,
      po: po.tranid,
      warning: `The bill was made in NetSuite, but marking this invoice billed failed (${stampErr.message}). Nothing will bill it again: in 15 minutes, Create NetSuite Bill finds bill ${number} and offers to mark this invoice billed with it.`,
    });
  }

  return NextResponse.json({ billId: bill.billId, billNumber: bill.billNumber, po: po.tranid });
}
