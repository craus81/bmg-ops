// /api/po-receipts POST (Receiving): the date a receipt takes, in NetSuite's item receipt and in Books' own copy
// (src/lib/books/own-receipts.ts), is the day in O'Fallon, so an evening receipt isn't dated tomorrow, nor one on
// the evening of the 31st dated next month. NetSuite and the database are stand-ins. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => {
  const PO = {
    id: 'a0000000-0000-4000-8000-000000000001', netsuite_id: '7001', tranid: 'PO2290',
    vendor_name: 'Ranger Design', vendor_netsuite_id: '3001', status: 'B',
  };
  const MIRROR = [{ line_id: '501', item_netsuite_id: '77', item_number: 'LB-100', description: 'Light bar', quantity: 4, quantity_received: 0, rate: 89.5 }];
  const service = {
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, not: () => q, order: () => q, in: () => q, is: () => q, update: () => q,
        maybeSingle: async () => ({ data: table === 'netsuite_vendor_pos' ? PO : null, error: null }),
        insert: (rows: Record<string, any>[]) => ({
          select: async () => ({ data: rows.map((r, i) => ({ id: `r-${i + 1}`, item_number: r.item_number, line_id: r.line_id })), error: null }),
        }),
        then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) =>
          Promise.resolve({ data: table === 'netsuite_vendor_po_lines' ? MIRROR : [], error: null }).then(done, failed),
      };
      return q;
    },
  };
  const netsuite = {
    suiteqlQuery: vi.fn(async () => ({ items: [{ id: '501', linesequencenumber: '1', item: '77', quantity: '4', quantityshiprecv: '0' }] })),
    createItemReceiptFromPo: vi.fn(async () => ({ success: true, receiptId: '8801', receiptNumber: 'IR1042' })),
  };
  return { PO, service, netsuite, saveOwnReceipt: vi.fn(async () => ({ ok: true })) };
});

vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/api-auth', () => ({ requireFeature: vi.fn(async () => ({ user: { id: 'u-dock' } })) }));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/notify', () => ({ notifyMany: vi.fn(async () => {}) }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/parts-readiness', () => ({ computePartsReadiness: vi.fn() }));
vi.mock('@/lib/books/own-receipts', () => ({ saveOwnReceipt: h.saveOwnReceipt }));

import { POST } from '../app/api/po-receipts/route';

const receive = async (at: string) => {
  vi.setSystemTime(new Date(at));
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/po-receipts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ poId: h.PO.id, lines: [{ lineId: '501', itemNumber: 'LB-100', itemNetsuiteId: '77', quantity: 2 }] }),
  }));
  expect(res.status).toBe(200);
  const tranDate = (h.netsuite.createItemReceiptFromPo.mock.calls.at(-1) as any)?.[0]?.tranDate;
  const receiveDate = (h.saveOwnReceipt.mock.calls.at(-1) as any)?.[1]?.receiveDate;
  return { tranDate, receiveDate };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h.netsuite.createItemReceiptFromPo.mockClear();
  h.saveOwnReceipt.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe("a receipt's date", () => {
  it("is the day in O'Fallon in the evening, in NetSuite and in Books' own copy", async () => {
    // 8 PM CST on November 2: UTC is on the 3rd already.
    expect(await receive('2026-11-03T02:00:00Z')).toEqual({ tranDate: '2026-11-02', receiveDate: '2026-11-02' });
  });

  it("keeps a receipt on the evening of the 31st in that month", async () => {
    // 10:30 PM CDT on October 31.
    expect(await receive('2026-11-01T03:30:00Z')).toEqual({ tranDate: '2026-10-31', receiveDate: '2026-10-31' });
  });

  it("takes the next day from midnight in O'Fallon", async () => {
    expect(await receive('2026-11-03T06:30:00Z')).toEqual({ tranDate: '2026-11-03', receiveDate: '2026-11-03' });
    expect(await receive('2026-11-03T15:00:00Z')).toEqual({ tranDate: '2026-11-03', receiveDate: '2026-11-03' });
  });
});
