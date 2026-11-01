// FleetSuite AI (src/app/api/ai-agent/chat) and the books' own logins (Books
// part 52): a bookkeeper or CPA login with nothing else, like a customer, is
// refused before anything is read, since the assistant reads company-wide
// data the books don't open to them. A made-up caller whose roles the test picks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let roles: string[] = [];
vi.mock('@/lib/api-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'u-pat' }, profile: { role: roles[0], roles } })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/netsuite', () => ({ suiteqlQuery: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));

import { POST } from '../app/api/ai-agent/chat/route';

const ask = async () => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/ai-agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'What did we sell last month?' }] }),
  }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { vi.stubEnv('ANTHROPIC_API_KEY', ''); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('FleetSuite AI and the books logins', () => {
  it('refuses a bookkeeper or CPA login with no other role', async () => {
    for (const r of [['bookkeeper'], ['cpa'], ['bookkeeper', 'cpa'], ['cpa', 'customer']]) {
      roles = r;
      expect(await ask(), r.join()).toEqual({ status: 403, body: { error: "The assistant isn't available for your role." } });
    }
  });

  it('lets one with a staff role too get past that wall', async () => {
    // With no API key in tests, getting past the wall means "not configured".
    roles = ['cpa', 'finance'];
    expect(await ask()).toEqual({ status: 500, body: { error: 'AI not configured' } });
  });
});
