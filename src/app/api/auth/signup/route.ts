import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateBody, z } from '@/lib/validate';

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

/**
 * POST /api/auth/signup
 * Called after supabase.auth.signUp() succeeds on the client.
 * Creates the profile record with status='pending' so admins can approve.
 */
export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, SignupSchema);
  if (parsed.error) return parsed.error;
  const { userId, email, fullName, requestedRole } = parsed.data;

  try {

    // Create the profile with pending status
    const { error } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        email,
        full_name: fullName,
        role: requestedRole || 'installer',
        roles: [requestedRole || 'installer'],
        status: 'pending',
        requested_role: requestedRole || 'installer',
      }, { onConflict: 'id' });

    if (error) {
      console.error('Signup profile creation error:', error);
      return NextResponse.json({ error: 'Failed to create profile: ' + error.message }, { status: 500 });
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
            body: `${fullName} (${email}) is requesting ${requestedRole || 'installer'} access.`,
            url: '/admin/users',
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
