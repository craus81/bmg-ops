import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getNetSuitePdf, suiteqlQuery } from '@/lib/netsuite';
import { sendEmail, buildInvoiceEmail } from '@/lib/resend';
import { requireRole } from '@/lib/api-auth';
import { safeStringLiteral, SqlSafeError } from '@/lib/sql-safe';
import { validateBody, z } from '@/lib/validate';

/** Quote a value for RFC-4180 CSV output. */
function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Builds a CSV of the scanned vehicles behind the given invoices, keyed by the
 * invoice_number stamped on scan_logs at invoice-creation time. Returns null
 * when no scans match, so the email goes out with just the PDFs.
 */
async function buildVinCsv(invoiceNumbers: string[]): Promise<string | null> {
  if (invoiceNumbers.length === 0) return null;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from('scan_logs')
    .select('invoice_number, vin, vehicle_year, vehicle_make, vehicle_model, vehicle_trim, part_number, part_description, po_number')
    .in('invoice_number', invoiceNumbers);

  if (error) {
    console.error('VIN list lookup failed:', error.message);
    return null;
  }
  if (!data || data.length === 0) return null;

  // Sort by invoice then VIN so the CSV reads in a stable, grouped order.
  const rows = [...data].sort((a, b) =>
    String(a.invoice_number).localeCompare(String(b.invoice_number)) ||
    String(a.vin).localeCompare(String(b.vin))
  );

  const header = ['Invoice', 'VIN', 'Year', 'Make', 'Model', 'Trim', 'Part Number', 'Part Description', 'PO'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.invoice_number, r.vin, r.vehicle_year, r.vehicle_make, r.vehicle_model,
      r.vehicle_trim, r.part_number, r.part_description, r.po_number,
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

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
  // True when the send goes to the signed-in user as a preview — test sends
  // are never logged to invoice_emails.
  testSend: z.boolean().optional(),
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
  const auth = await requireRole(req, ['sales']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, EmailInvoicesSchema);
  if (parsed.error) return parsed.error;
  const { invoices, customerName, customerEmail, customBody, dryRun, testSend } = parsed.data;

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
    // invoiceId is echoed back so the client can offer "view PDF" links for
    // invoices it only knew by number (the verify dry run resolves them).
    const results: { invoiceNumber: string; invoiceId?: string; status: 'ok' | 'error'; error?: string }[] = [];

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
        results.push({ invoiceNumber: inv.invoiceNumber, invoiceId, status: 'ok' });
      } else {
        results.push({ invoiceNumber: inv.invoiceNumber || invoiceId, invoiceId, status: 'error', error: result.error || 'PDF fetch failed' });
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

    // Count invoice PDFs before appending the VIN list so the response's `sent`
    // tally reflects invoices, not attachments.
    const pdfCount = attachments.length;

    // Attach a VIN list for the scanned vehicles behind these invoices, if any
    // scan_logs rows are linked by invoice_number. Failures here never block the
    // invoice send — the PDFs are the essential payload.
    const vinCsv = await buildVinCsv(invoiceNumbers);
    if (vinCsv) {
      attachments.push({
        filename: 'VIN_List.csv',
        content: Buffer.from(vinCsv, 'utf-8'),
        contentType: 'text/csv',
      });
    }

    const sent = await sendEmail(recipients, subject, html, undefined, attachments);

    if (!sent) {
      return NextResponse.json({ error: 'Failed to send email' }, { status: 500 });
    }

    // Record the send (one row per invoice) so screens can show "already
    // emailed" next time. Test sends to the sender are skipped, and a
    // logging failure never turns a delivered email into an error.
    if (!testSend && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const service = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY
        );
        await service.from('invoice_emails').insert(
          results.filter(r => r.status === 'ok').map(r => ({
            invoice_number: r.invoiceNumber,
            netsuite_invoice_id: r.invoiceId || null,
            customer_name: customerName || null,
            recipients,
            sent_by: auth.user?.id || null,
          }))
        );
      } catch (logErr) {
        console.error('invoice_emails log failed:', logErr);
      }
    }

    return NextResponse.json({
      success: true,
      sent: pdfCount,
      vinListAttached: !!vinCsv,
      to: recipients,
      results,
    });
  } catch (err: any) {
    console.error('Email invoices error:', err);
    return NextResponse.json({ error: err.message || 'Failed to email invoices' }, { status: 500 });
  }
}
