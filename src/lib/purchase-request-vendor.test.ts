import { describe, it, expect } from 'vitest';
import { resolveVendorName, resolveVendorNames, vendorKey } from './purchase-request-vendor';

const master = [
  { netsuite_id: '101', company_name: 'Grimco Inc', entity_id: 'Grimco' },
  { netsuite_id: '202', company_name: 'CURT Manufacturing', entity_id: 'CURT' },
  { netsuite_id: '303', company_name: 'Buyers Products', entity_id: 'Buyers' },
  { netsuite_id: '304', company_name: 'Buyers Supply', entity_id: 'Buyers Supply' },
];

/** Fake Supabase read of netsuite_vendors, paged like PostgREST. */
const fakeClient = (rows: typeof master) => ({
  from: () => {
    const q: any = {
      select: () => q, eq: () => q, order: () => q,
      range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
    };
    return q;
  },
}) as any;

describe('resolveVendorName', () => {
  it('matches a typed name to its NetSuite vendor whatever the case', () => {
    expect(resolveVendorName('grimco inc.', master)).toEqual({ id: '101', name: 'Grimco Inc' });
  });

  it('matches the NetSuite entity id too', () => {
    expect(resolveVendorName('Curt', master)).toEqual({ id: '202', name: 'CURT Manufacturing' });
  });

  it('matches a unique leading name', () => {
    expect(resolveVendorName('CURT Manufacturing LLC', master)).toEqual({ id: '202', name: 'CURT Manufacturing' });
  });

  it('leaves an ambiguous name unmatched rather than guessing', () => {
    expect(resolveVendorName('Buy', master)).toBeNull();
  });

  it('leaves an unknown or blank name unmatched', () => {
    expect(resolveVendorName('Acme Hitch', master)).toBeNull();
    expect(resolveVendorName('  ', master)).toBeNull();
  });
});

describe('resolveVendorNames', () => {
  it('resolves several names in one read, keyed by vendorKey', async () => {
    const out = await resolveVendorNames(fakeClient(master), ['Grimco', 'Acme', null, 'grimco']);
    expect(out.get(vendorKey('Grimco'))).toEqual({ id: '101', name: 'Grimco Inc' });
    expect(out.has(vendorKey('Acme'))).toBe(false);
    expect(out.size).toBe(1);
  });

  it('reads every page of a large vendor list', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ netsuite_id: String(i + 1), company_name: `Vendor ${i + 1}`, entity_id: null }));
    const out = await resolveVendorNames(fakeClient(many as any), ['Vendor 2400']);
    expect(out.get(vendorKey('Vendor 2400'))?.id).toBe('2400');
  });

  it('skips the read when there is nothing to resolve', async () => {
    const out = await resolveVendorNames({ from: () => { throw new Error('should not read'); } } as any, [null, '']);
    expect(out.size).toBe(0);
  });
});
