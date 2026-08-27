import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GetSchema = z.object({ jobId: z.string().uuid() });

const last8 = (vin: string | null | undefined) =>
  (vin || '').replace(/\s/g, '').toUpperCase().slice(-8);

/**
 * AP billing coverage for one company-mode CNI job: which of the job's
 * completed vehicles appear on a vendor invoice (the modern AP flow), and how
 * far along each invoice is. This is what the job's closure checklist reads —
 * company billing no longer runs through the legacy per-job invoice columns.
 *
 * Lines link to the job two ways: directly by scan_log_id (the CNI scan the
 * AP matcher reused) or by VIN last-8 (the matcher can create a NEW scan row
 * when part spellings differ, so scan ids alone under-count). The VIN
 * fallback only applies when the job has an assigned company to scope by —
 * unscoped last-8 matching would claim coverage from unrelated invoices.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;

  const { data: job } = await service
    .from('cni_jobs')
    .select('id, assigned_company_id, payout_mode')
    .eq('id', q.data.jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: vins, error: vinsErr } = await fetchAllRows<{
    id: string; vin: string; status: string; scan_log_id: string | null;
  }>((from, to) => service
    .from('cni_job_vins')
    .select('id, vin, status, scan_log_id')
    .eq('job_id', q.data.jobId)
    .order('id')
    .range(from, to));
  if (vinsErr) {
    return NextResponse.json({ error: 'Failed to load vehicles: ' + vinsErr.message }, { status: 500 });
  }

  const completed = vins.filter(v => v.status === 'completed');
  const scanIds = new Set(vins.map(v => v.scan_log_id).filter(Boolean) as string[]);

  type InvoiceRow = {
    id: string; invoice_number: string | null; vendor_name: string;
    status: string; total_amount: number | null;
  };
  type LineRow = { vendor_invoice_id: string; scan_log_id: string | null; vin: string };

  const invoices = new Map<string, InvoiceRow>();
  const lines: LineRow[] = [];

  if (job.assigned_company_id) {
    // Company known: read the company's whole invoice book, match lines by
    // scan id OR VIN last-8.
    const { data: invRows, error: invErr } = await fetchAllRows<InvoiceRow>((from, to) => service
      .from('vendor_invoices')
      .select('id, invoice_number, vendor_name, status, total_amount')
      .eq('company_id', job.assigned_company_id)
      .order('id')
      .range(from, to));
    if (invErr) {
      return NextResponse.json({ error: 'Failed to load invoices: ' + invErr.message }, { status: 500 });
    }
    for (const inv of invRows) invoices.set(inv.id, inv);

    const invIds = [...invoices.keys()];
    for (let i = 0; i < invIds.length; i += 200) {
      const { data, error } = await fetchAllRows<LineRow>((from, to) => service
        .from('vendor_invoice_lines')
        .select('vendor_invoice_id, scan_log_id, vin')
        .in('vendor_invoice_id', invIds.slice(i, i + 200))
        .order('id')
        .range(from, to));
      if (error) {
        return NextResponse.json({ error: 'Failed to load invoice lines: ' + error.message }, { status: 500 });
      }
      lines.push(...data);
    }
  } else if (scanIds.size > 0) {
    // No company on the job: only exact scan-id linkage is trustworthy.
    const idArr = [...scanIds];
    for (let i = 0; i < idArr.length; i += 200) {
      const { data, error } = await fetchAllRows<LineRow>((from, to) => service
        .from('vendor_invoice_lines')
        .select('vendor_invoice_id, scan_log_id, vin')
        .in('scan_log_id', idArr.slice(i, i + 200))
        .order('id')
        .range(from, to));
      if (error) {
        return NextResponse.json({ error: 'Failed to load invoice lines: ' + error.message }, { status: 500 });
      }
      lines.push(...data);
    }
    const parentIds = [...new Set(lines.map(l => l.vendor_invoice_id))];
    for (let i = 0; i < parentIds.length; i += 200) {
      const { data, error } = await service
        .from('vendor_invoices')
        .select('id, invoice_number, vendor_name, status, total_amount')
        .in('id', parentIds.slice(i, i + 200));
      if (error) {
        return NextResponse.json({ error: 'Failed to load invoices: ' + error.message }, { status: 500 });
      }
      for (const inv of (data || []) as InvoiceRow[]) invoices.set(inv.id, inv);
    }
  }

  // A line covers a job VIN by exact scan id, or (company-scoped path only)
  // by VIN last-8.
  const vinCovers = (v: { vin: string; scan_log_id: string | null }, l: LineRow) =>
    (l.scan_log_id && v.scan_log_id && l.scan_log_id === v.scan_log_id)
    || (!!job.assigned_company_id && last8(l.vin) !== '' && last8(l.vin) === last8(v.vin));

  const APPROVED_PLUS = new Set(['approved', 'billed', 'paid']);
  const vinsCoveredByInvoice = new Map<string, number>();
  let coveredApproved = 0;
  let coveredAny = 0;
  for (const v of completed) {
    const covering = lines.filter(l => vinCovers(v, l));
    const statuses = covering
      .map(l => invoices.get(l.vendor_invoice_id)?.status)
      .filter(Boolean) as string[];
    if (statuses.some(s => APPROVED_PLUS.has(s))) coveredApproved++;
    if (statuses.some(s => s !== 'rejected')) coveredAny++;
    for (const invId of new Set(covering.map(l => l.vendor_invoice_id))) {
      vinsCoveredByInvoice.set(invId, (vinsCoveredByInvoice.get(invId) || 0) + 1);
    }
  }

  return NextResponse.json({
    completedVins: completed.length,
    totalVins: vins.length,
    coveredApproved,
    coveredAny,
    invoices: [...invoices.values()]
      .filter(inv => (vinsCoveredByInvoice.get(inv.id) || 0) > 0)
      .map(inv => ({
        id: inv.id,
        invoice_number: inv.invoice_number,
        vendor_name: inv.vendor_name,
        status: inv.status,
        total_amount: inv.total_amount != null ? Number(inv.total_amount) : null,
        vinsCovered: vinsCoveredByInvoice.get(inv.id) || 0,
      })),
  });
}
