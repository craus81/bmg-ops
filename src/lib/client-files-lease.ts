import type { SupabaseClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Near-instant Client Files sync (Craig, 2026-10-16, option 2): Dropbox's
 * webhook tells /api/webhooks/dropbox that something changed, and that
 * kicks /api/cron/client-files at once instead of waiting for the next
 * 10-minute run (which stays as the backup).
 *
 * Bursts of alerts (Dropbox sends one per change anywhere in the account)
 * must not start a pile of overlapping runs, so a run holds a lease: one
 * sync_state row whose last_synced_at is "held until". Taking it is a
 * single UPDATE ... WHERE held-until < now, so two callers can't both win.
 * An alert that finds the lease held leaves a request (last_result.
 * requestedAt) and the running sync does one more pass for it before it
 * lets go, so a change made mid-run isn't left for the next 10 minutes.
 */

export const CLIENT_FILES_LEASE_TYPE = 'dropbox_client_files_lease';
const LONG_AGO = '2020-01-01T00:00:00Z';

/** Take the lease for `ms`. False when another run holds it. */
export async function acquireClientFilesLease(service: SupabaseClient, ms: number): Promise<boolean> {
  await service.from('sync_state').upsert(
    { sync_type: CLIENT_FILES_LEASE_TYPE, last_synced_at: LONG_AGO },
    { onConflict: 'sync_type', ignoreDuplicates: true },
  );
  const now = new Date();
  const { data, error } = await service.from('sync_state')
    .update({ last_synced_at: new Date(now.getTime() + ms).toISOString(), updated_at: now.toISOString() })
    .eq('sync_type', CLIENT_FILES_LEASE_TYPE)
    .lt('last_synced_at', now.toISOString())
    .select('sync_type');
  if (error) throw new Error(`lease: ${error.message}`);
  return (data || []).length === 1;
}

export async function releaseClientFilesLease(service: SupabaseClient): Promise<void> {
  await service.from('sync_state')
    .update({ last_synced_at: LONG_AGO, updated_at: new Date().toISOString() })
    .eq('sync_type', CLIENT_FILES_LEASE_TYPE);
}

/** Ask for another pass: the running sync (or the next one) picks it up. */
export async function requestClientFilesRun(service: SupabaseClient): Promise<void> {
  await service.from('sync_state').upsert(
    { sync_type: CLIENT_FILES_LEASE_TYPE, last_synced_at: LONG_AGO },
    { onConflict: 'sync_type', ignoreDuplicates: true },
  );
  await service.from('sync_state')
    .update({ last_result: { requestedAt: new Date().toISOString() } })
    .eq('sync_type', CLIENT_FILES_LEASE_TYPE);
}

/** When the last pass was asked for, or null. */
export async function clientFilesRunRequestedAt(service: SupabaseClient): Promise<number | null> {
  const { data } = await service.from('sync_state').select('last_result')
    .eq('sync_type', CLIENT_FILES_LEASE_TYPE).maybeSingle();
  const at = Date.parse((data?.last_result as any)?.requestedAt || '');
  return Number.isFinite(at) ? at : null;
}

/**
 * Dropbox signs each webhook POST: X-Dropbox-Signature is the hex
 * HMAC-SHA256 of the raw body keyed with the app secret. Fails closed
 * without a secret.
 */
export function verifyDropboxSignature(rawBody: string, signature: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !signature) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
