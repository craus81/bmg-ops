import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const QuerySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

interface ReportLine {
  invoiceId: string;
  invoiceNumber: string | null;
  date: string;
  vendor: string;
  location: string;
  vin: string;
  partNumber: string | null;
  paid: number | null;
  invoiced: number | null;
  invoicedSource: 'po_price' | 'catalog_price' | null;
}

function rollup(lines: ReportLine[], keyOf: (l: ReportLine) => string) {
  const map = new Map<string, { key: string; vins: number; paid: number; invoiced: number; unpriced: number }>();
  for (const l of lines) {
    const key = keyOf(l);
    const row = map.get(key) || { key, vins: 0, paid: 0, invoiced: 0, unpriced: 0 };
    row.vins += 1;
    if (l.paid != null) row.paid += l.paid; else row.unpriced += 1;
    if (l.invoiced != null) row.invoiced += l.invoiced;
    map.set(key, row);
  }
  return [...map.values()]
    .map(r => ({ ...r, margin: r.invoiced - r.paid }))
    .sort((a, b) => b.paid - a.paid);
}

/**
 * What we paid CNI installers per VIN (vendor_invoice_lines) vs. what we
 * (would) invoice the customer for the same install. The revenue side is an
 * ESTIMATE — the PO line's unit price when the scan is PO-matched, else the
 * part's catalog sales price — because per-VIN billed dollars only exist in
 * NetSuite invoice lines.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, QuerySchema);
  if (parsed.error) return parsed.error;
  const { start, end } = parsed.data;

  try {
    // Invoices in range: by invoice_date when present, else by recorded date.
    const [byDate, byCreated] = await Promise.all([
      service.from('vendor_invoices')
        .select('id, invoice_number, invoice_date, vendor_name, location_name, created_at')
        .gte('invoice_date', start).lte('invoice_date', end),
      service.from('vendor_invoices')
        .select('id, invoice_number, invoice_date, vendor_name, location_name, created_at')
        .is('invoice_date', null)
        .gte('created_at', `${start}T00:00:00`).lte('created_at', `${end}T23:59:59`),
    ]);
    const invoices = [...(byDate.data || []), ...(byCreated.data || [])];
    if (invoices.length === 0) {
      return NextResponse.json({ range: { start, end }, lines: [], perVendor: [], perLocation: [], perPart: [], totals: { vins: 0, paid: 0, invoiced: 0, margin: 0, unpriced: 0 } });
    }
    const invoiceById = new Map(invoices.map(i => [i.id, i]));

    // Lines, in chunks.
    const invoiceIds = invoices.map(i => i.id);
    const rawLines: any[] = [];
    for (let i = 0; i < invoiceIds.length; i += 100) {
      const { data } = await service
        .from('vendor_invoice_lines')
        .select('vendor_invoice_id, scan_log_id, vin, part_number, amount')
        .in('vendor_invoice_id', invoiceIds.slice(i, i + 100))
        .limit(5000);
      rawLines.push(...(data || []));
    }

    // Revenue estimate inputs: the scan's PO line price, else catalog price.
    const scanIds = [...new Set(rawLines.map(l => l.scan_log_id).filter(Boolean))] as string[];
    const scanById = new Map<string, { id: string; po_line_item_id: string | null; part_number: string | null; location_name: string | null }>();
    for (let i = 0; i < scanIds.length; i += 200) {
      const { data } = await service
        .from('scan_logs')
        .select('id, po_line_item_id, part_number, location_name')
        .in('id', scanIds.slice(i, i + 200));
      for (const s of data || []) scanById.set(s.id, s);
    }
    const poLineIds = [...new Set([...scanById.values()].map(s => s.po_line_item_id).filter(Boolean))] as string[];
    const poLinePrice = new Map<string, number>();
    for (let i = 0; i < poLineIds.length; i += 200) {
      const { data } = await service
        .from('po_line_items').select('id, unit_price').in('id', poLineIds.slice(i, i + 200));
      for (const l of data || []) if (l.unit_price != null) poLinePrice.set(l.id, Number(l.unit_price));
    }
    const partPrice = new Map<string, number>();
    {
      let pg = 0; let more = true;
      while (more) {
        const { data } = await service
          .from('netsuite_parts').select('item_number, sales_price')
          .range(pg * 1000, (pg + 1) * 1000 - 1);
        for (const p of data || []) {
          if (p.sales_price != null && Number(p.sales_price) > 0) partPrice.set(p.item_number.toUpperCase(), Number(p.sales_price));
        }
        more = (data || []).length === 1000;
        pg++;
      }
    }

    const lines: ReportLine[] = rawLines.map(l => {
      const inv = invoiceById.get(l.vendor_invoice_id)!;
      const scan = l.scan_log_id ? scanById.get(l.scan_log_id) : undefined;
      const partNumber = l.part_number || scan?.part_number || null;
      let invoiced: number | null = null;
      let invoicedSource: ReportLine['invoicedSource'] = null;
      if (scan?.po_line_item_id && poLinePrice.has(scan.po_line_item_id)) {
        invoiced = poLinePrice.get(scan.po_line_item_id)!;
        invoicedSource = 'po_price';
      } else if (partNumber && partPrice.has(partNumber.toUpperCase())) {
        invoiced = partPrice.get(partNumber.toUpperCase())!;
        invoicedSource = 'catalog_price';
      }
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        date: inv.invoice_date || inv.created_at.slice(0, 10),
        vendor: inv.vendor_name,
        location: inv.location_name || scan?.location_name || 'No Location',
        vin: l.vin,
        partNumber,
        paid: l.amount != null ? Number(l.amount) : null,
        invoiced,
        invoicedSource,
      };
    }).sort((a, b) => b.date.localeCompare(a.date));

    const totals = {
      vins: lines.length,
      paid: lines.reduce((s, l) => s + (l.paid || 0), 0),
      invoiced: lines.reduce((s, l) => s + (l.invoiced || 0), 0),
      unpriced: lines.filter(l => l.paid == null).length,
      margin: 0,
    };
    totals.margin = totals.invoiced - totals.paid;

    return NextResponse.json({
      range: { start, end },
      lines,
      perVendor: rollup(lines, l => l.vendor),
      perLocation: rollup(lines, l => l.location),
      perPart: rollup(lines, l => l.partNumber || 'No Part'),
      totals,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Report failed' }, { status: 500 });
  }
}
