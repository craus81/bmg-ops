import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireSuperAdmin } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { deepLinks } from '@/lib/deep-links';
import { notifyMany } from '@/lib/notify';
import { validateBody, z } from '@/lib/validate';
import { verifiedAuthenticators } from '@/lib/two-step';
import { personName, tellTwoStepChange } from '@/lib/two-step-tell';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** When an authenticator app was set up: Supabase stamps it again when its first code is taken. */
const setUpTime = (f: { created_at?: string; updated_at?: string }) => Date.parse(f.updated_at || f.created_at || '') || 0;

/**
 * Someone's two-step sign-in, from the Users page (src/lib/two-step.ts,
 * docs/books.md "Two-step sign-in"). Super admins only.
 *
 * GET  ?userId= — whether they've set an authenticator app up, and since when.
 * POST { userId } — reset it: every authenticator app they set up goes, which
 *        signs them out everywhere, and they sign in again with their
 *        password, setting one up again when FleetSuite asks or in Settings.
 *        For a lost or replaced phone. Audited; tells the other super admins
 *        and anyone copied on new alerts, and the person.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const userId = req.nextUrl.searchParams.get('userId') ?? '';
  if (!UUID.test(userId)) return NextResponse.json({ error: 'Which user?' }, { status: 400 });

  const { data, error } = await service.auth.admin.mfa.listFactors({ userId });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const apps = verifiedAuthenticators(data?.factors);
  const newest = apps.length ? Math.max(...apps.map(setUpTime)) : 0;
  return NextResponse.json({ hasAuthenticator: apps.length > 0, setUpAt: newest ? new Date(newest).toISOString() : null }, NO_STORE);
}

const Schema = z.object({ userId: z.string().regex(UUID, 'Which user?') });

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { userId } = parsed.data;
  const me = auth.user.id as string;

  const { data: person, error: personError } = await service.from('profiles').select('id, full_name, email').eq('id', userId).maybeSingle();
  if (personError) return NextResponse.json({ error: personError.message }, { status: 500 });
  if (!person) return NextResponse.json({ error: "There's no such user." }, { status: 404 });
  const name = personName(person as { full_name?: string | null; email?: string | null });

  const { data, error } = await service.auth.admin.mfa.listFactors({ userId });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const factors = data?.factors ?? [];
  if (factors.length === 0) return NextResponse.json({ error: `${name} hasn't set up two-step sign-in.` }, { status: 409 });

  let removed = 0;
  let failed: string | null = null;
  for (const f of factors) {
    const { error: deleteError } = await service.auth.admin.mfa.deleteFactor({ id: f.id, userId });
    if (deleteError) { failed = deleteError.message; break; }
    removed++;
  }
  if (removed > 0) {
    await logAudit(service, {
      actorId: me, table: 'auth.mfa_factors', recordId: userId, action: 'two_step_reset',
      detail: { person: name, authenticators: verifiedAuthenticators(factors).length, removed, of: factors.length },
    });
  }
  if (failed) {
    return NextResponse.json({ error: `Couldn't reset ${name}'s two-step sign-in: ${failed}. Try again.` }, { status: 500 });
  }

  const by = personName({ full_name: auth.profile?.full_name, email: auth.user?.email });
  await tellTwoStepChange(service, {
    title: 'Two-step sign-in reset',
    body: userId === me
      ? `${by} reset their own two-step sign-in, so they were signed out everywhere.`
      : `${by} reset ${name}'s two-step sign-in, so ${name} was signed out everywhere and signs in again with their password.`,
    url: deepLinks.adminUser(userId),
  }, [me, userId]);
  if (userId !== me) {
    try {
      await notifyMany([userId], {
        type: 'two_step_changed',
        title: 'Your two-step sign-in was reset',
        body: `${by} reset your two-step sign-in, so you were signed out everywhere. Sign in with your password, and set it up again in Settings → Two-step sign-in, or when FleetSuite asks.`,
        url: deepLinks.twoStepSettings(),
        channels: ['in_app', 'push', 'email'],
      });
    } catch (err) {
      console.error(`[two-step] reset notice not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return NextResponse.json({ reset: true, removed });
}
