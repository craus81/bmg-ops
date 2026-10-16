import { describe, it, expect } from 'vitest';
import { formatResponder, resolveProofResponder } from './proof-responder';

function fakeDb(contacts: Record<string, string>, profiles: Record<string, string> = {}) {
  return {
    from(table: string) {
      let email = '';
      const q: any = {
        select: () => q,
        ilike: (_c: string, v: string) => { email = v.toLowerCase(); return q; },
        limit: () => q,
        maybeSingle: async () => {
          const src = table === 'external_contacts' ? contacts : profiles;
          const hit = src[email];
          return { data: hit ? (table === 'external_contacts' ? { name: hit } : { full_name: hit }) : null };
        },
      };
      return q;
    },
  } as any;
}

describe('formatResponder', () => {
  it('pairs a name with the address', () => {
    expect(formatResponder('Scott Lee', 'scott@x.com')).toBe('Scott Lee (scott@x.com)');
  });
  it('falls back to the bare address', () => {
    expect(formatResponder(null, 'scott@x.com')).toBe('scott@x.com');
    expect(formatResponder('scott@x.com', 'scott@x.com')).toBe('scott@x.com');
  });
});

describe('resolveProofResponder', () => {
  it('does not guess on an older shared link', async () => {
    expect(await resolveProofResponder(fakeDb({ 'scott@x.com': 'Scott' }), { ownLink: false, deliveryTarget: 'scott@x.com' })).toBeNull();
  });
  it('names a customer contact from their own link', async () => {
    expect(await resolveProofResponder(fakeDb({ 'scott@x.com': 'Scott Lee' }), { ownLink: true, deliveryTarget: 'Scott@x.com' }))
      .toBe('Scott Lee (Scott@x.com)');
  });
  it('names a staff member when no contact matches', async () => {
    expect(await resolveProofResponder(fakeDb({}, { 'zach@bmgfleet.com': 'Zach' }), { ownLink: true, deliveryTarget: 'zach@bmgfleet.com' }))
      .toBe('Zach (zach@bmgfleet.com)');
  });
  it('keeps the typed name of a forwarded reader', async () => {
    expect(await resolveProofResponder(fakeDb({}), { ownLink: true, deliveryTarget: 'scott@x.com', typedName: 'Pat' }))
      .toBe('Pat (forwarded from scott@x.com)');
  });
  it('records a phone as is', async () => {
    expect(await resolveProofResponder(fakeDb({}), { ownLink: true, deliveryTarget: '(636) 946-0633' })).toBe('(636) 946-0633');
  });
});
