// /api/parts-mail/create-bill (Parts Mail's Create NetSuite Bill): one bill per captured vendor invoice
// (src/lib/bill-once.ts). NetSuite is asked for a bill it already has from the PO's vendor under the invoice's
// Reference No. before one is made, so a bill whose billed stamp failed, or one entered in NetSuite by hand, isn't
// made twice; Mark billed then marks the invoice with that bill, after asking NetSuite again. NetSuite and the
// database are stand-ins. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const INVOICE_ID = 'a0000000-0000-4000-8000-000000000001';
const USER = 'u0000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => {
  const PO = { id: 'p0000000-0000-4000-8000-000000000001', netsuite_id: '7001', tranid: 'PO2290', vendor_name: 'Ranger Design', vendor_netsuite_id: '3001' };
  const state = {
    row: {} as Record<string, any>,
    po: { ...PO } as Record<string, any> | null,
    /** What the billed stamp answers. */
    stampError: null as { message: string } | null,
    updates: [] as Record<string, any>[],
  };
  // vendor_parts_invoices, one row: the invoice read with its PO, the claim, letting it go, the stamp and Mark billed.
  const service = {
    from(table: string) {
      if (table !== 'vendor_parts_invoices') throw new Error(`stand-in has no ${table}`);
      return {
        select: () => {
          const q: any = { eq: () => q, maybeSingle: async () => ({ data: { ...state.row, netsuite_vendor_pos: state.po }, error: null }) };
          return q;
        },
        update(patch: Record<string, any>) {
          const filters: Array<(r: Record<string, any>) => boolean> = [];
          const apply = () => {
            const hit = filters.every((f) => f(state.row));
            if (hit) { Object.assign(state.row, patch); state.updates.push(patch); }
            return hit;
          };
          const q: any = {
            eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return q; },
            or(expr: string) {
              const [isNull, lt] = expr.split(',');
              if (isNull !== 'bill_claimed_at.is.null' || !lt.startsWith('bill_claimed_at.lt.')) throw new Error(`stand-in can't read ${expr}`);
              const cutoff = lt.replace('bill_claimed_at.lt.', '');
              filters.push((r) => r.bill_claimed_at === null || r.bill_claimed_at < cutoff);
              return q;
            },
            select: async () => ({ data: apply() ? [{ id: state.row.id }] : [], error: null }),
            then(resolve: (v: unknown) => unknown) {
              if (patch.status === 'billed' && state.stampError) return Promise.resolve({ error: state.stampError }).then(resolve);
              apply();
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return q;
        },
      };
    },
  };
  const netsuite = { createBillFromPo: vi.fn(), findVendorBill: vi.fn() };
  return {
    PO, state, service, netsuite,
    match: vi.fn(),
    saveOwnBill: vi.fn(async () => ({ ok: true })),
    logAudit: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/api-auth', () => ({ requireRole: vi.fn(async () => ({ user: { id: USER } })) }));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/three-way-match', () => ({ loadThreeWayMatchForPo: h.match }));
vi.mock('@/lib/audit', () => ({ logAudit: h.logAudit }));
vi.mock('@/lib/books/own-bills', () => ({ saveOwnBill: h.saveOwnBill }));

import { POST } from '../app/api/parts-mail/create-bill/route';

const call = async (body: Record<string, unknown> = {}) => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/parts-mail/create-bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoiceId: INVOICE_ID, ...body }),
  }));
  return { status: res.status, body: await res.json() };
};
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const MADE = { success: true, billId: '8801', billNumber: 'VB-1042' };

beforeEach(() => {
  h.state.row = {
    id: INVOICE_ID, status: 'captured', bill_claimed_at: null, invoice_number: 'INV-5520', file_name: 'inv-5520.pdf',
    vendor_name: 'Ranger Design Inc', total: 358, matched_po_id: h.PO.id, netsuite_bill_id: null, netsuite_bill_number: null,
  };
  h.state.po = { ...h.PO };
  h.state.stampError = null;
  h.state.updates = [];
  h.netsuite.createBillFromPo.mockReset().mockResolvedValue(MADE);
  h.netsuite.findVendorBill.mockReset().mockResolvedValue(null);
  h.match.mockReset().mockResolvedValue({ match: { verdict: 'green', variances: [] } });
  h.saveOwnBill.mockClear();
  h.logAudit.mockClear();
});

describe('Create NetSuite Bill', () => {
  it("asks NetSuite for the vendor's bill under the invoice number, makes it when there's none, and marks the invoice billed", async () => {
    expect(await call()).toEqual({ status: 200, body: { billId: '8801', billNumber: 'VB-1042', po: 'PO2290' } });
    expect(h.netsuite.findVendorBill).toHaveBeenCalledTimes(1);
    expect(h.netsuite.findVendorBill).toHaveBeenCalledWith('3001', 'INV-5520');
    expect(h.netsuite.createBillFromPo).toHaveBeenCalledWith({
      purchaseOrderId: '7001', referenceNo: 'INV-5520', memo: 'Parts invoice INV-5520 (via FleetSuite parts mail)',
    });
    expect(h.state.row).toMatchObject({ status: 'billed', netsuite_bill_id: '8801', netsuite_bill_number: 'VB-1042', billed_by: USER, bill_claimed_at: null });
    expect(h.saveOwnBill).toHaveBeenCalledWith(h.service, expect.objectContaining({ netsuiteId: '8801', referenceNo: 'INV-5520', madeFrom: 'parts_mail' }));
  });

  it("makes none when NetSuite already has the vendor's bill under that number, names it, and lets the claim go", async () => {
    h.netsuite.findVendorBill.mockResolvedValue({ billId: '8802', billNumber: 'INV-5520' });
    expect(await call()).toEqual({
      status: 409,
      body: {
        error: "NetSuite already has bill INV-5520 from Ranger Design, so FleetSuite didn't make another.",
        found: { billId: '8802', billNumber: 'INV-5520' },
      },
    });
    expect(h.netsuite.createBillFromPo).not.toHaveBeenCalled();
    expect(h.state.row).toMatchObject({ status: 'captured', bill_claimed_at: null, netsuite_bill_id: null });
    expect(h.saveOwnBill).not.toHaveBeenCalled();
  });

  it("asks and bills under a number made from the invoice's id when the scan read none", async () => {
    h.state.row.invoice_number = null;
    expect((await call()).status).toBe(200);
    expect(h.netsuite.findVendorBill).toHaveBeenCalledWith('3001', 'PM-a0000000');
    expect(h.netsuite.createBillFromPo).toHaveBeenCalledWith({
      purchaseOrderId: '7001', referenceNo: 'PM-a0000000', memo: 'Parts invoice inv-5520.pdf (via FleetSuite parts mail)',
    });
    expect(h.saveOwnBill).toHaveBeenCalledWith(h.service, expect.objectContaining({ referenceNo: 'PM-a0000000' }));
  });

  it('turns away a second try while the first holds the invoice, without asking NetSuite', async () => {
    h.state.row.bill_claimed_at = minutesAgo(1);
    expect(await call()).toEqual({ status: 409, body: { error: 'A bill for this is already being made, or was just made. Wait a moment and refresh.' } });
    expect(h.netsuite.findVendorBill).not.toHaveBeenCalled();
    expect(h.netsuite.createBillFromPo).not.toHaveBeenCalled();
  });

  it("makes nothing when NetSuite can't be asked, and lets the claim go", async () => {
    h.netsuite.findVendorBill.mockRejectedValue(new Error('NetSuite SuiteQL error (503)'));
    expect(await call()).toEqual({
      status: 502,
      body: { error: "Couldn't ask NetSuite whether it already has bill INV-5520, so nothing was billed. Try again. (NetSuite SuiteQL error (503))" },
    });
    expect(h.netsuite.createBillFromPo).not.toHaveBeenCalled();
    expect(h.state.row.bill_claimed_at).toBeNull();
  });

  it('finds the bill NetSuite kept when its answer never came, and marks the invoice billed with it', async () => {
    h.netsuite.findVendorBill.mockResolvedValueOnce(null).mockResolvedValueOnce({ billId: '8803', billNumber: 'INV-5520' });
    h.netsuite.createBillFromPo.mockResolvedValue({ success: false, error: 'Failed to create vendor bill: fetch failed' });
    expect(await call()).toEqual({ status: 200, body: { billId: '8803', billNumber: 'INV-5520', po: 'PO2290' } });
    expect(h.state.row).toMatchObject({ status: 'billed', netsuite_bill_id: '8803', bill_claimed_at: null });
  });

  it("passes NetSuite's refusal on and lets the claim go when it has no such bill", async () => {
    h.netsuite.createBillFromPo.mockResolvedValue({ success: false, error: 'NetSuite error (400): The PO is closed' });
    expect(await call()).toEqual({ status: 502, body: { error: 'NetSuite error (400): The PO is closed' } });
    expect(h.state.row).toMatchObject({ status: 'captured', bill_claimed_at: null });
  });

  it("won't bill when FleetSuite's copy of the PO doesn't have its vendor", async () => {
    h.state.po!.vendor_netsuite_id = null;
    const res = await call();
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("FleetSuite's copy of PO PO2290 doesn't have its vendor yet, so it can't check NetSuite for a bill already made from this invoice. Nothing was billed. Tap Sync POs, then try again.");
    expect(h.netsuite.findVendorBill).not.toHaveBeenCalled();
    expect(h.state.row.bill_claimed_at).toBeNull();
  });

  it("won't bill or mark a dismissed invoice", async () => {
    h.state.row.status = 'dismissed';
    for (const body of [{}, { recordBill: '8802' }]) {
      expect(await call(body)).toEqual({ status: 409, body: { error: "This invoice was dismissed, so it isn't billed from Parts Mail." } });
    }
    expect(h.netsuite.findVendorBill).not.toHaveBeenCalled();
    expect(h.state.row.bill_claimed_at).toBeNull();
  });

  it("stops at a three-way match that isn't green before holding the invoice or asking NetSuite", async () => {
    h.match.mockResolvedValue({ match: { verdict: 'red', variances: ['Invoice total is $58.00 over the PO'] } });
    const res = await call();
    expect(res.status).toBe(409);
    expect(res.body.canOverride).toBe(true);
    expect(h.netsuite.findVendorBill).not.toHaveBeenCalled();
    expect(h.state.row.bill_claimed_at).toBeNull();
  });

  it('keeps the invoice held when the billed stamp fails, and says what happens next', async () => {
    h.state.stampError = { message: 'statement timeout' };
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.warning).toBe('The bill was made in NetSuite, but marking this invoice billed failed (statement timeout). Nothing will bill it again: in 15 minutes, Create NetSuite Bill finds bill VB-1042 and offers to mark this invoice billed with it.');
    expect(h.state.row.status).toBe('captured');
    expect(h.state.row.bill_claimed_at).not.toBeNull();
  });
});

describe('Mark billed with the bill NetSuite already has', () => {
  it('marks the invoice billed with it after asking NetSuite again, and makes no bill', async () => {
    h.netsuite.findVendorBill.mockResolvedValue({ billId: '8802', billNumber: 'INV-5520' });
    expect(await call({ recordBill: '8802' })).toEqual({ status: 200, body: { billId: '8802', billNumber: 'INV-5520', po: 'PO2290', recorded: true } });
    expect(h.netsuite.findVendorBill).toHaveBeenCalledWith('3001', 'INV-5520');
    expect(h.netsuite.createBillFromPo).not.toHaveBeenCalled();
    expect(h.match).not.toHaveBeenCalled();
    expect(h.state.row).toMatchObject({ status: 'billed', netsuite_bill_id: '8802', netsuite_bill_number: 'INV-5520', billed_by: USER, bill_claimed_at: null });
    expect(h.logAudit).toHaveBeenCalledWith(h.service, expect.objectContaining({
      table: 'vendor_parts_invoices', recordId: INVOICE_ID, action: 'record_bill',
      detail: { po: 'PO2290', invoiceNumber: 'INV-5520', referenceNo: 'INV-5520', netsuite_bill_id: '8802', billNumber: 'INV-5520' },
    }));
    expect(h.saveOwnBill).not.toHaveBeenCalled();
  });

  it("won't mark it with a bill NetSuite doesn't have from the vendor under that number now", async () => {
    for (const now of [null, { billId: '8899', billNumber: 'INV-5520' }]) {
      h.netsuite.findVendorBill.mockResolvedValue(now);
      expect(await call({ recordBill: '8802' })).toEqual({
        status: 409,
        body: { error: "NetSuite doesn't have that bill from Ranger Design under INV-5520 now, so this invoice wasn't marked billed. Refresh and try again." },
      });
      expect(h.state.row.status).toBe('captured');
    }
  });

  it("marks nothing when NetSuite can't be asked", async () => {
    h.netsuite.findVendorBill.mockRejectedValue(new Error('NetSuite SuiteQL error (503)'));
    const res = await call({ recordBill: '8802' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Couldn't ask NetSuite for bill INV-5520, so this invoice wasn't marked billed. Try again. (NetSuite SuiteQL error (503))");
    expect(h.state.row.status).toBe('captured');
  });

  it('leaves an invoice a try is billing right now to that try, and takes over one a try left long ago', async () => {
    h.netsuite.findVendorBill.mockResolvedValue({ billId: '8802', billNumber: 'INV-5520' });
    h.state.row.bill_claimed_at = minutesAgo(1);
    expect(await call({ recordBill: '8802' })).toEqual({
      status: 409, body: { error: 'A bill for this invoice is being made, or it was just marked billed. Wait a moment and refresh.' },
    });
    expect(h.state.row.status).toBe('captured');
    h.state.row.bill_claimed_at = minutesAgo(16);
    expect((await call({ recordBill: '8802' })).status).toBe(200);
    expect(h.state.row).toMatchObject({ status: 'billed', bill_claimed_at: null });
  });

  it('leaves an invoice another try billed while NetSuite was being asked', async () => {
    h.netsuite.findVendorBill.mockImplementation(async () => {
      Object.assign(h.state.row, { status: 'billed', netsuite_bill_id: '8801', netsuite_bill_number: 'VB-1042' });
      return { billId: '8802', billNumber: 'INV-5520' };
    });
    expect((await call({ recordBill: '8802' })).status).toBe(409);
    expect(h.state.row).toMatchObject({ status: 'billed', netsuite_bill_id: '8801' });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("won't mark an invoice already billed, or take anything but NetSuite's id for a bill", async () => {
    h.state.row = { ...h.state.row, status: 'billed', netsuite_bill_id: '8801', netsuite_bill_number: 'VB-1042' };
    expect(await call({ recordBill: '8802' })).toEqual({ status: 409, body: { error: 'Already billed (VB-1042)' } });
    expect((await call({ recordBill: "8802' OR 1=1" })).status).toBe(400);
    expect(h.netsuite.findVendorBill).not.toHaveBeenCalled();
  });
});
