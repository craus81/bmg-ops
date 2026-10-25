import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  billPayload,
  poBillLines,
  readPoCopyLines,
  saveOwnBill,
  toCents,
  workOutOwnBill,
  type MadeBill,
  type PoCopyLine,
} from './own-bills';

const line = (over: Partial<PoCopyLine> = {}): PoCopyLine => ({
  line_id: '1', item_netsuite_id: '9001', item_number: 'RACK-48', description: 'Ladder rack', quantity: '12', quantity_billed: '0',
  rate: '178.3333', amount: '2140.00', ...over,
});

describe('toCents', () => {
  it('rounds half away from zero, past the float error in the product', () => {
    expect(toCents(1.005)).toBe(101);
    expect(toCents(3 * 19.99)).toBe(5997);
    expect(toCents(0.125)).toBe(13);
    expect(toCents(-2.505)).toBe(-251);
    expect(toCents(-0.001)).toBe(0);
    expect(Object.is(toCents(-0.001), 0)).toBe(true);
  });
});

describe("a Parts Mail bill's lines", () => {
  it("bills what's still open on each line at the PO's price, to the cent, in the PO's order", () => {
    const { lines, priced } = poBillLines([
      line({ line_id: '10', item_netsuite_id: '9002', item_number: 'BIN-10', quantity: '4', quantity_billed: '1', rate: '19.99', amount: '79.96' }),
      line({ line_id: '2' }),
      // Billed already, or nothing on it.
      line({ line_id: '3', quantity: '2', quantity_billed: '2' }),
      line({ line_id: '4', quantity: '0', quantity_billed: '0' }),
    ]);
    expect(priced).toBe(true);
    expect(lines.map((l) => [l.lineNo, l.poLineId, l.itemId, l.quantity, l.rate, l.cents])).toEqual([
      [1, '2', '9001', 12, 178.3333, 214000],
      [2, '10', '9002', 3, 19.99, 5997],
    ]);
    expect(lines[0]).toMatchObject({ accountId: null, itemNumber: 'RACK-48', description: 'Ladder rack' });
  });

  it("takes the price from the line's amount when the copy has none, and says when it has neither", () => {
    expect(poBillLines([line({ rate: null, amount: '90.00', quantity: '3' })]).lines[0]).toMatchObject({ rate: 30, cents: 9000 });
    const { lines, priced } = poBillLines([line({ rate: null, amount: null })]);
    expect(priced).toBe(false);
    expect(lines[0]).toMatchObject({ rate: null, cents: null, quantity: 12 });
  });
});

const AT = new Date('2026-10-25T03:00:00Z'); // 10 PM Central on the 24th
const made = (over: Partial<MadeBill> = {}): MadeBill & { netsuiteId: string } => ({
  netsuiteId: '8801',
  netsuiteNumber: 'VI-1042',
  madeFrom: 'vendor_invoice',
  madeFromId: 'inv-1',
  madeBy: 'u-1',
  vendorId: 412,
  vendorName: ' Northside Install Co. ',
  referenceNo: 'VI-1042',
  subsidiaryId: '2',
  locationId: 1,
  expense: { accountId: '611', amount: 1250, memo: 'Install for job 1042' },
  ...over,
} as MadeBill & { netsuiteId: string });

describe("working out Books' own bill", () => {
  it("is one expense line for a CNI vendor invoice or payout, dated the day in Central time", () => {
    const own = workOutOwnBill(made(), null, AT);
    expect(own).toMatchObject({
      netsuiteId: '8801', netsuiteNumber: 'VI-1042', madeFrom: 'vendor_invoice', vendorId: '412', vendorName: 'Northside Install Co.',
      subsidiaryId: '2', locationId: '1', billDate: '2026-10-24', unknowns: [], invoiceCents: null, poId: null,
    });
    expect(own.lines).toEqual([{
      lineNo: 1, accountId: '611', itemId: null, itemNumber: null, description: 'Install for job 1042', quantity: null, rate: null,
      cents: 125000, poLineId: null,
    }]);
  });

  it("is the PO's open lines for a Parts Mail bill, and says what it didn't know", () => {
    const partsMail = made({ madeFrom: 'parts_mail', expense: null, po: { copyId: 'po-1', netsuiteId: '5001', number: 'PO453-ACME' }, invoiceTotal: '2140.5' });
    const own = workOutOwnBill(partsMail, [line()], AT);
    expect(own).toMatchObject({ poId: '5001', poNumber: 'PO453-ACME', invoiceCents: 214050, unknowns: [] });
    expect(own.lines.map((l) => l.cents)).toEqual([214000]);
    expect(workOutOwnBill(partsMail, null, AT)).toMatchObject({ lines: [], unknowns: ['lines'] });
    expect(workOutOwnBill(partsMail, [line({ rate: null, amount: null })], AT).unknowns).toEqual(['prices']);
  });

  it("keeps only numbers for NetSuite's ids", () => {
    const own = workOutOwnBill(made({ vendorId: 'V-412', subsidiaryId: ' ', locationId: null }), null, AT);
    expect(own).toMatchObject({ vendorId: null, subsidiaryId: null, locationId: null });
  });

  it('writes the copy as the database takes it', () => {
    expect(billPayload(workOutOwnBill(made({ invoiceTotal: 1250 }), null, AT))).toEqual({
      netsuite_id: '8801', netsuite_number: 'VI-1042', subsidiary_id: '2', made_from: 'vendor_invoice', made_from_id: 'inv-1',
      vendor_netsuite_id: '412', vendor_name: 'Northside Install Co.', reference_no: 'VI-1042', bill_date: '2026-10-24',
      po_netsuite_id: null, po_number: null, location_netsuite_id: '1', invoice_total: '1250.00', unknowns: [], made_by: 'u-1',
      lines: [{
        line_no: 1, account_netsuite_id: '611', item_netsuite_id: null, item_number: null, description: 'Install for job 1042',
        quantity: null, rate: null, amount: '1250.00', po_line_id: null,
      }],
    });
    const unpriced = workOutOwnBill(made({ madeFrom: 'parts_mail', expense: null }), [line({ rate: null, amount: null })], AT);
    expect((billPayload(unpriced).lines as Array<Record<string, unknown>>)[0].amount).toBeNull();
  });
});

/** Just enough of the service client: reads of netsuite_vendor_po_lines and the save. */
function fakeService(opts: { poLines?: PoCopyLine[]; readError?: string; rpc?: { data?: unknown; error?: { message: string } } } = {}) {
  const reads: Array<{ table: string; columns: string; filters: Array<[string, unknown]> }> = [];
  const rpc = vi.fn(async (_fn: string, _args: unknown) => opts.rpc ?? { data: { saved: true, lines: 1 }, error: null });
  const service = {
    from(table: string) {
      const read = { table, columns: '', filters: [] as Array<[string, unknown]> };
      reads.push(read);
      const q: any = {
        select(columns: string) { read.columns = columns; return q; },
        eq(column: string, value: unknown) {
          read.filters.push([column, value]);
          return Promise.resolve(opts.readError ? { data: null, error: { message: opts.readError } } : { data: opts.poLines ?? [], error: null });
        },
      };
      return q;
    },
    rpc,
  } as unknown as SupabaseClient;
  return { service, rpc, reads };
}

describe('reading the PO copy', () => {
  it("reads the lines of FleetSuite's copy of the PO, and says when it has none", async () => {
    const { service, reads } = fakeService({ poLines: [line()] });
    expect(await readPoCopyLines(service, 'po-1')).toEqual([line()]);
    expect(reads).toEqual([{ table: 'netsuite_vendor_po_lines', columns: expect.stringContaining('quantity_billed'), filters: [['po_id', 'po-1']] }]);
    expect(await readPoCopyLines(fakeService().service, 'po-1')).toBeNull();
    expect(await readPoCopyLines(fakeService().service, null)).toBeNull();
    await expect(readPoCopyLines(fakeService({ readError: 'timed out' }).service, 'po-1')).rejects.toThrow('timed out');
  });
});

describe('saving the copy', () => {
  const payloadOf = (rpc: ReturnType<typeof fakeService>['rpc']) => (rpc.mock.calls[0][1] as { p: Record<string, any> }).p;
  afterEach(() => { vi.restoreAllMocks(); });

  it("saves a CNI vendor invoice's or payout's bill without reading the PO copy", async () => {
    const { service, rpc, reads } = fakeService();
    expect(await saveOwnBill(service, made(), AT)).toEqual({ saved: true });
    expect(rpc).toHaveBeenCalledWith('gl_own_bill_save', expect.anything());
    expect(payloadOf(rpc)).toMatchObject({ netsuite_id: '8801', made_from: 'vendor_invoice', bill_date: '2026-10-24' });
    expect(reads).toEqual([]);
  });

  it("saves a Parts Mail bill from FleetSuite's copy of the PO", async () => {
    const { service, rpc } = fakeService({ poLines: [line()] });
    await saveOwnBill(service, made({ madeFrom: 'parts_mail', expense: null, po: { copyId: 'po-1', netsuiteId: '5001', number: 'PO453-ACME' } }), AT);
    expect(payloadOf(rpc)).toMatchObject({ made_from: 'parts_mail', po_netsuite_id: '5001', unknowns: [] });
    expect(payloadOf(rpc).lines).toEqual([expect.objectContaining({ item_netsuite_id: '9001', quantity: 12, amount: '2140.00', po_line_id: '1' })]);
  });

  it('says so when the bill was already saved', async () => {
    const { service } = fakeService({ rpc: { data: { saved: false, lines: 0 } } });
    expect(await saveOwnBill(service, made(), AT)).toEqual({ saved: false, reason: 'already saved' });
  });

  it('never throws: a bill with no id, a failed read or a refused save is only logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const none = fakeService();
    expect(await saveOwnBill(none.service, made({ netsuiteId: '' }), AT)).toEqual({ saved: false, reason: "NetSuite didn't say which bill it made" });
    expect(await saveOwnBill(none.service, made({ netsuiteId: 'VB-8801' }), AT)).toMatchObject({ saved: false });
    expect(none.rpc).not.toHaveBeenCalled();

    const failing = fakeService({ readError: 'statement timeout' });
    expect(await saveOwnBill(failing.service, made({ madeFrom: 'parts_mail', expense: null, po: { copyId: 'po-1', netsuiteId: '5001', number: null } }), AT))
      .toEqual({ saved: false, reason: 'statement timeout' });
    expect(failing.rpc).not.toHaveBeenCalled();

    const refused = fakeService({ rpc: { error: { message: 'new row violates check constraint' } } });
    expect(await saveOwnBill(refused.service, made(), AT)).toEqual({ saved: false, reason: 'new row violates check constraint' });
    expect(error).toHaveBeenCalledWith('[books] own copy of NetSuite bill 8801 not saved: new row violates check constraint');

    const thrown = fakeService();
    thrown.rpc.mockRejectedValueOnce(new Error('fetch failed'));
    expect(await saveOwnBill(thrown.service, made(), AT)).toEqual({ saved: false, reason: 'fetch failed' });
  });
});
