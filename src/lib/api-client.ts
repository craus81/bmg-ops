/**
 * Authenticated API client for frontend fetch calls.
 * Automatically includes the Supabase access token in requests.
 */

import { createClient } from '@/lib/supabase-browser';

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  const headers = new Headers(options.headers);
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(url, { ...options, headers });
}
