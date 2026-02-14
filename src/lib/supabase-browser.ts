import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (client) return client;

  // Patch fetch globally to strip abort signals for Supabase requests
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('supabase.co')) {
      const { signal, ...rest } = init || {};
      return originalFetch.call(globalThis, input, rest);
    }
    return originalFetch.call(globalThis, input, init);
  } as typeof fetch;

  client = createBrowserClient(supabaseUrl, supabaseAnonKey);
  return client;
}
