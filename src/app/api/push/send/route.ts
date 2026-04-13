import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Configure web-push with VAPID keys
webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'admin@bluemoongraphics.com'}`,
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

/**
 * POST /api/push/send
 * Send a push notification to specific users.
 * Internal use only (authenticated via service role key or user session).
 *
 * Body: {
 *   userIds: string[],
 *   title: string,
 *   body: string,
 *   url?: string,
 *   tag?: string,
 * }
 */
export async function POST(req: NextRequest) {
  // Allow internal server-to-server calls
  const authHeader = req.headers.get('authorization');
  const isInternalCall = authHeader === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  if (!isInternalCall) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { userIds, title, body, url, tag } = await req.json();

    if (!userIds?.length || !title || !body) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get all push subscriptions for these users
    const { data: subscriptions, error } = await supabase
      .from('push_subscriptions')
      .select('id, user_id, endpoint, p256dh, auth')
      .in('user_id', userIds);

    if (error || !subscriptions?.length) {
      return NextResponse.json({ sent: 0, total: 0 });
    }

    const payload = JSON.stringify({ title, body, url: url || '/', tag: tag || 'bmg-notification' });

    let sent = 0;
    const staleIds: string[] = [];

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload
          );
          sent++;
        } catch (err: any) {
          // 410 Gone or 404 = subscription expired, clean it up
          if (err.statusCode === 410 || err.statusCode === 404) {
            staleIds.push(sub.id);
          } else {
            console.error(`Push send failed for ${sub.endpoint}:`, err.statusCode, err.body);
          }
        }
      })
    );

    // Clean up expired subscriptions
    if (staleIds.length > 0) {
      await supabase.from('push_subscriptions').delete().in('id', staleIds);
    }

    return NextResponse.json({ sent, total: subscriptions.length, cleaned: staleIds.length });
  } catch (err: any) {
    console.error('Push send error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
