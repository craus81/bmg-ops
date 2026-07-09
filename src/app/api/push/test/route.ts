import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { apnsConfigured, sendApnsNotification } from '@/lib/apns';
import webpush from 'web-push';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/push/test
 *
 * Sends a real test push to every device registered to the CALLING user —
 * native iOS/iPadOS (APNs) and browser (Web Push) — and reports what happened
 * at each step. Every failure mode in the normal send path is silent (missing
 * env vars, missing table, no registered tokens, APNs rejection), so this is
 * the one place that surfaces which link in the chain is broken.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const payload = {
    title: 'Test notification',
    body: 'If you can read this, push notifications are working.',
    url: '/settings',
  };

  // ── Native app (APNs) ──────────────────────────────────────────────
  const missingEnv = ['APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_PRIVATE_KEY']
    .filter((k) => !process.env[k]);
  const native = {
    configured: apnsConfigured(),
    missingEnv,
    devices: 0,
    sent: 0,
    stale: 0,
    errors: 0,
    tableError: null as string | null,
  };

  const { data: tokens, error: tokErr } = await supabase
    .from('native_push_tokens')
    .select('id, token')
    .eq('user_id', auth.user.id);

  if (tokErr) {
    native.tableError = tokErr.message;
  } else {
    native.devices = tokens?.length || 0;
    if (native.configured && tokens?.length) {
      const staleIds: string[] = [];
      await Promise.allSettled(
        tokens.map(async (t) => {
          const result = await sendApnsNotification(t.token, payload);
          if (result === 'sent') native.sent++;
          else if (result === 'stale') { native.stale++; staleIds.push(t.id); }
          else native.errors++;
        })
      );
      if (staleIds.length) {
        await supabase.from('native_push_tokens').delete().in('id', staleIds);
      }
    }
  }

  // ── Browser (Web Push) ─────────────────────────────────────────────
  const vapidOk = !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const web = {
    configured: vapidOk,
    subscriptions: 0,
    sent: 0,
    failed: 0,
    tableError: null as string | null,
  };

  const { data: subs, error: subErr } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', auth.user.id);

  if (subErr) {
    web.tableError = subErr.message;
  } else {
    web.subscriptions = subs?.length || 0;
    if (vapidOk && subs?.length) {
      webpush.setVapidDetails(
        `mailto:${process.env.VAPID_EMAIL || 'admin@bluemoongraphics.com'}`,
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!
      );
      const webPayload = JSON.stringify({ ...payload, tag: 'push-test' });
      const staleIds: string[] = [];
      await Promise.allSettled(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              webPayload
            );
            web.sent++;
          } catch (err: any) {
            web.failed++;
            if (err?.statusCode === 410 || err?.statusCode === 404) staleIds.push(sub.id);
          }
        })
      );
      if (staleIds.length) {
        await supabase.from('push_subscriptions').delete().in('id', staleIds);
      }
    }
  }

  return NextResponse.json({ success: true, native, web });
}
