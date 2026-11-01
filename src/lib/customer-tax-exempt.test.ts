import { describe, it, expect, vi, beforeEach } from 'vitest';

const suiteqlAll = vi.fn();
vi.mock('@/lib/netsuite', () => ({ suiteqlQueryAll: (...a: any[]) => suiteqlAll(...a) }));

import { planTaxExemptSync, certWarning, billedCertWarning, taxMismatch, staffTaxExemptPatch, type CustomerTaxRow } from './customer-tax-exempt';
import { syncNetsuiteTaxExempt, NON_TAXABLE_QUERY } from './customer-tax-exempt-sync';

const row = (netsuite_id: string, o: Partial<CustomerTaxRow> = {}): CustomerTaxRow => ({
  netsuite_id, tax_exempt: false, tax_exempt_source: null, netsuite_taxable: null, ...o,
});

describe('planTaxExemptSync', () => {
  it('marks a customer exempt when NetSuite has Taxable off and nobody set it here', () => {
    const plan = planTaxExemptSync([row('101')], new Set(['101']));
    expect(plan).toEqual({ toTaxable: [], toNonTaxable: ['101'], markExempt: ['101'] });
  });

  it('records Taxable on without touching the exemption', () => {
    const plan = planTaxExemptSync([row('102', { tax_exempt: true, tax_exempt_source: 'staff' })], new Set());
    expect(plan).toEqual({ toTaxable: ['102'], toNonTaxable: [], markExempt: [] });
  });

  it('never takes an exemption away, even one NetSuite set', () => {
    const plan = planTaxExemptSync([row('103', { tax_exempt: true, tax_exempt_source: 'netsuite', netsuite_taxable: false })], new Set());
    expect(plan.markExempt).toEqual([]);
    expect(plan.toTaxable).toEqual(['103']);
  });

  it('leaves a customer staff set back to taxed', () => {
    const plan = planTaxExemptSync([row('104', { tax_exempt: false, tax_exempt_source: 'staff', netsuite_taxable: false })], new Set(['104']));
    expect(plan).toEqual({ toTaxable: [], toNonTaxable: [], markExempt: [] });
  });

  it('skips an already exempt customer and unchanged flags', () => {
    const plan = planTaxExemptSync([row('105', { tax_exempt: true, netsuite_taxable: false })], new Set(['105']));
    expect(plan).toEqual({ toTaxable: [], toNonTaxable: [], markExempt: [] });
  });

  it('ignores rows without a numeric NetSuite id', () => {
    const plan = planTaxExemptSync([row(''), { ...row('x'), netsuite_id: null }], new Set());
    expect(plan).toEqual({ toTaxable: [], toNonTaxable: [], markExempt: [] });
  });
});

describe('syncNetsuiteTaxExempt', () => {
  beforeEach(() => { suiteqlAll.mockReset(); });

  function fakeService(customers: CustomerTaxRow[]) {
    const updates: Array<{ values: any; ids: string[]; filters: string[] }> = [];
    const service: any = {
      from: () => ({
        select: () => {
          const chain: any = { not: () => chain, order: () => chain, range: async () => ({ data: customers, error: null }) };
          return chain;
        },
        update: (values: any) => {
          const u = { values, ids: [] as string[], filters: [] as string[] };
          updates.push(u);
          const chain: any = {
            in: (_c: string, ids: string[]) => { u.ids = ids; return chain; },
            eq: (c: string, v: unknown) => { u.filters.push(`${c}=${v}`); return chain; },
            or: (f: string) => { u.filters.push(f); return chain; },
            select: async () => ({ data: u.ids.map((id) => ({ id })), error: null }),
            then: (res: any) => res({ error: null }),
          };
          return chain;
        },
      }),
    };
    return { service, updates };
  }

  it('copies the flag and marks exempt with guards', async () => {
    suiteqlAll.mockResolvedValue([{ id: 101 }]);
    const { service, updates } = fakeService([row('101'), row('102', { netsuite_taxable: true })]);
    const at = new Date('2026-10-22T21:00:00Z');
    const res = await syncNetsuiteTaxExempt(service, at);
    expect(suiteqlAll).toHaveBeenCalledWith(NON_TAXABLE_QUERY);
    expect(res).toEqual({ nonTaxableInNetSuite: 1, taxableFlagsUpdated: 1, markedExempt: 1 });
    expect(updates[0]).toMatchObject({ values: { netsuite_taxable: false }, ids: ['101'] });
    expect(updates[1]).toMatchObject({
      values: { tax_exempt: true, tax_exempt_source: 'netsuite', tax_exempt_changed_at: at.toISOString() },
      ids: ['101'],
      filters: ['tax_exempt=false', 'tax_exempt_source.is.null,tax_exempt_source.neq.staff'],
    });
  });

  it('writes nothing when NetSuite cannot be read', async () => {
    suiteqlAll.mockRejectedValue(new Error('Unknown identifier taxable'));
    const { service, updates } = fakeService([row('101')]);
    await expect(syncNetsuiteTaxExempt(service)).rejects.toThrow('taxable');
    expect(updates).toEqual([]);
  });
});

describe('certWarning', () => {
  it('warns on an expired certificate', () => {
    expect(certWarning('2026-09-30', '2026-10-22')).toEqual({
      level: 'expired', text: 'Certificate expired 9/30/2026. Still tax exempt; get a new certificate on file.',
    });
  });
  it('warns 60 days ahead', () => {
    expect(certWarning('2026-12-01', '2026-10-22')?.level).toBe('soon');
    expect(certWarning('2026-10-23', '2026-10-22')?.text).toBe('Certificate expires 10/23/2026 (1 day).');
  });
  it('says nothing for a far expiry or none', () => {
    expect(certWarning('2027-06-01', '2026-10-22')).toBeNull();
    expect(certWarning(null, '2026-10-22')).toBeNull();
  });
});

describe('billedCertWarning', () => {
  it('warns when the certificate expired before the invoice day, and says they were still billed exempt', () => {
    expect(billedCertWarning('Sample Fleet Co', '2026-09-30', '2026-10-22')).toBe(
      "Sample Fleet Co's tax-exempt certificate expired 9/30/2026. Still billed tax exempt; get a new certificate on file.",
    );
    // A date read with its time still reads as the day.
    expect(billedCertWarning('Sample Fleet Co', '2026-06-30T00:00:00Z', '2026-10-22')).toMatch(/ expired 6\/30\/2026\. /);
    expect(billedCertWarning(null, '2026-09-30', '2026-10-22')).toMatch(/^This customer's tax-exempt certificate expired 9\/30\/2026\. /);
  });
  it('says nothing when it expires on the invoice day or later, or there is no date to go by', () => {
    expect(billedCertWarning('Sample Fleet Co', '2026-10-22', '2026-10-22')).toBeNull();
    expect(billedCertWarning('Sample Fleet Co', '2026-10-23', '2026-10-22')).toBeNull();
    expect(billedCertWarning('Sample Fleet Co', null, '2026-10-22')).toBeNull();
    expect(billedCertWarning('Sample Fleet Co', 'not a date', '2026-10-22')).toBeNull();
  });
});

describe('taxMismatch', () => {
  it('flags exempt here but taxed in NetSuite, and the reverse', () => {
    expect(taxMismatch({ tax_exempt: true, netsuite_taxable: true })).toBe('netsuite_taxes');
    expect(taxMismatch({ tax_exempt: false, netsuite_taxable: false })).toBe('netsuite_exempt');
    expect(taxMismatch({ tax_exempt: true, netsuite_taxable: false })).toBeNull();
    expect(taxMismatch({ tax_exempt: true, netsuite_taxable: null })).toBeNull();
  });
});

describe('staffTaxExemptPatch', () => {
  it('stamps staff as the source', () => {
    const at = new Date('2026-10-22T21:00:00Z');
    expect(staffTaxExemptPatch(true, at)).toEqual({ tax_exempt: true, tax_exempt_source: 'staff', tax_exempt_changed_at: at.toISOString() });
  });
});
