import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { vinMatchOrFilter, sameVehicleVin } from '@/lib/vin-match';
import { locationBillingOverride } from '@/lib/scan-billing';
import { matchScansToOpenPos } from '@/lib/scan-match';

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

interface ScanRow {
  id: string;
  vin: string;
  part_number: string | null;
  po_id: string | null;
  exported_at: string | null;
  archived_at: string | null;
  invoice_number: string | null;
  date_invoiced: string | null;
  is_paid: boolean | null;
  scanned_at: string;
}

const cleanVin = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Same lifecycle labels the Scan Log derives — so the client can tell the
 *  admin exactly what state each already-scanned VIN was left in. */
function scanStateLabel(s: ScanRow, requiresPo: (part: string | null) => boolean): string {
  if (s.invoice_number || s.date_invoiced) {
    const inv = s.invoice_number ? ` #${s.invoice_number}` : '';
    return s.is_paid ? `Invoiced${inv} · Paid` : `Invoiced${inv}`;
  }
  if (s.archived_at) return 'Archived';
  if (s.exported_at) return 'Exported';
  if (s.po_id || !requiresPo(s.part_number)) return 'Ready to Export';
  return 'Waiting for PO';
}

/** All scan_logs rows that could be the same vehicles as the given VINs
 *  (last-8 suffix matching, chunked to stay inside URL limits). */
async function findMatchingScans(vins: string[]): Promise<ScanRow[]> {
  const filters = [...new Set(vins.map(vinMatchOrFilter).filter(Boolean))];
  const out: ScanRow[] = [];
  for (let i = 0; i < filters.length; i += 25) {
    const { data } = await service
      .from('scan_logs')
      .select('id, vin, part_number, po_id, exported_at, archived_at, invoice_number, date_invoiced, is_paid, scanned_at')
      .or(filters.slice(i, i + 25).join(','))
      .order('scanned_at', { ascending: false });
    out.push(...((data || []) as ScanRow[]));
  }
  return out;
}

/** Best-effort NHTSA batch decode for full 17-char VINs. */
async function decodeVins(vins: string[]): Promise<Map<string, any>> {
  const decoded = new Map<string, any>();
  const fullVins = [...new Set(vins.filter(v => v.length === 17))];
  for (let i = 0; i < fullVins.length; i += 50) {
    const chunk = fullVins.slice(i, i + 50);
    try {
      const res = await fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `format=json&data=${encodeURIComponent(chunk.join(';'))}`,
      });
      const json = await res.json();
      for (const r of json.Results || []) {
        const v = (r.VIN || '').toUpperCase();
        if (!v) continue;
        decoded.set(v, {
          vehicle_year: r.ModelYear || null,
          vehicle_make: r.Make || null,
          vehicle_model: r.Model || null,
          vehicle_trim: r.Trim || null,
          body_class: r.BodyClass || null,
        });
      }
    } catch {
      // Decode is best-effort; rows still insert without vehicle data.
    }
  }
  return decoded;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data, error } = await service
    .from('vendor_invoices')
    .select('*, company:companies(id, name, netsuite_vendor_id), lines:vendor_invoice_lines(id, vin, part_number, amount, was_existing_scan, scan_log_id)')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ invoices: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const lines = body.lines.map(l => ({
    vin: cleanVin(l.vin),
    partNumber: l.partNumber?.trim() || null,
    amount: l.amount ?? null,
  }));
  const badVins = lines.filter(l => l.vin.length < 5).map(l => l.vin);
  if (badVins.length > 0) {
    return NextResponse.json({ error: `Invalid VIN(s): ${badVins.join(', ') || '(empty)'}` }, { status: 400 });
  }

  try {
    // Location snapshot
    let locationName: string | null = null;
    if (body.locationId) {
      const { data: loc } = await service
        .from('work_locations').select('name').eq('id', body.locationId).maybeSingle();
      locationName = loc?.name || null;
    }

    // Part lookups (description / billable customer / requires_po_match) for
    // every part number on the invoice.
    const partNumbers = [...new Set(lines.map(l => l.partNumber).filter(Boolean))] as string[];
    const partByNumber = new Map<string, { item_number: string; display_name: string | null; billable_customer: string | null; requires_po_match: boolean | null }>();
    for (const pn of partNumbers) {
      const { data: candidates } = await service
        .from('netsuite_parts')
        .select('item_number, display_name, billable_customer, requires_po_match')
        .ilike('item_number', pn)
        .limit(2);
      const exact = (candidates || []).find(c => c.item_number.toUpperCase() === pn.toUpperCase());
      if (exact) partByNumber.set(pn.toUpperCase(), exact);
    }
    const requiresPo = (part: string | null) =>
      !part || partByNumber.get(part.toUpperCase())?.requires_po_match !== false;

    // Match each line to an existing scan (same-vehicle last-8 rule; prefer a
    // scan carrying the line's part number, then the most recent).
    const existingScans = await findMatchingScans(lines.map(l => l.vin));
    const matched = lines.map(line => {
      const candidates = existingScans.filter(s => sameVehicleVin(s.vin, line.vin));
      const withPart = line.partNumber
        ? candidates.filter(s => (s.part_number || '').toUpperCase() === line.partNumber!.toUpperCase())
        : [];
      return { line, scan: withPart[0] || candidates[0] || null };
    });

    // Record the invoice itself.
    const { data: invoice, error: invErr } = await service
      .from('vendor_invoices')
      .insert({
        invoice_number: body.invoiceNumber || null,
        invoice_date: body.invoiceDate || null,
        company_id: body.companyId || null,
        vendor_name: body.vendorName,
        total_amount: body.totalAmount ?? null,
        location_id: body.locationId || null,
        location_name: locationName,
        file_name: body.file?.fileName || null,
        storage_path: body.file?.storagePath || null,
        notes: body.notes || null,
        created_by: auth.user!.id,
      })
      .select('id')
      .single();
    if (invErr || !invoice) {
      return NextResponse.json({ error: `Failed to save invoice: ${invErr?.message}` }, { status: 500 });
    }

    const updated: { vin: string; scanLogId: string; state: string }[] = [];
    const created: { vin: string; scanLogId: string; state: string }[] = [];
    const failed: { vin: string; error: string }[] = [];

    // Existing scans: stamp cost info only — never touch lifecycle fields, so
    // each record stays exactly in the state it was in (ready, archived,
    // invoiced, waiting for PO, …).
    for (const { line, scan } of matched) {
      if (!scan) continue;
      const { error } = await service
        .from('scan_logs')
        .update({
          install_cost: line.amount,
          installer_name: body.vendorName,
          vendor_invoice_id: invoice.id,
        })
        .eq('id', scan.id);
      if (error) failed.push({ vin: line.vin, error: error.message });
      else updated.push({ vin: line.vin, scanLogId: scan.id, state: scanStateLabel(scan, requiresPo) });
    }

    // New VINs: create a scan_logs row so the vehicle is tracked from here on.
    const toCreate = matched.filter(m => !m.scan);
    const decoded = await decodeVins(toCreate.map(m => m.line.vin));
    const overrideCustomer = locationBillingOverride(locationName);
    const newScanIds: string[] = [];
    for (const { line } of toCreate) {
      const part = line.partNumber ? partByNumber.get(line.partNumber.toUpperCase()) : undefined;
      const { data: row, error } = await service
        .from('scan_logs')
        .insert({
          vin: line.vin,
          ...(decoded.get(line.vin) || {}),
          part_number: part?.item_number || line.partNumber,
          part_description: part?.display_name || null,
          billable_customer: overrideCustomer ?? part?.billable_customer ?? null,
          location_id: body.locationId || null,
          location_name: locationName,
          scanned_by: auth.user!.id,
          install_cost: line.amount,
          installer_name: body.vendorName,
          vendor_invoice_id: invoice.id,
        })
        .select('id')
        .single();
      if (error || !row) failed.push({ vin: line.vin, error: error?.message || 'insert failed' });
      else {
        newScanIds.push(row.id);
        created.push({ vin: line.vin, scanLogId: row.id, state: 'New scan' });
      }
    }

    // Invoice lines, pointing at whichever scan each VIN landed on.
    const scanIdByVin = new Map<string, string>();
    for (const u of [...updated, ...created]) scanIdByVin.set(u.vin, u.scanLogId);
    const { error: linesErr } = await service.from('vendor_invoice_lines').insert(
      matched.map(({ line, scan }) => ({
        vendor_invoice_id: invoice.id,
        scan_log_id: scanIdByVin.get(line.vin) || null,
        vin: line.vin,
        part_number: line.partNumber,
        amount: line.amount,
        was_existing_scan: !!scan,
      })),
    );
    if (linesErr) {
      return NextResponse.json({ error: `Invoice saved but lines failed: ${linesErr.message}` }, { status: 500 });
    }

    // Refresh the per-part running average of installer cost.
    for (const pn of partNumbers) {
      const { error } = await service.rpc('recompute_part_install_cost', { p_part_number: pn });
      if (error) console.error('recompute_part_install_cost failed:', pn, error.message);
    }

    // Newly created scans can still auto-match open POs (best-effort).
    if (newScanIds.length > 0) {
      try { await matchScansToOpenPos(service, newScanIds); } catch (e) {
        console.error('PO auto-match after vendor invoice failed:', e);
      }
    }

    return NextResponse.json({
      success: true,
      invoiceId: invoice.id,
      updated,
      created,
      failed,
      summary: { updatedCount: updated.length, createdCount: created.length, failedCount: failed.length },
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
    const { data: lines } = await service
      .from('vendor_invoice_lines').select('part_number').eq('vendor_invoice_id', id);

    // Clear the cost stamps from scans that point at this invoice. Scans the
    // invoice created stay — they're real vehicle records now.
    await service
      .from('scan_logs')
      .update({ install_cost: null, installer_name: null, vendor_invoice_id: null })
      .eq('vendor_invoice_id', id);

    const { error } = await service.from('vendor_invoices').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const partNumbers = [...new Set((lines || []).map(l => l.part_number).filter(Boolean))] as string[];
    for (const pn of partNumbers) {
      const { error: rpcErr } = await service.rpc('recompute_part_install_cost', { p_part_number: pn });
      if (rpcErr) console.error('recompute_part_install_cost failed:', pn, rpcErr.message);
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Delete failed' }, { status: 500 });
  }
}
