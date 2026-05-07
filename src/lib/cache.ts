import { unstable_cache } from 'next/cache';

/**
 * Thin wrapper around Next's unstable_cache that gives us a single place to
 * tune cache behavior and consistent key/tag conventions.
 *
 * Usage:
 *   const getItems = cached(
 *     async (partNumbers: string[]) => findItems(partNumbers),
 *     ['netsuite', 'find-items'],
 *     { revalidate: 3600, tags: ['netsuite:items'] },
 *   );
 *
 * The cache is keyed by the function arguments as well as the keyParts, so
 * different argument combinations are cached independently. Use a short
 * revalidate for things that change frequently and a long one (or `false`)
 * for slow-changing data. Use `tags` so you can call `revalidateTag()` from
 * a write path to invalidate the read cache after a mutation.
 */
export function cached<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  keyParts: string[],
  options: { revalidate?: number | false; tags?: string[] } = {},
): (...args: TArgs) => Promise<TResult> {
  return unstable_cache(fn, keyParts, {
    revalidate: options.revalidate ?? 60,
    tags: options.tags,
  });
}

/**
 * Cache TTL presets. Naming is intentionally suggestive rather than precise —
 * pick the bucket that matches the data's volatility and adjust the number in
 * one place if behavior needs tuning.
 */
export const CACHE_TTL = {
  /** Typeahead-ish — too short to amortize a slow call meaningfully. */
  SHORT: 60,
  /** Dashboard widgets, list views — OK to be a minute stale. */
  MEDIUM: 300,
  /** Slow-changing reference data — item catalogs, location lookups. */
  LONG: 3600,
} as const;
