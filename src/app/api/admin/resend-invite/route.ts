import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://bmg-ops.vercel.app');

export async function POST(req: NextRequest) {
  try {
    const { userId, email, fullName } = await req.json();

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    // Generate a fresh magic link
    let inviteLink = appUrl;
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
        return NextResponse.json({ error: 'Failed to generate invite link: ' + linkError.message }, { status: 500 });
      }

      if (linkData?.properties?.action_link) {
        inviteLink = linkData.properties.action_link;
      }
    } catch (linkErr: any) {
      return NextResponse.json({ error: 'Magic link generation error: ' + linkErr.message }, { status: 500 });
    }

    // Send the invite email
    let emailSent = false;
    try {
      const { sendEmail } = await import('@/lib/resend');
      emailSent = await sendEmail(
        email,
        'FleetSuite — Your Login Link',
        `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; background: #0a1017; color: #e8ecf1; padding: 32px; border-radius: 16px;">
            <div style="text-align: center; margin-bottom: 24px;">
              <div style="font-size: 28px; font-weight: 800; color: #ffffff;">FleetSuite</div>
              <div style="font-size: 13px; color: #4a5f78; margin-top: 4px;">by BMG Fleet</div>
            </div>

            <div style="background: #141e2b; border: 1px solid #1e2d3d; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
              <div style="font-size: 18px; font-weight: 700; margin-bottom: 12px;">Hi${fullName ? `, ${fullName}` : ''}!</div>
              <p style="color: #c8d6e5; line-height: 1.6; margin: 0 0 16px;">
                Here's your login link for FleetSuite. Click the button below to sign in instantly.
              </p>

              <a href="${inviteLink}" style="display: block; text-align: center; padding: 14px; background: #3b82f6; color: #ffffff; font-weight: 800; font-size: 14px; border-radius: 10px; text-decoration: none;">
                Log In to FleetSuite
              </a>

              <p style="color: #6b7a8d; font-size: 12px; margin: 16px 0 0; text-align: center;">
                This link expires in 24 hours. If it doesn't work, ask your admin for a new one.
              </p>
            </div>

            <div style="text-align: center; font-size: 11px; color: #4a5f78;">
              BMG Fleet Graphics &amp; Upfitting
            </div>
          </div>
        `
      );
    } catch (emailErr: any) {
      console.warn('Resend invite email failed:', emailErr.message);
    }

    return NextResponse.json({
      success: true,
      inviteLink,
      emailSent,
      message: emailSent ? 'Invite email sent' : 'Link generated (email not configured)',
    });
  } catch (err: any) {
    console.error('Resend invite error:', err);
    return NextResponse.json({ error: err.message || 'Failed to resend invite' }, { status: 500 });
  }
}
