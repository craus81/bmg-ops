import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { recordVendorInvoice } from '@/lib/vendor-invoice-record';
import { financeUserIds } from '@/lib/ap';
import { logAudit } from '@/lib/audit';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';
// Scan matching + VIN decoding on submit can take a while for big invoices.
export const maxDuration = 120;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Columns installers may see on their own company's invoices — no internal
// actor ids and no staff notes.
const INSTALLER_COLUMNS =
  'id, invoice_number, invoice_date, vendor_name, total_amount, file_name, storage_path, status, ' +
  'submitted_at, approved_at, rejected_at, rejection_reason, billed_at, paid_at, created_at, ' +
  'lines:vendor_invoice_lines(id, vin, part_number, amount)';

const PostSchema = z.object({
  invoiceNumber: z.string().trim().max(60).nullable().optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  totalAmount: z.number().nonnegative().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  // The actual invoice document is required — it's the payment record BMG
  // keeps on file, and what finance reviews in the AP queue.
  file: z.object({
    storagePath: z.string().max(500),
    fileName: z.string().max(200),
  }),
  lines: z.array(z.object({
    vin: z.string().trim().min(5).max(20),
    partNumber: z.string().trim().max(80).nullable().optional(),
    amount: z.number().nonnegative().nullable().optional(),
  })).min(1).max(500),
});

const PatchSchema = z.object({ id: z.string().uuid() });

/** The caller's installer company (profiles.company_id → companies). */
async function callerCompany(userId: string): Promise<{ id: string; name: string } | null> {
  const { data: profile } = await service
    .from('profiles').select('company_id').eq('id', userId).maybeSingle();
  if (!profile?.company_id) return null;
  const { data: company } = await service
    .from('companies').select('id, name').eq('id', profile.company_id).maybeSingle();
  return company || null;
}

async function notifyFinanceOfSubmission(
  actorId: string,
  invoiceId: string,
  companyName: string,
  invoiceNumber: string | null,
  amount: number,
  vinCount: number,
  resubmitted: boolean,
) {
  const recipients = await financeUserIds(service, actorId);
  if (recipients.length === 0) return;
  const num = invoiceNumber ? ` #${invoiceNumber}` : '';
  await notifyMany(recipients, {
    type: 'ap_submitted',
    title: `${resubmitted ? 'Resubmitted' : 'Installer invoice'}: ${companyName}${num}`,
    body: `${companyName} ${resubmitted ? 'resubmitted' : 'submitted'} invoice${num} for $${amount.toFixed(2)} (${vinCount} VIN${vinCount !== 1 ? 's' : ''}) — awaiting approval.`,
    url: deepLinks.apInvoice(invoiceId),
    channels: ['in_app', 'push'],
  });
}

/**
 * GET — the signed-in installer's company invoice history (their own
 * submissions AND invoices BMG recorded on their behalf). Admins can pass
 * ?companyId= to view as a company (the portal's admin-preview mode).
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['installer']);
  if (auth.error) return auth.error;

  const roles: string[] = auth.profile?.roles?.length > 0 ? auth.profile.roles : [auth.profile?.role];
  const previewCompanyId = req.nextUrl.searchParams.get('companyId')?.trim() || '';

  let company: { id: string; name: string } | null = null;
  if (roles.includes('admin') && previewCompanyId) {
    const { data } = await service.from('companies').select('id, name').eq('id', previewCompanyId).maybeSingle();
    company = data || null;
  } else {
    company = await callerCompany(auth.user!.id);
  }
  if (!company) return NextResponse.json({ invoices: [], noCompany: true });

  // Single-invoice fetch (still company-scoped): the ?invoice= deep-link
  // fallback for rows older than the newest-100 window below.
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (id) {
    const { data, error } = await service
      .from('vendor_invoices')
      .select(INSTALLER_COLUMNS)
      .eq('company_id', company.id)
      .eq('id', id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ invoices: data ? [data] : [], companyId: company.id, companyName: company.name });
  }

  const { data, error } = await service
    .from('vendor_invoices')
    .select(INSTALLER_COLUMNS)
    .eq('company_id', company.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ invoices: data || [], companyId: company.id, companyName: company.name });
}

/**
 * POST — submit an invoice. Lands in the AP queue as 'submitted' with the
 * company forced to the installer's own, and finance gets notified. Uses the
 * exact same record path as staff entry (scan matching, cost stamps, part
 * averages, duplicate guard).
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['installer']);
  if (auth.error) return auth.error;

  const company = await callerCompany(auth.user!.id);
  if (!company) {
    return NextResponse.json(
      { error: "Your account isn't linked to an installer company yet — ask BMG to link it before submitting invoices." },
      { status: 400 },
    );
  }

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    const result = await recordVendorInvoice(service, {
      vendorName: company.name,
      companyId: company.id,
      invoiceNumber: body.invoiceNumber || null,
      invoiceDate: body.invoiceDate || null,
      totalAmount: body.totalAmount ?? null,
      locationId: null,
      notes: body.notes || null,
      file: body.file,
      lines: body.lines.map(l => ({
        vin: l.vin,
        partNumber: l.partNumber ?? null,
        amount: l.amount ?? null,
      })),
      actorId: auth.user!.id,
      initialStatus: 'submitted',
      auditDetail: { source: 'installer_portal' },
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const amount = body.totalAmount
      ?? body.lines.reduce((s, l) => s + (l.amount != null ? Number(l.amount) : 0), 0);
    await notifyFinanceOfSubmission(
      auth.user!.id, result.invoiceId, company.name, body.invoiceNumber || null, amount, body.lines.length, false,
    );

    return NextResponse.json({
      success: true,
      invoiceId: result.invoiceId,
      matchedVins: result.updated.length,
      newVins: result.created.length,
      failedVins: result.failed.map(f => f.vin),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to submit invoice' }, { status: 500 });
  }
}

/**
 * PATCH — resubmit a rejected invoice (unchanged content; a corrected
 * re-issue should be submitted as a new invoice with a distinct number).
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(req, ['installer']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;

  const company = await callerCompany(auth.user!.id);
  if (!company) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const { data: invoice } = await service
    .from('vendor_invoices')
    .select('id, status, company_id, vendor_name, invoice_number, total_amount, lines:vendor_invoice_lines(amount)')
    .eq('id', parsed.data.id)
    .maybeSingle();
  // Same 404 whether it doesn't exist or belongs to another company.
  if (!invoice || invoice.company_id !== company.id) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }
  if (invoice.status !== 'rejected') {
    return NextResponse.json({ error: `Invoice is ${invoice.status} — only rejected invoices can be resubmitted` }, { status: 400 });
  }

  const { error } = await service
    .from('vendor_invoices')
    .update({
      status: 'submitted', submitted_by: auth.user!.id, submitted_at: new Date().toISOString(),
      rejected_by: null, rejected_at: null, rejection_reason: null,
    })
    .eq('id', invoice.id);
  if (error) return NextResponse.json({ error: `Failed to resubmit: ${error.message}` }, { status: 500 });

  const amount = invoice.total_amount != null
    ? Number(invoice.total_amount)
    : (invoice.lines || []).reduce((s: number, l: { amount: number | null }) => s + (l.amount != null ? Number(l.amount) : 0), 0);
  await notifyFinanceOfSubmission(
    auth.user!.id, invoice.id, company.name, invoice.invoice_number, amount, (invoice.lines || []).length, true,
  );
  await logAudit(service, {
    actorId: auth.user!.id,
    table: 'vendor_invoices',
    recordId: invoice.id,
    action: 'submit',
    detail: { vendor: invoice.vendor_name, amount, source: 'installer_portal', resubmitted: true },
  });

  return NextResponse.json({ success: true });
}
