import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ownPaymentPayload, saveOwnPayment, type MadePayment } from './own-payments';

// Books' own copy of a customer payment FleetSuite made (Books part 54). Made-up data.

const MADE: MadePayment = {
  netsuiteId: '7101',
  netsuiteNumber: 'PYMT-301',
  company: 'BMG',
  customerNetsuiteId: '501',
  date: '2026-10-30',
  method: 'check',
  reference: '10442',
  memo: 'Check 10442 · September',
  amountCents: 65010,
  applied: [{ invoiceId: '8990', number: 'INV1990', cents: 40010 }, { invoiceId: '9001', number: '', cents: 25000 }],
  madeFromId: 'b0000000-0000-4000-8000-000000000001',
  madeBy: 'd0000000-0000-4000-8000-000000000001',
};

function fakeService(opts: { customers?: Array<{ id: string }>; customersError?: string; rpc?: { data?: unknown; error?: { message: string } } } = {}) {
  const calls: unknown[][] = [];
  const service = {
    from: (table: string) => ({
      select: () => ({
        eq: async (column: string, value: string) => {
          calls.push(['select', table, column, value]);
          return opts.customersError ? { data: null, error: { message: opts.customersError } } : { data: opts.customers ?? [], error: null };
        },
      }),
    }),
    rpc: async (fn: string, args: unknown) => {
      calls.push(['rpc', fn, args]);
      return { data: opts.rpc && 'data' in opts.rpc ? opts.rpc.data : { saved: true, lines: 2 }, error: opts.rpc?.error ?? null };
    },
  };
  return { service: service as unknown as SupabaseClient, calls };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ownPaymentPayload', () => {
  it('keeps the payment in Undeposited Funds, its dollars to the cent, each invoice it pays in order', () => {
    expect(ownPaymentPayload({ ...MADE, netsuiteId: '7101' }, { customerId: 'c1' })).toEqual({
      netsuite_id: '7101', netsuite_number: 'PYMT-301', company: 'BMG', made_from_id: MADE.madeFromId, customer_netsuite_id: '501',
      customer_id: 'c1', payment_date: '2026-10-30', method: 'check', reference: '10442', memo: 'Check 10442 · September',
      deposited_to: 'undeposited_funds', amount: '650.10', made_by: MADE.madeBy,
      applications: [
        { line_no: 1, invoice_netsuite_id: '8990', invoice_number: 'INV1990', amount: '400.10' },
        { line_no: 2, invoice_netsuite_id: '9001', invoice_number: null, amount: '250.00' },
      ],
    });
    expect(ownPaymentPayload({ ...MADE, netsuiteId: '7101', netsuiteNumber: undefined }, { customerId: null }))
      .toMatchObject({ netsuite_number: null, customer_id: null });
  });
});

describe('saveOwnPayment', () => {
  it("saves the copy with the customer's FleetSuite id", async () => {
    const { service, calls } = fakeService({ customers: [{ id: 'c1' }] });
    expect(await saveOwnPayment(service, { ...MADE, netsuiteId: ' 7101 ' })).toEqual({ saved: true });
    expect(calls[0]).toEqual(['select', 'customers', 'netsuite_id', '501']);
    expect(calls[1][0]).toBe('rpc');
    expect(calls[1][1]).toBe('gl_own_payment_save');
    expect((calls[1][2] as { p: Record<string, unknown> }).p).toMatchObject({ netsuite_id: '7101', customer_id: 'c1', amount: '650.10' });
  });

  it('leaves the customer out when FleetSuite has none, or two, with that NetSuite id', async () => {
    for (const customers of [[], [{ id: 'c1' }, { id: 'c2' }]]) {
      const { service, calls } = fakeService({ customers });
      await saveOwnPayment(service, MADE);
      expect((calls[1][2] as { p: Record<string, unknown> }).p.customer_id).toBeNull();
    }
  });

  it("says when it's already saved", async () => {
    const { service } = fakeService({ rpc: { data: { saved: false, lines: 0 } } });
    expect(await saveOwnPayment(service, MADE)).toEqual({ saved: false, reason: 'already saved' });
  });

  it('never throws: no NetSuite id, a failed read or a refused save is logged and left', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const netsuiteId of [null, undefined, '', 'PYMT-301']) {
      const none = fakeService();
      expect(await saveOwnPayment(none.service, { ...MADE, netsuiteId })).toEqual({ saved: false, reason: "NetSuite didn't say which payment it made" });
      expect(none.calls).toEqual([]);
    }
    const read = fakeService({ customersError: 'timeout' });
    expect(await saveOwnPayment(read.service, MADE)).toEqual({ saved: false, reason: 'timeout' });
    expect(read.calls).toHaveLength(1);

    const refused = fakeService({ rpc: { data: null, error: { message: "gl: what own payment 7101 applies doesn't add up to its amount" } } });
    expect(await saveOwnPayment(refused.service, MADE))
      .toEqual({ saved: false, reason: "gl: what own payment 7101 applies doesn't add up to its amount" });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toBe("[books] own copy of NetSuite payment 7101 not saved: gl: what own payment 7101 applies doesn't add up to its amount");
  });
});
