// /api/estimates/[id]/drop-ship POST: the number the drop ship PO NetSuite
// made ends up with. NetSuite's own, with the ending when one was asked for,
// and FleetSuite's next PO number once FleetSuite's own numbers is on
// (src/lib/books/own-numbers.ts), with what became of that number kept.
// NetSuite and the database are stand-ins. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { setNumberKeeper, type NumberEnd } from './books/own-numbers';

const h = vi.hoisted(() => {
  const state = { inserted: [] as Record<string, any>[], upserted: [] as Record<string, any>[] };
  const netsuite = {
    getSalesOrderRecord: vi.fn(),
    patchSalesOrder: vi.fn(),
    patchPurchaseOrder: vi.fn(),
    setPurchaseOrderNumber: vi.fn(),
    createDropShipPoViaRestlet: vi.fn(),
    getVendorContact: vi.fn(async () => ({ email: 'orders@ranger.example' })),
    suiteqlQuery: vi.fn(),
    transactionUrl: (type: string, id: string) => `https://netsuite.example/${type}/${id}`,
  };
  const ESTIMATE = {
    id: 'est-1', estimate_number: 'Q-1001', customer_name: 'Acme Plumbing', customer_netsuite_id: '4242',
    netsuite_so_id: '6001', netsuite_so_number: 'SO4410',
  };
  const service = {
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: table === 'estimates' ? ESTIMATE : null, error: null }),
        insert: (row: Record<string, any>) => {
          state.inserted.push(row);
          return { select: () => ({ single: async () => ({ data: { id: `ds-${state.inserted.length}` }, error: null }) }) };
        },
        upsert: async (row: Record<string, any>) => { state.upserted.push(row); return { error: null }; },
      };
      return builder;
    },
  };
  return { state, netsuite, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: 'p0000000-0000-4000-8000-000000000001' }, profile: { roles: ['admin'] } })),
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));

import { POST } from '../app/api/estimates/[id]/drop-ship/route';

const { netsuite, state } = h;

const SHIP_TO = { name: 'Acme Plumbing', address: '1 Depot Way', city: "O'Fallon", state: 'MO', zip: '63366' };
const record = (createdPo?: unknown) => ({
  id: '6001', tranId: 'SO4410', entity: { id: '4242', refName: 'Acme Plumbing' }, status: { id: 'B', refName: 'Pending Fulfillment' },
  shippingAddress: { addressee: 'Acme Plumbing', addr1: '1 Depot Way', city: "O'Fallon", state: 'MO', zip: '63366' },
  item: { items: [{ line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, ...(createdPo ? { createdPo } : {}) }] },
});

function post(extra: Record<string, unknown> = {}) {
  const req = new NextRequest('http://localhost/api/estimates/est-1/drop-ship', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ picks: [{ line: 1, rate: 61.25 }], vendorNetsuiteId: '3001', vendorName: 'Ranger Design', shipTo: SHIP_TO, ...extra }),
  });
  return POST(req, { params: { id: 'est-1' } });
}

function keeper(opts: { off?: boolean; fails?: boolean } = {}) {
  const ends: Array<[string, NumberEnd]> = [];
  setNumberKeeper({
    reserve: async () => {
      if (opts.fails) throw new Error('could not reach the database');
      return opts.off ? null : { id: 'num-1', number: 'PO10001' };
    },
    settle: async (id, end) => { ends.push([id, end]); },
  });
  return ends;
}

beforeEach(() => {
  state.inserted.length = 0;
  state.upserted.length = 0;
  for (const fn of [netsuite.getSalesOrderRecord, netsuite.patchSalesOrder, netsuite.patchPurchaseOrder, netsuite.setPurchaseOrderNumber]) fn.mockReset();
  netsuite.getSalesOrderRecord
    .mockResolvedValueOnce({ success: true, record: record() })
    .mockResolvedValueOnce({ success: true, record: record({ id: '9101', refName: 'Purchase Order #PO2301' }) });
  netsuite.patchSalesOrder.mockResolvedValue({ success: true });
  netsuite.patchPurchaseOrder.mockResolvedValue({ success: true });
  netsuite.setPurchaseOrderNumber.mockResolvedValue({ success: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setNumberKeeper(undefined);
  vi.restoreAllMocks();
});

const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

describe("a drop ship PO's number", () => {
  it("keeps NetSuite's, with the ending asked for, while FleetSuite's own numbers is off", async () => {
    const ends = keeper({ off: true });
    const plain = await answer(await post());
    expect(plain.status).toBe(200);
    expect(plain.body.dropShips[0].purchaseOrderNumber).toBe('PO2301');
    expect(netsuite.setPurchaseOrderNumber).not.toHaveBeenCalled();

    netsuite.getSalesOrderRecord
      .mockResolvedValueOnce({ success: true, record: record() })
      .mockResolvedValueOnce({ success: true, record: record({ id: '9101', refName: 'Purchase Order #PO2301' }) });
    const ended = await answer(await post({ poSuffix: 'acme' }));
    expect(netsuite.setPurchaseOrderNumber).toHaveBeenCalledWith('9101', 'PO2301-ACME');
    expect(ended.body.dropShips[0].purchaseOrderNumber).toBe('PO2301-ACME');
    expect(ended.body.warnings).toEqual([]);
    expect(ends).toEqual([]);
  });

  it("takes FleetSuite's next PO number once it's on, with the ending asked for", async () => {
    const ends = keeper();
    const res = await answer(await post({ poSuffix: 'ACME' }));
    expect(netsuite.setPurchaseOrderNumber).toHaveBeenCalledWith('9101', 'PO10001-ACME');
    expect(res.body.dropShips[0].purchaseOrderNumber).toBe('PO10001-ACME');
    expect(state.inserted[0].purchase_order_number).toBe('PO10001-ACME');
    expect(state.upserted[0].tranid).toBe('PO10001-ACME');
    expect(res.body.warnings).toEqual([]);
    expect(ends).toEqual([['num-1', { status: 'made', netsuiteId: '9101', netsuiteNumber: 'PO10001-ACME' }]]);
  });

  it("takes FleetSuite's number with no ending too, even when NetSuite's number couldn't be read", async () => {
    const ends = keeper();
    netsuite.getSalesOrderRecord.mockReset()
      .mockResolvedValueOnce({ success: true, record: record() })
      .mockResolvedValueOnce({ success: true, record: record({ id: '9101' }) });
    netsuite.suiteqlQuery.mockRejectedValueOnce(new Error('SuiteQL is down'));
    const res = await answer(await post());
    expect(netsuite.setPurchaseOrderNumber).toHaveBeenCalledWith('9101', 'PO10001');
    expect(res.body.dropShips[0].purchaseOrderNumber).toBe('PO10001');
    expect(ends).toEqual([['num-1', { status: 'made', netsuiteId: '9101', netsuiteNumber: 'PO10001' }]]);
  });

  it('keeps the number NetSuite kept when it keeps its own', async () => {
    const ends = keeper();
    netsuite.setPurchaseOrderNumber.mockResolvedValueOnce({ success: false, error: 'NetSuite kept its own number', actual: 'PO2301' });
    const res = await answer(await post());
    expect(res.body.dropShips[0].purchaseOrderNumber).toBe('PO2301');
    expect(res.body.warnings).toEqual(['NetSuite kept the number PO2301 instead of PO10001 (NetSuite kept its own number).']);
    expect(ends).toEqual([['num-1', { status: 'made', netsuiteId: '9101', netsuiteNumber: 'PO2301' }]]);
  });

  it("says NetSuite refused the number, or that FleetSuite can't tell", async () => {
    const ends = keeper();
    netsuite.setPurchaseOrderNumber.mockResolvedValueOnce({ success: false, error: 'NetSuite 400: Invalid tranid.' });
    const refused = await answer(await post());
    expect(refused.body.dropShips[0].purchaseOrderNumber).toBe('PO2301');
    expect(refused.body.warnings).toEqual(['NetSuite kept the number PO2301 instead of PO10001 (NetSuite 400: Invalid tranid.).']);

    netsuite.getSalesOrderRecord
      .mockResolvedValueOnce({ success: true, record: record() })
      .mockResolvedValueOnce({ success: true, record: record({ id: '9101', refName: 'Purchase Order #PO2301' }) });
    netsuite.setPurchaseOrderNumber.mockRejectedValueOnce(new Error('NetSuite request timed out'));
    await post();
    expect(ends).toEqual([
      ['num-1', { status: 'refused', note: 'NetSuite 400: Invalid tranid.' }],
      ['num-1', { status: 'unsure', note: 'NetSuite request timed out' }],
    ]);
  });

  it("keeps NetSuite's number, and says so, when FleetSuite can't give the PO its own", async () => {
    keeper({ fails: true });
    const res = await answer(await post({ poSuffix: 'ACME' }));
    expect(res.status).toBe(200);
    expect(netsuite.setPurchaseOrderNumber).toHaveBeenCalledWith('9101', 'PO2301-ACME');
    expect(res.body.dropShips[0].purchaseOrderNumber).toBe('PO2301-ACME');
    expect(res.body.warnings).toEqual(["FleetSuite couldn't give PO PO2301 its own number, so it keeps NetSuite's."]);
  });
});
