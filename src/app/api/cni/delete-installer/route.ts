import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DeleteInstallerSchema = z.object({
  userId: z.string().uuid(),
});

// References we clear automatically rather than treat as a blocker: the
// account's own personal data — CNI extended profile, internal notes admins
// wrote about / as them, the user's notification rows + preferences — and the
// deactivated_by audit pointer. None of these are real job / financial / photo
// history. Per-user tables whose auth.users FK is ON DELETE CASCADE (dashboard
// layouts, push subscriptions, feature overrides, AI chat, …) aren't listed —
// they vanish on their own when the auth user is deleted. notifications and
// notification_preferences are baseline tables with NO ACTION FKs, so they do
// reach the blocker list and must be cleared explicitly (step 3).
const AUTO_CLEAR = new Set([
  'public.cni_internal_notes',
  'public.cni_profiles',
  'public.notifications',
  'public.notification_preferences',
  'public.profiles', // only the deactivated_by FK reaches here; nulled below
]);

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DeleteInstallerSchema);
  if (parsed.error) return parsed.error;
  const { userId } = parsed.data;

  if (auth.user?.id === userId) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 });
  }

  try {
    // 1. What still references this account? (Only NO ACTION / RESTRICT foreign
    //    keys — i.e. the ones that actually block a delete.)
    const { data: blockers, error: blockErr } = await supabase
      .rpc('user_delete_blockers', { target: userId });
    if (blockErr) {
      return NextResponse.json(
        { error: 'Could not verify references (is migration 120 applied?): ' + blockErr.message },
        { status: 500 }
      );
    }

    // 2. Anything outside the auto-clear set is real history. Refuse and steer to
    //    deactivation instead of half-deleting the account.
    const real = (blockers || []).filter((b: { ref_table: string }) => !AUTO_CLEAR.has(b.ref_table));
    if (real.length > 0) {
      const summary = real
        .map((b: { ref_table: string; n: number }) => `${b.ref_table.replace(/^public\./, '')} (${b.n})`)
        .join(', ');
      return NextResponse.json(
        {
          error: `Can't permanently delete — this account is still referenced by real records: ${summary}. Deactivate it instead to keep that history.`,
          blockers: real,
        },
        { status: 409 }
      );
    }

    // 3. Safe to delete. Clear the auto-clear references first so the profile
    //    row (and then the auth user) can be removed.
    await supabase.from('cni_internal_notes').delete().eq('installer_id', userId);
    await supabase.from('cni_internal_notes').delete().eq('created_by', userId);
    await supabase.from('cni_profiles').delete().eq('user_id', userId);
    await supabase.from('notifications').delete().eq('user_id', userId);
    await supabase.from('notification_preferences').delete().eq('user_id', userId);
    await supabase.from('profiles').update({ deactivated_by: null }).eq('deactivated_by', userId);

    // 4. Delete the profile row.
    const { error: profileError } = await supabase.from('profiles').delete().eq('id', userId);
    if (profileError) {
      return NextResponse.json(
        { error: 'Failed to delete profile: ' + profileError.message },
        { status: 400 }
      );
    }

    // 5. Delete the auth login. This cascades the CASCADE-linked per-user tables.
    const { error: authError } = await supabase.auth.admin.deleteUser(userId);
    if (authError) {
      return NextResponse.json(
        { error: 'Profile deleted, but the auth login could not be removed: ' + authError.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('CNI delete installer error:', err);
    return NextResponse.json({ error: err.message || 'Failed to delete installer' }, { status: 500 });
  }
}
