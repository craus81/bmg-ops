import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, getProfileRoles } from '@/lib/api-auth';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/account/delete
 * Settings → Delete my account: a person closes their own account.
 *
 * Apple requires this in any app that leads people to create an account
 * (guideline 5.1.1(v)); the phone app's sign-in links to Request Access.
 *
 * The account is closed, not erased: jobs, estimates and invoices this person
 * touched carry their id (created_by and friends, many referencing
 * auth.users), and those are BMG's business records. So the profile is
 * deactivated, which requireAuth/isActiveProfile and the Siri keys already
 * refuse everywhere; their personal extras (email signature, phone push
 * devices) are removed; every session is signed out. An admin can still
 * Reactivate on the Users page if it was a mistake.
 *
 * Pending and denied accounts may close too (requireAuth hands back the user
 * with its 403), so a request someone regrets can be withdrawn.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  const user = auth.user;
  if (!user) return auth.error!;
  const profile: any = auth.profile;

  if (profile?.deactivated) return NextResponse.json({ success: true });

  // An owner deleting themselves could leave nobody able to run the books or
  // approve accounts. Owners close their account through support instead.
  if (getProfileRoles(profile).includes('super_admin')) {
    return NextResponse.json(
      { error: 'Owner accounts can’t be deleted here. Email inquiry@bmgfleet.com.' },
      { status: 400 }
    );
  }

  const { error: updErr } = await supabase
    .from('profiles')
    .update({
      deactivated: true,
      deactivated_at: new Date().toISOString(),
      deactivated_by: user.id,
      email_signature: null,
      email_signature_logo: false,
    })
    .eq('id', user.id);
  if (updErr) {
    console.error('Account delete: profile update failed:', updErr.message);
    return NextResponse.json({ error: 'Could not delete your account. Please try again.' }, { status: 500 });
  }

  // Best effort from here: the account is already closed.
  await Promise.allSettled([
    supabase.from('native_push_tokens').delete().eq('user_id', user.id),
    supabase.from('push_subscriptions').delete().eq('user_id', user.id),
  ]);

  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (token) {
    const { error } = await supabase.auth.admin.signOut(token, 'global');
    if (error) console.warn('Account delete: global sign-out failed:', error.message);
  }

  try {
    const { notifyMany, getSuperAdminIds } = await import('@/lib/notify');
    const ids = await getSuperAdminIds(user.id);
    if (ids.length > 0) {
      const name = profile?.full_name || user.email || 'Someone';
      await notifyMany(ids, {
        type: 'account_closed',
        title: 'Account deleted',
        body: `${name}${user.email && name !== user.email ? ` (${user.email})` : ''} deleted their FleetSuite account from Settings.`,
        url: deepLinks.adminUser(user.id),
      });
    }
  } catch (err: any) {
    console.warn('Account delete: admin notice failed:', err?.message);
  }

  return NextResponse.json({ success: true });
}
