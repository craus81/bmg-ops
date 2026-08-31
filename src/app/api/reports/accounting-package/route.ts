import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import { requireRole } from '@/lib/api-auth';
import { r2Get } from '@/lib/r2';
import { logAudit } from '@/lib/audit';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const csvCell = (v: string | number | null | undefined) =>
  `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = (headers: string[], rows: (string | number | null | undefined)[][]) =>
  [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');

const sanitize = (name: string, fallback = 'file'): string => {
  const cleaned = (name || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
};

async function readAll(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const money = (n: any) => (n != null ? Number(n).toFixed(2) : '');

/**
 * GET /api/reports/accounting-package?month=YYYY-MM[&preview=1]
 *
 * One-click monthly handoff to the accountant: a ZIP containing
 *   - vendor-invoices.csv (CNI vendor invoices dated in the month, with
 *     lifecycle stamps + NetSuite bill references)
 *   - invoice-files/ (the original uploaded invoice documents)
 *   - payouts.csv (installer/payroll payouts PAID in the month, with
 *     NetSuite bill references)
 *   - pay-credits.csv (per-VIN pay credits created in the month)
 *   - summary.csv (totals for the month)
 * preview=1 returns the counts/totals as JSON without building the ZIP.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['finance']);
  if (auth.error) return auth.error;

  const month = req.nextUrl.searchParams.get('month') || '';
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
  }
  const preview = req.nextUrl.searchParams.get('preview') === '1';

  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const endNext = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

  try {
    // Paginated (fetchAllRows): PostgREST caps every response at 1000 rows
    // regardless of .limit(2000/10000), so a busy month's totals and CSVs
    // silently dropped rows (Round 3 CRITICAL, R3-1). This is the package
    // the accountant books from — a short read must be an error, never a
    // smaller number.
    const [invoicesRes, payoutsRes, creditsRes] = await Promise.all([
      // Business date wins; fall back to record date for undated invoices.
      fetchAllRows<any>((from, to) =>
        service
          .from('vendor_invoices')
          .select('id, invoice_number, invoice_date, vendor_name, total_amount, status, netsuite_bill_id, file_name, storage_path, created_at, submitted_at, approved_at, billed_at, paid_at, lines:vendor_invoice_lines(amount)')
          .or(`and(invoice_date.gte.${start},invoice_date.lt.${endNext}),and(invoice_date.is.null,created_at.gte.${start},created_at.lt.${endNext})`)
          .order('invoice_date', { ascending: true })
          .order('id')
          .range(from, to)),
      fetchAllRows<any>((from, to) =>
        service
          .from('payouts')
          .select('id, profile_id, kind, cni_job_id, period_start, period_end, total_amount, status, netsuite_bill_id, paid_at, created_at')
          .gte('paid_at', start)
          .lt('paid_at', endNext)
          .order('paid_at', { ascending: true })
          .order('id')
          .range(from, to)),
      fetchAllRows<any>((from, to) =>
        service
          .from('install_credits')
          .select('id, vin, part_number, source, profile_id, rate_per_vehicle, share_weight, crew_size, amount, payout_id, voided_at, created_at')
          .gte('created_at', start)
          .lt('created_at', endNext)
          .is('voided_at', null)
          .order('created_at', { ascending: true })
          .order('id')
          .range(from, to)),
    ]);

    const readErr = invoicesRes.error || payoutsRes.error || creditsRes.error;
    if (readErr) {
      return NextResponse.json({ error: `Could not read the month's records (${readErr.message}) — refusing to build a partial package.` }, { status: 502 });
    }

    const invoices = invoicesRes.data || [];
    const payouts = payoutsRes.data || [];
    const credits = creditsRes.data || [];

    // Resolve worker names once for payouts + credits.
    const profileIds = [...new Set([...payouts.map(p => p.profile_id), ...credits.map(c => c.profile_id)].filter(Boolean))] as string[];
    const names = new Map<string, string>();
    for (let i = 0; i < profileIds.length; i += 200) {
      const { data } = await service.from('profiles').select('id, full_name').in('id', profileIds.slice(i, i + 200));
      for (const p of data || []) names.set(p.id, p.full_name);
    }
    const jobIds = [...new Set(payouts.map(p => p.cni_job_id).filter(Boolean))] as string[];
    const jobLabels = new Map<string, string>();
    for (let i = 0; i < jobIds.length; i += 200) {
      const { data } = await service.from('cni_jobs').select('id, job_number, title').in('id', jobIds.slice(i, i + 200));
      for (const j of data || []) jobLabels.set(j.id, j.title || j.job_number || '');
    }

    const invoiceAmount = (inv: any) => inv.total_amount != null
      ? Number(inv.total_amount)
      : (inv.lines || []).reduce((s: number, l: any) => s + (l.amount != null ? Number(l.amount) : 0), 0);

    const totals = {
      vendorInvoices: invoices.length,
      vendorInvoiceTotal: invoices.reduce((s, i) => s + invoiceAmount(i), 0),
      invoiceFiles: invoices.filter(i => i.storage_path).length,
      payoutsPaid: payouts.length,
      payoutsPaidTotal: payouts.reduce((s, p) => s + (p.total_amount != null ? Number(p.total_amount) : 0), 0),
      payCredits: credits.length,
      payCreditsTotal: credits.reduce((s, c) => s + (c.amount != null ? Number(c.amount) : 0), 0),
      unpricedCredits: credits.filter(c => c.amount == null).length,
    };

    if (preview) return NextResponse.json({ month, totals });

    const zip = new JSZip();

    zip.file('vendor-invoices.csv', csv(
      ['Invoice #', 'Vendor', 'Invoice Date', 'Amount', 'Status', 'NetSuite Bill', 'Submitted', 'Approved', 'Billed', 'Paid', 'File'],
      invoices.map(i => [
        i.invoice_number, i.vendor_name, i.invoice_date || i.created_at?.slice(0, 10), money(invoiceAmount(i)),
        i.status, i.netsuite_bill_id,
        i.submitted_at?.slice(0, 10), i.approved_at?.slice(0, 10), i.billed_at?.slice(0, 10), i.paid_at?.slice(0, 10),
        i.file_name,
      ]),
    ));

    zip.file('payouts.csv', csv(
      ['Paid Date', 'Worker', 'Type', 'Job / Period', 'Amount', 'Status', 'NetSuite Bill'],
      payouts.map(p => [
        p.paid_at?.slice(0, 10),
        p.profile_id ? names.get(p.profile_id) || p.profile_id : '',
        p.kind === 'payroll_period' ? 'Payroll period' : 'CNI job',
        p.kind === 'payroll_period'
          ? `${p.period_start || ''} – ${p.period_end || ''}`
          : (p.cni_job_id && jobLabels.get(p.cni_job_id)) || '',
        money(p.total_amount), p.status, p.netsuite_bill_id,
      ]),
    ));

    zip.file('pay-credits.csv', csv(
      ['Date', 'Worker', 'VIN', 'Part', 'Source', 'Rate/Vehicle', 'Share', 'Crew', 'Amount', 'Payout'],
      credits.map(c => [
        c.created_at?.slice(0, 10),
        c.profile_id ? names.get(c.profile_id) || c.profile_id : '',
        c.vin, c.part_number, c.source, money(c.rate_per_vehicle), Number(c.share_weight), c.crew_size,
        c.amount != null ? money(c.amount) : 'UNPRICED', c.payout_id || 'unassigned',
      ]),
    ));

    zip.file('summary.csv', csv(
      ['Metric', 'Value'],
      [
        ['Month', month],
        ['Vendor invoices', totals.vendorInvoices],
        ['Vendor invoice total', money(totals.vendorInvoiceTotal)],
        ['Invoice files included', totals.invoiceFiles],
        ['Payouts paid', totals.payoutsPaid],
        ['Payouts paid total', money(totals.payoutsPaidTotal)],
        ['Pay credits earned', totals.payCredits],
        ['Pay credits total', money(totals.payCreditsTotal)],
        ['Unpriced credits (follow up!)', totals.unpricedCredits],
        ['Generated', new Date().toISOString()],
      ],
    ));

    // Original invoice documents — the recordkeeping half of the package.
    const fileErrors: string[] = [];
    const usedNames = new Map<string, number>();
    for (const inv of invoices) {
      if (!inv.storage_path) continue;
      try {
        const result = await r2Get('invoices', inv.storage_path);
        if (!result.success || !result.body) {
          fileErrors.push(`${inv.vendor_name} #${inv.invoice_number || inv.id.slice(0, 8)}: ${result.error || 'fetch failed'}`);
          continue;
        }
        const bytes = await readAll(result.body);
        const ext = (inv.file_name || inv.storage_path).match(/\.[A-Za-z0-9]{1,6}$/)?.[0] || '';
        const base = sanitize(`${inv.vendor_name} - ${inv.invoice_number || inv.id.slice(0, 8)}`);
        const seen = usedNames.get(base) || 0;
        usedNames.set(base, seen + 1);
        zip.file(`invoice-files/${base}${seen ? ` (${seen})` : ''}${ext}`, bytes);
      } catch (e: any) {
        fileErrors.push(`${inv.vendor_name} #${inv.invoice_number || ''}: ${e?.message || 'unknown error'}`);
      }
    }
    if (fileErrors.length > 0) {
      zip.file('invoice-files/MISSING-FILES.txt',
        `These invoice documents could not be fetched from storage:\n\n${fileErrors.join('\n')}\n`);
    }

    const buffer = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

    await logAudit(service, {
      actorId: auth.user!.id,
      table: 'accounting_export',
      recordId: month,
      action: 'export',
      detail: { ...totals, fileErrors: fileErrors.length },
    });

    return new Response(buffer as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="bmg-accounting-${month}.zip"`,
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Export failed' }, { status: 500 });
  }
}
