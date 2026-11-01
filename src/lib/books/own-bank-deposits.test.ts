import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ownBankDepositPayload, saveOwnBankDeposit, type MadeBankDeposit } from './own-bank-deposits';

// Books' own copy of a bank deposit FleetSuite made (Books part 56). Made-up data.

const MADE: MadeBankDeposit = {
  netsuiteId: '8301',
  netsuiteNumber: 'DEP-1207',
  company: 'BMG',
  bankAccountNetsuiteId: '211',
  date: '2026-10-30',
  memo: 'Slip 14',
  lines: [
    { netsuiteId: '9001', kind: 'payment', number: 'PYMT-9001', customerName: 'Rivera Plumbing', cents: 125000 },
    { netsuiteId: '9003', kind: 'deposit', number: 'DEP-77', customerName: 'Ozark Fleet Co', cents: 250005 },
  ],
  totalCents: 375005,
  madeFromId: 'e0000000-0000-4000-8000-000000000001',
  madeBy: 'd0000000-0000-4000-8000-000000000001',
};

function fakeService(rpc?: { data?: unknown; error?: { message: string } }, throws?: string) {
  const calls: unknown[][] = [];
  const service = {
    rpc: async (fn: string, args: unknown) => {
      calls.push([fn, args]);
      if (throws) throw new Error(throws);
      return { data: rpc && 'data' in rpc ? rpc.data : { saved: true }, error: rpc?.error ?? null };
    },
  };
  return { service: service as unknown as SupabaseClient, calls };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ownBankDepositPayload', () => {
  it('keeps the account, the day and each payment and deposit in it, its dollars to the cent', () => {
    expect(ownBankDepositPayload({ ...MADE, netsuiteId: '8301' })).toEqual({
      netsuite_id: '8301', netsuite_number: 'DEP-1207', company: 'BMG', made_from_id: MADE.madeFromId,
      bank_account_netsuite_id: '211', deposit_date: '2026-10-30', memo: 'Slip 14',
      lines: [
        { netsuite_id: '9001', kind: 'payment', number: 'PYMT-9001', customer_name: 'Rivera Plumbing', amount: '1250.00' },
        { netsuite_id: '9003', kind: 'deposit', number: 'DEP-77', customer_name: 'Ozark Fleet Co', amount: '2500.05' },
      ],
      amount: '3750.05', made_by: MADE.madeBy,
    });
    expect(ownBankDepositPayload({ ...MADE, netsuiteId: '8301', netsuiteNumber: undefined, memo: null, madeBy: null }))
      .toMatchObject({ netsuite_number: null, memo: null, made_by: null });
  });
});

describe('saveOwnBankDeposit', () => {
  it('saves the copy', async () => {
    const { service, calls } = fakeService();
    expect(await saveOwnBankDeposit(service, { ...MADE, netsuiteId: ' 8301 ' })).toEqual({ saved: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('gl_own_bank_deposit_save');
    expect((calls[0][1] as { p: Record<string, unknown> }).p).toMatchObject({ netsuite_id: '8301', amount: '3750.05', bank_account_netsuite_id: '211' });
  });

  it("says when it's already saved", async () => {
    for (const data of [{ saved: false }, null]) {
      const { service } = fakeService({ data });
      expect(await saveOwnBankDeposit(service, MADE)).toEqual({ saved: false, reason: 'already saved' });
    }
  });

  it('never throws: no NetSuite id, a refused save or a failed call is logged and left', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const netsuiteId of [null, undefined, '', 'DEP-1207']) {
      const none = fakeService();
      expect(await saveOwnBankDeposit(none.service, { ...MADE, netsuiteId }))
        .toEqual({ saved: false, reason: "NetSuite didn't say which bank deposit it made" });
      expect(none.calls).toEqual([]);
    }
    expect(log).not.toHaveBeenCalled();

    const refused = fakeService({ data: null, error: { message: "gl: company ACME doesn't exist" } });
    expect(await saveOwnBankDeposit(refused.service, MADE)).toEqual({ saved: false, reason: "gl: company ACME doesn't exist" });
    const thrown = fakeService(undefined, 'fetch failed');
    expect(await saveOwnBankDeposit(thrown.service, MADE)).toEqual({ saved: false, reason: 'fetch failed' });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toBe("[books] own copy of NetSuite bank deposit 8301 not saved: gl: company ACME doesn't exist");
    expect(log.mock.calls[1][0]).toBe('[books] own copy of NetSuite bank deposit 8301 not saved: fetch failed');

    const long = fakeService({ data: null, error: { message: 'x'.repeat(400) } });
    expect((await saveOwnBankDeposit(long.service, MADE)).reason).toHaveLength(300);
  });
});
