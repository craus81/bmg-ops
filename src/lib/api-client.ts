/**
 * Authenticated API client for frontend fetch calls.
 * Automatically includes the Supabase access token in requests.
 */

import { createClient } from '@/lib/supabase-browser';
import { TWO_STEP_EVENT, isTwoStepNeed } from '@/lib/two-step';

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

  const res = await fetch(url, { ...options, headers });
  if (res.status === 403 && typeof window !== 'undefined') noticeTwoStep(res);
  return res;
}

/**
 * A call FleetSuite refused because the sign-in still owes its two-step code
 * (src/lib/two-step.ts) brings up the code or set-up screen (AuthProvider
 * listens), so a sign-in the switch caught partway through isn't left with
 * pages that just fail. Reads a copy of the answer; the caller keeps its own.
 */
function noticeTwoStep(res: Response): void {
  try {
    res.clone().json()
      .then((body: { twoStep?: unknown }) => {
        if (isTwoStepNeed(body?.twoStep)) window.dispatchEvent(new CustomEvent(TWO_STEP_EVENT, { detail: body.twoStep }));
      })
      .catch(() => {});
  } catch { /* an answer that can't be read twice */ }
}
