import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// authenticateSiriKey reads siri_keys and profiles through the service
// client; this fake answers those two lookups from `db` and records what was
// asked, so the tests can check the key never reaches the database raw.
const db = vi.hoisted(() => ({
  keyRow: null as { id: string; user_id: string; revoked_at: string | null } | null,
  keyError: null as { message: string } | null,
  profile: null as Record<string, unknown> | null,
  profileError: null as { message: string } | null,
  hasSchedule: true,
  lookups: [] as Array<{ table: string; column: string; value: unknown }>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
}));

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: unknown) => {
          db.lookups.push({ table, column, value });
          return {
            maybeSingle: async () =>
              table === 'siri_keys'
                ? { data: db.keyRow, error: db.keyError }
                : { data: db.profile, error: db.profileError },
          };
        },
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          db.updates.push({ table, values });
          return { error: null };
        },
      }),
    }),
  }),
}));

// The real account check; only the feature lookup (its own database read) is stubbed.
vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  profileHasFeature: vi.fn(async () => db.hasSchedule),
}));

import { authenticateSiriKey, hashSiriKey, mintSiriKey } from './siri-keys';

const request = (authorization?: string) =>
  new NextRequest('https://go.bmgfleet.com/api/siri/calendar-event', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });

const activeProfile = { id: 'user-1', role: 'sales', roles: ['sales'], status: 'approved', deactivated: false };

beforeEach(() => {
  db.keyRow = { id: 'key-1', user_id: 'user-1', revoked_at: null };
  db.keyError = null;
  db.profile = activeProfile;
  db.profileError = null;
  db.hasSchedule = true;
  db.lookups = [];
  db.updates = [];
});

describe('mintSiriKey / hashSiriKey', () => {
  it('mints prefixed 256-bit keys that never repeat', () => {
    const a = mintSiriKey();
    const b = mintSiriKey();
    expect(a).toMatch(/^fss_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes to a stable SHA-256 hex digest', () => {
    const key = mintSiriKey();
    expect(hashSiriKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSiriKey(key)).toBe(hashSiriKey(key));
    expect(hashSiriKey(key)).not.toBe(hashSiriKey(mintSiriKey()));
  });
});

describe('authenticateSiriKey', () => {
  it('resolves a live key to its owner, looking it up by hash only', async () => {
    const key = mintSiriKey();
    const result = await authenticateSiriKey(request(`Bearer ${key}`));

    expect(result).toEqual({ userId: 'user-1' });
    expect(db.lookups[0]).toEqual({ table: 'siri_keys', column: 'key_hash', value: hashSiriKey(key) });
    expect(db.lookups.some(l => l.value === key)).toBe(false);
    expect(db.updates).toEqual([{ table: 'siri_keys', values: { last_used_at: expect.any(String) } }]);
  });

  it('refuses a missing header or a session token without touching the database', async () => {
    for (const header of [undefined, 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y', `Basic ${mintSiriKey()}`]) {
      const result = await authenticateSiriKey(request(header));
      expect(result.error?.status).toBe(401);
    }
    expect(db.lookups).toEqual([]);
  });

  it('answers 401, which makes the phone drop its key, only for unknown or revoked keys', async () => {
    db.keyRow = null;
    expect((await authenticateSiriKey(request(`Bearer ${mintSiriKey()}`))).error?.status).toBe(401);

    db.keyRow = { id: 'key-1', user_id: 'user-1', revoked_at: '2026-09-23T12:00:00Z' };
    expect((await authenticateSiriKey(request(`Bearer ${mintSiriKey()}`))).error?.status).toBe(401);
  });

  it('answers 503 when a lookup fails, so a database hiccup never wipes a good key', async () => {
    db.keyError = { message: 'Gateway Timeout' };
    expect((await authenticateSiriKey(request(`Bearer ${mintSiriKey()}`))).error?.status).toBe(503);

    db.keyError = null;
    db.profileError = { message: 'Gateway Timeout' };
    expect((await authenticateSiriKey(request(`Bearer ${mintSiriKey()}`))).error?.status).toBe(503);
    expect(db.updates).toEqual([]);
  });

  it('re-checks the owner on every use: deactivated, unapproved, or no Schedule is refused', async () => {
    for (const profile of [
      { ...activeProfile, deactivated: true },
      { ...activeProfile, status: 'pending' },
      null,
    ]) {
      db.profile = profile;
      const result = await authenticateSiriKey(request(`Bearer ${mintSiriKey()}`));
      expect(result.error?.status).toBe(403);
    }

    db.profile = activeProfile;
    db.hasSchedule = false;
    const result = await authenticateSiriKey(request(`Bearer ${mintSiriKey()}`));
    expect(result.error?.status).toBe(403);
    expect(await result.error?.json()).toEqual({ error: "Your FleetSuite account can't add to the schedule." });
    expect(db.updates).toEqual([]);
  });
});
