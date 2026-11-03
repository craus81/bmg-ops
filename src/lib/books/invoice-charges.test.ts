// Shipping and handling NetSuite adds to an invoice: reading it from NetSuite as soon as the invoice is made, for
// FleetSuite's own copy to bill as NetSuite charged it. NetSuite is a stand-in. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ suiteql: vi.fn() }));
vi.mock('@/lib/netsuite', () => ({ suiteqlQueryAll: h.suiteql }));

import { chargeLines, chargesQuery, CHARGES_TIMEOUT_MS, readInvoiceCharges, SHIP_ITEM_TYPE, withCharges } from './invoice-charges';

const row = (over: Record<string, unknown> = {}) => ({
  line_id: '14', line_no: '6', item: '70', item_number: 'UPS Ground', description: null, netamount: '-12.5', ...over,
});

beforeEach(() => { h.suiteql.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('the shipping lines of an invoice', () => {
  it("asks NetSuite for the invoice's lines whose item is a shipping item, in the invoice's order", () => {
    const sql = chargesQuery('5001');
    expect(sql).toMatch(/FROM transactionline tl\s+JOIN item i ON i\.id = tl\.item/);
    expect(sql).toMatch(/WHERE tl\.transaction = 5001\s/);
    expect(sql).toMatch(/AND tl\.mainline = 'F'\s+AND tl\.taxline = 'F'\s+AND i\.itemtype = 'ShipItem'/);
    expect(sql).toMatch(/ORDER BY tl\.linesequencenumber, tl\.id$/);
    expect(SHIP_ITEM_TYPE).toBe('ShipItem');
  });

  it("won't ask about anything but a NetSuite id", () => {
    for (const bad of ['', 'INV2401', '5001 OR 1=1', ' 5001']) expect(() => chargesQuery(bad)).toThrow(`Not a NetSuite invoice id: ${bad}`);
  });
});

describe("NetSuite's answer as the copy's lines", () => {
  it('takes each line at what NetSuite charged, a sale the other way round from NetSuite, and leaves out lines of nothing', () => {
    expect(chargeLines([
      row(),
      row({ item: 71, item_number: '  Handling ', description: ' Handling ', netamount: -4 }),
      row({ item: ' 70 ', item_number: '', description: '  ', netamount: '0' }),
      row({ netamount: null }),
      row({ item: ' 72 ', item_number: null, netamount: '3.25' }),
    ])).toEqual([
      { itemId: '70', itemNumber: 'UPS Ground', description: null, quantity: null, rate: null, cents: 1250 },
      { itemId: '71', itemNumber: 'Handling', description: 'Handling', quantity: null, rate: null, cents: 400 },
      { itemId: '72', itemNumber: null, description: null, quantity: null, rate: null, cents: -325 },
    ]);
    expect(chargeLines([])).toEqual([]);
  });

  it("takes none of an answer it can't read whole", () => {
    expect(chargeLines(undefined)).toBeNull();
    expect(chargeLines({ items: [] })).toBeNull();
    expect(chargeLines([row(), row({ item: null })])).toBeNull();
    expect(chargeLines([row({ item: 'UPS' })])).toBeNull();
    expect(chargeLines([row({ netamount: 'twelve' })])).toBeNull();
    expect(chargeLines([null])).toBeNull();
  });
});

describe('reading the shipping NetSuite added', () => {
  it("reads it once NetSuite has the invoice, trying once more if NetSuite doesn't answer", async () => {
    h.suiteql.mockResolvedValueOnce([row()]);
    expect(await readInvoiceCharges('5001')).toEqual({
      ok: true, lines: [{ itemId: '70', itemNumber: 'UPS Ground', description: null, quantity: null, rate: null, cents: 1250 }],
    });
    expect(h.suiteql).toHaveBeenCalledWith(chargesQuery('5001'), 1000, { retries: 1 });
    h.suiteql.mockResolvedValueOnce([]);
    expect(await readInvoiceCharges('5002')).toEqual({ ok: true, lines: [] });
  });

  it('says why when NetSuite fails or its answer can\'t be read, and never throws', async () => {
    h.suiteql.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (400): Invalid search query'));
    expect(await readInvoiceCharges('5001')).toEqual({ ok: false, reason: 'NetSuite SuiteQL error (400): Invalid search query' });
    h.suiteql.mockRejectedValueOnce('socket hang up');
    expect(await readInvoiceCharges('5001')).toEqual({ ok: false, reason: 'socket hang up' });
    h.suiteql.mockRejectedValueOnce(new Error('x'.repeat(400)));
    expect((await readInvoiceCharges('5001') as { reason: string }).reason).toHaveLength(300);
    h.suiteql.mockResolvedValueOnce([row({ item: null })]);
    expect(await readInvoiceCharges('5001')).toEqual({ ok: false, reason: "NetSuite's answer couldn't be read" });
  });

  it("gives up on NetSuite after a while: the billing screen is waiting", async () => {
    vi.useFakeTimers();
    h.suiteql.mockReturnValue(new Promise(() => {}));
    const read = readInvoiceCharges('5001');
    await vi.advanceTimersByTimeAsync(CHARGES_TIMEOUT_MS - 1);
    let done = false;
    void read.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toEqual({ ok: false, reason: "NetSuite didn't answer within 6 seconds" });
    const quick = readInvoiceCharges('5001', { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await quick).toEqual({ ok: false, reason: "NetSuite didn't answer within 0.5 seconds" });
    expect(CHARGES_TIMEOUT_MS).toBe(6000);
  });

  it('leaves no timer behind once NetSuite has answered', async () => {
    vi.useFakeTimers();
    h.suiteql.mockResolvedValueOnce([]);
    await readInvoiceCharges('5001');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks NetSuite nothing for an invoice id that isn\'t one', async () => {
    expect(await readInvoiceCharges('INV2401')).toEqual({ ok: false, reason: 'Not a NetSuite invoice id: INV2401' });
    expect(h.suiteql).not.toHaveBeenCalled();
  });
});

describe('the lines an invoice bills, with the shipping NetSuite added', () => {
  const TYPES: Record<string, string> = { 55: 'InvtPart', 70: 'ShipItem', 71: 'ShipItem' };
  const typeOf = (id: string) => TYPES[id];

  it("puts NetSuite's shipping after FleetSuite's lines, in place of any shipping line FleetSuite had", () => {
    const shelf = { itemId: '55', cents: 25100 };
    const fee = { itemId: null, cents: 500 };
    const oldShipping = { itemId: '70', cents: 1000 };
    const shipping = { itemId: '70', cents: 1250 };
    const handling = { itemId: '71', cents: 400 };
    expect(withCharges([shelf, oldShipping, fee], [shipping, handling], typeOf)).toEqual([shelf, fee, shipping, handling]);
    expect(withCharges([shelf], [], typeOf)).toEqual([shelf]);
    expect(withCharges([oldShipping], [], typeOf)).toEqual([]);
  });
});
