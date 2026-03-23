import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notify, notifyMany } from '@/lib/notify';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/notifications/send
 * General-purpose notification endpoint.
 * Client-side pages (like graphics dashboard) call this to send multi-channel notifications.
 *
 * Body: {
 *   userIds: string[],      // Users to notify
 *   type: string,            // Notification type
 *   title: string,
 *   body: string,
 *   url?: string,            // Deep link
 *   excludeUserId?: string,  // Don't notify this user (typically the sender)
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const { userIds, type, title, body, url, excludeUserId } = await req.json();

    if (!userIds || !type || !title || !body) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const filteredIds = excludeUserId
      ? userIds.filter((id: string) => id !== excludeUserId)
      : userIds;

    if (filteredIds.length === 0) {
      return NextResponse.json({ sent: 0 });
    }

    await notifyMany(filteredIds, { type, title, body, url });

    return NextResponse.json({ sent: filteredIds.length });
  } catch (err: any) {
    console.error('Notification send error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
