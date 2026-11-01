// Users → Add user (src/app/api/admin/create-user): only a super admin makes a
// super admin, a bookkeeper or a CPA login (Books part 52; migration 483 holds
// the database to the same). Made-up people; nothing is emailed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  callerRoles: ['admin'] as string[],
  created: [] as string[],
  profiles: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/api-auth', () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: 'u-admin' }, profile: { roles: h.callerRoles } })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    auth: {
      admin: {
        createUser: vi.fn(async ({ email }: { email: string }) => { h.created.push(email); return { data: { user: { id: 'u-new' } }, error: null }; }),
        generateLink: vi.fn(async () => ({ data: null, error: { message: 'no links in tests' } })),
      },
    },
    from: () => ({ upsert: async (row: Record<string, unknown>) => { h.profiles.push(row); return { error: null }; } }),
  }),
}));

import { POST } from '../app/api/admin/create-user/route';

const create = async (roles: string[]) => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/create-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pat@example.com', password: 'made-up-pass-1', fullName: 'Pat Example', roles, sendInvite: false }),
  }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  h.callerRoles = ['admin'];
  h.created.length = 0;
  h.profiles.length = 0;
});

describe('create-user and the roles only a super admin gives', () => {
  it("won't let an admin make a bookkeeper, a CPA or a super admin", async () => {
    expect(await create(['bookkeeper'])).toEqual({ status: 403, body: { error: 'Forbidden: only a super admin can create a bookkeeper account' } });
    expect(await create(['cpa'])).toEqual({ status: 403, body: { error: 'Forbidden: only a super admin can create a CPA account' } });
    expect(await create(['finance', 'cpa'])).toEqual({ status: 403, body: { error: 'Forbidden: only a super admin can create a CPA account' } });
    expect(await create(['super_admin'])).toEqual({ status: 403, body: { error: 'Forbidden: only a super admin can create a super admin account' } });
    expect(h.created).toEqual([]);
    expect(h.profiles).toEqual([]);
  });

  it('lets an admin make any other login', async () => {
    expect((await create(['finance'])).status).toBe(200);
    expect(h.profiles.map((p) => p.roles)).toEqual([['finance']]);
  });

  it('lets a super admin make a bookkeeper or a CPA, each its own role', async () => {
    h.callerRoles = ['admin', 'super_admin'];
    expect((await create(['bookkeeper'])).status).toBe(200);
    expect((await create(['cpa'])).status).toBe(200);
    expect(h.profiles.map((p) => [p.role, p.roles, p.status])).toEqual([
      ['bookkeeper', ['bookkeeper'], 'approved'],
      ['cpa', ['cpa'], 'approved'],
    ]);
  });
});
