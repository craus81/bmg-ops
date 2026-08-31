import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Graphics profitability: invoiced revenue minus logged material cost, per
 * job — the graphics twin of the installer-cost report. Jobs are ranged by
 * creation date; revenue is the invoice amount stamped on the job.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales', 'graphics_production']);
  if (auth.error) return auth.error;

  const startParam = req.nextUrl.searchParams.get('start') || '';
  const endParam = req.nextUrl.searchParams.get('end') || '';
  const end = DATE_RE.test(endParam) ? endParam : new Date().toISOString().slice(0, 10);
  const start = DATE_RE.test(startParam) ? startParam
    : new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const endNext = new Date(new Date(end + 'T00:00:00Z').getTime() + 86_400_000).toISOString().slice(0, 10);

  try {
    // Paginated (R3-1 MAJOR sweep): the .limit(2000) capped at 1000 rows,
    // silently dropping the window's oldest jobs from the cost report.
    const { data: jobs, error: jobsErr } = await fetchAllRows<any>((from, to) =>
      service
        .from('graphics_jobs')
        .select('id, job_number, title, status, job_category, invoice_amount, netsuite_invoice_number, invoiced_at, created_at')
        .gte('created_at', start)
        .lt('created_at', endNext)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to));
    if (jobsErr) return NextResponse.json({ error: jobsErr.message }, { status: 500 });

    const jobIds = (jobs || []).map(j => j.id);
    const materials: { graphics_job_id: string; material_name: string; category: string; quantity_sqft: number | null; cost: number | null }[] = [];
    for (let i = 0; i < jobIds.length; i += 200) {
      // Each chunk paginated too: 200 jobs' materials can pass 1000 rows.
      const { data, error: matErr } = await fetchAllRows<any>((from, to) =>
        service
          .from('graphics_job_materials')
          .select('graphics_job_id, material_name, category, quantity_sqft, cost')
          .in('graphics_job_id', jobIds.slice(i, i + 200))
          .order('id')
          .range(from, to));
      if (matErr) return NextResponse.json({ error: matErr.message }, { status: 500 });
      materials.push(...((data || []) as typeof materials));
    }

    const byJob = new Map<string, { cost: number; sqft: number; entries: number }>();
    const byMaterial = new Map<string, { name: string; category: string; sqft: number; cost: number; entries: number }>();
    for (const m of materials) {
      const j = byJob.get(m.graphics_job_id) || { cost: 0, sqft: 0, entries: 0 };
      j.cost += m.cost != null ? Number(m.cost) : 0;
      j.sqft += m.quantity_sqft != null ? Number(m.quantity_sqft) : 0;
      j.entries += 1;
      byJob.set(m.graphics_job_id, j);

      const key = m.material_name.trim().toUpperCase();
      const mat = byMaterial.get(key) || { name: m.material_name.trim(), category: m.category, sqft: 0, cost: 0, entries: 0 };
      mat.sqft += m.quantity_sqft != null ? Number(m.quantity_sqft) : 0;
      mat.cost += m.cost != null ? Number(m.cost) : 0;
      mat.entries += 1;
      byMaterial.set(key, mat);
    }

    const rows = (jobs || []).map(j => {
      const mat = byJob.get(j.id);
      const revenue = j.invoice_amount != null ? Number(j.invoice_amount) : null;
      const materialCost = mat ? mat.cost : 0;
      return {
        id: j.id,
        jobNumber: j.job_number,
        title: j.title,
        status: j.status,
        category: j.job_category,
        createdAt: j.created_at,
        invoicedAt: j.invoiced_at,
        invoiceNumber: j.netsuite_invoice_number,
        revenue,
        materialCost,
        materialSqft: mat ? mat.sqft : 0,
        materialEntries: mat ? mat.entries : 0,
        margin: revenue != null ? revenue - materialCost : null,
      };
    });

    const withMaterials = rows.filter(r => r.materialEntries > 0);
    const invoiced = rows.filter(r => r.revenue != null);
    const totals = {
      jobs: rows.length,
      jobsWithMaterials: withMaterials.length,
      jobsInvoiced: invoiced.length,
      revenue: invoiced.reduce((s, r) => s + (r.revenue || 0), 0),
      materialCost: rows.reduce((s, r) => s + r.materialCost, 0),
      materialSqft: rows.reduce((s, r) => s + r.materialSqft, 0),
    };

    return NextResponse.json({
      range: { start, end },
      totals: { ...totals, margin: totals.revenue - totals.materialCost },
      perMaterial: [...byMaterial.values()].sort((a, b) => b.cost - a.cost),
      jobs: rows,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Report failed' }, { status: 500 });
  }
}
