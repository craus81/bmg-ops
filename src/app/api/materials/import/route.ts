import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Actual-consumption import (R6-1): the seam for reconciling what the roll
 * plan ESTIMATED against what the printer actually burned.
 *
 * Why a generic import rather than a printer integration: Epson Edge
 * Dashboard publishes no API, and the printer lives on the shop LAN while
 * this app runs on Vercel — so nothing here can poll it. What CAN reach us
 * is a file: an Edge Print job-log export, a Cloud Solution PORT report,
 * or a small on-prem agent POSTing SNMP readings. All three land here in
 * the same shape, so adopting any of them later needs no redesign.
 *
 * Rows key on job NUMBER (what a RIP log carries; job UUIDs are ours
 * alone). Imported lines are stamped cost_source='import' so they never
 * masquerade as catalog pricing, and a row whose job can't be resolved is
 * reported back rather than silently dropped.
 */

const RowSchema = z.object({
  jobNumber: z.string().min(1).max(60),
  category: z.enum(['vinyl', 'laminate', 'premask', 'ink', 'other']),
  materialName: z.string().min(1).max(200),
  quantitySqft: z.number().min(0).max(100000).nullable().optional(),
  linearFeet: z.number().min(0).max(100000).nullable().optional(),
  cost: z.number().min(0).max(1000000).nullable().optional(),
  notes: z.string().max(300).optional(),
});

const ImportSchema = z.object({
  rows: z.array(RowSchema).min(1).max(500),
  /** Preview without writing — the import screen's dry run. */
  preview: z.boolean().optional(),
  /** Free-text label for where this batch came from (e.g. 'Edge Print 9/8'). */
  source: z.string().max(120).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'graphics_production']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ImportSchema);
  if (parsed.error) return parsed.error;
  const { rows, preview, source } = parsed.data;

  const wanted = [...new Set(rows.map(r => r.jobNumber.trim().toUpperCase()))];
  const { data: jobs, error } = await fetchAllRows<{ id: string; job_number: string }>((from, to) => service
    .from('graphics_jobs')
    .select('id, job_number')
    .not('job_number', 'is', null)
    .order('id')
    .range(from, to));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byNumber = new Map<string, string>();
  for (const j of jobs || []) {
    if (j.job_number) byNumber.set(j.job_number.trim().toUpperCase(), j.id);
  }

  const matched: { row: typeof rows[number]; jobId: string }[] = [];
  const unmatched: string[] = [];
  for (const r of rows) {
    const jobId = byNumber.get(r.jobNumber.trim().toUpperCase());
    if (jobId) matched.push({ row: r, jobId });
    else unmatched.push(r.jobNumber);
  }

  const summary = {
    received: rows.length,
    matched: matched.length,
    unmatchedJobNumbers: [...new Set(unmatched)],
    jobsTouched: new Set(matched.map(m => m.jobId)).size,
    totalCost: Math.round(matched.reduce((s, m) => s + (m.row.cost || 0), 0) * 100) / 100,
  };
  if (preview) return NextResponse.json({ preview: true, ...summary });
  if (matched.length === 0) {
    return NextResponse.json({ error: 'No row matched a graphics job number.', ...summary }, { status: 400 });
  }

  const stamp = source ? `Imported (${source})` : 'Imported consumption';
  const { error: insErr } = await service.from('graphics_job_materials').insert(
    matched.map(({ row, jobId }) => ({
      graphics_job_id: jobId,
      material_name: row.materialName.trim(),
      category: row.category,
      quantity_sqft: row.quantitySqft ?? null,
      linear_feet: row.linearFeet ?? null,
      cost: row.cost ?? null,
      cost_source: 'import',
      notes: [stamp, row.notes?.trim()].filter(Boolean).join(' — '),
      logged_by: auth.user.id,
    })),
  );
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...summary });
}
