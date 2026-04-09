import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/scans/match-po
 * Retroactively match unmatched scan_logs to open POs by part_number + location.
 * Called after PO import or manually from admin scan review page.
 */
export async function POST(req: NextRequest) {
  // Allow internal calls (from cron/PO import) or authenticated users
  const authHeader = req.headers.get('authorization');
  const isInternal = authHeader === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  if (!isInternal) {
    const auth = await requireAuth(req);
    if (auth.error) return auth.error;
  }

  try {
    // Get all unmatched, unexported scans
    const { data: unmatched } = await supabase
      .from('scan_logs')
      .select('id, part_number, location_name, location_id')
      .is('po_id', null)
      .is('exported_at', null)
      .is('archived_at', null);

    if (!unmatched || unmatched.length === 0) {
      return NextResponse.json({ matched: 0, total: 0 });
    }

    // Get all open POs with line items and ship_to
    const { data: pos } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, ship_to')
      .eq('status', 'open');

    if (!pos || pos.length === 0) {
      return NextResponse.json({ matched: 0, total: unmatched.length });
    }

    const poIds = pos.map(p => p.id);
    const { data: allLines } = await supabase
      .from('po_line_items')
      .select('id, po_id, part_number, quantity, installed')
      .in('po_id', poIds);

    const lines = allLines || [];

    let matched = 0;

    for (const scan of unmatched) {
      if (!scan.part_number) continue;

      // Find POs with matching part number that have remaining capacity
      const candidatePOs = pos.filter(po => {
        const poLines = lines.filter(l => l.po_id === po.id && l.part_number === scan.part_number && l.installed < l.quantity);
        if (poLines.length === 0) return false;

        // If scan has location, try to match PO ship_to
        if (scan.location_name) {
          const shipTo = po.ship_to as any;
          if (shipTo) {
            const locLower = scan.location_name.toLowerCase();
            const shipName = (shipTo.name || '').toLowerCase();
            const shipCity = (shipTo.city || '').toLowerCase();
            // Extract city from location name like "Masterack - Kansas City"
            const locCity = locLower.includes(' - ') ? locLower.split(' - ')[1] : locLower;
            if (shipName.includes(locCity) || shipCity.includes(locCity) || locCity.includes(shipCity)) {
              return true;
            }
          }
          // Location set but no ship_to match — skip this PO
          return !shipTo;
        }

        // No location on scan — match on part alone
        return true;
      });

      if (candidatePOs.length === 0) continue;

      // Pick the first matching PO
      const po = candidatePOs[0];
      const lineItem = lines.find(l => l.po_id === po.id && l.part_number === scan.part_number && l.installed < l.quantity);
      if (!lineItem) continue;

      // Update scan with PO match
      await supabase.from('scan_logs').update({
        po_id: po.id,
        po_number: po.po_number,
        po_line_item_id: lineItem.id,
      }).eq('id', scan.id);

      // Increment installed count
      await supabase.from('po_line_items').update({
        installed: lineItem.installed + 1,
      }).eq('id', lineItem.id);

      // Update local state for next iteration
      lineItem.installed += 1;
      matched++;
    }

    return NextResponse.json({ matched, total: unmatched.length });
  } catch (err: any) {
    console.error('Scan PO match error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
