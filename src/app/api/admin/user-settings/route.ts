import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

/**
 * Super-admin view/edit of another user's settings (field ask 2026-08-21:
 * "I wanna be able to change everyone's settings as a super admin... go in
 * and look at their settings"). Covers what lives server-side: notification
 * preferences and the email signature. Device-bound settings (text size,
 * push enrollment) live in each device's browser and can't be managed here.
 *
 * notification_preferences RLS is own-rows-only, so this goes through the
 * service role behind a super_admin gate.
 */

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// GET ?userId= — that user's settings as their own Settings page sees them.
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['super_admin']);
  if (auth.error) return auth.error;

  const userId = req.nextUrl.searchParams.get('userId') || '';
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 });
  }

  const supabase = getSupabase();
  const [{ data: profile, error: pErr }, { data: prefs }] = await Promise.all([
    supabase.from('profiles')
      .select('id, full_name, email, email_signature, email_signature_logo')
      .eq('id', userId).maybeSingle(),
    supabase.from('notification_preferences')
      .select('*').eq('user_id', userId).maybeSingle(),
  ]);
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
  if (!profile) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  return NextResponse.json({ profile, prefs: prefs || null });
}

const PrefsSchema = z.object({
  notify_new_job: z.boolean().optional(),
  notify_status_change: z.boolean().optional(),
  notify_ready: z.boolean().optional(),
  notify_ready_for_install: z.boolean().optional(),
  notify_invoicing: z.boolean().optional(),
  notify_shipped: z.boolean().optional(),
  notify_new_po: z.boolean().optional(),
  notify_in_app: z.boolean().optional(),
  notify_email: z.boolean().optional(),
  notify_sms: z.boolean().optional(),
  sms_messages: z.boolean().optional(),
  email_messages: z.boolean().optional(),
  sms_messages_mode: z.enum(['always', 'unread_only']).optional(),
  phone_number: z.string().max(40).nullable().optional(),
  custom_statuses: z.array(z.string().max(60)).max(30).nullable().optional(),
});

const PutSchema = z.object({
  userId: z.string().uuid(),
  // Signature edits — omit to leave untouched (null clears).
  email_signature: z.string().max(5000).nullable().optional(),
  email_signature_logo: z.boolean().optional(),
  prefs: PrefsSchema.optional(),
});

// PUT — apply edits to that user's settings.
export async function PUT(req: NextRequest) {
  const auth = await requireRole(req, ['super_admin']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PutSchema);
  if (parsed.error) return parsed.error;
  const { userId, email_signature, email_signature_logo, prefs } = parsed.data;

  const supabase = getSupabase();

  const profileUpdate: Record<string, any> = {};
  if (email_signature !== undefined) profileUpdate.email_signature = email_signature?.trim() || null;
  if (email_signature_logo !== undefined) profileUpdate.email_signature_logo = email_signature_logo;
  if (Object.keys(profileUpdate).length > 0) {
    const { error } = await supabase.from('profiles').update(profileUpdate).eq('id', userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (prefs && Object.keys(prefs).length > 0) {
    const { data: existing, error: readErr } = await supabase
      .from('notification_preferences').select('id').eq('user_id', userId).maybeSingle();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    const payload = { ...prefs, updated_at: new Date().toISOString() };
    const { error } = existing
      ? await supabase.from('notification_preferences').update(payload).eq('id', existing.id)
      : await supabase.from('notification_preferences').insert({ user_id: userId, ...payload });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
