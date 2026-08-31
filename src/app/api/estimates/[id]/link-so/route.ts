import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/**
 * Attach an already-existing NetSuite Sales Order to an estimate by hand.
 *
 * The recovery path for a conversion that created a real SO in NetSuite but
 * failed to record it (convert-to-so's `created_unlinked`). That error told
 * the user to "link the SO number by hand" — and until this route there was
 * no way to do it, so the SO stayed orphaned and the estimate stayed
 * convertible, one click away from a duplicate SO.
 *
 * This never creates anything in NetSuite. It looks the SO up by its number,
 * refuses if it doesn't exist, and refuses if the SO or the estimate is
 * already spoken for.
 */

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const LinkSchema = z.object({
  /** The SO number as NetSuite shows it (tranid), e.g. "SO1064". */
  salesOrderNumber: z.string().min(1).max(60),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, LinkSchema);
  if (parsed.error) return parsed.error;

  // NetSuite shows the number with no spaces and upper-cased; accept what a
  // human types off the screen ("so 1064") and normalize.
  const tranid = parsed.data.salesOrderNumber.replace(/\s+/g, '').toUpperCase();

  const supabase = getSupabase();

  const { data: estimate, error: estError } = await supabase
    .from('estimates')
    .select('id, estimate_number, netsuite_so_id, netsuite_so_number')
    .eq('id', params.id)
    .maybeSingle();

  // A read error here is the same schema fault this route exists to repair —
  // say so plainly rather than reporting a missing estimate.
  if (estError) {
    return NextResponse.json({
      error: `Couldn't read the estimate's Sales Order link (${estError.message}). This is a schema problem — confirm migration 246 applied.`,
    }, { status: 503 });
  }
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

  if (estimate.netsuite_so_id) {
    return NextResponse.json({
      error: `This estimate is already linked to SO #${estimate.netsuite_so_number || estimate.netsuite_so_id}.`,
    }, { status: 409 });
  }

  // Confirm the SO is real before writing it down. Linking a typo would leave
  // the estimate looking converted while the SO it names doesn't exist —
  // worse than the unlinked state we're repairing.
  let so: { id: string; tranid: string } | null = null;
  try {
    const escaped = tranid.replace(/'/g, "''");
    const res = await suiteqlQuery(
      `SELECT t.id, t.tranid FROM transaction t WHERE t.type = 'SalesOrd' AND UPPER(t.tranid) = '${escaped}'`,
      2,
    );
    const rows = res?.items || [];
    if (rows.length > 1) {
      return NextResponse.json({
        error: `More than one Sales Order in NetSuite is numbered ${tranid} — link it in NetSuite instead.`,
      }, { status: 409 });
    }
    if (rows.length === 1) so = { id: String(rows[0].id), tranid: String(rows[0].tranid || tranid) };
  } catch (e: any) {
    return NextResponse.json({
      error: `Couldn't reach NetSuite to verify ${tranid}: ${e?.message || e}. Nothing was changed.`,
    }, { status: 502 });
  }

  if (!so) {
    return NextResponse.json({
      error: `No Sales Order numbered ${tranid} exists in NetSuite. Check the number on the SO record.`,
    }, { status: 404 });
  }

  // One SO belongs to one estimate. Without this, a mistyped number could
  // point two estimates at the same order and both would look converted.
  const { data: claimed } = await supabase
    .from('estimates')
    .select('id, estimate_number')
    .eq('netsuite_so_id', so.id)
    .neq('id', params.id)
    .maybeSingle();
  if (claimed) {
    return NextResponse.json({
      error: `SO #${so.tranid} is already linked to estimate ${claimed.estimate_number}.`,
    }, { status: 409 });
  }

  // First-writer-wins, same as convert-to-so's stamp: if a concurrent
  // conversion linked an SO in the meantime, this must not overwrite it.
  const { data: stamped, error: writeError } = await supabase
    .from('estimates')
    .update({
      netsuite_so_id: so.id,
      netsuite_so_number: so.tranid,
      // Matches what a successful conversion records.
      status: 'accepted',
    })
    .eq('id', params.id)
    .is('netsuite_so_id', null)
    .select('id');

  if (writeError) {
    return NextResponse.json({ error: `Couldn't save the link: ${writeError.message}` }, { status: 500 });
  }
  if ((stamped || []).length === 0) {
    const { data: current } = await supabase
      .from('estimates').select('netsuite_so_number').eq('id', params.id).maybeSingle();
    return NextResponse.json({
      error: `Another conversion linked SO #${current?.netsuite_so_number || 'unknown'} to this estimate first.`,
    }, { status: 409 });
  }

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'estimates',
    recordId: params.id,
    action: 'sales_order_linked_manually',
    detail: {
      estimate_number: estimate.estimate_number,
      netsuite_so_id: so.id,
      netsuite_so_number: so.tranid,
      why: 'manual repair of a Sales Order created in NetSuite whose write-back failed',
    },
  });

  return NextResponse.json({
    success: true,
    salesOrderId: so.id,
    salesOrderNumber: so.tranid,
    message: `Linked SO #${so.tranid} to this estimate.`,
  });
}
