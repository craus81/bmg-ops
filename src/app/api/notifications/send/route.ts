import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notify, notifyMany } from '@/lib/notify';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const NotifySchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(500),
  type: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(1000),
  // App-relative deep link to the exact record ('/graphics/<id>', ...) —
  // sendViaEmail prefixes the app origin, so absolute URLs are rejected.
  url: z.string().max(2000).startsWith('/', { message: 'url must be app-relative (start with /)' }).optional(),
  excludeUserId: z.string().uuid().optional(),
});

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
  // Allow internal server-to-server calls (from cron jobs, background tasks)
  const authHeader = req.headers.get('authorization');
  const isInternalCall = authHeader === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  if (!isInternalCall) {
    const auth = await requireStaff(req);
    if (auth.error) return auth.error;
  }

  const parsed = await validateBody(req, NotifySchema);
  if (parsed.error) return parsed.error;
  const { userIds, type, title, body, url, excludeUserId } = parsed.data;

  try {
    const filteredIds = excludeUserId
      ? userIds.filter((id) => id !== excludeUserId)
      : userIds;

    if (filteredIds.length === 0) {
      return NextResponse.json({ sent: 0 });
    }

    // Every notification should deep-link (see src/lib/deep-links.ts) — a
    // url-less one produces dead clicks in "New for you"/the bell, so make
    // the offending caller findable in logs rather than silently shipping.
    if (!url) console.warn(`[notifications/send] no url on type='${type}' — clicks will go nowhere; build one from src/lib/deep-links.ts`);

    await notifyMany(filteredIds, { type, title, body, url });

    return NextResponse.json({ sent: filteredIds.length });
  } catch (err: any) {
    console.error('Notification send error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
