import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { suiteqlQuery } from '@/lib/netsuite';
import { safeStringLiteral } from '@/lib/sql-safe';
import { fetchPartRowsCI } from '@/lib/part-number';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const QuerySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  internal: z.enum(['0', '1']).optional(),
});

type InvoicedSource = 'actual' | 'netsuite' | 'po_price' | 'catalog_price';

interface ReportLine {
  invoiceId: string | null;
  invoiceNumber: string | null;
  date: string;
  vendor: string;
  inHouse: boolean;
  location: string;
  vin: string;
  partNumber: string | null;
  poNumber: string | null;
  paid: number | null;
  invoiced: number | null;
  invoicedSource: InvoicedSource | null;
}

interface ScanInfo {
  id: string;
  vin: string;
  po_line_item_id: string | null;
  po_number: string | null;
  part_number: string | null;
  location_name: string | null;
  invoiced_amount: number | null;
  invoice_number: string | null;
}

// How many distinct customer invoices we'll ask NetSuite about per report run.
const NETSUITE_LOOKUP_CAP = 200;

function rollup(lines: ReportLine[], keyOf: (l: ReportLine) => string) {
  // Group case-insensitively (part numbers especially can arrive in mixed
  // case) but display the first-seen spelling.
  const map = new Map<string, { key: string; vins: number; paid: number; invoiced: number; unpriced: number }>();
  for (const l of lines) {
    const display = keyOf(l);
    const key = display.toUpperCase();
    const row = map.get(key) || { key: display, vins: 0, paid: 0, invoiced: 0, unpriced: 0 };
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
 * Per-unit billed amounts for the given invoice numbers, straight from
 * NetSuite invoice lines: (tranid, item) → net amount / quantity. Used for
 * scans invoiced before invoiced_amount stamping existed.
 */
async function fetchNetsuitePerUnit(invoiceNumbers: string[]): Promise<Map<string, number>> {
  const perUnit = new Map<string, number>();
  for (let i = 0; i < invoiceNumbers.length; i += 50) {
    const chunk = invoiceNumbers.slice(i, i + 50);
    const literals = chunk.map(n => `'${safeStringLiteral(n, 60)}'`).join(', ');
    const q = `
      SELECT t.tranid AS tranid, i.itemid AS part_number,
             SUM(-tl.netamount) AS amount, SUM(-tl.quantity) AS qty
      FROM transaction t
      INNER JOIN transactionline tl ON tl.transaction = t.id
      LEFT JOIN item i ON i.id = tl.item
      WHERE t.type = 'CustInvc'
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND t.tranid IN (${literals})
      GROUP BY t.tranid, i.itemid
    `;
    const result = await suiteqlQuery(q, 1000, 0);
    for (const r of result?.items || []) {
      const qty = parseFloat(r.qty || '0') || 0;
      const amount = parseFloat(r.amount || '0') || 0;
      if (qty > 0 && r.tranid && r.part_number) {
        perUnit.set(`${r.tranid}|||${String(r.part_number).toUpperCase()}`, amount / qty);
      }
    }
  }
  return perUnit;
}

/**
 * What we paid installers per VIN vs. what the customer was billed for the
 * same install. Cost = vendor_invoice_lines (CNI vendor invoices) plus,
 * with internal=1, install_credits (in-house pay). Revenue per VIN prefers
 * the stamped billed rate (scan_logs.invoiced_amount), then the NetSuite
 * invoice line, then the PO unit price, then the catalog sales price — and
 * is counted once per scan so multi-line costs never double the revenue.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, QuerySchema);
  if (parsed.error) return parsed.error;
  const { start, end } = parsed.data;
  const includeInternal = parsed.data.internal === '1';

  try {
    // Invoices in range: by invoice_date when present, else by recorded
    // timestamp. The fallback compares whole days in UTC (a timestamptz has
    // no user timezone here) — set invoice_date for exact month cutoffs.
    const endNext = (() => {
      const d = new Date(`${end}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    // Paginated (R3-1 MAJOR sweep): the lines below were already chunked +
    // paginated, but these two top-level reads still truncated at 1000 —
    // dropping whole invoices from the report.
    const [byDate, byCreated] = await Promise.all([
      fetchAllRows<any>((from, to) =>
        service.from('vendor_invoices')
          .select('id, invoice_number, invoice_date, vendor_name, location_name, created_at')
          .gte('invoice_date', start).lte('invoice_date', end)
          .order('invoice_date').order('id')
          .range(from, to)),
      fetchAllRows<any>((from, to) =>
        service.from('vendor_invoices')
          .select('id, invoice_number, invoice_date, vendor_name, location_name, created_at')
          .is('invoice_date', null)
          .gte('created_at', `${start}T00:00:00Z`).lt('created_at', `${endNext}T00:00:00Z`)
          .order('created_at').order('id')
          .range(from, to)),
    ]);
    const invReadErr = byDate.error || byCreated.error;
    if (invReadErr) return NextResponse.json({ error: invReadErr.message }, { status: 500 });
    const invoices = [...(byDate.data || []), ...(byCreated.data || [])];
    const invoiceById = new Map(invoices.map(i => [i.id, i]));

    // Lines, in chunks of invoices, each paginated — PostgREST caps a single
    // response at 1000 rows, and silently truncating a financial report is
    // worse than an extra round trip.
    const invoiceIds = invoices.map(i => i.id);
    const rawLines: any[] = [];
    for (let i = 0; i < invoiceIds.length; i += 100) {
      let pg = 0;
      let more = true;
      while (more) {
        const { data } = await service
          .from('vendor_invoice_lines')
          .select('vendor_invoice_id, scan_log_id, vin, part_number, amount')
          .in('vendor_invoice_id', invoiceIds.slice(i, i + 100))
          .order('id')
          .range(pg * 1000, (pg + 1) * 1000 - 1);
        rawLines.push(...(data || []));
        more = (data || []).length === 1000;
        pg++;
      }
    }

    // In-house pay credits in the same window (created when the vehicle was
    // scanned/completed). Only scan-linked credits can be reported per VIN.
    const credits: { id: string; profile_id: string; scan_log_id: string; vin: string | null; part_number: string | null; amount: number | null; created_at: string }[] = [];
    let internalSkippedUnlinked = 0;
    const profileNames = new Map<string, string>();
    if (includeInternal) {
      let pg = 0;
      let more = true;
      while (more) {
        const { data } = await service
          .from('install_credits')
          .select('id, profile_id, scan_log_id, vin, part_number, amount, created_at')
          .is('voided_at', null)
          .gte('created_at', `${start}T00:00:00Z`).lt('created_at', `${endNext}T00:00:00Z`)
          .order('id')
          .range(pg * 1000, (pg + 1) * 1000 - 1);
        for (const c of data || []) {
          if (c.scan_log_id) credits.push(c as (typeof credits)[0]);
          else internalSkippedUnlinked++;
        }
        more = (data || []).length === 1000;
        pg++;
      }
      const profileIds = [...new Set(credits.map(c => c.profile_id))];
      for (let i = 0; i < profileIds.length; i += 200) {
        const { data } = await service
          .from('profiles').select('id, full_name').in('id', profileIds.slice(i, i + 200));
        for (const p of data || []) profileNames.set(p.id, p.full_name);
      }
    }

    if (rawLines.length === 0 && credits.length === 0) {
      return NextResponse.json({
        range: { start, end }, lines: [], perVendor: [], perLocation: [], perPart: [], perPO: [],
        totals: { vins: 0, paid: 0, invoiced: 0, margin: 0, unpriced: 0 },
        meta: { internalIncluded: includeInternal, internalLines: 0, internalSkippedUnlinked, netsuiteLookups: 0 },
      });
    }

    // Scans behind both cost sources — the revenue side hangs off them.
    const scanIds = [...new Set([
      ...rawLines.map(l => l.scan_log_id).filter(Boolean),
      ...credits.map(c => c.scan_log_id),
    ])] as string[];
    const scanById = new Map<string, ScanInfo>();
    for (let i = 0; i < scanIds.length; i += 200) {
      const { data } = await service
        .from('scan_logs')
        .select('id, vin, po_line_item_id, po_number, part_number, location_name, invoiced_amount, invoice_number')
        .in('id', scanIds.slice(i, i + 200));
      for (const s of data || []) scanById.set(s.id, s as ScanInfo);
    }

    const poLineIds = [...new Set([...scanById.values()].map(s => s.po_line_item_id).filter(Boolean))] as string[];
    const poLinePrice = new Map<string, number>();
    for (let i = 0; i < poLineIds.length; i += 200) {
      const { data } = await service
        .from('po_line_items').select('id, unit_price').in('id', poLineIds.slice(i, i + 200));
      for (const l of data || []) if (l.unit_price != null) poLinePrice.set(l.id, Number(l.unit_price));
    }

    // Catalog prices for just the parts this report touches.
    const neededParts = [...new Set([
      ...rawLines.map(l => l.part_number).filter(Boolean),
      ...credits.map(c => c.part_number).filter(Boolean),
      ...[...scanById.values()].map(s => s.part_number).filter(Boolean),
    ])] as string[];
    // Case-insensitive fetch — the map is already keyed uppercase, but an
    // exact .in() never returned the catalog row for a hand-typed casing.
    const partPrice = new Map<string, number>();
    for (const p of await fetchPartRowsCI(service, neededParts, 'item_number, sales_price')) {
      if (p.sales_price != null && Number(p.sales_price) > 0) partPrice.set(p.item_number.toUpperCase(), Number(p.sales_price));
    }

    // Actual billed dollars for scans invoiced before invoiced_amount
    // stamping existed. NetSuite being down degrades to estimates, never
    // fails the report.
    const lookupTargets = [...new Set(
      [...scanById.values()]
        .filter(s => s.invoice_number && s.invoiced_amount == null)
        .map(s => s.invoice_number as string),
    )];
    const netsuiteCapped = lookupTargets.length > NETSUITE_LOOKUP_CAP;
    let nsPerUnit = new Map<string, number>();
    let netsuiteError: string | undefined;
    if (lookupTargets.length > 0) {
      try {
        nsPerUnit = await fetchNetsuitePerUnit(lookupTargets.slice(0, NETSUITE_LOOKUP_CAP));
      } catch (e: any) {
        netsuiteError = e?.message || 'NetSuite lookup failed';
      }
    }

    const resolveRevenue = (scan: ScanInfo | undefined, partNumber: string | null): { invoiced: number | null; invoicedSource: InvoicedSource | null } => {
      if (scan?.invoiced_amount != null) {
        return { invoiced: Number(scan.invoiced_amount), invoicedSource: 'actual' };
      }
      const pn = partNumber || scan?.part_number || null;
      if (scan?.invoice_number && pn) {
        const hit = nsPerUnit.get(`${scan.invoice_number}|||${pn.toUpperCase()}`);
        if (hit != null) return { invoiced: hit, invoicedSource: 'netsuite' };
      }
      if (scan?.po_line_item_id && poLinePrice.has(scan.po_line_item_id)) {
        return { invoiced: poLinePrice.get(scan.po_line_item_id)!, invoicedSource: 'po_price' };
      }
      if (pn && partPrice.has(pn.toUpperCase())) {
        return { invoiced: partPrice.get(pn.toUpperCase())!, invoicedSource: 'catalog_price' };
      }
      return { invoiced: null, invoicedSource: null };
    };

    // Revenue is claimed once per scan — several cost lines (crew splits, a
    // vendor line plus credits) never multiply the customer-side dollars.
    const revenueClaimed = new Set<string>();
    const claimRevenue = (scan: ScanInfo | undefined, partNumber: string | null) => {
      const r = resolveRevenue(scan, partNumber);
      if (scan) {
        if (revenueClaimed.has(scan.id)) return { invoiced: null, invoicedSource: null };
        if (r.invoiced != null) revenueClaimed.add(scan.id);
      }
      return r;
    };

    const lines: ReportLine[] = rawLines.map(l => {
      const inv = invoiceById.get(l.vendor_invoice_id)!;
      const scan = l.scan_log_id ? scanById.get(l.scan_log_id) : undefined;
      const partNumber = l.part_number || scan?.part_number || null;
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        date: inv.invoice_date || inv.created_at.slice(0, 10),
        vendor: inv.vendor_name,
        inHouse: false,
        location: inv.location_name || scan?.location_name || 'No Location',
        vin: l.vin,
        partNumber,
        poNumber: scan?.po_number || null,
        paid: l.amount != null ? Number(l.amount) : null,
        ...claimRevenue(scan, partNumber),
      };
    });

    for (const c of credits) {
      const scan = scanById.get(c.scan_log_id);
      if (!scan) { internalSkippedUnlinked++; continue; }
      const partNumber = c.part_number || scan.part_number || null;
      lines.push({
        invoiceId: null,
        invoiceNumber: null,
        date: c.created_at.slice(0, 10),
        vendor: `${profileNames.get(c.profile_id) || 'Unknown'} (in-house)`,
        inHouse: true,
        location: scan.location_name || 'No Location',
        vin: c.vin || scan.vin,
        partNumber,
        poNumber: scan.po_number || null,
        paid: c.amount != null ? Number(c.amount) : null,
        ...claimRevenue(scan, partNumber),
      });
    }

    lines.sort((a, b) => b.date.localeCompare(a.date));

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
      perPO: rollup(lines, l => l.poNumber || 'No PO'),
      totals,
      meta: {
        internalIncluded: includeInternal,
        internalLines: lines.filter(l => l.inHouse).length,
        internalSkippedUnlinked,
        netsuiteLookups: Math.min(lookupTargets.length, NETSUITE_LOOKUP_CAP),
        ...(netsuiteCapped ? { netsuiteCapped: true } : {}),
        ...(netsuiteError ? { netsuiteError } : {}),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Report failed' }, { status: 500 });
  }
}
