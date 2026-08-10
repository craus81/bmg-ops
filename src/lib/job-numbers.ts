import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Human job numbers (K4): one dated, sequential format for every record the
 * team says out loud — EST-2608-041, GFX-2608-017, WQ-2608-003, and the
 * graphics category prefixes (PRF/INT/CSG). Minted by the atomic
 * next_job_number() DB function (migration 194), which replaced six
 * independent base36/random generators.
 *
 * The RPC failing must never block a save — creation flows are more
 * important than pretty numbers — so every caller passes a fallback built
 * from the old collision-resistant format. Estimates additionally keep
 * their 23505 retry loop, which only ever engages on the fallback path.
 *
 * Client-safe: works with both the browser client (wrap-quote, schedule,
 * graphics pages mint numbers client-side; the function is SECURITY
 * DEFINER + EXECUTE to authenticated) and server service clients.
 */
export async function nextJobNumber(
  client: Pick<SupabaseClient, 'rpc'>,
  prefix: string,
  fallback: () => string,
): Promise<string> {
  try {
    const { data, error } = await client.rpc('next_job_number', { p_prefix: prefix });
    if (error || typeof data !== 'string' || !data) {
      if (error) console.warn(`next_job_number(${prefix}) failed, using legacy format:`, error.message);
      return fallback();
    }
    return data;
  } catch (err: any) {
    console.warn(`next_job_number(${prefix}) threw, using legacy format:`, err?.message);
    return fallback();
  }
}

/** Legacy generators, kept ONLY as RPC-failure fallbacks (old format). */
export const legacyJobNumber = {
  est(): string {
    const d = new Date();
    const yy = d.getFullYear().toString().slice(-2);
    const mm = (d.getMonth() + 1).toString().padStart(2, '0');
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `EST-${yy}${mm}-${rand}`;
  },
  gfx(prefix = 'GFX'): string {
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  },
  wq(): string {
    const d = new Date();
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getFullYear()).slice(-2)}`;
    return `WQ-${md}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  },
};
