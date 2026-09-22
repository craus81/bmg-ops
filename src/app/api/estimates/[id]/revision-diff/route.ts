import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { diffEstimates } from '@/lib/estimate-diff';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const HEADER_FIELDS =
  'id, estimate_number, status, subtotal, labor_total, labor_hours, labor_hours_override, tax_amount, grand_total, vehicle_count, supersedes_estimate_id, customer_rejection_reason, customer_rejected_at';

/**
 * GET /api/estimates/[id]/revision-diff — what this revision changed against
 * the document it supersedes (R6-9 counter-offer workbench).
 *
 * Read-only and derived: nothing is stored, so the answer is always against
 * the two documents as they stand right now rather than a snapshot that can
 * go stale while the rep is still editing.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  try {
    const { data: revision } = await supabase
      .from('estimates').select(HEADER_FIELDS).eq('id', params.id).maybeSingle();
    if (!revision) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    // Not a revision at all: that is an answer, not an error — the builder
    // simply shows no diff panel.
    if (!revision.supersedes_estimate_id) {
      return NextResponse.json({ diff: null, reason: 'not_a_revision' });
    }

    const { data: original } = await supabase
      .from('estimates').select(HEADER_FIELDS).eq('id', revision.supersedes_estimate_id).maybeSingle();
    if (!original) {
      // The original was deleted (supersedes_estimate_id is ON DELETE SET
      // NULL, so this is the race where it goes mid-read). Say so rather
      // than diffing against nothing and calling every line "added".
      return NextResponse.json({ diff: null, reason: 'original_missing' });
    }

    const [{ data: beforeLines }, { data: afterLines }] = await Promise.all([
      supabase.from('estimate_line_items')
        .select('item_number, description, quantity, unit_price, labor_hours, line_total')
        .eq('estimate_id', original.id).order('sort_order').order('id'),
      supabase.from('estimate_line_items')
        .select('item_number, description, quantity, unit_price, labor_hours, line_total')
        .eq('estimate_id', revision.id).order('sort_order').order('id'),
    ]);

    return NextResponse.json({
      diff: diffEstimates(original, beforeLines || [], revision, afterLines || []),
      original: {
        id: original.id,
        estimateNumber: original.estimate_number,
        status: original.status,
        rejectionReason: original.customer_rejection_reason || null,
        rejectedAt: original.customer_rejected_at || null,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not build the comparison' }, { status: 500 });
  }
}
