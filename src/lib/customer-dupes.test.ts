import { describe, it, expect } from 'vitest';
import { escapeIlike, normalizeCompanyName, phoneDigits, last10, describeMatch, findCustomerDuplicates } from './customer-dupes';

describe('normalizeCompanyName', () => {
  it('trims, lowercases, collapses whitespace', () => {
    expect(normalizeCompanyName('  Acme   Fleet  Services ')).toBe('acme fleet services');
  });
});

describe('phoneDigits', () => {
  it('strips formatting', () => {
    expect(phoneDigits('(555) 123-4567')).toBe('5551234567');
  });
  it('keeps country code digits', () => {
    expect(phoneDigits('+1 555 123 4567')).toBe('15551234567');
  });
  it('rejects too-short fragments (extensions, partials)', () => {
    expect(phoneDigits('x1234')).toBeNull();
    expect(phoneDigits('')).toBeNull();
    expect(phoneDigits(null)).toBeNull();
  });
});

describe('last10', () => {
  it('makes +1-prefixed and bare numbers comparable', () => {
    expect(last10('15551234567')).toBe('5551234567');
    expect(last10('5551234567')).toBe('5551234567');
    expect(last10('1234567')).toBe('1234567');
  });
});

describe('escapeIlike', () => {
  it('escapes the ilike wildcards so a name matches literally', () => {
    expect(escapeIlike('100% Fleet_Co')).toBe('100\\% Fleet\\_Co');
  });
});

describe('describeMatch', () => {
  it('names the matched fields', () => {
    expect(describeMatch({
      source: 'customers', id: '1', company_name: 'Acme', email: null, phone: null,
      netsuite_id: '42', matchedOn: ['name', 'phone'],
    })).toBe('Acme (same name, same phone)');
  });
});

// findCustomerDuplicates against a stub client: verifies the dedupe/merge
// and ordering logic without a database.
function stubService(tables: Record<string, any[]>) {
  // One builder per from() call; filters accumulate and the builder itself
  // is thenable, so any chaining order (.ilike().limit(), .limit().like())
  // resolves the filtered rows like PostgREST would.
  const makeBuilder = (rows: any[]) => {
    let filtered = rows;
    const b: any = {
      select: () => b, limit: () => b,
      eq: (col: string, val: any) => { filtered = filtered.filter(r => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter(r => r[col] !== val); return b; },
      ilike: (col: string, val: string) => {
        const target = val.replace(/\\([\\%_])/g, '$1').toLowerCase();
        filtered = filtered.filter(r => (r[col] || '').toLowerCase() === target);
        return b;
      },
      like: (col: string, val: string) => {
        const tail = val.replace(/^%/, '');
        filtered = filtered.filter(r => (r[col] || '').endsWith(tail));
        return b;
      },
      then: (resolve: any) => resolve({ data: filtered }),
    };
    return b;
  };
  return { from: (t: string) => makeBuilder(tables[t] || []) } as any;
}

describe('findCustomerDuplicates', () => {
  const tables = {
    prospects: [
      { id: 'p1', company_name: 'Acme Fleet', contact_name: 'Jo', email: 'jo@acme.com', phone: '(555) 123-4567', phone_digits: '5551234567', netsuite_id: null, record_type: 'customer' },
    ],
    customers: [
      { id: 'c1', company_name: 'Acme Fleet', email: 'ap@acme.com', phone: '555.123.4567', phone_digits: '5551234567', netsuite_id: 42 },
    ],
  };

  it('merges multi-field hits per record and puts name matches first', async () => {
    const matches = await findCustomerDuplicates(stubService(tables), {
      companyName: 'acme fleet', email: 'jo@acme.com', phone: '+1 555 123 4567',
    });
    const p = matches.find(m => m.source === 'prospects');
    const c = matches.find(m => m.source === 'customers');
    expect(p?.matchedOn.sort()).toEqual(['email', 'name', 'phone']);
    expect(c?.matchedOn.sort()).toEqual(['name', 'phone']);
    expect(c?.netsuite_id).toBe('42');
    expect(matches[0].matchedOn).toContain('name');
  });

  it('finds a phone-only match under a different name', async () => {
    const matches = await findCustomerDuplicates(stubService(tables), {
      companyName: 'Totally Different LLC', phone: '5551234567',
    });
    expect(matches.length).toBe(2);
    expect(matches.every(m => m.matchedOn.join() === 'phone')).toBe(true);
  });

  it('vendor checks match vendor rows only and skip the customers mirror', async () => {
    const withVendor = {
      ...tables,
      prospects: [
        ...tables.prospects,
        { id: 'v1', company_name: 'Acme Fleet', contact_name: null, email: null, phone: null, phone_digits: null, netsuite_id: null, record_type: 'vendor' },
      ],
    };
    const matches = await findCustomerDuplicates(stubService(withVendor), {
      companyName: 'Acme Fleet', recordType: 'vendor',
    });
    // The same-named CUSTOMER prospect and the NetSuite mirror are ignored;
    // only the vendor row hits.
    expect(matches.map(m => `${m.source}:${m.id}`)).toEqual(['prospects:v1']);
  });
});
