import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const ResendInviteSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email().max(254),
  fullName: z.string().trim().max(120).optional().nullable(),
});

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';

function buildCniReinviteEmailHtml(fullName: string, inviteLink: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; background: #0a1017; color: #f5f8fc; padding: 32px; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 11px; font-weight: 800; color: #ee3120; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 4px;">BMG Fleet</div>
        <div style="font-size: 24px; font-weight: 800; color: #ffffff;">Certified Network Installer</div>
      </div>

      <div style="background: #141e2b; border: 1px solid #1e2d3d; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 12px;">Hi ${fullName}!</div>
        <p style="color: #c8d6e5; line-height: 1.6; margin: 0 0 16px;">
          Here's your login link for the BMG Fleet CNI program. Click below to sign in.
        </p>

        <a href="${inviteLink}" style="display: block; text-align: center; padding: 14px; background: #ee3120; color: #ffffff; font-weight: 800; font-size: 14px; border-radius: 10px; text-decoration: none; margin-bottom: 16px;">
          Sign In to CNI Portal
        </a>

        <p style="color: #8899aa; font-size: 12px; margin: 0; text-align: center;">
          This link expires in 24 hours. If it doesn't work, contact your BMG coordinator.
        </p>
      </div>

      <div style="text-align: center; font-size: 11px; color: #8899aa;">
        BMG Fleet Graphics &amp; Upfitting
      </div>
    </div>
  `;
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ResendInviteSchema);
  if (parsed.error) return parsed.error;
  const { userId, email, fullName } = parsed.data;

  try {

    // Check if profile is complete to decide redirect destination
    const { data: cniProfile } = await supabase
      .from('cni_profiles')
      .select('profile_complete')
      .eq('user_id', userId)
      .single();

    const redirectTo = cniProfile?.profile_complete
      ? `${appUrl}/installer`
      : `${appUrl}/cni/onboarding`;

    // Generate a fresh magic link
    let inviteLink = redirectTo;
    try {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: {
          redirectTo,
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
        cniProfile?.profile_complete
          ? 'BMG Fleet CNI — Your Login Link'
          : 'BMG Fleet CNI — Complete Your Profile',
        buildCniReinviteEmailHtml(fullName || 'there', inviteLink),
        undefined,
        undefined,
        auth.user?.email || undefined,
        undefined,
        { kind: 'invite', sentBy: auth.user?.id }
      );
    } catch (emailErr: any) {
      console.warn('CNI resend invite email failed:', emailErr.message);
    }

    return NextResponse.json({
      success: true,
      inviteLink,
      emailSent,
      message: emailSent ? 'Invite email sent' : 'Link generated (email may not have sent)',
    });
  } catch (err: any) {
    console.error('CNI resend invite error:', err);
    return NextResponse.json({ error: err.message || 'Failed to resend invite' }, { status: 500 });
  }
}
