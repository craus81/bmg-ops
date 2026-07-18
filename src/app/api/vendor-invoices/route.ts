import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { recordVendorInvoice, restampScans } from '@/lib/vendor-invoice-record';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const LineSchema = z.object({
  vin: z.string().trim().min(5).max(20),
  partNumber: z.string().trim().max(80).nullable().optional(),
  amount: z.number().nonnegative().nullable().optional(),
});

const PostSchema = z.object({
  vendorName: z.string().trim().min(1).max(160),
  companyId: z.string().uuid().nullable().optional(),
  invoiceNumber: z.string().trim().max(60).nullable().optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  totalAmount: z.number().nonnegative().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  file: z.object({
    storagePath: z.string().max(500),
    fileName: z.string().max(200),
  }).nullable().optional(),
  lines: z.array(LineSchema).min(1).max(500),
});

const DeleteSchema = z.object({ id: z.string().uuid() });

export async function GET(req: NextRequest) {
  // Finance (Jessie's AP queue) reads this too — admin passes requireRole.
  const auth = await requireRole(req, ['finance']);
  if (auth.error) return auth.error;

  const status = req.nextUrl.searchParams.get('status')?.trim() || '';
  let q = service
    .from('vendor_invoices')
    .select('*, company:companies(id, name, netsuite_vendor_id), lines:vendor_invoice_lines(id, vin, part_number, amount, was_existing_scan, scan_log_id)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ invoices: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    const result = await recordVendorInvoice(service, {
      vendorName: body.vendorName,
      companyId: body.companyId || null,
      invoiceNumber: body.invoiceNumber || null,
      invoiceDate: body.invoiceDate || null,
      totalAmount: body.totalAmount ?? null,
      locationId: body.locationId || null,
      notes: body.notes || null,
      file: body.file || null,
      lines: body.lines.map(l => ({
        vin: l.vin,
        partNumber: l.partNumber ?? null,
        amount: l.amount ?? null,
      })),
      actorId: auth.user!.id,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, ...(result.duplicate ? { duplicate: result.duplicate } : {}) },
        { status: result.status },
      );
    }
    return NextResponse.json({
      success: true,
      invoiceId: result.invoiceId,
      updated: result.updated,
      created: result.created,
      failed: result.failed,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to record vendor invoice' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DeleteSchema);
  if (parsed.error) return parsed.error;
  const { id } = parsed.data;

  try {
    // Snapshot the whole record before the hard delete — this audit entry is
    // the only durable trace of a deleted invoice.
    const [{ data: header }, { data: fullLines }] = await Promise.all([
      service.from('vendor_invoices').select('*').eq('id', id).maybeSingle(),
      service.from('vendor_invoice_lines').select('scan_log_id, vin, part_number, amount, was_existing_scan').eq('vendor_invoice_id', id),
    ]);
    if (!header) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    // In-pipeline invoices belong to finance — reject or unwind them from
    // /admin/ap first so a delete can't yank a bill out from under AP.
    if (!['recorded', 'rejected'].includes(header.status)) {
      return NextResponse.json({ error: `Invoice is ${header.status} — only recorded or rejected invoices can be deleted` }, { status: 409 });
    }

    const { data: stampedScans } = await service.from('scan_logs').select('id').eq('vendor_invoice_id', id);
    const affected = [...new Set([
      ...((fullLines || []).map(l => l.scan_log_id).filter(Boolean) as string[]),
      ...((stampedScans || []).map(s => s.id) as string[]),
    ])];

    // Cascade removes the lines; the trigger recomputes the part averages.
    const { error } = await service.from('vendor_invoices').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logAudit(service, {
      actorId: auth.user!.id,
      table: 'vendor_invoices',
      recordId: id,
      action: 'delete',
      detail: { invoice: header || null, lines: fullLines || [] },
    });

    // Re-derive scan stamps from whatever other invoices still cover them —
    // scans this invoice created stay (they're real vehicle records now).
    await restampScans(service, affected);

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Delete failed' }, { status: 500 });
  }
}
