import { NextRequest, NextResponse } from 'next/server';
import { requireBooks, requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { PDF_TRIES } from '@/lib/books/invoice-pdf-status';
import { loadOwnInvoicePdf, readInvoicePdfsSwitch, scriptBlocked, sendInvoicePdf, type SendOutcome } from '@/lib/books/invoice-pdfs';

export const dynamic = 'force-dynamic';
// Attaching waits up to 60 s for NetSuite's answer (ATTACH_PDF_TIMEOUT_MS in src/lib/netsuite.ts).
export const maxDuration = 90;

const ID_RE = /^\d{1,20}$/;
const NOT_AN_ID = "That isn't a NetSuite invoice id";

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });

/** What a super admin is told when nothing went, and the status it goes with. */
const SKIPPED: Record<Extract<SendOutcome, { done: 'skipped' }>['why'], { error: string; status: number }> = {
  off: { error: 'Invoice PDFs is switched off, so FleetSuite sends no PDF to NetSuite.', status: 409 },
  missing: { error: 'FleetSuite has no copy of that invoice', status: 404 },
  changed: { error: 'The invoice was fixed while FleetSuite was making its PDF. Look at it again, then send it.', status: 409 },
  attached: { error: "NetSuite has FleetSuite's PDF of this invoice already.", status: 409 },
  sending: { error: "FleetSuite's PDF of this invoice is on its way to NetSuite already.", status: 409 },
  tries: { error: `FleetSuite has tried ${PDF_TRIES} times already.`, status: 409 },
};

/**
 * GET /api/admin/books/own-invoices/pdf?id=<NetSuite id> — FleetSuite's own
 * PDF of one of its own invoices, drawn from its copy
 * (src/lib/books/own-invoice-pdf.ts), to open.
 *
 * POST { id } — sends that PDF to NetSuite's invoice now, even once the
 * two-hourly run has stopped trying (src/lib/books/invoice-pdfs.ts,
 * docs/books.md "Invoice PDFs"). Held back, saying why, when the copy
 * doesn't match NetSuite's invoice; only while Invoice PDFs is on and the PDF
 * script in NetSuite can attach it. Answers what became of it; the invoice's
 * page reads its line again. Audited, without amounts.
 *
 * Super admins, the bookkeeper and the CPA open it; sending it is super
 * admins' only (docs/books.md "Who can open the books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!ID_RE.test(id)) return NextResponse.json({ error: NOT_AN_ID }, { status: 400 });
  try {
    const pdf = await loadOwnInvoicePdf(createServiceClient(), id);
    if (!pdf.ok) return NextResponse.json({ error: pdf.error }, { status: pdf.status });
    return new NextResponse(new Uint8Array(pdf.bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${pdf.filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return failed(err);
  }
}

const Schema = z.object({ id: z.string().max(40) });

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { id } = parsed.data;
  if (!ID_RE.test(id)) return NextResponse.json({ error: NOT_AN_ID }, { status: 400 });
  const service = createServiceClient();
  try {
    if (!(await readInvoicePdfsSwitch(service)).on) return NextResponse.json({ error: SKIPPED.off.error }, { status: SKIPPED.off.status });
    const blocked = await scriptBlocked();
    if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

    const sent = await sendInvoicePdf(service, { netsuiteId: id, by: auth.user.id, again: true });
    if (sent.done === 'skipped') return NextResponse.json({ error: SKIPPED[sent.why].error }, { status: SKIPPED[sent.why].status });
    const outcome = sent.done === 'held' ? 'held' : sent.outcome;
    await logAudit(service, {
      actorId: auth.user.id,
      table: 'own_invoice_pdfs',
      recordId: id,
      action: 'send_invoice_pdf',
      detail: sent.done === 'held'
        ? { outcome, heldFor: sent.heldFor }
        : sent.outcome === 'attached' ? { outcome, fileId: sent.fileId, replaced: sent.replaced } : { outcome },
    });
    return NextResponse.json(sent.done === 'held' ? { outcome, heldFor: sent.heldFor } : { outcome });
  } catch (err) {
    return failed(err);
  }
}
