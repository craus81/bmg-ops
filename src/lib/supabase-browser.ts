import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let client: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (client) return client;
  
  client = createBrowserClient(supabaseUrl, supabaseAnonKey, {
    global: {
      fetch: (url, options) => {
        // Remove the abort signal to prevent AbortError
        const { signal, ...rest } = options || {};
        return fetch(url, rest);
      },
    },
  });
  
  return client;
}
