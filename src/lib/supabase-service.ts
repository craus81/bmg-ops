import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client with Next's fetch Data Cache disabled.
 *
 * Next 14 patches global fetch, and a cached PostgREST GET serves frozen
 * rows across requests — on Vercel, even across deployments. This table has
 * field evidence twice now: the gmail auto-import status strip served a
 * days-old sync_state timestamp while writes verifiably landed, and in the
 * July 2026 incident every job's heartbeat *read* froze (System Health
 * showed the whole board stale at 38h, the watcher's alert-dedupe state
 * "never persisted", and healthchecks.io pinged /fail for a day and a half)
 * while the underlying rows were being written the entire time.
 *
 * `route.ts` config like `dynamic = 'force-dynamic'` is not sufficient —
 * the Data Cache is keyed per fetch URL and survives it. Every server-side
 * service client should come from here so reads are always live.
 */
export function createServiceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { global: { fetch: (input: any, init?: any) => fetch(input, { ...init, cache: 'no-store' }) } },
  );
}
