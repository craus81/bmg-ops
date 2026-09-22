import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { resolveCustomerContact } from '@/lib/customer-notify';
import { mayReceive } from '@/lib/notification-prefs';
import { notifyMany } from '@/lib/notify';
import { recordHeartbeat } from '@/lib/system-health';
import { loadDigestBuckets, bucketSize, type DigestBucket } from '@/lib/customer-digest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createServiceClient();

/**
 * Monday-morning digest sweep: which customers have a week worth telling
 * them about, and who is subscribed to hear it.
 *
 * THIS CRON DOES NOT EMAIL CUSTOMERS. It used to send every digest itself.
 * Owner decision 2026-09-14: no customer email leaves FleetSuite without a
 * person sending it. So it counts the digests that are ready and tells the
 * admins once; each one goes out from Customer Notifications (Send update →
 * the standard compose screen, with a preview of that customer's week).
 *
 * The subscription still decides who is even offered: a customer who opted
 * out of the digest is not counted here and not listed there.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    let byCustomer: Map<string, DigestBucket>;
    try {
      byCustomer = await loadDigestBuckets(service);
    } catch (e: any) {
      return NextResponse.json({ error: `${e?.message || 'digest reads failed'} — nobody was notified` }, { status: 502 });
    }

    let ready = 0, skippedNoEmail = 0, skippedOptOut = 0, skippedEmpty = 0;
    const names: string[] = [];
    for (const [customerName, b] of byCustomer) {
      if (bucketSize(b) === 0) { skippedEmpty++; continue; }
      const { customer, email, contactPrefs } = await resolveCustomerContact(service, customerName);
      if (!customer || !email) { skippedNoEmail++; continue; }
      // Opt-IN since migration 171, and since migration 306 the resolved
      // contact's own choice overrides the company one in either direction.
      if (!mayReceive('weekly_digest', customer, contactPrefs)) { skippedOptOut++; continue; }
      ready++;
      if (names.length < 12) names.push(customerName);
    }

    if (ready > 0) {
      const { data: admins } = await service
        .from('profiles').select('id')
        .or('role.in.(admin,super_admin),roles.cs.{admin},roles.cs.{super_admin}')
        .eq('status', 'approved');
      const adminIds = (admins || []).map((a: any) => a.id);
      if (adminIds.length > 0) {
        await notifyMany(adminIds, {
          type: 'customer_digest_ready',
          title: `${ready} weekly customer update${ready === 1 ? '' : 's'} ready to send`,
          body: `${names.join(', ')}${ready > names.length ? `, and ${ready - names.length} more` : ''}`
            + ' have vehicle activity worth a note and are subscribed to the weekly update.'
            + ' Nothing has gone to them — send each from Customer Notifications.',
          url: '/admin/customer-notifications',
          channels: ['in_app', 'email'],
        });
      }
    }

    const syncStateWrite = await recordHeartbeat(
      service, 'weekly_customer_digest', { status: 'ok', customers: byCustomer.size, ready, skippedNoEmail, skippedOptOut, skippedEmpty },
    );

    return NextResponse.json({ status: 'ok', customers: byCustomer.size, ready, skippedNoEmail, skippedOptOut, syncStateWrite });
  } catch (e: any) {
    console.error('weekly-customer-digest failed:', e);
    await recordHeartbeat(service, 'weekly_customer_digest', { error: e.message || 'digest failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'digest failed' }, { status: 500 });
  }
}
