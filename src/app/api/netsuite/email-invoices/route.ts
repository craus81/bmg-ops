import { NextRequest, NextResponse } from 'next/server';
import { getNetSuitePdf, suiteqlQuery } from '@/lib/netsuite';
import { sendEmail, buildInvoiceEmail } from '@/lib/resend';
import { requireAuth } from '@/lib/api-auth';

/**
 * POST /api/netsuite/email-invoices
 * Body: { invoices: { invoiceId?: string; invoiceNumber: string; po?: string }[]; customerName: string; customerEmail: string }
 * Fetches PDFs for each invoice from NetSuite, attaches them all to one email.
 * If invoiceId is missing, looks it up by invoiceNumber (tranid) via SuiteQL.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { invoices, customerName, customerEmail, customBody } = await req.json();

    if (!invoices || !Array.isArray(invoices) || invoices.length === 0) {
      return NextResponse.json({ error: 'invoices array required' }, { status: 400 });
    }
    if (!customerEmail) {
      return NextResponse.json({ error: 'customerEmail required' }, { status: 400 });
    }

    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    const failed: string[] = [];

    for (const inv of invoices) {
      let invoiceId = inv.invoiceId;

      // Look up internal ID from tranid if not provided
      if (!invoiceId && inv.invoiceNumber) {
        try {
          const lookup = await suiteqlQuery(
            `SELECT id FROM transaction WHERE type = 'CustInvc' AND tranid = '${String(inv.invoiceNumber).replace(/'/g, "''")}'`
          );
          invoiceId = lookup?.items?.[0]?.id;
        } catch (err) {
          // fall through — will record as failed below
        }
      }

      if (!invoiceId) {
        failed.push(inv.invoiceNumber || 'unknown');
        continue;
      }

      const result = await getNetSuitePdf('invoice', invoiceId);
      if (result.success && result.pdfBase64) {
        attachments.push({
          filename: result.filename || `Invoice_${inv.invoiceNumber}.pdf`,
          content: Buffer.from(result.pdfBase64, 'base64'),
          contentType: 'application/pdf',
        });
      } else {
        failed.push(inv.invoiceNumber || invoiceId);
      }
    }

    if (attachments.length === 0) {
      return NextResponse.json({
        error: `Could not fetch any invoice PDFs: ${failed.join(', ')}`,
      }, { status: 400 });
    }

    const invoiceNumbers = invoices.map((inv: any) => inv.invoiceNumber).filter(Boolean);
    const poNumbers = invoices.map((inv: any) => inv.po).filter(Boolean);

    const subject = invoiceNumbers.length === 1
      ? `Invoice #${invoiceNumbers[0]} from BMG Fleet`
      : `${invoiceNumbers.length} Invoices from BMG Fleet`;

    const html = buildInvoiceEmail(customerName, invoiceNumbers, poNumbers, customBody);

    const sent = await sendEmail(customerEmail, subject, html, undefined, attachments);

    if (!sent) {
      return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      sent: attachments.length,
      failed: failed.length,
      failedInvoices: failed,
      to: customerEmail,
    });
  } catch (err: any) {
    console.error('Email invoices error:', err);
    return NextResponse.json({ error: err.message || 'Failed to email invoices' }, { status: 500 });
  }
}
