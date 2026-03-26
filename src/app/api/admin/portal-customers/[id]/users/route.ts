import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const adminSupabase = createSupabaseAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://app.bmgfleet.com');

async function assertAdmin() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('id', session.user.id)
    .maybeSingle();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  if (!roles.includes('admin') && !roles.includes('sales')) return null;
  return session.user.id;
}

// GET: list portal users for a customer
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await adminSupabase
    .from('portal_customer_users')
    .select(`
      id,
      portal_customer_id,
      user_id,
      role,
      created_at,
      profile:profiles (
        id, full_name, email, role, status, deactivated
      )
    `)
    .eq('portal_customer_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST: create a new portal user and link them to this customer
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Get the portal customer to find the slug for the invite link
  const { data: customer } = await adminSupabase
    .from('portal_customers')
    .select('slug, company_name')
    .eq('id', params.id)
    .maybeSingle();

  if (!customer) return NextResponse.json({ error: 'Portal customer not found' }, { status: 404 });

  const { email, password, full_name, portal_role = 'user', send_invite = true } = await req.json();
  if (!email || !password || !full_name) {
    return NextResponse.json({ error: 'email, password, and full_name are required' }, { status: 400 });
  }

  // 1. Create the auth user
  const { data: authData, error: authError } = await adminSupabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
  });

  if (authError) {
    return NextResponse.json({ error: 'Failed to create user: ' + authError.message }, { status: 400 });
  }

  const userId = authData.user?.id;
  if (!userId) return NextResponse.json({ error: 'User created but no ID returned' }, { status: 500 });

  // 2. Create profile with customer role
  await adminSupabase.from('profiles').upsert({
    id: userId,
    email,
    full_name,
    role: 'customer',
    roles: ['customer'],
    status: 'approved',
  }, { onConflict: 'id' });

  // 3. Link to portal customer
  const { error: linkError } = await adminSupabase
    .from('portal_customer_users')
    .insert({ portal_customer_id: params.id, user_id: userId, role: portal_role });

  if (linkError) {
    return NextResponse.json({ error: 'User created but could not link to customer: ' + linkError.message }, { status: 500 });
  }

  // 4. Generate invite link pointing to the portal slug
  const portalUrl = `${appUrl}/portal/${customer.slug}`;
  let inviteLink = portalUrl;
  try {
    const { data: linkData } = await adminSupabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: portalUrl },
    });
    if (linkData?.properties?.action_link) {
      inviteLink = linkData.properties.action_link;
    }
  } catch {}

  // 5. Send invite email
  let emailSent = false;
  if (send_invite) {
    try {
      const { sendEmail } = await import('@/lib/sendgrid');
      emailSent = await sendEmail(
        email,
        `Welcome to the ${customer.company_name} Graphics Portal`,
        buildPortalInviteEmail(full_name, email, password, inviteLink, customer.company_name, portalUrl)
      );
    } catch {}
  }

  return NextResponse.json({ success: true, userId, inviteLink, emailSent });
}

// DELETE: remove a portal user link (does not delete the auth user)
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { pcu_id } = await req.json();
  if (!pcu_id) return NextResponse.json({ error: 'pcu_id required' }, { status: 400 });

  const { error } = await adminSupabase
    .from('portal_customer_users')
    .delete()
    .eq('id', pcu_id)
    .eq('portal_customer_id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

function buildPortalInviteEmail(
  fullName: string,
  email: string,
  password: string,
  inviteLink: string,
  companyName: string,
  portalUrl: string
): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; background: #0a1017; color: #e8ecf1; padding: 32px; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 22px; font-weight: 800; color: #ffffff;">${companyName}</div>
        <div style="font-size: 13px; color: #4a5f78; margin-top: 4px;">Graphics Ordering Portal — by BMG Fleet</div>
      </div>
      <div style="background: #141e2b; border: 1px solid #1e2d3d; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 12px;">Welcome, ${fullName}!</div>
        <p style="color: #c8d6e5; line-height: 1.6; margin: 0 0 16px;">
          Your account for the ${companyName} graphics ordering portal has been created.
        </p>
        <a href="${inviteLink}" style="display: block; text-align: center; padding: 14px; background: #ee3120; color: #ffffff; font-weight: 800; font-size: 14px; border-radius: 10px; text-decoration: none; margin-bottom: 16px;">
          Access Your Portal
        </a>
        <div style="background: #0f1720; border-radius: 8px; padding: 14px; margin-bottom: 10px;">
          <div style="font-size: 11px; color: #4a5f78; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">Portal URL</div>
          <div style="font-size: 14px; color: #60a5fa;">${portalUrl}</div>
        </div>
        <div style="background: #0f1720; border-radius: 8px; padding: 14px; margin-bottom: 10px;">
          <div style="font-size: 11px; color: #4a5f78; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">Email</div>
          <div style="font-size: 15px; font-weight: 700; color: #60a5fa;">${email}</div>
        </div>
        <div style="background: #0f1720; border-radius: 8px; padding: 14px; margin-bottom: 10px;">
          <div style="font-size: 11px; color: #4a5f78; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">Password</div>
          <div style="font-size: 15px; font-weight: 700; color: #60a5fa;">${password}</div>
        </div>
        <p style="color: #6b7a8d; font-size: 12px; margin: 0;">
          We recommend changing your password after your first login.
        </p>
      </div>
      <div style="text-align: center; margin-top: 20px; font-size: 11px; color: #4a5f78;">
        BMG Fleet Graphics &amp; Upfitting
      </div>
    </div>
  `;
}
