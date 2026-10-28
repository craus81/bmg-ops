import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { installSchedulerIds } from '@/lib/install-scheduling';
import { deepLinks } from '@/lib/deep-links';
import { isEstimateApproved } from '@/lib/order-status-server';

export const dynamic = 'force-dynamic';

const Schema = z.object({ done: z.boolean() });

/**
 * POST /api/estimates/[id]/order-status/parts-in — Mark all parts in (or
 * Undo). Set by hand on purpose: Craig doesn't trust inventory or receiving
 * to say it yet (2026-10-28). Marking moves the customer's Order status page
 * to "All parts in" and tells whoever schedules installs to book it.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const supabase = createServiceClient();

  const { data: est } = await supabase
    .from('estimates')
    .select('id, estimate_number, title, customer_name, customer_approved, status, parts_all_in_at')
    .eq('id', params.id)
    .maybeSingle();
  if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (!isEstimateApproved(est)) {
    return NextResponse.json({ error: 'The customer has not approved this estimate yet.' }, { status: 409 });
  }

  if (!parsed.data.done) {
    const { error } = await supabase.from('estimates')
      .update({ parts_all_in_at: null, parts_all_in_by: null })
      .eq('id', est.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, partsAllIn: null });
  }

  if (est.parts_all_in_at) return NextResponse.json({ ok: true, alreadyMarked: true });
  const now = new Date().toISOString();
  const { error } = await supabase.from('estimates')
    .update({ parts_all_in_at: now, parts_all_in_by: auth.user.id })
    .eq('id', est.id)
    .is('parts_all_in_at', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (await installSchedulerIds(supabase)).filter(id => id !== auth.user.id);
  if (ids.length > 0) {
    const who = (auth.profile as any)?.full_name || 'Someone';
    const label = `Estimate #${est.estimate_number}${est.title ? ` (${est.title})` : ''}`;
    await notifyMany(ids, {
      type: 'estimate_parts_in',
      title: `All parts in: ${est.customer_name || 'customer'}, Estimate #${est.estimate_number}`,
      body: `${who} marked every part in for ${label}. Call ${est.customer_name || 'the customer'} and set the drop-off or install date.`,
      url: deepLinks.estimate(est.id),
    });
  }

  return NextResponse.json({ ok: true, partsAllIn: { at: now, by: (auth.profile as any)?.full_name || null } });
}
