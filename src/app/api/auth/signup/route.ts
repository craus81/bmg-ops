import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/auth/signup
 * Called after supabase.auth.signUp() succeeds on the client.
 * Creates the profile record with status='pending' so admins can approve.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId, email, fullName, requestedRole } = await req.json();

    if (!userId || !email || !fullName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

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

    // Notify admins about the new access request
    try {
      const { data: admins } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('status', 'approved');

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
