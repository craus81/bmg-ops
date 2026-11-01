import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ownBillPaymentPayload, saveOwnBillPayment, type MadeBillPayment } from './own-bill-payments';

// Books' own copy of a bill payment FleetSuite made from a payment run (Books part 57). Made-up data.

const MADE: MadeBillPayment = {
  netsuiteId: '8302',
  netsuiteNumber: 'CHK-5521',
  company: 'BMG',
  vendorNetsuiteId: '31',
  vendorName: 'Ozark Hose & Fitting',
  bankAccountNetsuiteId: '211',
  date: '2026-11-06',
  method: 'check',
  memo: 'November run',
  bills: [
    { netsuiteId: '7001', number: 'B-4410', cents: 81240 },
    { netsuiteId: '7002', number: 'B-4471', cents: 60005 },
  ],
  totalCents: 141245,
  madeFromRun: 'e0000000-0000-4000-8000-000000000001',
  madeFromPayment: 'f0000000-0000-4000-8000-000000000001',
  askedBy: 'd0000000-0000-4000-8000-000000000001',
  approvedBy: 'd0000000-0000-4000-8000-000000000002',
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

describe('ownBillPaymentPayload', () => {
  it('keeps the vendor, the bank account, the day, check or ACH and each bill it paid, its dollars to the cent', () => {
    expect(ownBillPaymentPayload({ ...MADE, netsuiteId: '8302' })).toEqual({
      netsuite_id: '8302', netsuite_number: 'CHK-5521', company: 'BMG', made_from_run: MADE.madeFromRun, made_from_payment: MADE.madeFromPayment,
      vendor_netsuite_id: '31', vendor_name: 'Ozark Hose & Fitting', bank_account_netsuite_id: '211', payment_date: '2026-11-06',
      method: 'check', memo: 'November run',
      bills: [
        { netsuite_id: '7001', number: 'B-4410', amount: '812.40' },
        { netsuite_id: '7002', number: 'B-4471', amount: '600.05' },
      ],
      amount: '1412.45', asked_by: MADE.askedBy, approved_by: MADE.approvedBy,
    });
    expect(ownBillPaymentPayload({
      ...MADE, netsuiteId: '8302', netsuiteNumber: undefined, vendorName: null, method: 'ach', memo: null, askedBy: null, approvedBy: null,
    })).toMatchObject({ netsuite_number: null, vendor_name: null, method: 'ach', memo: null, asked_by: null, approved_by: null });
  });
});

describe('saveOwnBillPayment', () => {
  it('saves the copy', async () => {
    const { service, calls } = fakeService();
    expect(await saveOwnBillPayment(service, { ...MADE, netsuiteId: ' 8302 ' })).toEqual({ saved: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('gl_own_bill_payment_save');
    expect((calls[0][1] as { p: Record<string, unknown> }).p).toMatchObject({ netsuite_id: '8302', amount: '1412.45', vendor_netsuite_id: '31' });
  });

  it("says when it's already saved", async () => {
    for (const data of [{ saved: false }, null]) {
      const { service } = fakeService({ data });
      expect(await saveOwnBillPayment(service, MADE)).toEqual({ saved: false, reason: 'already saved' });
    }
  });

  it('never throws: no NetSuite id, a refused save or a failed call is logged and left', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const netsuiteId of [null, undefined, '', 'CHK-5521']) {
      const none = fakeService();
      expect(await saveOwnBillPayment(none.service, { ...MADE, netsuiteId }))
        .toEqual({ saved: false, reason: "NetSuite didn't say which bill payment it made" });
      expect(none.calls).toEqual([]);
    }
    expect(log).not.toHaveBeenCalled();

    const refused = fakeService({ data: null, error: { message: "gl: company ACME doesn't exist" } });
    expect(await saveOwnBillPayment(refused.service, MADE)).toEqual({ saved: false, reason: "gl: company ACME doesn't exist" });
    const thrown = fakeService(undefined, 'fetch failed');
    expect(await saveOwnBillPayment(thrown.service, MADE)).toEqual({ saved: false, reason: 'fetch failed' });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toBe("[books] own copy of NetSuite bill payment 8302 not saved: gl: company ACME doesn't exist");
    expect(log.mock.calls[1][0]).toBe('[books] own copy of NetSuite bill payment 8302 not saved: fetch failed');

    const long = fakeService({ data: null, error: { message: 'x'.repeat(400) } });
    expect((await saveOwnBillPayment(long.service, MADE)).reason).toHaveLength(300);
  });
});
