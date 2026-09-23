import { createHash, randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { isActiveProfile, profileHasFeature } from '@/lib/api-auth';

/**
 * Per-device keys for the iPhone app's Siri commands (migration 322).
 *
 * Siri saves a calendar entry without opening the app, so it can't use the
 * web view's Supabase session. After sign-in the app mints one of these
 * (/api/siri/key), keeps it in the iPhone Keychain, and the Siri intent
 * sends it as a bearer token to /api/siri/*. Only its SHA-256 lands in the
 * database, and every use re-runs the account checks a session gets.
 *
 * Error messages here are spoken by Siri as-is, so they are whole sentences.
 */

const KEY_PREFIX = 'fss_';

export function hashSiriKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** 256 random bits, prefixed so a leaked key is recognizable in a log. */
export function mintSiriKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

export type SiriAuthResult =
  | { userId: string; error?: undefined }
  | { userId?: undefined; error: NextResponse };

const refuse = (status: number, error: string): SiriAuthResult =>
  ({ error: NextResponse.json({ error }, { status }) });

/**
 * Resolve the request's Siri key to its owner: the key must exist and not be
 * revoked, and the owner must still be approved, not deactivated, and still
 * hold the Schedule feature (the only thing a key can do today). A 401 tells
 * the phone to drop its stored key (the next app launch mints a fresh one), so
 * it means only "this key is no good", never "the database is busy".
 */
export async function authenticateSiriKey(req: NextRequest): Promise<SiriAuthResult> {
  const header = req.headers.get('authorization') || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const signInAgain = 'Open FleetSuite on this iPhone and sign in, then ask me again.';
  if (!key.startsWith(KEY_PREFIX)) return refuse(401, signInAgain);

  // A failed read is not a bad key: answer 503, not 401, so the phone keeps it.
  const busy = "FleetSuite isn't answering right now. Try again in a minute.";
  const service = createServiceClient();
  const { data: row, error: keyError } = await service
    .from('siri_keys')
    .select('id, user_id, revoked_at')
    .eq('key_hash', hashSiriKey(key))
    .maybeSingle();
  if (keyError) return refuse(503, busy);
  if (!row || row.revoked_at) return refuse(401, signInAgain);

  const { data: profile, error: profileError } = await service
    .from('profiles')
    .select('id, role, roles, status, deactivated')
    .eq('id', row.user_id)
    .maybeSingle();
  if (profileError) return refuse(503, busy);
  if (!isActiveProfile(profile)) return refuse(403, 'That FleetSuite account is not active.');
  if (!(await profileHasFeature(row.user_id, profile, 'schedule'))) {
    return refuse(403, "Your FleetSuite account can't add to the schedule.");
  }

  await service.from('siri_keys').update({ last_used_at: new Date().toISOString() }).eq('id', row.id);
  return { userId: row.user_id };
}
