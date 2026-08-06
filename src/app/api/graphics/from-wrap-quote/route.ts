import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fmtInches } from '@/lib/format';

export const dynamic = 'force-dynamic';

const Schema = z
  .object({
    quoteId: z.string().uuid(),
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
 * A quote that turned into (or got linked to) a graphics job is won — mark
 * it accepted so it drops out of the follow-up nudge queue, which only
 * watches status='sent'. The neq guard keeps the original accepted_at when
 * the customer already approved through the token link.
 */
async function markQuoteWon(supabase: ReturnType<typeof getSupabase>, quoteId: string) {
  await supabase
    .from('wrap_quotes')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('id', quoteId)
    .neq('status', 'accepted');
}

/**
 * POST /api/graphics/from-wrap-quote
 *
 * Spawn a new graphics job from a wrap quote (mode='create') OR link an
 * existing standalone graphics job to a wrap quote (mode='link'). The
 * sibling of /api/graphics/from-estimate for the wrap quote estimator:
 * the job arrives pre-filled with the vehicle, films, and coverage areas
 * so nothing has to be retyped onto the graphics board.
 *
 * Body:
 *   { quoteId: string, mode: 'create' | 'link',
 *     existingJobId?: string,    // required for mode='link'
 *     userId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { quoteId, mode, existingJobId, userId } = parsed.data;

  try {
    const supabase = getSupabase();

    const { data: quote, error: qErr } = await supabase
      .from('wrap_quotes')
      .select('id, quote_number, vehicle_description, customer_id, customer, project_type, project_notes, measurements, total_area_sqft')
      .eq('id', quoteId)
      .single();
    if (qErr || !quote) {
      return NextResponse.json({ error: 'Wrap quote not found' }, { status: 404 });
    }

    if (mode === 'link') {
      const { data: existing, error: exErr } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, wrap_quote_id, status')
        .eq('id', existingJobId)
        .single();
      if (exErr || !existing) {
        return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
      }
      if (existing.wrap_quote_id && existing.wrap_quote_id !== quoteId) {
        return NextResponse.json({
          error: `Graphics job ${existing.job_number} is already linked to a different wrap quote`,
        }, { status: 400 });
      }

      const { error: updErr } = await supabase
        .from('graphics_jobs')
        .update({
          wrap_quote_id: quoteId,
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
        note: `Linked to wrap quote ${quote.quote_number}`,
      });

      await markQuoteWon(supabase, quoteId);

      return NextResponse.json({
        success: true,
        graphicsJobId: existingJobId,
        jobNumber: existing.job_number,
        action: 'linked',
      });
    }

    // mode === 'create' — one job per quote: a wrap quote covers one vehicle,
    // so a second create is almost always a double-click. Surface the
    // existing job instead of silently making a twin.
    const { data: dupe } = await supabase
      .from('graphics_jobs')
      .select('id, job_number')
      .eq('wrap_quote_id', quoteId)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dupe) {
      return NextResponse.json({
        error: `Wrap quote ${quote.quote_number} already has graphics job ${dupe.job_number}`,
        graphicsJobId: dupe.id,
        jobNumber: dupe.job_number,
      }, { status: 409 });
    }

    // NetSuite customer id (for downstream invoicing) — only present when
    // the quote's customer was picked from the synced NetSuite list.
    let customerNetsuiteId: string | null = null;
    if (quote.customer_id) {
      const { data: cust } = await supabase
        .from('customers')
        .select('netsuite_id')
        .eq('id', quote.customer_id)
        .maybeSingle();
      customerNetsuiteId = cust?.netsuite_id ? String(cust.netsuite_id) : null;
    }

    // Seed the production specs from the quote's measurement snapshot: the
    // films become vinyl/laminate, each drawn area becomes a content line.
    const measurements: any[] = Array.isArray(quote.measurements) ? quote.measurements : [];
    const filmNames = [...new Set(measurements.map(m => m.substrate?.film_name || m.substrate?.name).filter(Boolean))];
    const laminateNames = [...new Set(measurements.map(m => m.substrate?.laminate_name).filter(Boolean))];
    const areaLines = measurements.map(m => {
      const qty = Math.max(1, Number(m.qty) || 1);
      const dims = `${fmtInches(m.dim1_in)}" × ${fmtInches(m.dim2_in)}"`;
      const film = m.substrate?.name ? ` — ${m.substrate.name}` : '';
      return `${m.name || 'Area'}: ${qty > 1 ? `${qty}× ` : ''}${dims}${film}`;
    });
    const totalSqft = Number(quote.total_area_sqft) || 0;
    const content = [
      ...areaLines,
      totalSqft > 0 ? `Total coverage: ${totalSqft.toFixed(1)} ft²` : null,
    ].filter(Boolean).join('\n') || null;

    const customerName: string | null = quote.customer?.name || null;
    const title = [customerName, quote.vehicle_description || 'Vehicle wrap']
      .filter(Boolean)
      .join(' — ');

    // Default assignee: first approved graphics_production user, same rule
    // as from-estimate. Falls back to null (unassigned queue).
    const { data: defaultAssignee } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'graphics_production')
      .eq('status', 'approved')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    const { data: newJob, error: insErr } = await supabase
      .from('graphics_jobs')
      .insert({
        job_number: generateJobNumber(),
        job_category: 'production',
        title,
        customer: customerName,
        customer_netsuite_id: customerNetsuiteId,
        quantity: 1,
        content,
        notes: [quote.project_type, quote.project_notes].filter(Boolean).join(' — ') || null,
        vinyl_type: filmNames.length > 0 ? filmNames.join(', ') : null,
        laminate: laminateNames.length > 0 ? laminateNames.join(', ') : null,
        priority: 'normal',
        status: 'received',
        wrap_quote_id: quoteId,
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
      note: `Spawned from wrap quote ${quote.quote_number}`,
    });

    await markQuoteWon(supabase, quoteId);

    return NextResponse.json({
      success: true,
      graphicsJobId: newJob.id,
      jobNumber: newJob.job_number,
      action: 'created',
    });
  } catch (err: any) {
    console.error('graphics/from-wrap-quote error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create or link graphics job' }, { status: 500 });
  }
}
