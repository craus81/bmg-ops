import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ownDepositPayload, saveOwnDeposit, type MadeDeposit } from './own-deposits';

// Books' own copy of a customer deposit FleetSuite made (Books part 55). Made-up data.

const MADE: MadeDeposit = {
  netsuiteId: '7301',
  netsuiteNumber: 'DEP-41',
  company: 'BMG',
  customerNetsuiteId: '501',
  salesOrderNetsuiteId: '4521',
  salesOrderNumber: 'SO1450',
  date: '2026-10-30',
  method: 'check',
  reference: '10442',
  memo: 'Check 10442 · half down',
  amountCents: 250050,
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
      return { data: opts.rpc && 'data' in opts.rpc ? opts.rpc.data : { saved: true }, error: opts.rpc?.error ?? null };
    },
  };
  return { service: service as unknown as SupabaseClient, calls };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ownDepositPayload', () => {
  it('keeps the deposit in Undeposited Funds, on its order, its dollars to the cent', () => {
    expect(ownDepositPayload({ ...MADE, netsuiteId: '7301' }, { customerId: 'c1' })).toEqual({
      netsuite_id: '7301', netsuite_number: 'DEP-41', company: 'BMG', made_from_id: MADE.madeFromId, customer_netsuite_id: '501',
      customer_id: 'c1', sales_order_netsuite_id: '4521', sales_order_number: 'SO1450', deposit_date: '2026-10-30', method: 'check',
      reference: '10442', memo: 'Check 10442 · half down', deposited_to: 'undeposited_funds', amount: '2500.50', made_by: MADE.madeBy,
    });
    expect(ownDepositPayload({ ...MADE, netsuiteId: '7301', netsuiteNumber: undefined, salesOrderNumber: '' }, { customerId: null }))
      .toMatchObject({ netsuite_number: null, sales_order_number: null, customer_id: null });
  });
});

describe('saveOwnDeposit', () => {
  it("saves the copy with the customer's FleetSuite id", async () => {
    const { service, calls } = fakeService({ customers: [{ id: 'c1' }] });
    expect(await saveOwnDeposit(service, { ...MADE, netsuiteId: ' 7301 ' })).toEqual({ saved: true });
    expect(calls[0]).toEqual(['select', 'customers', 'netsuite_id', '501']);
    expect(calls[1][0]).toBe('rpc');
    expect(calls[1][1]).toBe('gl_own_deposit_save');
    expect((calls[1][2] as { p: Record<string, unknown> }).p).toMatchObject({
      netsuite_id: '7301', customer_id: 'c1', sales_order_netsuite_id: '4521', amount: '2500.50',
    });
  });

  it('leaves the customer out when FleetSuite has none, or two, with that NetSuite id', async () => {
    for (const customers of [[], [{ id: 'c1' }, { id: 'c2' }]]) {
      const { service, calls } = fakeService({ customers });
      await saveOwnDeposit(service, MADE);
      expect((calls[1][2] as { p: Record<string, unknown> }).p.customer_id).toBeNull();
    }
  });

  it("says when it's already saved", async () => {
    for (const data of [{ saved: false }, null]) {
      const { service } = fakeService({ rpc: { data } });
      expect(await saveOwnDeposit(service, MADE)).toEqual({ saved: false, reason: 'already saved' });
    }
  });

  it('never throws: no NetSuite id, a failed read or a refused save is logged and left', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const netsuiteId of [null, undefined, '', 'DEP-41']) {
      const none = fakeService();
      expect(await saveOwnDeposit(none.service, { ...MADE, netsuiteId })).toEqual({ saved: false, reason: "NetSuite didn't say which deposit it made" });
      expect(none.calls).toEqual([]);
    }
    const read = fakeService({ customersError: 'timeout' });
    expect(await saveOwnDeposit(read.service, MADE)).toEqual({ saved: false, reason: 'timeout' });
    expect(read.calls).toHaveLength(1);

    const refused = fakeService({ rpc: { data: null, error: { message: "gl: company ACME doesn't exist" } } });
    expect(await saveOwnDeposit(refused.service, MADE)).toEqual({ saved: false, reason: "gl: company ACME doesn't exist" });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toBe('[books] own copy of NetSuite deposit 7301 not saved: timeout');
    expect(log.mock.calls[1][0]).toBe("[books] own copy of NetSuite deposit 7301 not saved: gl: company ACME doesn't exist");

    const long = fakeService({ rpc: { data: null, error: { message: 'x'.repeat(400) } } });
    expect((await saveOwnDeposit(long.service, MADE)).reason).toHaveLength(300);
  });
});
