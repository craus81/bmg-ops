import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany, getSuperAdminIds } from '@/lib/notify';
import { newAlertWatcherIds } from '@/lib/new-alert-watchers';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { PRICE_MISMATCH_SYNC, runPriceMismatchCheck } from '@/lib/price-mismatch';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const money = (n: number | null) => (n === null ? 'no price' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

/**
 * Nightly price check (migration 513, owner ask 2026-11-03): compares every
 * part's FleetSuite price with NetSuite's and refreshes Admin → Update Prices
 * → "Prices that don't match". When it finds parts that weren't on the list
 * before, it tells the super admins and anyone with "Copy me on new alerts"
 * (Craig's standing rule, 2026-10-28), once. Nothing is changed in either
 * system; a person picks which price stands.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const startedAt = Date.now();
  try {
    const out = await runPriceMismatchCheck(service);

    let told = 0;
    if (out.added.length > 0) {
      const to = [...new Set([...(await getSuperAdminIds()), ...(await newAlertWatcherIds(service))])];
      const one = out.added.length === 1 ? out.added[0] : null;
      const title = one
        ? `${one.item_number}: price differs in NetSuite`
        : `${out.added.length} part prices differ in NetSuite`;
      const body = one
        ? `FleetSuite has ${money(one.fleetsuite_price)}, NetSuite has ${money(one.netsuite_price)}. Send FleetSuite's price to NetSuite or use NetSuite's.`
        : `${out.added.slice(0, 5).map(m => m.item_number).join(', ')}${out.added.length > 5 ? '…' : ''}. Send FleetSuite's prices to NetSuite or use NetSuite's.`;
      if (to.length > 0) {
        await notifyMany(to, {
          type: 'price_mismatch_found',
          title,
          body,
          url: deepLinks.priceMismatches(one?.part_id),
          channels: ['in_app', 'push', 'email'],
        });
        told = to.length;
      }
    }

    await recordHeartbeat(service, PRICE_MISMATCH_SYNC, { checked: out.checked, mismatches: out.mismatches, new: out.added.length, told }, { startedAt, records: out.checked });
    return NextResponse.json({ ok: true, checked: out.checked, mismatches: out.mismatches, new: out.added.length, told });
  } catch (e: any) {
    await recordHeartbeat(service, PRICE_MISMATCH_SYNC, { error: e?.message || 'unknown' }, { startedAt });
    return NextResponse.json({ error: e?.message || 'Price check failed' }, { status: 500 });
  }
}
