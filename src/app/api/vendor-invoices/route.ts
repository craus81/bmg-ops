import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchScansMatchingVins, pickScanForLine } from '@/lib/vin-match';
import { scanLifecycle } from '@/lib/scan-state';
import { decodeVinsBatch } from '@/lib/vin-decoder';
import { locationBillingOverride } from '@/lib/scan-billing';
import { matchScansToOpenPos } from '@/lib/scan-match';
import { findOrMirrorPart } from '@/lib/parts-mirror';

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
  location_id: string | null;
  exported_at: string | null;
  archived_at: string | null;
  invoice_number: string | null;
  date_invoiced: string | null;
  is_paid: boolean | null;
  scanned_at: string;
}

const SCAN_MATCH_COLUMNS =
  'id, vin, part_number, po_id, location_id, exported_at, archived_at, invoice_number, date_invoiced, is_paid, scanned_at';

const cleanVin = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

interface PartInfo {
  item_number: string;
  display_name: string | null;
  billable_customer: string | null;
  requires_po_match: boolean | null;
}

/**
 * Case-insensitive part lookups, parallelized per part. A part missing from
 * the local catalog is checked against NetSuite and mirrored in when it
 * exists there — so a NetSuite-known part is resolved (and stays resolved)
 * instead of being flagged unknown on every invoice.
 */
async function lookupParts(partNumbers: string[]): Promise<Map<string, PartInfo>> {
  const map = new Map<string, PartInfo>();
  await Promise.all(partNumbers.map(async pn => {
    const { part } = await findOrMirrorPart(service, pn);
    if (part) map.set(pn.toUpperCase(), part);
  }));
  return map;
}

/**
 * Recompute the installer-cost stamps on scans from their vendor_invoice_lines
 * (newest line with an amount wins; a grand-total-only line never erases a
 * known cost, and deleting one invoice falls back to whatever other invoices
 * still cover the VIN). Scans with no remaining lines are cleared.
 */
async function restampScans(scanIds: string[]): Promise<void> {
  const ids = [...new Set(scanIds)];
  if (ids.length === 0) return;

  const lines: {
    scan_log_id: string;
    amount: number | null;
    created_at: string;
    vendor_invoice_id: string;
    invoice: { vendor_name: string } | { vendor_name: string }[] | null;
  }[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await service
      .from('vendor_invoice_lines')
      .select('scan_log_id, amount, created_at, vendor_invoice_id, invoice:vendor_invoices(vendor_name)')
      .in('scan_log_id', ids.slice(i, i + 200))
      .order('created_at', { ascending: false });
    lines.push(...((data || []) as typeof lines));
  }

  const byScan = new Map<string, typeof lines>();
  for (const l of lines) {
    if (!l.scan_log_id) continue;
    const arr = byScan.get(l.scan_log_id) || [];
    arr.push(l);
    byScan.set(l.scan_log_id, arr);
  }

  const vendorNameOf = (l: (typeof lines)[0]) => {
    const inv = Array.isArray(l.invoice) ? l.invoice[0] : l.invoice;
    return inv?.vendor_name ?? null;
  };

  const updates = ids.map(id => {
    const scanLines = byScan.get(id) || [];
    const costLine = scanLines.find(l => l.amount != null);
    const refLine = costLine || scanLines[0];
    return {
      id,
      stamp: {
        install_cost: costLine ? Number(costLine.amount) : null,
        installer_name: refLine ? vendorNameOf(refLine) : null,
        vendor_invoice_id: refLine ? refLine.vendor_invoice_id : null,
      },
    };
  });
  for (let i = 0; i < updates.length; i += 10) {
    await Promise.all(updates.slice(i, i + 10).map(u =>
      service.from('scan_logs').update(u.stamp).eq('id', u.id),
    ));
  }
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

  const rawLines = body.lines.map(l => ({
    vin: cleanVin(l.vin),
    partNumber: l.partNumber?.trim() || null,
    amount: l.amount ?? null,
  }));
  const badVins = rawLines.filter(l => l.vin.length < 5).map(l => l.vin);
  if (badVins.length > 0) {
    return NextResponse.json({ error: `Invalid VIN(s): ${badVins.join(', ') || '(empty)'}` }, { status: 400 });
  }

  try {
    // Duplicate guard: the same installer + invoice number was already
    // recorded (matched by company link OR vendor name, so a name-only
    // record still collides with a linked one). Recording it twice would
    // double-count installer cost and skew the per-part averages. Unique
    // indexes (migration 146) are the hard backstop.
    if (body.invoiceNumber) {
      const numberEsc = body.invoiceNumber.replace(/[\\%_]/g, ch => `\\${ch}`);
      // Quoted so commas/parens in names don't break the or-filter syntax.
      const nameQuoted = `"${body.vendorName.replace(/["\\%_]/g, ch => (ch === '"' ? '' : `\\${ch}`))}"`;
      const orFilter = body.companyId
        ? `company_id.eq.${body.companyId},vendor_name.ilike.${nameQuoted}`
        : `vendor_name.ilike.${nameQuoted}`;
      const { data: dupes } = await service
        .from('vendor_invoices')
        .select('id, vendor_name, invoice_number, invoice_date, total_amount, created_at')
        .ilike('invoice_number', numberEsc)
        .or(orFilter)
        .limit(1);
      if (dupes && dupes.length > 0) {
        const d = dupes[0];
        return NextResponse.json({
          error: `Invoice #${d.invoice_number} from ${d.vendor_name} was already recorded on ${String(d.created_at).slice(0, 10)}${d.total_amount != null ? ` for $${Number(d.total_amount).toFixed(2)}` : ''}. If this is a corrected re-issue, give it a distinct number (e.g. "${body.invoiceNumber}-A") or delete the earlier record first.`,
          duplicate: d,
        }, { status: 409 });
      }
    }

    // Location snapshot
    let locationName: string | null = null;
    if (body.locationId) {
      const { data: loc } = await service
        .from('work_locations').select('name').eq('id', body.locationId).maybeSingle();
      locationName = loc?.name || null;
    }

    // Parts named on the invoice — canonicalize each line's part number to
    // the catalog's casing so lines, scans, and the running average all key
    // on one spelling.
    const linePartNumbers = [...new Set(rawLines.map(l => l.partNumber).filter(Boolean))] as string[];
    const partByNumber = await lookupParts(linePartNumbers);
    const lines = rawLines.map(l => ({
      ...l,
      partNumber: l.partNumber
        ? (partByNumber.get(l.partNumber.toUpperCase())?.item_number || l.partNumber)
        : null,
    }));

    // Match each line to an existing scan (same-vehicle last-8 rule; a line
    // with a part only attaches to a scan with that part or none — a
    // different part on the same vehicle is a separate install).
    const existingScans = await fetchScansMatchingVins<ScanRow>(service, lines.map(l => l.vin), SCAN_MATCH_COLUMNS);
    const matched = lines.map(line => ({
      line,
      scan: pickScanForLine(existingScans, line.vin, line.partNumber),
    }));

    // A line with no part number inherits the matched scan's — the system
    // already knows what was installed on that vehicle, so the line feeds the
    // part's running average and the report without anyone retyping it.
    for (const m of matched) {
      if (!m.line.partNumber && m.scan?.part_number) m.line.partNumber = m.scan.part_number;
    }

    // requires_po_match must cover the MATCHED scans' parts too, not just the
    // invoice's — otherwise their reported state defaults to "Waiting for PO".
    const scanPartNumbers = [...new Set(
      matched.map(m => m.scan?.part_number).filter((p): p is string => !!p && !partByNumber.has(p.toUpperCase())),
    )];
    const scanParts = await lookupParts(scanPartNumbers);
    const requiresPo = (part: string | null) => {
      if (!part) return true;
      const info = partByNumber.get(part.toUpperCase()) || scanParts.get(part.toUpperCase());
      return info ? info.requires_po_match !== false : true;
    };

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
      // Unique-index race: someone else recorded the same invoice between
      // the pre-check and this insert.
      if (invErr?.code === '23505') {
        return NextResponse.json({
          error: `Invoice #${body.invoiceNumber} from ${body.vendorName} was just recorded by someone else — check the history list below.`,
        }, { status: 409 });
      }
      return NextResponse.json({ error: `Failed to save invoice: ${invErr?.message}` }, { status: 500 });
    }

    const updated: { vin: string; scanLogId: string; state: string }[] = [];
    const created: { vin: string; scanLogId: string; state: string }[] = [];
    const failed: { vin: string; error: string }[] = [];
    // Scan id per matched entry (never keyed by VIN — one invoice can carry
    // the same VIN twice for two different installs).
    const entryScanIds: (string | null)[] = matched.map(m => m.scan?.id || null);

    // Report the state each pre-existing record was in BEFORE this upload —
    // that's what "left in its current state" means to the admin.
    for (const m of matched) {
      if (m.scan) {
        updated.push({ vin: m.line.vin, scanLogId: m.scan.id, state: scanLifecycle(m.scan, requiresPo).label });
      }
    }

    // New VINs: create scan_logs rows so the vehicles are tracked from here
    // on. Direct insert (not logScan) deliberately mirrors the admin Bulk
    // Upload tab: retroactive entry skips device validation, and scanned_by
    // is the recording admin.
    const toCreateIdx = matched.map((m, i) => (m.scan ? -1 : i)).filter(i => i >= 0);
    if (toCreateIdx.length > 0) {
      const decoded = await decodeVinsBatch(toCreateIdx.map(i => lines[i].vin));
      const overrideCustomer = locationBillingOverride(locationName);
      const rows = toCreateIdx.map(i => {
        const line = lines[i];
        const part = line.partNumber ? partByNumber.get(line.partNumber.toUpperCase()) : undefined;
        return {
          vin: line.vin,
          ...(decoded.get(line.vin) || {}),
          part_number: part?.item_number || line.partNumber,
          part_description: part?.display_name || null,
          billable_customer: overrideCustomer ?? part?.billable_customer ?? null,
          location_id: body.locationId || null,
          location_name: locationName,
          scanned_by: auth.user!.id,
          vendor_invoice_id: invoice.id,
        };
      });

      // One bulk insert; if the whole chunk fails, retry per row so a single
      // bad row doesn't sink the rest.
      const { data: insertedRows, error: bulkErr } = await service
        .from('scan_logs').insert(rows).select('id, vin');
      if (!bulkErr && insertedRows && insertedRows.length === rows.length) {
        insertedRows.forEach((row, j) => {
          entryScanIds[toCreateIdx[j]] = row.id;
          created.push({ vin: rows[j].vin, scanLogId: row.id, state: 'New scan' });
        });
      } else {
        for (const [j, row] of rows.entries()) {
          const { data: single, error } = await service
            .from('scan_logs').insert(row).select('id').single();
          if (error || !single) failed.push({ vin: row.vin, error: error?.message || 'insert failed' });
          else {
            entryScanIds[toCreateIdx[j]] = single.id;
            created.push({ vin: row.vin, scanLogId: single.id, state: 'New scan' });
          }
        }
      }
    }

    // Invoice lines, each pointing at the scan its VIN landed on. The
    // migration's trigger keeps netsuite_parts.avg_install_cost current.
    const { error: linesErr } = await service.from('vendor_invoice_lines').insert(
      matched.map(({ line, scan }, i) => ({
        vendor_invoice_id: invoice.id,
        scan_log_id: entryScanIds[i],
        vin: line.vin,
        part_number: line.partNumber,
        amount: line.amount,
        was_existing_scan: !!scan,
      })),
    );
    if (linesErr) {
      return NextResponse.json({ error: `Invoice saved but lines failed: ${linesErr.message}` }, { status: 500 });
    }

    // Stamp cost info on every touched scan from the full line history —
    // never touching lifecycle fields, so each record stays exactly in the
    // state it was in (ready, archived, invoiced, waiting for PO, …).
    await restampScans(entryScanIds.filter((id): id is string => !!id));

    // Matched scans with no location yet inherit the invoice's — new info on
    // the record (profitability reports group by location), still no state
    // change. Scans that already have a location keep it.
    if (body.locationId && locationName) {
      const fillIds = [...new Set(
        matched.filter(m => m.scan && !m.scan.location_id).map(m => m.scan!.id),
      )];
      if (fillIds.length > 0) {
        await service
          .from('scan_logs')
          .update({ location_id: body.locationId, location_name: locationName })
          .in('id', fillIds);
      }
    }

    // Newly created scans can still auto-match open POs (best-effort).
    const newScanIds = toCreateIdx.map(i => entryScanIds[i]).filter((id): id is string => !!id);
    if (newScanIds.length > 0) {
      try { await matchScansToOpenPos(service, newScanIds); } catch (e) {
        console.error('PO auto-match after vendor invoice failed:', e);
      }
    }

    return NextResponse.json({ success: true, invoiceId: invoice.id, updated, created, failed });
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
    // Every scan this invoice touches, captured before the lines cascade away.
    const [{ data: lineScans }, { data: stampedScans }] = await Promise.all([
      service.from('vendor_invoice_lines').select('scan_log_id').eq('vendor_invoice_id', id),
      service.from('scan_logs').select('id').eq('vendor_invoice_id', id),
    ]);
    const affected = [...new Set([
      ...((lineScans || []).map(l => l.scan_log_id).filter(Boolean) as string[]),
      ...((stampedScans || []).map(s => s.id) as string[]),
    ])];

    // Cascade removes the lines; the trigger recomputes the part averages.
    const { error } = await service.from('vendor_invoices').delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Re-derive scan stamps from whatever other invoices still cover them —
    // scans this invoice created stay (they're real vehicle records now).
    await restampScans(affected);

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Delete failed' }, { status: 500 });
  }
}
