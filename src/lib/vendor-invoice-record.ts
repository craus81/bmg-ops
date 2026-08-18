/**
 * Shared CNI vendor-invoice recording — one code path for both entrances:
 * staff recording from Scan Log → Vendor Invoices (status 'recorded') and
 * installer self-submission from the CNI portal (status 'submitted',
 * landing straight in the AP queue).
 *
 * Matches every line to an existing scan (same-vehicle last-8 rule),
 * creates scans for unknown VINs, stamps installer costs without ever
 * touching lifecycle state, and keeps the per-part running average current
 * via the migration-143 trigger.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchScansMatchingVins, pickScanForLine } from './vin-match';
import { scanLifecycle } from './scan-state';
import { customerRequiresPo, loadBillableCustomers } from './billable-customers';
import { decodeVinsBatch } from './vin-decoder';
import { locationBillingOverride } from './scan-billing';
import { matchScansToOpenPos } from './scan-match';
import { findOrMirrorPart } from './parts-mirror';
import { logAudit } from './audit';

type Service = SupabaseClient<any, any, any>;

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
  'id, vin, part_number, po_id, location_id, exported_at, archived_at, billable_customer, invoice_number, date_invoiced, is_paid, scanned_at';

export const cleanVin = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

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
async function lookupParts(service: Service, partNumbers: string[]): Promise<Map<string, PartInfo>> {
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
export async function restampScans(service: Service, scanIds: string[]): Promise<void> {
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

export interface VendorInvoiceLineInput {
  vin: string;
  partNumber: string | null;
  amount: number | null;
}

export interface RecordVendorInvoiceInput {
  vendorName: string;
  companyId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate?: string | null;
  totalAmount: number | null;
  locationId: string | null;
  notes: string | null;
  file: { storagePath: string; fileName: string } | null;
  lines: VendorInvoiceLineInput[];
  /** created_by on the invoice and scanned_by on any scans created. */
  actorId: string;
  /**
   * 'submitted' = installer self-submission: lands straight in the AP queue.
   * 'paid' = the invoice was already processed and paid outside the app
   * (retroactive upload): recorded as paid, skipping the approval pipeline.
   */
  initialStatus?: 'recorded' | 'submitted' | 'paid';
  /** Extra keys merged into the audit-log detail (e.g. source). */
  auditDetail?: Record<string, unknown>;
}

export type RecordVendorInvoiceResult =
  | {
      ok: true;
      invoiceId: string;
      updated: { vin: string; scanLogId: string; state: string }[];
      created: { vin: string; scanLogId: string; state: string }[];
      failed: { vin: string; error: string }[];
    }
  | { ok: false; status: number; error: string; duplicate?: unknown };

export async function recordVendorInvoice(
  service: Service,
  input: RecordVendorInvoiceInput,
): Promise<RecordVendorInvoiceResult> {
  const rawLines = input.lines.map(l => ({
    vin: cleanVin(l.vin),
    partNumber: l.partNumber?.trim() || null,
    amount: l.amount ?? null,
  }));
  const badVins = rawLines.filter(l => l.vin.length < 5).map(l => l.vin);
  if (badVins.length > 0) {
    return { ok: false, status: 400, error: `Invalid VIN(s): ${badVins.join(', ') || '(empty)'}` };
  }

  // Duplicate guard: the same installer + invoice number was already
  // recorded (matched by company link OR vendor name, so a name-only
  // record still collides with a linked one). Recording it twice would
  // double-count installer cost and skew the per-part averages. Unique
  // indexes (migration 146) are the hard backstop.
  if (input.invoiceNumber) {
    const numberEsc = input.invoiceNumber.replace(/[\\%_]/g, ch => `\\${ch}`);
    // Quoted so commas/parens in names don't break the or-filter syntax.
    const nameQuoted = `"${input.vendorName.replace(/["\\%_]/g, ch => (ch === '"' ? '' : `\\${ch}`))}"`;
    const orFilter = input.companyId
      ? `company_id.eq.${input.companyId},vendor_name.ilike.${nameQuoted}`
      : `vendor_name.ilike.${nameQuoted}`;
    const { data: dupes } = await service
      .from('vendor_invoices')
      .select('id, vendor_name, invoice_number, invoice_date, total_amount, created_at')
      .ilike('invoice_number', numberEsc)
      .or(orFilter)
      .limit(1);
    if (dupes && dupes.length > 0) {
      const d = dupes[0];
      return {
        ok: false,
        status: 409,
        error: `Invoice #${d.invoice_number} from ${d.vendor_name} was already recorded on ${String(d.created_at).slice(0, 10)}${d.total_amount != null ? ` for $${Number(d.total_amount).toFixed(2)}` : ''}. If this is a corrected re-issue, give it a distinct number (e.g. "${input.invoiceNumber}-A") or delete the earlier record first.`,
        duplicate: d,
      };
    }
  }

  // Location snapshot
  let locationName: string | null = null;
  if (input.locationId) {
    const { data: loc } = await service
      .from('work_locations').select('name').eq('id', input.locationId).maybeSingle();
    locationName = loc?.name || null;
  }

  // Parts named on the invoice — canonicalize each line's part number to
  // the catalog's casing so lines, scans, and the running average all key
  // on one spelling.
  const linePartNumbers = [...new Set(rawLines.map(l => l.partNumber).filter(Boolean))] as string[];
  const partByNumber = await lookupParts(service, linePartNumbers);
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
  const scanParts = await lookupParts(service, scanPartNumbers);
  const billableCustomers = await loadBillableCustomers(service);
  const requiresPo = (part: string | null, billableCustomer?: string | null) => {
    // Invoice-first customers (e.g. Reading Truck) never wait for a PO.
    if (!customerRequiresPo(billableCustomer, billableCustomers)) return false;
    if (!part) return true;
    const info = partByNumber.get(part.toUpperCase()) || scanParts.get(part.toUpperCase());
    return info ? info.requires_po_match !== false : true;
  };

  // Record the invoice itself.
  const submitted = input.initialStatus === 'submitted';
  const alreadyPaid = input.initialStatus === 'paid';
  const { data: invoice, error: invErr } = await service
    .from('vendor_invoices')
    .insert({
      invoice_number: input.invoiceNumber || null,
      invoice_date: input.invoiceDate || null,
      due_date: input.dueDate || null,
      company_id: input.companyId || null,
      vendor_name: input.vendorName,
      total_amount: input.totalAmount ?? null,
      location_id: input.locationId || null,
      location_name: locationName,
      file_name: input.file?.fileName || null,
      storage_path: input.file?.storagePath || null,
      notes: input.notes || null,
      created_by: input.actorId,
      ...(submitted ? {
        status: 'submitted',
        submitted_by: input.actorId,
        submitted_at: new Date().toISOString(),
      } : {}),
      ...(alreadyPaid ? {
        status: 'paid',
        paid_by: input.actorId,
        paid_at: new Date().toISOString(),
      } : {}),
    })
    .select('id')
    .single();
  if (invErr || !invoice) {
    // Unique-index race: someone else recorded the same invoice between
    // the pre-check and this insert.
    if (invErr?.code === '23505') {
      return {
        ok: false,
        status: 409,
        error: `Invoice #${input.invoiceNumber} from ${input.vendorName} was just recorded by someone else — check the invoice history.`,
      };
    }
    return { ok: false, status: 500, error: `Failed to save invoice: ${invErr?.message}` };
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
  // is whoever recorded the invoice.
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
        location_id: input.locationId || null,
        location_name: locationName,
        scanned_by: input.actorId,
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
    return { ok: false, status: 500, error: `Invoice saved but lines failed: ${linesErr.message}` };
  }

  // Stamp cost info on every touched scan from the full line history —
  // never touching lifecycle fields, so each record stays exactly in the
  // state it was in (ready, archived, invoiced, waiting for PO, …).
  await restampScans(service, entryScanIds.filter((id): id is string => !!id));

  // Matched scans with no location yet inherit the invoice's — new info on
  // the record (profitability reports group by location), still no state
  // change. Scans that already have a location keep it.
  if (input.locationId && locationName) {
    const fillIds = [...new Set(
      matched.filter(m => m.scan && !m.scan.location_id).map(m => m.scan!.id),
    )];
    if (fillIds.length > 0) {
      await service
        .from('scan_logs')
        .update({ location_id: input.locationId, location_name: locationName })
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

  await logAudit(service, {
    actorId: input.actorId,
    table: 'vendor_invoices',
    recordId: invoice.id,
    action: 'create',
    detail: {
      vendor_name: input.vendorName,
      invoice_number: input.invoiceNumber || null,
      total_amount: input.totalAmount ?? null,
      lines: matched.length,
      scans_updated: updated.length,
      scans_created: created.length,
      ...(input.auditDetail || {}),
    },
  });

  return { ok: true, invoiceId: invoice.id, updated, created, failed };
}
