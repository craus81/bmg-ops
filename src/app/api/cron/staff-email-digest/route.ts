import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { sendEmail, buildStaffDigestEmail } from '@/lib/resend';
import { groupDigests, digestSubject, DIGEST_ITEM_CAP, type DigestQueueRow } from '@/lib/staff-email-digest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createServiceClient();

/**
 * Daily staff email digest — 21:31 UTC (4:31 PM Chicago in daylight time, 3:31 PM in standard time).
 * Non-urgent alerts queue their email copy in staff_email_digest_queue
 * (shouldDigestEmail in src/lib/notify.ts); this sends each person ONE
 * email listing them, then stamps the rows sent. In-app and push already
 * went out when each event happened.
 *
 * Why: one email per event ran out Resend's 100/day cap on 2026-09-28.
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
    const { data: rows, error: readErr } = await fetchAllRows<DigestQueueRow>((from, to) =>
      service
        .from('staff_email_digest_queue')
        .select('id, user_id, type, title, body, url, created_at')
        .is('sent_at', null)
        .order('created_at')
        .order('id')
        .range(from, to),
    );
    // A partial read would send a partial digest and strand the rest — fail
    // the run instead; everything stays queued for the next one.
    if (readErr) throw new Error(readErr.message);

    const digests = groupDigests(rows);
    const userIds = digests.map(d => d.userId);
    const emailById = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: profiles, error } = await service
        .from('profiles').select('id, email').in('id', userIds);
      if (error) throw new Error(error.message);
      for (const p of profiles || []) if (p.email) emailById.set(String(p.id), p.email);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com';
    let sent = 0;
    let failed = 0;
    let noEmail = 0;
    for (const d of digests) {
      const email = emailById.get(d.userId);
      // Nobody to send to — mark the rows so they don't pile up forever.
      let done = !email;
      if (!email) noEmail++;
      if (email) {
        const shown = d.items.slice(0, DIGEST_ITEM_CAP);
        const html = buildStaffDigestEmail(shown, appUrl, d.items.length - shown.length);
        done = await sendEmail(
          email, digestSubject(d.items.length), html,
          undefined, undefined, undefined, undefined,
          { kind: 'staff_digest', contextUrl: '/home' },
        );
        if (done) sent++; else failed++;
      }
      // A failed send stays queued and rides tomorrow's digest.
      if (done) {
        for (let i = 0; i < d.rowIds.length; i += 200) {
          const { error } = await service
            .from('staff_email_digest_queue')
            .update({ sent_at: new Date().toISOString() })
            .in('id', d.rowIds.slice(i, i + 200));
          if (error) console.error('staff-email-digest mark sent failed:', error.message);
        }
      }
    }

    // Keep the table small: sent rows older than 30 days have no use.
    await service
      .from('staff_email_digest_queue')
      .delete()
      .not('sent_at', 'is', null)
      .lt('sent_at', new Date(Date.now() - 30 * 86_400_000).toISOString());

    const result = { status: 'ok', queued: rows.length, people: digests.length, sent, failed, noEmail };
    const syncStateWrite = await recordHeartbeat(service, 'staff_email_digest', result);
    return NextResponse.json({ ...result, syncStateWrite });
  } catch (e: any) {
    console.error('staff-email-digest failed:', e);
    await recordHeartbeat(service, 'staff_email_digest', { error: e.message || 'staff email digest failed' }).catch(() => {});
    return NextResponse.json({ error: e.message || 'staff email digest failed' }, { status: 500 });
  }
}
