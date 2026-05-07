import { NextRequest, NextResponse } from 'next/server';
import { getNetSuitePdf, suiteqlQuery } from '@/lib/netsuite';
import { sendEmail, buildInvoiceEmail } from '@/lib/resend';
import { requireAuth } from '@/lib/api-auth';
import { safeStringLiteral, SqlSafeError } from '@/lib/sql-safe';
import { validateBody, z } from '@/lib/validate';

const InvoiceItemSchema = z.object({
  invoiceId: z.string().regex(/^\d{1,15}$/).optional(),
  invoiceNumber: z.string().trim().min(1).max(60),
  po: z.string().max(120).optional(),
});

const EmailInvoicesSchema = z.object({
  invoices: z.array(InvoiceItemSchema).min(1).max(50),
  customerName: z.string().max(200).optional().default(''),
  customerEmail: z
    .union([z.string().max(2000), z.array(z.string().max(254)).max(20)])
    .optional(),
  customBody: z.string().max(10_000).optional(),
  dryRun: z.boolean().optional(),
});

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

  const parsed = await validateBody(req, EmailInvoicesSchema);
  if (parsed.error) return parsed.error;
  const { invoices, customerName, customerEmail, customBody, dryRun } = parsed.data;

  try {
    const recipients: string[] = Array.isArray(customerEmail)
      ? customerEmail.map((e) => e.trim()).filter(Boolean)
      : String(customerEmail || '').split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);

    if (!dryRun && recipients.length === 0) {
      return NextResponse.json({ error: 'customerEmail required' }, { status: 400 });
    }

    // Batch resolve any missing invoiceIds in a single SuiteQL query rather
    // than once-per-invoice. With 50 invoices in a packet this drops 50
    // round-trips to one.
    const tranidsToLookup = invoices
      .filter((inv) => !inv.invoiceId && inv.invoiceNumber)
      .map((inv) => inv.invoiceNumber);
    const tranidToId = new Map<string, string>();
    if (tranidsToLookup.length > 0) {
      try {
        const inList = tranidsToLookup
          .map((t) => `'${safeStringLiteral(t, 60)}'`)
          .join(', ');
        const lookup = await suiteqlQuery(
          `SELECT id, tranid FROM transaction WHERE type = 'CustInvc' AND tranid IN (${inList})`
        );
        for (const row of lookup?.items || []) {
          if (row.tranid && row.id) tranidToId.set(String(row.tranid), String(row.id));
        }
      } catch (err: any) {
        if (err instanceof SqlSafeError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }
    }

    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    const results: { invoiceNumber: string; status: 'ok' | 'error'; error?: string }[] = [];

    for (const inv of invoices) {
      const invoiceId = inv.invoiceId || tranidToId.get(inv.invoiceNumber);

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

    const invoiceNumbers = invoices.map((inv) => inv.invoiceNumber).filter(Boolean);
    const poNumbers = invoices.map((inv) => inv.po).filter((v): v is string => !!v);

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
