import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({
      p256dh: z.string().min(1).max(200),
      auth: z.string().min(1).max(200),
    }),
  }),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
});

/**
 * POST /api/push/subscribe
 * Save a browser push subscription for the authenticated user.
 *
 * Body: { subscription: PushSubscriptionJSON }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SubscribeSchema);
  if (parsed.error) return parsed.error;
  const { subscription } = parsed.data;

  try {
    // Upsert: if this endpoint already exists, update it
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({
        user_id: auth.user.id,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      }, { onConflict: 'endpoint' });

    if (error) {
      console.error('Push subscribe error:', error);
      return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('Push subscribe exception:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * DELETE /api/push/subscribe
 * Remove a push subscription (user unsubscribes).
 *
 * Body: { endpoint: string }
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UnsubscribeSchema);
  if (parsed.error) return parsed.error;
  const { endpoint } = parsed.data;

  try {
    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', auth.user.id)
      .eq('endpoint', endpoint);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
