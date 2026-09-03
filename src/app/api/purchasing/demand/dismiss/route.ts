import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';

export const dynamic = 'force-dynamic';

/**
 * Dismiss / restore a part on the Purchasing → Open-job demand list
 * (purchasing_demand_dismissals, migration 255).
 *
 *   POST   { itemNumber, needed, reason? }  → hide the part while its needed
 *                                            quantity stays <= `needed`
 *   DELETE { itemNumber }                    → bring it back
 *
 * A dismissal is a buying decision about the PART ("covered from stock",
 * "customer supplies it"), keyed by the demand row's own identity — the
 * normalized item number — so it survives the sales-order sync replacing
 * lines wholesale. New demand past the dismissed quantity un-hides the row
 * on its own (src/lib/parts-demand.ts).
 */

const service = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const DismissSchema = z.object({
  itemNumber: z.string().min(1).max(120),
  needed: z.number().min(0).max(1_000_000),
  reason: z.string().trim().max(500).optional().nullable(),
});

const RestoreSchema = z.object({
  itemNumber: z.string().min(1).max(120),
});

export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DismissSchema);
  if (parsed.error) return parsed.error;
  const key = normalizeItemNumber(parsed.data.itemNumber);
  if (!key) return NextResponse.json({ error: 'Item number is required' }, { status: 400 });

  const { error } = await service()
    .from('purchasing_demand_dismissals')
    .upsert({
      item_number: key,
      needed_at_dismiss: parsed.data.needed,
      reason: parsed.data.reason?.trim() || null,
      dismissed_by: auth.user.id,
      dismissed_at: new Date().toISOString(),
    }, { onConflict: 'item_number' });
  if (error) {
    return NextResponse.json({ error: `Could not dismiss: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, RestoreSchema);
  if (parsed.error) return parsed.error;
  const key = normalizeItemNumber(parsed.data.itemNumber);
  if (!key) return NextResponse.json({ error: 'Item number is required' }, { status: 400 });

  const { error } = await service()
    .from('purchasing_demand_dismissals')
    .delete()
    .eq('item_number', key);
  if (error) {
    return NextResponse.json({ error: `Could not restore: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
