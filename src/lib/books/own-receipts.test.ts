import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { receiptPayload, saveOwnReceipt, workOutOwnReceipt, type MadeReceipt } from './own-receipts';

const ROW_1 = '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f60';
const ROW_2 = '1c7b2d4f-6a3e-4d9c-8b8f-2e3d4c5b6a71';

const made = (over: Partial<MadeReceipt> = {}): MadeReceipt => ({
  rows: [
    { id: ROW_1, lineId: '2', itemId: '9001', itemNumber: 'RACK-48', description: 'Ladder rack', quantity: 12, rate: '178.3333' },
    { id: ROW_2, lineId: '3', itemId: '9002', itemNumber: 'BIN-10', description: null, quantity: 4, rate: 19.99 },
  ],
  netsuiteId: '7101',
  netsuiteNumber: 'IR-2288',
  netsuiteError: null,
  po: { netsuiteId: 5001, number: 'PO453-ACME', vendorId: '412', vendorName: 'Acme Truck Racks' },
  receiveDate: '2026-10-21',
  madeBy: 'u-1',
  ...over,
});

describe("working out Books' own receipt", () => {
  it("keys it by the Receive's first row, a line for each row received, at the PO's prices", () => {
    const own = workOutOwnReceipt(made())!;
    expect(own).toMatchObject({
      receiptKey: ROW_1, netsuiteId: '7101', netsuiteNumber: 'IR-2288', poId: '5001', poNumber: 'PO453-ACME', vendorId: '412',
      vendorName: 'Acme Truck Racks', receiveDate: '2026-10-21', netsuiteError: null, unknowns: [], madeBy: 'u-1',
    });
    expect(own.lines.map((l) => [l.lineNo, l.itemId, l.quantity, l.rate, l.poLineId, l.poReceiptId])).toEqual([
      [1, '9001', 12, 178.3333, '2', ROW_1],
      [2, '9002', 4, 19.99, '3', ROW_2],
    ]);
  });

  it("leaves out a row of nothing, and has no copy without a row to key it by", () => {
    const own = workOutOwnReceipt(made({ rows: [{ ...made().rows[0], quantity: 0 }, made().rows[1]] }))!;
    expect(own.receiptKey).toBe(ROW_2);
    expect(own.lines.map((l) => l.lineNo)).toEqual([1]);
    expect(workOutOwnReceipt(made({ rows: [] }))).toBeNull();
    expect(workOutOwnReceipt(made({ rows: [{ ...made().rows[0], id: null }] }))).toBeNull();
    expect(workOutOwnReceipt(made({ rows: [{ ...made().rows[0], id: 'row-1' }] }))).toBeNull();
  });

  it("keeps what NetSuite said only when it didn't take it, and says when a line has no price", () => {
    expect(workOutOwnReceipt(made({ netsuiteError: 'Invalid line' }))!.netsuiteError).toBeNull();
    const refused = workOutOwnReceipt(made({ netsuiteId: null, netsuiteNumber: null, netsuiteError: `  ${'x'.repeat(600)}` }))!;
    expect(refused).toMatchObject({ netsuiteId: null, netsuiteNumber: null });
    expect(refused.netsuiteError).toHaveLength(500);
    expect(workOutOwnReceipt(made({ rows: [{ ...made().rows[0], rate: null }] }))!.unknowns).toEqual(['prices']);
    expect(workOutOwnReceipt(made({ rows: [{ ...made().rows[0], rate: '' }] }))!.lines[0].rate).toBeNull();
  });

  it("keeps only numbers for NetSuite's ids", () => {
    const own = workOutOwnReceipt(made({ netsuiteId: 'IR-2288', po: { netsuiteId: 'PO453', number: null, vendorId: null, vendorName: null } }))!;
    expect(own).toMatchObject({ netsuiteId: null, poId: null, poNumber: null, vendorId: null });
    expect(workOutOwnReceipt(made({ rows: [{ ...made().rows[0], itemId: 'RACK-48' }] }))!.lines[0].itemId).toBeNull();
  });

  it('writes the copy as the database takes it', () => {
    expect(receiptPayload(workOutOwnReceipt(made({ rows: [made().rows[0]] }))!)).toEqual({
      receipt_key: ROW_1, netsuite_id: '7101', netsuite_number: 'IR-2288', po_netsuite_id: '5001', po_number: 'PO453-ACME',
      vendor_netsuite_id: '412', vendor_name: 'Acme Truck Racks', receive_date: '2026-10-21', netsuite_error: null, unknowns: [],
      made_by: 'u-1',
      lines: [{
        line_no: 1, item_netsuite_id: '9001', item_number: 'RACK-48', description: 'Ladder rack', quantity: 12, rate: 178.3333,
        po_line_id: '2', po_receipt_id: ROW_1,
      }],
    });
  });
});

describe('saving the copy', () => {
  const fake = (result: { data?: unknown; error?: { message: string } } = { data: { saved: true, lines: 2 } }) => {
    const rpc = vi.fn(async (_fn: string, _args: unknown) => result);
    return { service: { rpc } as unknown as SupabaseClient, rpc };
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it('saves it, and says so when it was already saved', async () => {
    const { service, rpc } = fake();
    expect(await saveOwnReceipt(service, made())).toEqual({ saved: true });
    expect(rpc).toHaveBeenCalledWith('gl_own_receipt_save', { p: expect.objectContaining({ receipt_key: ROW_1, netsuite_id: '7101' }) });
    expect(await saveOwnReceipt(fake({ data: { saved: false, lines: 0 } }).service, made())).toEqual({ saved: false, reason: 'already saved' });
  });

  it('never throws: a Receive with no row, a refused save or a failed call is only logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const none = fake();
    expect(await saveOwnReceipt(none.service, made({ rows: [] }))).toEqual({ saved: false, reason: 'No receipt row to keep it by' });
    expect(none.rpc).not.toHaveBeenCalled();

    expect(await saveOwnReceipt(fake({ error: { message: 'value too long' } }).service, made()))
      .toEqual({ saved: false, reason: 'value too long' });
    expect(error).toHaveBeenCalledWith('[books] own copy of the receipt on PO453-ACME not saved: value too long');

    const thrown = fake();
    thrown.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    expect(await saveOwnReceipt(thrown.service, made({ po: { netsuiteId: null, number: null, vendorId: null, vendorName: null } })))
      .toEqual({ saved: false, reason: 'fetch failed' });
    expect(error).toHaveBeenLastCalledWith('[books] own copy of the receipt on a PO not saved: fetch failed');
  });
});
