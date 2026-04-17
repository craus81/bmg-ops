import { NextRequest, NextResponse } from 'next/server';
import { getNetSuitePdf, suiteqlQuery } from '@/lib/netsuite';
import { sendEmail, buildInvoiceEmail } from '@/lib/resend';
import { requireAuth } from '@/lib/api-auth';

/**
 * POST /api/netsuite/email-invoices
 * Body: {
 *   invoices: { invoiceId?: string; invoiceNumber: string; po?: string }[];
 *   customerName: string;
 *   customerEmail: string | string[];
 *   customBody?: string;
 *   dryRun?: boolean;  // when true, fetch PDFs but don't send — returns per-invoice status
 * }
 * Fetches PDFs for each invoice from NetSuite, attaches them all to one email.
 * If invoiceId is missing, looks it up by invoiceNumber (tranid) via SuiteQL.
 * Fails the whole send if any invoice PDF can't be fetched, so customers never
 * receive partial invoice packets.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { invoices, customerName, customerEmail, customBody, dryRun } = await req.json();

    if (!invoices || !Array.isArray(invoices) || invoices.length === 0) {
      return NextResponse.json({ error: 'invoices array required' }, { status: 400 });
    }

    const recipients: string[] = Array.isArray(customerEmail)
      ? customerEmail.map((e: string) => String(e).trim()).filter(Boolean)
      : String(customerEmail || '').split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);

    if (!dryRun && recipients.length === 0) {
      return NextResponse.json({ error: 'customerEmail required' }, { status: 400 });
    }

    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    const results: { invoiceNumber: string; status: 'ok' | 'error'; error?: string }[] = [];

    for (const inv of invoices) {
      let invoiceId = inv.invoiceId;

      if (!invoiceId && inv.invoiceNumber) {
        try {
          const lookup = await suiteqlQuery(
            `SELECT id FROM transaction WHERE type = 'CustInvc' AND tranid = '${String(inv.invoiceNumber).replace(/'/g, "''")}'`
          );
          invoiceId = lookup?.items?.[0]?.id;
        } catch (err: any) {
          results.push({ invoiceNumber: inv.invoiceNumber || 'unknown', status: 'error', error: `Lookup failed: ${err?.message || 'unknown'}` });
          continue;
        }
      }

      if (!invoiceId) {
        results.push({ invoiceNumber: inv.invoiceNumber || 'unknown', status: 'error', error: 'Invoice number not found in NetSuite' });
        continue;
      }

      const result = await getNetSuitePdf('invoice', invoiceId);
      if (result.success && result.pdfBase64) {
        attachments.push({
          filename: result.filename || `Invoice_${inv.invoiceNumber}.pdf`,
          content: Buffer.from(result.pdfBase64, 'base64'),
          contentType: 'application/pdf',
        });
        results.push({ invoiceNumber: inv.invoiceNumber, status: 'ok' });
      } else {
        results.push({ invoiceNumber: inv.invoiceNumber || invoiceId, status: 'error', error: result.error || 'PDF fetch failed' });
      }
    }

    const failed = results.filter(r => r.status === 'error');

    if (dryRun) {
      return NextResponse.json({ success: failed.length === 0, results });
    }

    if (failed.length > 0) {
      return NextResponse.json({
        error: `${failed.length} invoice${failed.length !== 1 ? 's' : ''} failed to fetch — email not sent. Fix or remove failing invoices and try again.`,
        results,
      }, { status: 400 });
    }

    const invoiceNumbers = invoices.map((inv: any) => inv.invoiceNumber).filter(Boolean);
    const poNumbers = invoices.map((inv: any) => inv.po).filter(Boolean);

    const subject = invoiceNumbers.length === 1
      ? `Invoice #${invoiceNumbers[0]} from BMG Fleet`
      : `${invoiceNumbers.length} Invoices from BMG Fleet`;

    const html = buildInvoiceEmail(customerName, invoiceNumbers, poNumbers, customBody);

    const sent = await sendEmail(recipients, subject, html, undefined, attachments);

    if (!sent) {
      return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      sent: attachments.length,
      to: recipients,
      results,
    });
  } catch (err: any) {
    console.error('Email invoices error:', err);
    return NextResponse.json({ error: err.message || 'Failed to email invoices' }, { status: 500 });
  }
}
