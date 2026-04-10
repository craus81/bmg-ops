import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/notifications/test
 * Creates a test notification for the current user to debug in-app notifications.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const userId = auth.user.id;

  // Step 1: Try direct insert with service role
  const insertData = {
    user_id: userId,
    type: 'test',
    title: 'Test Notification',
    body: `This is a test notification created at ${new Date().toLocaleTimeString()}`,
    url: '/home',
  };

  console.log('[notif-test] Inserting:', JSON.stringify(insertData));

  const { data, error } = await supabase
    .from('notifications')
    .insert(insertData)
    .select();

  if (error) {
    console.error('[notif-test] INSERT FAILED:', error.message, error.details, error.hint, error.code);
    return NextResponse.json({
      success: false,
      error: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
  }

  console.log('[notif-test] INSERT SUCCESS:', data);

  // Step 2: Verify we can read it back
  const { data: readBack, error: readErr } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  return NextResponse.json({
    success: true,
    inserted: data,
    readBack: readBack?.[0] || null,
    readError: readErr?.message || null,
  });
}
