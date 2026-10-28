import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';
import {
  ESTIMATE_LINK_COLUMNS,
  estimateJobPo, estimateVehicleLine, findEstimateWrapQuote, joinBlocks, linkQuoteClientFiles, wrapQuoteJobFields,
} from '@/lib/graphics-links';
import { fleetMembers } from '@/lib/estimate-fleet';
import { deliveryColumns, deliveryFromRow } from '@/lib/delivery';
import { fleetContentLine, fleetJobFor, linkFleetCheckins } from '@/lib/graphics-fleet';
import { graphicsJobQuantity } from '@/lib/graphics-job-quantity';

export const dynamic = 'force-dynamic';

const Schema = z
  .object({
    estimateId: z.string().uuid(),
    // 'prefill' reads the estimate into New Job form values (no writes);
    // 'created' finishes a job the form already saved with estimate_id set.
    mode: z.enum(['create', 'link', 'prefill', 'created']),
    existingJobId: z.string().uuid().optional().nullable(),
    userId: z.string().uuid().optional().nullable(),
    // mode='created': the person chose one job for the estimate's whole
    // fleet order (migration 411), one kit per vehicle.
    fleet: z.boolean().optional(),
  })
  .refine((d) => (d.mode !== 'link' && d.mode !== 'created') || !!d.existingJobId, {
    message: 'existingJobId required for link/created mode',
    path: ['existingJobId'],
  });

function getSupabase() {
  return createServiceClient();
}


/**
 * POST /api/graphics/from-estimate
 *
 * The estimate/SO "+ Graphics job" button opens the standard New Job form
 * (/graphics?new=1&fromEstimate=<id>) rather than creating anything itself,
 * so a job from an estimate goes through exactly the screen a job from
 * scratch does. That form calls mode='prefill' for its starting values and,
 * once the person presses Create, mode='created' to mark the estimate won.
 * mode='create' (one-click spawn) is kept for older callers; mode='link'
 * links an existing standalone graphics job to an estimate. The
 * estimate_id link causes the migration-084 trigger to also populate
 * graphics_jobs.upfit_project_id when the estimate is on an upfit project.
 *
 * Body:
 *   { estimateId: string, mode: 'create' | 'link' | 'prefill' | 'created',
 *     existingJobId?: string,    // required for mode='link' / 'created'
 *     userId?: string }
 */

/**
 * An estimate that turned into (or got linked to) a graphics job is won —
 * mark it accepted (same status convert-to-so uses) so it drops out of the
 * follow-up nudge queue, which only watches status='sent'.
 */
async function markEstimateWon(supabase: any, estimateId: string) {
  // Only estimates the CUSTOMER approved flip to accepted. The revision
  // lock keys on status === 'accepted', so writing it unconditionally
  // froze never-sent drafts the moment a graphics job was created from
  // them — the rep couldn't save a quote the customer had never seen
  // (Round 3 finding). Unapproved estimates keep their status; the real
  // approval flow sets it when the customer acts.
  await supabase
    .from('estimates')
    .update({ status: 'accepted' })
    .eq('id', estimateId)
    .eq('customer_approved', true)
    .neq('status', 'accepted');
}

/**
 * What a graphics job made from this estimate starts with: the graphics-
 * catalog lines' part numbers and total quantity, a title carrying the VIN
 * last-6 (K4/K5: the shop says jobs out loud by VIN), and the default
 * assignee — the first approved graphics_production user (Brian in this
 * org), or null so the team picks it up from the queue.
 */
async function buildEstimateJobPrefill(supabase: any, estimate: any) {
  const { data: lineRows } = await supabase
    .from('estimate_line_items')
    .select('part_id, item_number, description, quantity, wrap_quote_id')
    .eq('estimate_id', estimate.id);

  const partIds = ((lineRows || []) as any[])
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
      ((parts || []) as any[]).filter(p => p.catalog === 'graphics').map(p => p.id)
    );
    const graphicsLines = ((lineRows || []) as any[]).filter(l => l.part_id && graphicsPartIds.has(l.part_id));
    graphicsItemNumbers = [...new Set(graphicsLines.map(l => l.item_number).filter(Boolean) as string[])];
    // Graphics worksheet lines are square feet, not pieces, so they don't
    // count toward the job's quantity.
    const totalQty = graphicsLines
      .filter(l => !l.wrap_quote_id)
      .reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
    graphicsQuantity = graphicsJobQuantity(totalQty);
  }

  const { data: defaultAssignee } = await supabase
    .from('profiles')
    .select('id')
    .eq('role', 'graphics_production')
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const titleParts = [estimate.title || `Estimate ${estimate.estimate_number}`];
  if (estimate.vin) titleParts.push(`· ${String(estimate.vin).slice(-6)}`);

  // The full vehicle (VIN, unit) rides in Content — the title only has
  // room for the last 6. The customer's PO wins the PO # field (it becomes
  // the invoice's PO); the SO # is the fallback.
  const po = estimateJobPo(estimate);

  // The estimate's wrap quote, when it has exactly one no job holds yet:
  // the job links to it and takes its films and coverage areas, same as a
  // job made from the quote.
  const quote = await findEstimateWrapQuote(supabase, estimate.id);
  const quoteFields = quote ? wrapQuoteJobFields(quote) : null;

  return {
    title: titleParts.join(' '),
    partNumbers: graphicsItemNumbers,
    quantity: graphicsQuantity,
    defaultAssigneeId: (defaultAssignee?.id as string | undefined) || null,
    content: joinBlocks(estimateVehicleLine(estimate), po.soNote, quoteFields?.content),
    poNumber: po.poNumber,
    notes: joinBlocks(estimate.notes, quoteFields?.notes),
    vinylType: quoteFields?.vinylType || null,
    laminate: quoteFields?.laminate || null,
    wrapQuoteId: (quote?.id as string | undefined) || null,
    wrapQuoteNumber: (quote?.quote_number as string | undefined) || null,
  };
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { estimateId, mode, existingJobId, userId, fleet } = parsed.data;

  try {
    const supabase = getSupabase();

    const { data: estimate, error: estErr } = await supabase
      .from('estimates')
      .select(ESTIMATE_LINK_COLUMNS)
      .eq('id', estimateId)
      .single();
    if (estErr || !estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }

    // The estimate's fleet order (migration 410), when it is in one with
    // other vehicles: the New Job form offers one job for all of them.
    const { data: groupRow } = await supabase.from('estimates').select('fleet_group_id').eq('id', estimateId).maybeSingle();
    const groupId: string | null = groupRow?.fleet_group_id || null;
    const members = groupId ? await fleetMembers(supabase, groupId) : [];

    if (mode === 'prefill') {
      const prefill = await buildEstimateJobPrefill(supabase, estimate);
      // Delivery method (migration 414): the upfit project's when it has one,
      // else the estimate's — they're kept the same once both exist.
      const [{ data: estDelivery }, { data: projDelivery }] = await Promise.all([
        supabase.from('estimates').select(deliveryColumns('estimates')).eq('id', estimateId).maybeSingle(),
        supabase.from('upfit_projects').select(deliveryColumns('upfit_projects')).eq('estimate_id', estimateId)
          .not('delivery_method', 'is', null).limit(1).maybeSingle(),
      ]);
      const delivery = projDelivery
        ? deliveryFromRow(projDelivery as any, 'upfit_projects')
        : deliveryFromRow(estDelivery as any, 'estimates');
      const fleetJob = members.length > 1 && groupId ? await fleetJobFor(supabase, groupId) : null;
      return NextResponse.json({
        success: true,
        prefill: {
          ...prefill,
          customer: estimate.customer_name || '',
          customerNetsuiteId: estimate.customer_netsuite_id || null,
          notes: prefill.notes || '',
          soNumber: estimate.netsuite_so_number || '',
          estimateNumber: estimate.estimate_number,
          delivery: delivery.method ? delivery : null,
          fleet: members.length > 1
            ? {
                count: members.length,
                units: members.map(m => m.unit_number || m.estimate_number),
                contentLine: fleetContentLine(members.map(m => m.unit_number)),
                existingJob: fleetJob ? { id: fleetJob.id, jobNumber: fleetJob.job_number } : null,
              }
            : null,
        },
      });
    }

    if (mode === 'created') {
      // The New Job form wrote estimate_id on insert; only confirm that the
      // job really is this estimate's before marking the estimate won.
      const { data: job } = await supabase
        .from('graphics_jobs')
        .select('id, estimate_id, wrap_quote_id')
        .eq('id', existingJobId)
        .maybeSingle();
      if (!job || job.estimate_id !== estimateId) {
        return NextResponse.json({ error: 'Graphics job is not linked to this estimate' }, { status: 400 });
      }
      await linkQuoteClientFiles(supabase, job.id, job.wrap_quote_id, userId || auth.user.id);
      if (fleet && groupId && members.length > 1) {
        // One job, one kit per vehicle: the kits are the order's estimates,
        // read live, so a vehicle added later gets its kit automatically.
        const other = await fleetJobFor(supabase, groupId);
        if (other && other.id !== job.id) {
          return NextResponse.json({ error: `This fleet order already has graphics job ${other.job_number || ''}.`.replace(' .', '.') }, { status: 409 });
        }
        await supabase.from('graphics_jobs').update({ fleet_group_id: groupId, quantity: members.length }).eq('id', job.id);
        await linkFleetCheckins(supabase, job.id, members.map(m => m.id));
        await supabase.from('graphics_status_history').insert({
          job_id: job.id,
          from_status: 'received',
          to_status: 'received',
          changed_by: userId || auth.user.id,
          note: `Fleet order: ${members.length} kits, one per vehicle (${members.map(m => `unit ${m.unit_number || '?'} ${m.estimate_number}`).join(', ')})`,
        });
        for (const m of members) await markEstimateWon(supabase, m.id);
        return NextResponse.json({ success: true, graphicsJobId: job.id, action: 'created', kits: members.length });
      }
      await markEstimateWon(supabase, estimateId);
      return NextResponse.json({ success: true, graphicsJobId: job.id, action: 'created' });
    }

    if (mode === 'link') {
      const { data: existing, error: exErr } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, estimate_id, wrap_quote_id, status')
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

      const linkQuote = existing.wrap_quote_id ? null : await findEstimateWrapQuote(supabase, estimateId);
      const { error: updErr } = await supabase
        .from('graphics_jobs')
        .update({
          estimate_id: estimateId,
          // …and the estimate's wrap quote, when the job has none.
          ...(!existing.wrap_quote_id && linkQuote ? { wrap_quote_id: linkQuote.id } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingJobId);
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 });
      }
      await linkQuoteClientFiles(supabase, existing.id, existing.wrap_quote_id || linkQuote?.id, userId || auth.user.id);

      await supabase.from('graphics_status_history').insert({
        job_id: existingJobId,
        from_status: existing.status,
        to_status: existing.status,
        changed_by: userId || auth.user.id,
        note: `Linked to estimate ${estimate.estimate_number}`,
      });

      await markEstimateWon(supabase, estimateId);

      return NextResponse.json({
        success: true,
        graphicsJobId: existingJobId,
        jobNumber: existing.job_number,
        action: 'linked',
      });
    }

    const jobNumber = await nextJobNumber(supabase, 'GFX', () => legacyJobNumber.gfx());
    const prefill = await buildEstimateJobPrefill(supabase, estimate);
    const { title, quantity: graphicsQuantity, defaultAssigneeId } = prefill;
    const graphicsItemNumbers = prefill.partNumbers;

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
        content: prefill.content,
        notes: prefill.notes,
        vinyl_type: prefill.vinylType,
        laminate: prefill.laminate,
        po_number: prefill.poNumber,
        priority: 'normal',
        status: 'received',
        estimate_id: estimateId,
        wrap_quote_id: prefill.wrapQuoteId,
        assigned_to: defaultAssigneeId,
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
    await linkQuoteClientFiles(supabase, newJob.id, prefill.wrapQuoteId, userId || auth.user.id);

    await markEstimateWon(supabase, estimateId);

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
