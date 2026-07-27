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
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  totalAmount: z.number().nonnegative().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  file: z.object({
    storagePath: z.string().max(500),
    fileName: z.string().max(200),
  }).nullable().optional(),
  lines: z.array(LineSchema).min(1).max(500),
  // Retroactive upload of an invoice that was already processed and paid
  // outside the app — record it as paid, skipping the approval pipeline.
  alreadyPaid: z.boolean().optional(),
});

const DeleteSchema = z.object({ id: z.string().uuid() });

// Header-only edit of an invoice that hasn't been billed yet. Every field is
// optional — only the keys present are changed. The common case is fixing the
// vendor link (companyId) on an invoice recorded before its company existed
// in NetSuite, but finance can correct the other header fields the same way.
const PatchSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid().nullable().optional(),
  vendorName: z.string().trim().min(1).max(160).optional(),
  invoiceNumber: z.string().trim().max(60).nullable().optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  totalAmount: z.number().nonnegative().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

// A bill in NetSuite already references the header, so editing after it's
// created would silently desync the two. Edits are for the pre-bill stages.
const EDITABLE_STATUSES = ['recorded', 'submitted', 'approved', 'rejected'];

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
      dueDate: body.dueDate || null,
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
      ...(body.alreadyPaid ? { initialStatus: 'paid' as const, auditDetail: { alreadyPaid: true } } : {}),
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

export async function PATCH(req: NextRequest) {
  // Finance operates the AP queue, same as the lifecycle workflow route.
  const auth = await requireRole(req, ['finance']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    const { data: current } = await service
      .from('vendor_invoices')
      .select('id, status, vendor_name, invoice_number')
      .eq('id', body.id)
      .maybeSingle();
    if (!current) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    if (!EDITABLE_STATUSES.includes(current.status)) {
      return NextResponse.json(
        { error: `Invoice is ${current.status} — a NetSuite bill already references it, so its details can't be edited here.` },
        { status: 409 },
      );
    }

    // Build the patch from only the keys actually supplied.
    const patch: Record<string, unknown> = {};
    if ('companyId' in body) patch.company_id = body.companyId || null;
    if (body.vendorName !== undefined) patch.vendor_name = body.vendorName;
    if ('invoiceNumber' in body) patch.invoice_number = body.invoiceNumber || null;
    if ('invoiceDate' in body) patch.invoice_date = body.invoiceDate || null;
    if ('dueDate' in body) patch.due_date = body.dueDate || null;
    if ('totalAmount' in body) patch.total_amount = body.totalAmount ?? null;
    if ('notes' in body) patch.notes = body.notes || null;
    if ('locationId' in body) {
      patch.location_id = body.locationId || null;
      let locationName: string | null = null;
      if (body.locationId) {
        const { data: loc } = await service
          .from('work_locations').select('name').eq('id', body.locationId).maybeSingle();
        locationName = loc?.name || null;
      }
      patch.location_name = locationName;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    // Renumbering into a number another invoice from the same installer
    // already carries would collide with the migration-146 unique index — the
    // same duplicate the record path guards against. Catch it early with a
    // clear message instead of a raw 23505.
    const newNumber = 'invoiceNumber' in body ? (body.invoiceNumber || null) : undefined;
    if (newNumber && newNumber.toLowerCase() !== (current.invoice_number || '').toLowerCase()) {
      const numberEsc = newNumber.replace(/[\\%_]/g, ch => `\\${ch}`);
      const name: string = body.vendorName ?? current.vendor_name ?? '';
      const nameQuoted = `"${name.replace(/["\\%_]/g, ch => (ch === '"' ? '' : `\\${ch}`))}"`;
      const orFilter = body.companyId
        ? `company_id.eq.${body.companyId},vendor_name.ilike.${nameQuoted}`
        : `vendor_name.ilike.${nameQuoted}`;
      const { data: dupes } = await service
        .from('vendor_invoices')
        .select('id, vendor_name, invoice_number')
        .ilike('invoice_number', numberEsc)
        .neq('id', body.id)
        .or(orFilter)
        .limit(1);
      if (dupes && dupes.length > 0) {
        return NextResponse.json(
          { error: `Invoice #${newNumber} from ${dupes[0].vendor_name} already exists — pick a distinct number.` },
          { status: 409 },
        );
      }
    }

    const { error } = await service.from('vendor_invoices').update(patch).eq('id', body.id);
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: `Invoice #${newNumber} already exists for this installer — pick a distinct number.` }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // vendor_name is stamped onto each covered scan as installer_name — keep
    // those in sync when it changes.
    if (patch.vendor_name !== undefined && patch.vendor_name !== current.vendor_name) {
      const { data: lines } = await service
        .from('vendor_invoice_lines').select('scan_log_id').eq('vendor_invoice_id', body.id);
      const scanIds = (lines || []).map(l => l.scan_log_id).filter(Boolean) as string[];
      if (scanIds.length > 0) await restampScans(service, scanIds);
    }

    await logAudit(service, {
      actorId: auth.user!.id,
      table: 'vendor_invoices',
      recordId: body.id,
      action: 'edit',
      detail: { changed: Object.keys(patch), before: { vendor_name: current.vendor_name, invoice_number: current.invoice_number } },
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Edit failed' }, { status: 500 });
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
    // Paid-with-no-bill = marked paid outside the pipeline (retroactive
    // upload); nothing downstream references it, so it stays deletable.
    const deletable = ['recorded', 'rejected'].includes(header.status)
      || (header.status === 'paid' && !header.netsuite_bill_id);
    if (!deletable) {
      return NextResponse.json({ error: `Invoice is ${header.status} — only recorded, rejected, or paid-outside-the-pipeline invoices can be deleted` }, { status: 409 });
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
