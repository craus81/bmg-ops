import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { getSuperAdminIds, notifyMany } from '@/lib/notify';
import { lookOf, runDailyCheck, type CheckAlert } from '@/lib/books/daily-check';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/books-daily-check — 09:58 and 13:58 UTC.
 *
 * Puts every month of each company's books next to NetSuite's, as
 * Differences vs NetSuite does, each item's count next to NetSuite's, as
 * Stock by item does, each customer's and vendor's balance next to
 * NetSuite's, as Customer and vendor balances does, each of FleetSuite's
 * own invoices next to NetSuite's, as Own invoices does, each of its own
 * fulfillments next to NetSuite's, as Own fulfillments does, each of
 * Books' own bills and receipts next to NetSuite's, as Own bills and Own
 * receipts do, and each Inventory Adjust next to NetSuite's adjustment, as
 * Own adjustments does, and tells the super admins in FleetSuite, in the app
 * and by push, when a month, an item, a balance, an own invoice,
 * fulfillment, bill, receipt or adjustment stops matching, when the
 * night's mistake checks found a likely mistake nobody has cleared, or when
 * FleetSuite isn't sure NetSuite took a send nobody has looked for yet, with a
 * link to it there
 * (src/lib/books/daily-check.ts, docs/books.md "Daily check"). The
 * 09:58 run notes what newly differs and the 13:58 run tells about what of
 * it still does. Minute 58 is free in vercel.json, and both runs come after
 * a posting run (:48 on odd hours, done by :52), a copy of NetSuite's
 * stock moves (:43 on odd hours) and the mistake checks (09:46), and before
 * the next copy of NetSuite's ledger (:26 on odd hours).
 *
 * The books are visible only to super admins, so this response says only
 * how the look went, and manual triggering is super admin only too; a run
 * before noon UTC is a first look and one after it a second.
 */
export async function GET(req: NextRequest) {
  // Vercel Cron with the shared secret; anyone else must be a super admin.
  // Fails closed if CRON_SECRET is not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireSuperAdmin(req);
    if (auth.error) return auth.error;
  }

  // Super admins only, as only they can open the books; never by email, but
  // for an Inventory Adjust or a send to NetSuite FleetSuite isn't sure about,
  // to one with "Copy me on new alerts" ticked (the email
  // books_own_adjustment_differs and books_netsuite_send_unsure fix in the
  // registry).
  const tell = async (alerts: CheckAlert[]) => {
    const ids = await getSuperAdminIds();
    for (const alert of alerts) {
      const sent = { title: alert.title, body: alert.body, url: alert.url };
      if (alert.about === 'stock') await notifyMany(ids, { type: 'books_stock_differs', ...sent, channels: ['in_app', 'push'] });
      else if (alert.about === 'balance') await notifyMany(ids, { type: 'books_balance_differs', ...sent, channels: ['in_app', 'push'] });
      else if (alert.about === 'own') await notifyMany(ids, { type: 'books_own_invoice_differs', ...sent, channels: ['in_app', 'push'] });
      else if (alert.about === 'fulfillment') await notifyMany(ids, { type: 'books_own_fulfillment_differs', ...sent, channels: ['in_app', 'push'] });
      else if (alert.about === 'bill') await notifyMany(ids, { type: 'books_own_bill_differs', ...sent, channels: ['in_app', 'push'] });
      else if (alert.about === 'receipt') await notifyMany(ids, { type: 'books_own_receipt_differs', ...sent, channels: ['in_app', 'push'] });
      else if (alert.about === 'adjustment') await notifyMany(ids, { type: 'books_own_adjustment_differs', ...sent, channels: ['in_app', 'push', 'email'] });
      else if (alert.about === 'mistake') await notifyMany(ids, { type: 'books_mistake_found', ...sent, channels: ['in_app', 'push'] });
      else if (alert.about === 'send') await notifyMany(ids, { type: 'books_netsuite_send_unsure', ...sent, channels: ['in_app', 'push', 'email'] });
      else await notifyMany(ids, { type: 'books_month_differs', ...sent, channels: ['in_app', 'push'] });
    }
  };

  try {
    const result = await runDailyCheck(createServiceClient(), { look: lookOf(new Date()), tell });
    return NextResponse.json({ booksDailyCheck: result.error ? 'failed' : 'ok', look: result.look, told: result.told });
  } catch (e: any) {
    // The check records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] daily check threw:', e?.message || e);
    return NextResponse.json({ booksDailyCheck: 'failed' }, { status: 500 });
  }
}
