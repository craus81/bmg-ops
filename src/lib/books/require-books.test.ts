// requireBooks (src/lib/api-auth.ts): every Books route's wall, by the
// caller's own roles (src/lib/books/access.ts, Books part 52). A made-up
// signed-in caller whose profile the test picks.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let profile: Record<string, unknown> | null;
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-pat', email: 'pat@example.com' } }, error: null }) },
  }),
}));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: profile, error: null }) }) }) }),
  }),
}));

import { requireBooks, requireStaff } from '@/lib/api-auth';

const signedIn = () => new NextRequest('https://go.bmgfleet.com/api/admin/books/accounts', { headers: { Authorization: 'Bearer made-up-token' } });
const as = (roles: string[], more: Record<string, unknown> = {}) => {
  profile = { id: 'u-pat', role: roles[0], roles, status: 'approved', deactivated: false, full_name: 'Pat Example', ...more };
};
const refusal = async (r: { error?: Response }) => (r.error ? { status: r.error.status, body: await r.error.json() } : null);

beforeEach(() => { profile = null; });

describe('requireBooks', () => {
  it('lets the CPA read the books and change nothing', async () => {
    as(['cpa']);
    const read = await requireBooks(signedIn(), 'read');
    expect(read.error).toBeUndefined();
    expect(read.access).toBe('read');
    expect(read.user.id).toBe('u-pat');
    const forbidden = { status: 403, body: { error: "Forbidden: this login reads the books but can't change them" } };
    expect(await refusal(await requireBooks(signedIn(), 'keep'))).toEqual(forbidden);
    expect(await refusal(await requireBooks(signedIn(), 'owner'))).toEqual({ status: 403, body: { error: 'Forbidden: super admin required' } });
  });

  it("lets the bookkeeper keep the books but not take the owner's steps", async () => {
    as(['bookkeeper']);
    expect((await requireBooks(signedIn(), 'read')).access).toBe('keep');
    const keep = await requireBooks(signedIn(), 'keep');
    expect(keep.error).toBeUndefined();
    expect(keep.access).toBe('keep');
    expect(await refusal(await requireBooks(signedIn(), 'owner'))).toEqual({ status: 403, body: { error: 'Forbidden: super admin required' } });
  });

  it('lets a super admin do everything', async () => {
    as(['admin', 'super_admin'], { role: 'admin' });
    for (const need of ['read', 'keep', 'owner'] as const) {
      const r = await requireBooks(signedIn(), need);
      expect(r.error, need).toBeUndefined();
      expect(r.access).toBe('owner');
    }
  });

  it('keeps out an admin, finance and an executive', async () => {
    for (const roles of [['admin'], ['finance'], ['executive'], ['sales', 'finance']]) {
      as(roles);
      expect(await refusal(await requireBooks(signedIn(), 'read')), roles.join()).toEqual({ status: 403, body: { error: 'Forbidden: no access to the books' } });
    }
  });

  it('keeps out a CPA whose account is waiting for approval or switched off, and anyone not signed in', async () => {
    as(['cpa'], { status: 'pending' });
    expect(await refusal(await requireBooks(signedIn(), 'read'))).toEqual({ status: 403, body: { error: 'Forbidden: account not approved' } });
    as(['bookkeeper'], { deactivated: true });
    expect(await refusal(await requireBooks(signedIn(), 'read'))).toEqual({ status: 403, body: { error: 'Forbidden: account not approved' } });
    as(['cpa']);
    expect((await refusal(await requireBooks(new NextRequest('https://go.bmgfleet.com/api/admin/books/accounts'), 'read')))?.status).toBe(401);
  });
});

describe('the books logins elsewhere', () => {
  it("aren't BMG staff, so the staff wall keeps them out", async () => {
    for (const roles of [['bookkeeper'], ['cpa'], ['bookkeeper', 'cpa']]) {
      as(roles);
      expect((await requireStaff(signedIn())).error?.status, roles.join()).toBe(403);
    }
    as(['cpa', 'finance']);
    expect((await requireStaff(signedIn())).error).toBeUndefined();
  });
});
