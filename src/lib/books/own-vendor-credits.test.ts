import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { workOutVendorCredit, type VendorCreditDraft, type VendorCreditFacts } from '@/lib/vendor-credit';
import { ownVendorCreditPayload, saveOwnVendorCredit, type MadeVendorCredit } from './own-vendor-credits';

// A made-up vendor credit: a shelf unit going back and a restocking fee back to an account, part of it against a bill.
const FACTS: VendorCreditFacts = {
  today: '2026-10-31',
  companies: [{ code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }] }],
  accounts: new Map([['610', { id: '610', number: '5100', name: 'Shop supplies', companies: ['BMG'] }]]),
  parts: new Map([['55', { id: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', stock: true, cost: 125.5, onHand: 4 }]]),
  vendor: { id: '4001', name: 'Acme Racks' },
  openBills: [{ id: '3002', number: 'B-101', date: '2026-08-15', dueDate: null, openCents: 5000 }],
};
const DRAFT: VendorCreditDraft = {
  company: 'BMG', vendorId: '4001', number: ' VC-77 ', date: '2026-10-30', locationId: '1', reason: '  Returned shelf ',
  lines: [
    { kind: 'part', itemId: '55', quantity: 1, rate: 125.5 },
    { kind: 'account', accountId: '610', amount: 20, memo: 'Restock fee back' },
    { kind: 'account', accountId: '610', amount: 1.5 },
  ],
  applied: [{ billId: '3002', amount: 50 }],
};

const made = (over: Partial<MadeVendorCredit> = {}): MadeVendorCredit => ({
  netsuiteId: '6002',
  draft: DRAFT,
  worked: workOutVendorCredit(DRAFT, FACTS),
  vendorName: 'Acme Racks',
  madeFromId: 'b0000000-0000-4000-8000-000000000001',
  madeBy: 'p0000000-0000-4000-8000-000000000001',
  ...over,
});

function fakeService(rpc: { data?: unknown; error?: { message: string }; throws?: boolean } = {}) {
  const calls: unknown[][] = [];
  const service = {
    rpc: async (fn: string, args: unknown) => {
      calls.push([fn, args]);
      if (rpc.throws) throw new Error('fetch failed');
      return { data: 'data' in rpc ? rpc.data : { saved: true, lines: 3 }, error: rpc.error ?? null };
    },
  };
  return { service: service as unknown as SupabaseClient, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('ownVendorCreditPayload', () => {
  it('keeps the vendor credit as FleetSuite worked it out', () => {
    const m = made();
    expect(m.worked.problems).toEqual([]);
    expect(ownVendorCreditPayload({ ...m, netsuiteId: '6002' })).toEqual({
      netsuite_id: '6002', company: 'BMG', made_from_id: 'b0000000-0000-4000-8000-000000000001', vendor_netsuite_id: '4001',
      vendor_name: 'Acme Racks', credit_number: 'VC-77', credit_date: '2026-10-30', location_netsuite_id: '1', reason: 'Returned shelf',
      rule: 'vendor_credit@1', total: '147.00', applied: '50.00',
      applied_to: [{ bill_netsuite_id: '3002', bill_number: 'B-101', amount: '50.00' }],
      made_by: 'p0000000-0000-4000-8000-000000000001',
      lines: [
        { line_no: 1, kind: 'part', account_netsuite_id: null, item_netsuite_id: '55', item_number: 'SHELF-1', description: 'Shelf unit', quantity: 1, rate: 125.5, amount: '125.50' },
        { line_no: 2, kind: 'account', account_netsuite_id: '610', item_netsuite_id: null, item_number: null, description: 'Restock fee back', quantity: null, rate: null, amount: '20.00' },
        { line_no: 3, kind: 'account', account_netsuite_id: '610', item_netsuite_id: null, item_number: null, description: null, quantity: null, rate: null, amount: '1.50' },
      ],
    });
  });

  it("names the draft's company when the rules found none", () => {
    const m = made();
    expect(ownVendorCreditPayload({ ...m, netsuiteId: '6002', worked: { ...m.worked, company: null } }).company).toBe('BMG');
  });
});

describe('saveOwnVendorCredit', () => {
  it('saves the copy through gl_own_vendor_credit_save', async () => {
    const { service, calls } = fakeService();
    expect(await saveOwnVendorCredit(service, made({ netsuiteId: ' 6002 ' }))).toEqual({ saved: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('gl_own_vendor_credit_save');
    expect((calls[0][1] as { p: Record<string, unknown> }).p).toMatchObject({ netsuite_id: '6002', total: '147.00', credit_number: 'VC-77' });
  });

  it("says when it's already saved", async () => {
    const { service } = fakeService({ data: { saved: false, lines: 0 } });
    expect(await saveOwnVendorCredit(service, made())).toEqual({ saved: false, reason: 'already saved' });
    expect(await saveOwnVendorCredit(fakeService({ data: null }).service, made())).toEqual({ saved: false, reason: 'already saved' });
  });

  it('never throws: no NetSuite id, a refused save or a failed call is logged and left', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const netsuiteId of [null, undefined, '', 'VC6002']) {
      const none = fakeService();
      expect(await saveOwnVendorCredit(none.service, made({ netsuiteId }))).toEqual({ saved: false, reason: "NetSuite didn't say which vendor credit it made" });
      expect(none.calls).toEqual([]);
    }
    const refused = fakeService({ data: null, error: { message: "gl: own vendor credit 6002's lines don't add up to its total" } });
    expect(await saveOwnVendorCredit(refused.service, made())).toEqual({ saved: false, reason: "gl: own vendor credit 6002's lines don't add up to its total" });
    const failed = fakeService({ throws: true });
    expect(await saveOwnVendorCredit(failed.service, made())).toEqual({ saved: false, reason: 'fetch failed' });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toBe("[books] own copy of NetSuite vendor credit 6002 not saved: gl: own vendor credit 6002's lines don't add up to its total");
  });
});
