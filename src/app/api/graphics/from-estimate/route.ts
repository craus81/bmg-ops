import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z
  .object({
    estimateId: z.string().uuid(),
    mode: z.enum(['create', 'link']),
    existingJobId: z.string().uuid().optional().nullable(),
    userId: z.string().uuid().optional().nullable(),
  })
  .refine((d) => d.mode !== 'link' || !!d.existingJobId, {
    message: 'existingJobId required for link mode',
    path: ['existingJobId'],
  });

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function generateJobNumber(): string {
  return `GFX-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * POST /api/graphics/from-estimate
 *
 * Spawn a new graphics job from an estimate (mode='create') OR link an
 * existing standalone graphics job to an estimate (mode='link'). The
 * estimate_id link causes the migration-084 trigger to also populate
 * graphics_jobs.upfit_project_id when the estimate is on an upfit project.
 *
 * Body:
 *   { estimateId: string, mode: 'create' | 'link',
 *     existingJobId?: string,    // required for mode='link'
 *     userId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { estimateId, mode, existingJobId, userId } = parsed.data;

  try {
    const supabase = getSupabase();

    const { data: estimate, error: estErr } = await supabase
      .from('estimates')
      .select('id, estimate_number, customer_id, customer_name, customer_netsuite_id, title, notes')
      .eq('id', estimateId)
      .single();
    if (estErr || !estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }

    if (mode === 'link') {
      const { data: existing, error: exErr } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, estimate_id, status')
        .eq('id', existingJobId)
        .single();
      if (exErr || !existing) {
        return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
      }
      if (existing.estimate_id && existing.estimate_id !== estimateId) {
        return NextResponse.json({
          error: `Graphics job ${existing.job_number} is already linked to a different estimate`,
        }, { status: 400 });
      }

      const { error: updErr } = await supabase
        .from('graphics_jobs')
        .update({
          estimate_id: estimateId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingJobId);
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }

      await supabase.from('graphics_status_history').insert({
        job_id: existingJobId,
        from_status: existing.status,
        to_status: existing.status,
        changed_by: userId || auth.user.id,
        note: `Linked to estimate ${estimate.estimate_number}`,
      });

      return NextResponse.json({
        success: true,
        graphicsJobId: existingJobId,
        jobNumber: existing.job_number,
        action: 'linked',
      });
    }

    // mode === 'create' — pull the graphics-catalog line items so the new job
    // arrives with the part numbers and quantity Brian needs to start.
    const { data: lineRows } = await supabase
      .from('estimate_line_items')
      .select('part_id, item_number, description, quantity')
      .eq('estimate_id', estimateId);

    const partIds = (lineRows || [])
      .map(l => l.part_id)
      .filter((id): id is string => !!id);

    let graphicsItemNumbers: string[] = [];
    let graphicsQuantity = 1;

    if (partIds.length > 0) {
      const { data: parts } = await supabase
        .from('netsuite_parts')
        .select('id, catalog')
        .in('id', partIds);
      const graphicsPartIds = new Set(
        (parts || []).filter(p => p.catalog === 'graphics').map(p => p.id)
      );
      const graphicsLines = (lineRows || []).filter(l => l.part_id && graphicsPartIds.has(l.part_id));
      graphicsItemNumbers = graphicsLines.map(l => l.item_number).filter(Boolean);
      const totalQty = graphicsLines.reduce((sum, l) => sum + (l.quantity || 0), 0);
      if (totalQty > 0) graphicsQuantity = Math.max(1, totalQty);
    }

    // Default assignee: first approved graphics_production user (Brian by
    // default in this org). Falls back to null — the team can pick up
    // unassigned jobs from the queue.
    const { data: defaultAssignee } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'graphics_production')
      .eq('status', 'approved')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    const jobNumber = generateJobNumber();
    const titleParts = [estimate.title || `Estimate ${estimate.estimate_number}`];
    const title = titleParts.join(' ');

    const { data: newJob, error: insErr } = await supabase
      .from('graphics_jobs')
      .insert({
        job_number: jobNumber,
        job_category: 'production',
        title,
        part_number: graphicsItemNumbers.length > 0 ? graphicsItemNumbers.join(', ') : null,
        customer: estimate.customer_name || null,
        customer_netsuite_id: estimate.customer_netsuite_id || null,
        quantity: graphicsQuantity,
        notes: estimate.notes || null,
        priority: 'normal',
        status: 'received',
        estimate_id: estimateId,
        assigned_to: defaultAssignee?.id || null,
        created_by: userId || auth.user.id,
      })
      .select('id, job_number')
      .single();

    if (insErr || !newJob) {
      return NextResponse.json({ error: insErr?.message || 'Failed to create graphics job' }, { status: 500 });
    }

    await supabase.from('graphics_status_history').insert({
      job_id: newJob.id,
      from_status: null,
      to_status: 'received',
      changed_by: userId || auth.user.id,
      note: `Spawned from estimate ${estimate.estimate_number}`,
    });

    return NextResponse.json({
      success: true,
      graphicsJobId: newJob.id,
      jobNumber: newJob.job_number,
      action: 'created',
    });
  } catch (err: any) {
    console.error('graphics/from-estimate error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create or link graphics job' }, { status: 500 });
  }
}
