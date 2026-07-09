import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const Schema = z.object({
  token: z.string().trim().min(16).max(400),
  platform: z.enum(['ios', 'android']).optional().default('ios'),
});

/**
 * POST /api/push/register-native
 * Body: { token, platform? }
 *
 * Called by the Capacitor app on launch after login. Stores the APNs device
 * token for the signed-in user so lib/notify's push channel reaches their
 * iPhone/iPad. Upserts on token — a device that changes hands follows the
 * most recent login.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { token, platform } = parsed.data;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { error } = await supabase
      .from('native_push_tokens')
      .upsert(
        { user_id: auth.user.id, token, platform, updated_at: new Date().toISOString() },
        { onConflict: 'token' }
      );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('register-native error:', err);
    return NextResponse.json({ error: err.message || 'Failed to register device' }, { status: 500 });
  }
}
