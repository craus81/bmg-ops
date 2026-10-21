import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const RequestSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).optional(),
  note: z.string().trim().max(500).optional(),
  // Honeypot: hidden on the form, so only bots fill it.
  website: z.string().max(200).optional(),
});

/**
 * POST /api/auth/request-access
 * The login page's Request Access form. It creates NO account: it tells the
 * super admins (in-app, push and email) who is asking, with a button that
 * opens Create User already filled in. An admin then makes the account with
 * the right role, which is what worked (Craig, 2026-10-20).
 *
 * Before, the form called supabase.auth.signUp and /api/auth/signup made a
 * pending profile with role "installer" ("Installer (Pre-Approval)"). Once
 * approved, people kept that installer role, which can't search parts.
 *
 * Public on purpose (src/middleware.ts PUBLIC_PATHS covers /api/auth): the
 * person asking has no account. It writes nothing and answers the same
 * whether or not the email already has an account.
 */
export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, RequestSchema);
  if (parsed.error) return parsed.error;
  const { fullName, email, phone, note, website } = parsed.data;
  if (website) return NextResponse.json({ success: true });

  const clean = email.toLowerCase();
  try {
    const { data: existing } = await supabase
      .from('profiles')
      .select('id, status, deactivated')
      .ilike('email', clean)
      .maybeSingle();

    const extra = [phone && `Phone: ${phone}`, note && `Note: ${note}`].filter(Boolean).join('\n');
    const already = existing
      ? existing.deactivated
        ? ' They already have a deactivated account; reactivate it on Users if they should be back.'
        : ' They already have an account; they may just need a password reset.'
      : '';
    const params = new URLSearchParams({ new: '1', name: fullName, email: clean });

    const { notifyMany, getSuperAdminIds } = await import('@/lib/notify');
    const ids = await getSuperAdminIds();
    if (ids.length > 0) {
      await notifyMany(ids, {
        type: 'access_request',
        title: `Account request: ${fullName}`,
        body: `${fullName} (${clean}) is asking for a FleetSuite account.${already}${extra ? `\n${extra}` : ''}`,
        url: existing ? `/admin/users?user=${existing.id}` : `/admin/users?${params.toString()}`,
      });
    }
  } catch (err: any) {
    console.error('Access request failed:', err?.message);
    return NextResponse.json({ error: 'Could not send your request. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
