import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://app.bmgfleet.com');

function buildInviteEmailHtml(fullName: string, email: string, password: string, inviteLink: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; background: #0a1017; color: #e8ecf1; padding: 32px; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 28px; font-weight: 800; color: #ffffff;">FleetSuite</div>
        <div style="font-size: 13px; color: #4a5f78; margin-top: 4px;">by BMG Fleet</div>
      </div>

      <div style="background: #141e2b; border: 1px solid #1e2d3d; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 12px;">Welcome, ${fullName}!</div>
        <p style="color: #c8d6e5; line-height: 1.6; margin: 0 0 16px;">
          Your FleetSuite account has been created. Click the button below to log in instantly, or use your credentials.
        </p>

        <a href="${inviteLink}" style="display: block; text-align: center; padding: 14px; background: #3b82f6; color: #ffffff; font-weight: 800; font-size: 14px; border-radius: 10px; text-decoration: none; margin-bottom: 16px;">
          Log In to FleetSuite
        </a>

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

export async function POST(req: NextRequest) {
  try {
    const { email, password, fullName, role, companyId, sendInvite } = await req.json();

    if (!email || !password || !fullName || !role) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 1. Create the auth user via Supabase Admin API
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Skip email verification — admin-created users are pre-verified
      user_metadata: {
        full_name: fullName,
      },
    });

    if (authError) {
      return NextResponse.json({ error: 'Failed to create auth user: ' + authError.message }, { status: 400 });
    }

    const userId = authData.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'User created but no ID returned' }, { status: 500 });
    }

    // 2. Create/update the profile (the trigger may have already created one)
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        email,
        full_name: fullName,
        role,
        status: 'approved', // Admin-created users are auto-approved
        company_id: companyId || null,
      }, { onConflict: 'id' });

    if (profileError) {
      console.error('Profile upsert error:', profileError);
    }

    // 3. Generate a magic link for the user
    let inviteLink = appUrl; // fallback to just the app URL
    try {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: {
          redirectTo: `${appUrl}/home`,
        },
      });

      if (linkError) {
        console.warn('Failed to generate magic link:', linkError.message);
      } else if (linkData?.properties?.action_link) {
        inviteLink = linkData.properties.action_link;
      }
    } catch (linkErr: any) {
      console.warn('Magic link generation error:', linkErr.message);
    }

    // 4. Send invite email if requested
    let emailSent = false;
    if (sendInvite) {
      try {
        const { sendEmail } = await import('@/lib/sendgrid');
        emailSent = await sendEmail(
          email,
          'Welcome to FleetSuite — Your Account is Ready',
          buildInviteEmailHtml(fullName, email, password, inviteLink)
        );
      } catch (emailErr: any) {
        console.warn('Invite email failed:', emailErr.message);
      }
    }

    return NextResponse.json({
      success: true,
      userId,
      inviteLink,
      emailSent,
      message: `User ${fullName} created successfully${emailSent ? ' — invite email sent' : ''}`,
    });
  } catch (err: any) {
    console.error('Create user error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create user' }, { status: 500 });
  }
}
