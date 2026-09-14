import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { QboEnvironment } from './config';

/**
 * The OAuth `state` nonce — single use, short lived, bound to one user.
 *
 * Without it, /api/auth/quickbooks/callback would accept any code an
 * attacker could get an admin's browser to deliver, and the single shared
 * `quickbooks_tokens` row would end up pointing at a realm we did not choose
 * (owner item 21). The callback ALSO calls requireAdmin, so this is the
 * second wall, not the only one.
 *
 * `quickbooks_oauth_states` has RLS on with no policies: only the service
 * role ever touches it.
 */

/** How long a consent screen may sit open before its state expires. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Rows older than this are swept on every mint — nothing else deletes them. */
const PURGE_AFTER_MS = 60 * 60 * 1000;

export async function mintState(
  service: SupabaseClient,
  userId: string,
  environment: QboEnvironment,
): Promise<string> {
  const state = crypto.randomUUID();
  const now = Date.now();

  // Housekeeping first so a failed insert still leaves the table tidy. A
  // stale row is harmless (it can never be consumed) but the table would
  // otherwise grow one row per abandoned connect attempt forever.
  const { error: purgeError } = await service
    .from('quickbooks_oauth_states')
    .delete()
    .lt('created_at', new Date(now - PURGE_AFTER_MS).toISOString());
  if (purgeError) console.error('[qbo] oauth state purge failed:', purgeError.message);

  const { error } = await service.from('quickbooks_oauth_states').insert({
    state,
    user_id: userId,
    environment,
    expires_at: new Date(now + STATE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`Could not mint an OAuth state: ${error.message}`);
  return state;
}

export type ConsumeResult =
  | { ok: true; environment: QboEnvironment }
  | { ok: false; reason: 'missing' | 'expired' | 'user_mismatch' | 'malformed' };

/**
 * Verify and burn one state. Returns the environment the connect STARTED in,
 * so the pairing check runs against what the admin actually chose rather
 * than whatever the env says by the time the callback lands.
 *
 * The comparison is `crypto.timingSafeEqual` against the stored primary key.
 * timingSafeEqual throws on a length mismatch, so the length is checked
 * first and reported as `malformed` — a thrown callback would be a 500 where
 * a refusal belongs.
 */
export async function consumeState(
  service: SupabaseClient,
  state: string,
  userId: string,
): Promise<ConsumeResult> {
  const candidate = String(state ?? '');
  if (!candidate) return { ok: false, reason: 'malformed' };

  const { data, error } = await service
    .from('quickbooks_oauth_states')
    .select('state, user_id, environment, expires_at')
    .eq('state', candidate)
    .maybeSingle();
  if (error) {
    console.error('[qbo] oauth state read failed:', error.message);
    return { ok: false, reason: 'missing' };
  }
  if (!data) return { ok: false, reason: 'missing' };

  const stored = Buffer.from(String(data.state), 'utf8');
  const given = Buffer.from(candidate, 'utf8');
  if (stored.length !== given.length) return { ok: false, reason: 'malformed' };
  if (!crypto.timingSafeEqual(stored, given)) return { ok: false, reason: 'missing' };

  // Burn it before deciding: a state that failed its expiry or user check has
  // still been presented once, and leaving it live invites a retry.
  const { error: delError } = await service
    .from('quickbooks_oauth_states')
    .delete()
    .eq('state', candidate);
  if (delError) console.error('[qbo] oauth state delete failed:', delError.message);

  if (!data.expires_at || new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (String(data.user_id) !== String(userId)) return { ok: false, reason: 'user_mismatch' };

  return { ok: true, environment: data.environment as QboEnvironment };
}
