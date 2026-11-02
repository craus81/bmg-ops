// apiFetch and two-step sign-in (Books part 87, src/lib/two-step.ts): a call
// FleetSuite refuses because the sign-in owes its code brings up the code or
// set-up screen, and the caller still reads its own answer. Made-up token.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/supabase-browser', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'made-up-token' } } }) } }),
}));

import { apiFetch } from './api-client';
import { TWO_STEP_EVENT } from './two-step';

let heard: unknown[];

const answering = (res: () => Response) => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => res());
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
/** Lets the copy apiFetch reads settle before anything is counted. */
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  heard = [];
  const page = new EventTarget();
  page.addEventListener(TWO_STEP_EVENT, (e) => heard.push((e as CustomEvent).detail));
  vi.stubGlobal('window', page);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('apiFetch and two-step sign-in', () => {
  it('brings up the code screen, and the caller still reads its answer', async () => {
    const body = { error: 'Enter the code from your authenticator app to carry on.', twoStep: 'code' };
    const fetch = answering(() => Response.json(body, { status: 403 }));
    const res = await apiFetch('/api/anything');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(body);
    await vi.waitFor(() => expect(heard).toEqual(['code']));
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer made-up-token');
  });

  it('brings up the set-up screen for a money role the switch just caught', async () => {
    answering(() => Response.json({ error: 'Set up two-step sign-in to carry on.', twoStep: 'setup' }, { status: 403 }));
    await apiFetch('/api/anything');
    await vi.waitFor(() => expect(heard).toEqual(['setup']));
  });

  it('leaves every other answer alone', async () => {
    answering(() => Response.json({ error: 'Forbidden: super admin required' }, { status: 403 }));
    await apiFetch('/api/anything');
    answering(() => Response.json({ error: 'Not this', twoStep: 'code' }, { status: 401 }));
    await apiFetch('/api/anything');
    answering(() => Response.json({ twoStep: 'code' }, { status: 200 }));
    await apiFetch('/api/anything');
    answering(() => Response.json({ twoStep: 'unknown' }, { status: 403 }));
    await apiFetch('/api/anything');
    answering(() => new Response('<html>Forbidden</html>', { status: 403 }));
    const res = await apiFetch('/api/anything');
    expect(await res.text()).toBe('<html>Forbidden</html>');
    await settle();
    expect(heard).toEqual([]);
  });

  it("doesn't read the answer on the server, where there is no page to show it", async () => {
    vi.stubGlobal('window', undefined);
    const refused = Response.json({ twoStep: 'code' }, { status: 403 });
    const copied = vi.spyOn(refused, 'clone');
    answering(() => refused);
    expect((await apiFetch('/api/anything')).status).toBe(403);
    await settle();
    expect(copied).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });
});
