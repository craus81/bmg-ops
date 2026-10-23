import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ updateCustomer: vi.fn() }));

import { companyEmailChange, syncCompanyEmailToPrimary } from './company-email-sync';

describe('companyEmailChange', () => {
  it('returns the new email when it differs', () => {
    expect(companyEmailChange('old@acme.com', ' new@acme.com ')).toBe('new@acme.com');
  });
  it('ignores case and padding', () => {
    expect(companyEmailChange('Dana@Acme.com', 'dana@acme.com ')).toBeNull();
  });
  it('never blanks the company email', () => {
    expect(companyEmailChange('old@acme.com', '')).toBeNull();
    expect(companyEmailChange('old@acme.com', null)).toBeNull();
  });
  it('fills an empty company email', () => {
    expect(companyEmailChange(null, 'dana@acme.com')).toBe('dana@acme.com');
  });
});

/** customers + prospects stand-in that records updates. */
function fakeService(customer: any) {
  const updates: { table: string; values: any; eq: [string, any] }[] = [];
  return {
    updates,
    service: {
      from(table: string) {
        const state: any = { op: 'select' };
        const b: any = {
          select() { return b; },
          update(values: any) { state.op = 'update'; state.values = values; return b; },
          eq(col: string, val: any) { state.eq = [col, val]; return b; },
          maybeSingle() { return Promise.resolve({ data: customer, error: null }); },
          then(resolve: any) {
            if (state.op === 'update') updates.push({ table, values: state.values, eq: state.eq });
            return resolve({ data: null, error: null });
          },
        };
        return b;
      },
    } as any,
  };
}

describe('syncCompanyEmailToPrimary', () => {
  const customer = { id: 'c1', netsuite_id: '1234', email: 'gmoyers@hosematesmo.com' };

  it('pushes to NetSuite first, then updates both local copies', async () => {
    const { service, updates } = fakeService({ ...customer });
    const updateCustomer = vi.fn().mockResolvedValue({ success: true });
    const r = await syncCompanyEmailToPrimary(service, 'c1', 'plee@hosemate.com', { updateCustomer });
    expect(r).toEqual({ status: 'updated', email: 'plee@hosemate.com' });
    expect(updateCustomer).toHaveBeenCalledWith('1234', { email: 'plee@hosemate.com' });
    expect(updates).toEqual([
      { table: 'customers', values: { email: 'plee@hosemate.com' }, eq: ['id', 'c1'] },
      { table: 'prospects', values: { email: 'plee@hosemate.com' }, eq: ['netsuite_id', '1234'] },
    ]);
  });

  it('writes nothing locally when NetSuite refuses', async () => {
    const { service, updates } = fakeService({ ...customer });
    const updateCustomer = vi.fn().mockResolvedValue({ success: false, error: 'Permission violation' });
    const r = await syncCompanyEmailToPrimary(service, 'c1', 'plee@hosemate.com', { updateCustomer });
    expect(r).toEqual({ status: 'failed', error: 'Permission violation' });
    expect(updates).toEqual([]);
  });

  it('skips NetSuite when the email already matches', async () => {
    const { service } = fakeService({ ...customer });
    const updateCustomer = vi.fn();
    const r = await syncCompanyEmailToPrimary(service, 'c1', 'GMoyers@hosematesmo.com', { updateCustomer });
    expect(r).toEqual({ status: 'unchanged' });
    expect(updateCustomer).not.toHaveBeenCalled();
  });

  it('leaves the company email alone when the primary has no email', async () => {
    const { service } = fakeService({ ...customer });
    const updateCustomer = vi.fn();
    expect(await syncCompanyEmailToPrimary(service, 'c1', '  ', { updateCustomer })).toEqual({ status: 'no_email' });
    expect(updateCustomer).not.toHaveBeenCalled();
  });

  it('does nothing for a customer with no NetSuite id', async () => {
    const { service } = fakeService({ ...customer, netsuite_id: null });
    const updateCustomer = vi.fn();
    expect(await syncCompanyEmailToPrimary(service, 'c1', 'plee@hosemate.com', { updateCustomer })).toEqual({ status: 'not_linked' });
    expect(updateCustomer).not.toHaveBeenCalled();
  });
});
