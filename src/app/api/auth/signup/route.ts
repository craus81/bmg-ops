import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateBody, z } from '@/lib/validate';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SignupSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email().max(254),
  fullName: z.string().trim().min(1).max(120),
  // 'admin' is intentionally excluded — admins must be promoted explicitly,
  // not self-requested at signup.
  requestedRole: z
    .enum(['installer', 'field_tech', 'shop_tech', 'sales', 'graphics_production', 'customer'])
    .optional(),
});

// Roles that must never arrive by self-service, even on a first insert.
const PRIVILEGED_ROLES = ['admin', 'super_admin', 'executive'];

/**
 * POST /api/auth/signup
 * Called after supabase.auth.signUp() succeeds on the client.
 * Creates the profile record with status='pending' so admins can approve.
 *
 * This route is deliberately public (src/middleware.ts PUBLIC_PATHS) — the
 * caller has just signed up and has no session yet — and it holds a
 * service-role client, so RLS is not a backstop here. It therefore proves
 * ownership itself before writing anything:
 *
 *   1. The uuid must belong to a real auth.users row, AND that row's email
 *      must match the submitted one. Without this, POSTing any known uuid
 *      rewrote that person's profile: status back to 'pending' and role down
 *      to 'installer', locking a working account (including an admin) out of
 *      the app until someone re-approved it by hand.
 *   2. The write is then NARROWED, not merely rejected. An outright 409 on any
 *      existing row would strand accounts, because handle_new_user()
 *      (migrations/045-security-hardening.sql:57-71) is defined but never
 *      attached to auth.users — nothing else creates the profile row, so a
 *      legitimate retry after a partial signup must still be able to land it.
 */
export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, SignupSchema);
  if (parsed.error) return parsed.error;
  const { userId, email, fullName, requestedRole } = parsed.data;
  const role = requestedRole || 'installer';

  try {
    // 1. Ownership: the uuid must be a real auth user whose email matches.
    const { data: authUser, error: lookupErr } = await supabase.auth.admin.getUserById(userId);
    if (lookupErr) {
      // Never collapse a transient GoTrue failure into "not found" — that
      // would turn an outage into silent, unexplained signup failures.
      console.error('Signup ownership lookup failed:', lookupErr.message);
      return NextResponse.json({ error: 'Could not verify the new account. Please try again.' }, { status: 503 });
    }
    const authEmail = authUser?.user?.email?.toLowerCase().trim();
    if (!authEmail || authEmail !== email.toLowerCase().trim()) {
      return NextResponse.json({ error: 'Signup verification failed.' }, { status: 403 });
    }

    // 2. Narrow the write against whatever profile row already exists.
    const { data: existing, error: readErr } = await supabase
      .from('profiles')
      .select('id, status, roles, role, deactivated')
      .eq('id', userId)
      .maybeSingle();
    if (readErr) {
      console.error('Signup profile read error:', readErr);
      return NextResponse.json({ error: 'Failed to create profile: ' + readErr.message }, { status: 500 });
    }

    const isEstablished =
      !!existing &&
      (existing.status === 'approved' ||
        existing.deactivated === true ||
        (existing.roles || []).some((r: string) => PRIVILEGED_ROLES.includes(r)) ||
        PRIVILEGED_ROLES.includes(existing.role));

    if (isEstablished) {
      // A live account already owns this id. Touch nothing and notify nobody,
      // but answer exactly as a fresh signup does so this can't be used to
      // probe which accounts exist.
      return NextResponse.json({ success: true });
    }

    if (existing) {
      // A pending/denied row — a re-application. Refresh the request without
      // touching role/roles: those are an approver's decision, and rewriting
      // them here was the privilege-downgrade vector.
      const { error } = await supabase
        .from('profiles')
        .update({ email, full_name: fullName, status: 'pending', requested_role: role })
        .eq('id', userId);
      if (error) {
        console.error('Signup profile update error:', error);
        return NextResponse.json({ error: 'Failed to create profile: ' + error.message }, { status: 500 });
      }
    } else {
      const { error } = await supabase
        .from('profiles')
        .insert({
          id: userId,
          email,
          full_name: fullName,
          role,
          roles: [role],
          status: 'pending',
          requested_role: role,
        });
      if (error) {
        console.error('Signup profile creation error:', error);
        return NextResponse.json({ error: 'Failed to create profile: ' + error.message }, { status: 500 });
      }
    }

    // Notify the people who can actually approve the request: super admins,
    // plus any admin individually granted the user_management feature.
    try {
      const [{ data: adminRows }, { data: umOverrides }] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, roles')
          .eq('role', 'admin')
          .eq('status', 'approved'),
        supabase
          .from('user_feature_overrides')
          .select('user_id')
          .eq('feature', 'user_management')
          .eq('granted', true),
      ]);
      const granted = new Set((umOverrides || []).map((o: any) => o.user_id));
      const admins = (adminRows || []).filter(
        (a: any) => (a.roles || []).includes('super_admin') || granted.has(a.id)
      );

      if (admins && admins.length > 0) {
        const { notifyMany } = await import('@/lib/notify');
        await notifyMany(
          admins.map((a: any) => a.id),
          {
            type: 'access_request',
            title: 'New Access Request',
            body: `${fullName} (${email}) is requesting ${role} access.`,
            url: deepLinks.adminUser(userId),
          }
        );
      }
    } catch (notifyErr: any) {
      console.warn('Failed to notify admins about new signup:', notifyErr.message);
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Signup error:', err);
    return NextResponse.json({ error: err.message || 'Signup failed' }, { status: 500 });
  }
}
