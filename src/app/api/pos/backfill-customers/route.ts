import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { matchCustomer } from '@/lib/customer-match';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  dryRun: z.boolean().optional(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * POST /api/pos/backfill-customers
 * Body: { dryRun?: boolean }
 *
 * One-time backfill: resolve every PO's free-text customer ("Masterack") to a
 * real NetSuite customer ("Masterack LLC" + internal id), stamping
 * customer_netsuite_id and canonicalizing the display name. Graphics jobs
 * linked to a matched PO get the same treatment where they're missing an id.
 * Names that don't resolve unambiguously are reported, never guessed.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const dryRun = parsed.data.dryRun ?? false;

  try {
    const supabase = getSupabase();

    const { data: pos, error } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer')
      .is('customer_netsuite_id', null)
      .not('customer', 'is', null)
      .limit(2000);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!pos || pos.length === 0) {
      return NextResponse.json({ message: 'No POs need backfilling', matched: 0, unmatched: [] });
    }

    // Resolve each distinct name once.
    const distinctNames = [...new Set(pos.map(p => (p.customer || '').trim()).filter(Boolean))];
    const nameToMatch = new Map<string, { netsuiteId: string; companyName: string } | null>();
    for (const name of distinctNames) {
      nameToMatch.set(name, await matchCustomer(supabase, name));
    }

    let matchedPOs = 0;
    let updatedJobs = 0;
    const unmatched: Record<string, number> = {};
    const matchedNames: Record<string, string> = {};

    for (const po of pos) {
      const name = (po.customer || '').trim();
      const match = name ? nameToMatch.get(name) : null;
      if (!match) {
        if (name) unmatched[name] = (unmatched[name] || 0) + 1;
        continue;
      }
      matchedPOs++;
      matchedNames[name] = match.companyName;
      if (dryRun) continue;

      await supabase
        .from('purchase_orders')
        .update({ customer_netsuite_id: match.netsuiteId, customer: match.companyName })
        .eq('id', po.id);

      // Flow the resolution down to this PO's graphics jobs that lack an id.
      const { data: jobs } = await supabase
        .from('graphics_jobs')
        .update({ customer_netsuite_id: match.netsuiteId, customer: match.companyName })
        .eq('po_id', po.id)
        .is('customer_netsuite_id', null)
        .select('id');
      updatedJobs += jobs?.length || 0;
    }

    return NextResponse.json({
      dryRun,
      scanned: pos.length,
      matched: matchedPOs,
      updatedGraphicsJobs: updatedJobs,
      resolutions: matchedNames,
      unmatched: Object.entries(unmatched).map(([name, count]) => ({ name, count })),
    });
  } catch (err: any) {
    console.error('PO customer backfill error:', err);
    return NextResponse.json({ error: err.message || 'Backfill failed' }, { status: 500 });
  }
}
