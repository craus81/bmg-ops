import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NO_EARLIER, parseInvoiceRecord, workOutCreditMemo, type InvoiceView } from '@/lib/credit-memo';
import { ownCreditMemoPayload, saveOwnCreditMemo, type MadeCreditMemo } from './own-credit-memos';

// A made-up invoice: a taxed stock part and untaxed labor.
const INVOICE: InvoiceView = parseInvoiceRecord({
  id: '7001', tranId: 'INV9001', tranDate: '2026-10-20', entity: { id: '9001', refName: 'Acme Fleet Services' },
  location: { id: '2', refName: 'Wentzville' }, subtotal: 536, taxTotal: 21.3, total: 557.3, taxRate: 8.488,
  item: { items: [
    { line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, description: 'Shelf unit', isTaxable: true },
    { line: 2, item: { id: '56', refName: 'LABOR' }, itemType: 'Service', quantity: 3, rate: 95, amount: 285, isTaxable: false },
  ] },
});
const CREDIT_ITEM = { id: '900', itemNumber: 'CREDIT' };

const made = (lines: Parameters<typeof workOutCreditMemo>[1], over: Partial<MadeCreditMemo> = {}): MadeCreditMemo => ({
  netsuiteId: '8001',
  netsuiteNumber: 'CM1001',
  invoice: INVOICE,
  worked: workOutCreditMemo(INVOICE, lines, [], { earlier: NO_EARLIER, creditItem: CREDIT_ITEM, reason: 'Returned' }),
  reason: '  Returned  ',
  madeFromId: 'b0000000-0000-4000-8000-000000000001',
  madeBy: 'p0000000-0000-4000-8000-000000000001',
  ...over,
});

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
      return { data: opts.rpc && 'data' in opts.rpc ? opts.rpc.data : { saved: true, lines: 1 }, error: opts.rpc?.error ?? null };
    },
  };
  return { service: service as unknown as SupabaseClient, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('ownCreditMemoPayload', () => {
  it('keeps the credit memo as FleetSuite worked it out', () => {
    const m = made([{ line: 1, quantity: 1, price: 125.5 }, { line: 2, quantity: 1, price: 95 }]);
    expect(m.worked.problems).toEqual([]);
    expect(ownCreditMemoPayload({ ...m, netsuiteId: '8001' }, { customerId: 'c1', creditDate: '2026-10-31' })).toEqual({
      netsuite_id: '8001', netsuite_number: 'CM1001', company: 'BMG', invoice_netsuite_id: '7001', invoice_number: 'INV9001',
      made_from_id: 'b0000000-0000-4000-8000-000000000001', customer_netsuite_id: '9001', customer_id: 'c1',
      credit_date: '2026-10-31', location_netsuite_id: '2', reason: 'Returned', tax_rule: 'credit_tax@1',
      tax_rate: '0.084880', tax_rate_from: 'invoice', subtotal: '220.50', tax: '10.65', total: '231.15',
      made_by: 'p0000000-0000-4000-8000-000000000001',
      lines: [
        {
          line_no: 1, invoice_line: 1, item_netsuite_id: '55', item_number: 'SHELF-1', description: 'Shelf unit', quantity: 1,
          rate: 125.5, amount: '125.50', taxable: true, tax: '10.65', back_to_stock: true, on_credit_item: false,
        },
        {
          line_no: 2, invoice_line: 2, item_netsuite_id: '56', item_number: 'LABOR', description: null, quantity: 1,
          rate: 95, amount: '95.00', taxable: false, tax: '0.00', back_to_stock: false, on_credit_item: false,
        },
      ],
    });
  });

  it('keeps no rate when nothing it credits was taxed', () => {
    const m = made([{ line: 2, quantity: 1, price: 95 }]);
    expect(ownCreditMemoPayload({ ...m, netsuiteId: '8001' }, { customerId: null, creditDate: '2026-10-31' }))
      .toMatchObject({ tax_rate: '0.000000', tax_rate_from: 'untaxed', tax: '0.00', total: '95.00' });
  });
});

describe('saveOwnCreditMemo', () => {
  it("saves the copy with the customer's FleetSuite id and today's date in Central time", async () => {
    const { service, calls } = fakeService({ customers: [{ id: 'c1' }] });
    const res = await saveOwnCreditMemo(service, made([{ line: 1, quantity: 1, price: 125.5 }]), new Date('2026-11-01T03:30:00Z'));
    expect(res).toEqual({ saved: true });
    expect(calls[0]).toEqual(['select', 'customers', 'netsuite_id', '9001']);
    expect(calls[1][0]).toBe('rpc');
    expect(calls[1][1]).toBe('gl_own_credit_memo_save');
    expect((calls[1][2] as { p: Record<string, unknown> }).p).toMatchObject({ customer_id: 'c1', credit_date: '2026-10-31', netsuite_id: '8001' });
  });

  it('leaves the customer out when FleetSuite has two with that NetSuite id', async () => {
    const { service, calls } = fakeService({ customers: [{ id: 'c1' }, { id: 'c2' }] });
    await saveOwnCreditMemo(service, made([{ line: 1, quantity: 1, price: 125.5 }]));
    expect((calls[1][2] as { p: Record<string, unknown> }).p.customer_id).toBeNull();
  });

  it("says when it's already saved", async () => {
    const { service } = fakeService({ rpc: { data: { saved: false, lines: 0 } } });
    expect(await saveOwnCreditMemo(service, made([{ line: 1, quantity: 1, price: 125.5 }]))).toEqual({ saved: false, reason: 'already saved' });
  });

  it("never throws: no NetSuite id, a failed read or a refused save is logged and left", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const none = fakeService();
    expect(await saveOwnCreditMemo(none.service, made([{ line: 1, quantity: 1, price: 125.5 }], { netsuiteId: null })))
      .toEqual({ saved: false, reason: "NetSuite didn't say which credit memo it made" });
    expect(none.calls).toEqual([]);

    const read = fakeService({ customersError: 'timeout' });
    expect(await saveOwnCreditMemo(read.service, made([{ line: 1, quantity: 1, price: 125.5 }]))).toEqual({ saved: false, reason: 'timeout' });

    const refused = fakeService({ rpc: { data: null, error: { message: "gl: own credit memo 8001's lines don't add up to its subtotal and tax" } } });
    expect(await saveOwnCreditMemo(refused.service, made([{ line: 1, quantity: 1, price: 125.5 }])))
      .toEqual({ saved: false, reason: "gl: own credit memo 8001's lines don't add up to its subtotal and tax" });
    expect(log).toHaveBeenCalledTimes(2);
  });
});
