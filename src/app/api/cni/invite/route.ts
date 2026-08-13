import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const InviteSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).optional().nullable(),
  companyName: z.string().trim().max(120).optional().nullable(),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';

function buildCniInviteEmailHtml(fullName: string, email: string, password: string, inviteLink: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; background: #0a1017; color: #f5f8fc; padding: 32px; border-radius: 16px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="font-size: 11px; font-weight: 800; color: #ee3120; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 4px;">BMG Fleet</div>
        <div style="font-size: 24px; font-weight: 800; color: #ffffff;">Certified Network Installer</div>
        <div style="font-size: 13px; color: #8899aa; margin-top: 4px;">You've been invited to join the CNI program</div>
      </div>

      <div style="background: #141e2b; border: 1px solid #1e2d3d; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 12px;">Welcome, ${fullName}!</div>
        <p style="color: #c8d6e5; line-height: 1.6; margin: 0 0 16px;">
          BMG Fleet Graphics &amp; Upfitting has invited you to join our Certified Network Installer program. Click below to set up your profile and start receiving job opportunities.
        </p>

        <a href="${inviteLink}" style="display: block; text-align: center; padding: 14px; background: #ee3120; color: #ffffff; font-weight: 800; font-size: 14px; border-radius: 10px; text-decoration: none; margin-bottom: 16px;">
          Complete Your CNI Profile
        </a>

        <div style="background: #0f1720; border-radius: 8px; padding: 14px; margin-bottom: 10px;">
          <div style="font-size: 11px; color: #8899aa; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">Login Email</div>
          <div style="font-size: 15px; font-weight: 700; color: #60a5fa;">${email}</div>
        </div>

        <div style="background: #0f1720; border-radius: 8px; padding: 14px; margin-bottom: 10px;">
          <div style="font-size: 11px; color: #8899aa; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">Temporary Password</div>
          <div style="font-size: 15px; font-weight: 700; color: #60a5fa;">${password}</div>
        </div>

        <p style="color: #8899aa; font-size: 12px; margin: 0;">
          We recommend changing your password after your first login.
        </p>
      </div>

      <div style="background: #141e2b; border: 1px solid #1e2d3d; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
        <div style="font-size: 13px; font-weight: 700; color: #f5f8fc; margin-bottom: 8px;">What to expect:</div>
        <div style="font-size: 12px; color: #8899aa; line-height: 1.6;">
          1. Complete your installer profile (services, coverage area, equipment)<br/>
          2. Upload your W9 and insurance certificate<br/>
          3. Accept the CNI program terms<br/>
          4. Start receiving job invitations in your area
        </div>
      </div>

      <div style="text-align: center; font-size: 11px; color: #8899aa;">
        BMG Fleet Graphics &amp; Upfitting<br/>
        <span style="color: #556677;">Questions? Reply to this email or contact your BMG coordinator.</span>
      </div>
    </div>
  `;
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 12; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, InviteSchema);
  if (parsed.error) return parsed.error;
  const { email, fullName, phone, companyName } = parsed.data;

  try {

    // Check if user already exists
    const { data: existing } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (existing) {
      return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
    }

    const password = generatePassword();

    // 1. Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (authError) {
      return NextResponse.json({ error: 'Failed to create account: ' + authError.message }, { status: 400 });
    }

    const userId = authData.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'User created but no ID returned' }, { status: 500 });
    }

    // 2a. Every installer belongs to a company (the authoritative membership
    // link is profiles.company_id -> companies). Find-or-create one from the
    // typed company name, falling back to a one-person company named after the
    // installer when none was given.
    const compName = (companyName || fullName).trim();
    let companyId: string | null = null;
    if (compName) {
      const { data: existingCo } = await supabase
        .from('companies').select('id').ilike('name', compName).limit(1).maybeSingle();
      if (existingCo) {
        companyId = existingCo.id;
      } else {
        const { data: newCo } = await supabase
          .from('companies').insert({ name: compName }).select('id').single();
        companyId = newCo?.id || null;
      }
    }

    // 2b. Create profile with installer role + company membership
    await supabase.from('profiles').upsert({
      id: userId,
      email: email.toLowerCase().trim(),
      full_name: fullName,
      role: 'installer',
      roles: ['installer'],
      status: 'approved',
      company_id: companyId,
    }, { onConflict: 'id' });

    // 3. Create a stub CNI profile so they show up in the installers list.
    // Membership lives on profiles.company_id (set above) — migration 192
    // dropped the transitional company_name copy. photo_quality is set
    // explicitly because the column's table default ('good') is invalid under
    // its own CHECK, which would fail the insert.
    await supabase.from('cni_profiles').upsert({
      user_id: userId,
      phone: phone || null,
      availability_status: 'available',
      photo_quality: 'pass',
      service_types: [],
      equipment_capabilities: [],
      risk_tags: [],
      profile_complete: false,
    }, { onConflict: 'user_id' });

    // 4. Generate magic link that redirects to CNI onboarding page
    let inviteLink = `${appUrl}/cni/onboarding`;
    try {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: email.toLowerCase().trim(),
        options: {
          redirectTo: `${appUrl}/cni/onboarding`,
        },
      });

      if (!linkError && linkData?.properties?.action_link) {
        inviteLink = linkData.properties.action_link;
      }
    } catch (linkErr: any) {
      console.warn('Magic link generation error:', linkErr.message);
    }

    // 5. Send branded CNI invite email
    let emailSent = false;
    try {
      const { sendEmail } = await import('@/lib/resend');
      emailSent = await sendEmail(
        email.toLowerCase().trim(),
        'You\'re Invited — BMG Fleet CNI Program',
        buildCniInviteEmailHtml(fullName, email.toLowerCase().trim(), password, inviteLink),
        undefined,
        undefined,
        auth.user?.email || undefined,
        undefined,
        { kind: 'invite', sentBy: auth.user?.id }
      );
    } catch (emailErr: any) {
      console.warn('CNI invite email failed:', emailErr.message);
    }

    return NextResponse.json({
      success: true,
      userId,
      inviteLink,
      emailSent,
      message: `${fullName} invited to CNI program${emailSent ? ' — email sent' : ''}`,
    });
  } catch (err: any) {
    console.error('CNI invite error:', err);
    return NextResponse.json({ error: err.message || 'Failed to send invite' }, { status: 500 });
  }
}
