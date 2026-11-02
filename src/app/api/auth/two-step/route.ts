import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getAccessToken, getProfileRoles, requireAuth } from '@/lib/api-auth';
import { readSwitch } from '@/lib/books/switches';
import { logAudit } from '@/lib/audit';
import { deepLinks } from '@/lib/deep-links';
import { validateBody, z } from '@/lib/validate';
import {
  SET_UP_TOLD_WITHIN_MS, TWO_STEP_REFUSAL, holdsMoneyRole, tokenLevel, twoStepNeed, verifiedAuthenticators,
} from '@/lib/two-step';
import { personName, tellTwoStepChange } from '@/lib/two-step-tell';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/** Nothing here is kept by a browser or anything between. */
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/** When an authenticator app was set up: Supabase stamps it again when its first code is taken. */
const setUpTime = (f: { created_at?: string; updated_at?: string }) => Date.parse(f.updated_at || f.created_at || '') || 0;

/**
 * Two-step sign-in, for the signed-in person (src/lib/two-step.ts, docs/books.md
 * "Two-step sign-in").
 *
 * GET  — what this sign-in still has to do (`need`: 'code', 'setup' or null),
 *        whether they've set an authenticator app up and since when, whether
 *        they hold a money role, and whether the switch is on. Answered even
 *        while the sign-in still owes its code: the code and set-up screens ask
 *        it first.
 * POST — { action: 'set_up' }: the app says the person just set an
 *        authenticator app up and gave its first code. FleetSuite checks
 *        Supabase has it, writes it in the audit log, and tells the super
 *        admins and anyone copied on new alerts, once for each app, so one set
 *        up by someone else who had the password is caught.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, { twoStep: false });
  if (auth.error) return auth.error;

  let switchOn: boolean;
  try {
    switchOn = await readSwitch(service, 'two_step_sign_in');
  } catch {
    return NextResponse.json({ error: TWO_STEP_REFUSAL.unknown }, { status: 503, ...NO_STORE });
  }
  const level = tokenLevel(getAccessToken(req));
  const apps = verifiedAuthenticators(auth.user?.factors);
  const moneyRole = holdsMoneyRole(getProfileRoles(auth.profile));
  const newest = apps.length ? Math.max(...apps.map(setUpTime)) : 0;
  return NextResponse.json({
    need: twoStepNeed({ level, hasAuthenticator: apps.length > 0, moneyRole, switchOn }),
    level,
    hasAuthenticator: apps.length > 0,
    setUpAt: newest ? new Date(newest).toISOString() : null,
    moneyRole,
    switchOn,
  }, NO_STORE);
}

const Schema = z.object({ action: z.literal('set_up') });

export async function POST(req: NextRequest) {
  // A sign-in that has an authenticator app has given its code to get here.
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const me = auth.user.id as string;
  const { data, error } = await service.auth.admin.mfa.listFactors({ userId: me });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const apps = verifiedAuthenticators(data?.factors);
  if (apps.length === 0) {
    return NextResponse.json({ error: "Two-step sign-in isn't set up yet: enter the code from your authenticator app first." }, { status: 400 });
  }
  const newest = apps.reduce((a, b) => (setUpTime(b) > setUpTime(a) ? b : a));
  if (Date.now() - setUpTime(newest) > SET_UP_TOLD_WITHIN_MS) return NextResponse.json({ told: false });

  const { data: seen, error: seenError } = await service.from('audit_log').select('id')
    .eq('table_name', 'auth.mfa_factors').eq('record_id', newest.id).eq('action', 'two_step_set_up').limit(1);
  if (seenError) return NextResponse.json({ error: seenError.message }, { status: 500 });
  if ((seen ?? []).length > 0) return NextResponse.json({ told: false });

  await logAudit(service, {
    actorId: me, table: 'auth.mfa_factors', recordId: newest.id, action: 'two_step_set_up', detail: { authenticators: apps.length },
  });
  const name = personName({ full_name: auth.profile?.full_name, email: auth.user?.email });
  await tellTwoStepChange(service, {
    title: 'Two-step sign-in set up',
    body: `${name} set up two-step sign-in with an authenticator app. If it wasn't them, reset it on their user.`,
    url: deepLinks.adminUser(me),
  }, [me]);
  return NextResponse.json({ told: true });
}
