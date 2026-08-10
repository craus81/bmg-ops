import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { suiteqlQuery } from '@/lib/netsuite';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Invoice numbers must compare the way they were written: the FS records
 *  store the NS tranid verbatim, so trim+uppercase is the whole game. */
const normNum = (n: string | null | undefined) => (n || '').trim().toUpperCase();

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

interface NsInvoice {
  invoiceNumber: string;
  date: string | null;
  status: 'open' | 'paid' | null;
  customer: string;
  po: string | null;
  /** Net of tax — line sums, same math as /api/reports/invoices-list. */
  total: number;
}

/** FleetSuite records claiming an invoice number, aggregated per number. */
interface FsClaim {
  invoiceNumber: string;
  scanCount: number;
  scanAmount: number;
  scanCustomers: string[];
  scanDates: string[];
  graphicsJobs: { jobNumber: string | null; title: string | null; amount: number | null }[];
  graphicsAmount: number;
}

const isoDate = (d: any): string | null => {
  if (!d) return null;
  const s = String(d);
  if (DATE_RE.test(s)) return s;
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const nsStatus = (raw: any): 'open' | 'paid' | null => {
  const s = String(raw || '');
  return s === 'B' || /paid/i.test(s) ? 'paid' : s === 'A' || /open/i.test(s) ? 'open' : null;
};

/** Every NetSuite customer invoice in the window, net totals ex tax. */
async function fetchNsInvoices(start: string, end: string): Promise<NsInvoice[]> {
  const query = `
    SELECT
      t.tranid            AS invoice_number,
      t.trandate          AS trandate,
      t.status            AS status,
      t.otherrefnum       AS po_number,
      c.companyname       AS customer,
      SUM(-tl.netamount)  AS net_total
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    LEFT JOIN customer c ON c.id = t.entity
    WHERE t.type = 'CustInvc'
      AND t.trandate BETWEEN TO_DATE('${start}', 'YYYY-MM-DD') AND TO_DATE('${end}', 'YYYY-MM-DD')
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
    GROUP BY t.tranid, t.trandate, t.status, t.otherrefnum, c.companyname
    ORDER BY t.trandate, t.tranid
  `;
  const out: NsInvoice[] = [];
  const PAGE = 1000;
  const HARD_CAP = 10_000;
  let offset = 0;
  while (offset < HARD_CAP) {
    const result = await suiteqlQuery(query, PAGE, offset);
    const items: any[] = result?.items || [];
    for (const r of items) {
      out.push({
        invoiceNumber: normNum(r.invoice_number),
        date: isoDate(r.trandate),
        status: nsStatus(r.status),
        po: r.po_number || null,
        customer: r.customer || 'Unknown',
        total: parseFloat(r.net_total || '0') || 0,
      });
    }
    if (items.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

/** Look up FS-claimed numbers that were NOT in the window: do they exist in
 *  NetSuite at all (just outside the window), or nowhere? */
async function lookupNsByNumbers(numbers: string[]): Promise<Map<string, { date: string | null; total: number }>> {
  const found = new Map<string, { date: string | null; total: number }>();
  for (const batch of chunk(numbers, 100)) {
    const inList = batch.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
    try {
      const result = await suiteqlQuery(`
        SELECT t.tranid AS invoice_number, t.trandate AS trandate, SUM(-tl.netamount) AS net_total
        FROM transaction t
        INNER JOIN transactionline tl ON tl.transaction = t.id
        WHERE t.type = 'CustInvc' AND UPPER(t.tranid) IN (${inList})
          AND tl.mainline = 'F' AND tl.taxline = 'F'
        GROUP BY t.tranid, t.trandate
      `);
      for (const r of result?.items || []) {
        found.set(normNum(r.invoice_number), {
          date: isoDate(r.trandate),
          total: parseFloat(r.net_total || '0') || 0,
        });
      }
    } catch (err: any) {
      console.error('[invoice-recon] out-of-window lookup failed:', err.message);
    }
  }
  return found;
}

/**
 * GET /api/reports/invoice-reconciliation?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * K10: NetSuite invoices for the period vs the FleetSuite records claiming
 * them (scan_logs.invoice_number, graphics_jobs.netsuite_invoice_number).
 * Buckets: matched (with amount deltas), NetSuite-only (no FS record — e.g.
 * entered directly in NS), FleetSuite-only (number missing from NS in the
 * window — annotated with whether it exists outside the window at all).
 * Turns the monthly invoicing audit from two eyeballed lists into one page.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const startParam = req.nextUrl.searchParams.get('start') || '';
  const endParam = req.nextUrl.searchParams.get('end') || '';
  const end = DATE_RE.test(endParam) ? endParam : new Date().toISOString().slice(0, 10);
  const start = DATE_RE.test(startParam) ? startParam : `${end.slice(0, 7)}-01`;
  const endNext = new Date(new Date(end + 'T00:00:00Z').getTime() + 86_400_000).toISOString().slice(0, 10);

  try {
    // ── NetSuite side ──
    const nsInvoices = await fetchNsInvoices(start, end);
    const nsByNumber = new Map(nsInvoices.map(i => [i.invoiceNumber, i]));

    // ── FleetSuite side: scans invoiced in the window, plus (below) any
    // scans claiming an in-window NS invoice regardless of their FS date,
    // so a backdated invoice still matches. Both reads paginate.
    const { data: scanRows, error: scanErr } = await fetchAllRows<any>((from, to) =>
      service
        .from('scan_logs')
        .select('invoice_number, invoiced_amount, date_invoiced, billable_customer')
        .not('invoice_number', 'is', null)
        .gte('date_invoiced', start)
        .lte('date_invoiced', end)
        .order('id')
        .range(from, to));
    if (scanErr) return NextResponse.json({ error: scanErr.message }, { status: 500 });

    const nsNumbers = [...nsByNumber.keys()];
    const extraScans: any[] = [];
    for (const batch of chunk(nsNumbers, 200)) {
      const { data } = await service
        .from('scan_logs')
        .select('invoice_number, invoiced_amount, date_invoiced, billable_customer')
        .in('invoice_number', batch)
        .or(`date_invoiced.is.null,date_invoiced.lt.${start},date_invoiced.gt.${end}`);
      extraScans.push(...(data || []));
    }

    const { data: graphicsRows, error: gfxErr } = await fetchAllRows<any>((from, to) =>
      service
        .from('graphics_jobs')
        .select('job_number, title, customer, netsuite_invoice_number, invoice_amount, invoiced_at')
        .not('netsuite_invoice_number', 'is', null)
        .gte('invoiced_at', start)
        .lt('invoiced_at', endNext)
        .order('id')
        .range(from, to));
    if (gfxErr) return NextResponse.json({ error: gfxErr.message }, { status: 500 });

    const extraGraphics: any[] = [];
    for (const batch of chunk(nsNumbers, 200)) {
      const { data } = await service
        .from('graphics_jobs')
        .select('job_number, title, customer, netsuite_invoice_number, invoice_amount, invoiced_at')
        .in('netsuite_invoice_number', batch)
        .or(`invoiced_at.is.null,invoiced_at.lt.${start},invoiced_at.gte.${endNext}`);
      extraGraphics.push(...(data || []));
    }

    // ── Aggregate FS claims per invoice number ──
    const claims = new Map<string, FsClaim>();
    const claimFor = (num: string): FsClaim => {
      let c = claims.get(num);
      if (!c) {
        c = { invoiceNumber: num, scanCount: 0, scanAmount: 0, scanCustomers: [], scanDates: [], graphicsJobs: [], graphicsAmount: 0 };
        claims.set(num, c);
      }
      return c;
    };
    for (const s of [...(scanRows || []), ...extraScans]) {
      const num = normNum(s.invoice_number);
      if (!num) continue;
      const c = claimFor(num);
      c.scanCount++;
      c.scanAmount += parseFloat(s.invoiced_amount || '0') || 0;
      if (s.billable_customer && !c.scanCustomers.includes(s.billable_customer)) c.scanCustomers.push(s.billable_customer);
      const d = isoDate(s.date_invoiced);
      if (d && !c.scanDates.includes(d)) c.scanDates.push(d);
    }
    // Graphics jobs can double-claim the same invoice a scan claims (a job
    // invoiced alongside installs) — keep them as a separate source column
    // rather than summing into one number blindly.
    for (const g of [...(graphicsRows || []), ...extraGraphics]) {
      const num = normNum(g.netsuite_invoice_number);
      if (!num) continue;
      const c = claimFor(num);
      c.graphicsJobs.push({ jobNumber: g.job_number || null, title: g.title || null, amount: g.invoice_amount });
      c.graphicsAmount += parseFloat(g.invoice_amount || '0') || 0;
    }

    // ── Buckets ──
    const matched: any[] = [];
    const nsOnly: any[] = [];
    for (const inv of nsInvoices) {
      const claim = claims.get(inv.invoiceNumber);
      if (!claim) {
        nsOnly.push(inv);
        continue;
      }
      // Scans carry the per-vehicle rate (ex tax) and graphics jobs the
      // stamped invoice amount — when both claim one invoice the scan sum
      // plus graphics sum is the honest FS total to compare.
      const fsTotal = claim.scanAmount + claim.graphicsAmount;
      const delta = Math.round((inv.total - fsTotal) * 100) / 100;
      matched.push({
        ...inv,
        scanCount: claim.scanCount,
        scanAmount: Math.round(claim.scanAmount * 100) / 100,
        graphicsJobs: claim.graphicsJobs.length,
        graphicsAmount: Math.round(claim.graphicsAmount * 100) / 100,
        fsTotal: Math.round(fsTotal * 100) / 100,
        delta,
        // $1 tolerance: rounding on per-vehicle rates is real; a dollar-plus
        // gap means a line FS doesn't know about (or a wrong rate).
        amountMismatch: Math.abs(delta) > 1,
      });
    }

    // FS claims whose number has no NS invoice in the window: annotate
    // whether the invoice exists outside the window or nowhere at all.
    const fsOnlyNums = [...claims.keys()].filter(n => !nsByNumber.has(n));
    const outside = fsOnlyNums.length > 0 ? await lookupNsByNumbers(fsOnlyNums) : new Map();
    const fsOnly = fsOnlyNums.map(num => {
      const c = claims.get(num)!;
      const found = outside.get(num);
      return {
        invoiceNumber: num,
        scanCount: c.scanCount,
        scanAmount: Math.round(c.scanAmount * 100) / 100,
        scanCustomers: c.scanCustomers,
        scanDates: c.scanDates,
        graphicsJobs: c.graphicsJobs,
        graphicsAmount: Math.round(c.graphicsAmount * 100) / 100,
        // 'outside_window' = fine, just dated differently; 'not_found' =
        // the number points at nothing in NetSuite — typo or deleted.
        nsStatus: found ? 'outside_window' : 'not_found',
        nsDate: found?.date || null,
        nsTotal: found ? Math.round(found.total * 100) / 100 : null,
      };
    }).sort((a, b) => (a.nsStatus === 'not_found' ? 0 : 1) - (b.nsStatus === 'not_found' ? 0 : 1));

    const mismatches = matched.filter(m => m.amountMismatch);
    return NextResponse.json({
      success: true,
      start,
      end,
      summary: {
        nsInvoices: nsInvoices.length,
        nsTotal: Math.round(nsInvoices.reduce((s, i) => s + i.total, 0) * 100) / 100,
        matched: matched.length,
        clean: matched.length - mismatches.length,
        amountMismatches: mismatches.length,
        nsOnly: nsOnly.length,
        fsOnly: fsOnly.length,
        fsNotFound: fsOnly.filter(f => f.nsStatus === 'not_found').length,
      },
      matched,
      nsOnly,
      fsOnly,
    });
  } catch (err: any) {
    console.error('invoice-reconciliation error:', err);
    return NextResponse.json({ error: err?.message || 'Reconciliation failed' }, { status: 500 });
  }
}
